"""The service's public shapes: one Pydantic model per thing that travels.

The state model is the whole machine as a value. Its four hex blobs are the
engine's own wire encoding (bit i of a set is byte i//8, LSB first, node
numbering visual6502's own), and the lengths are fixed by the die: 1725 node
bits pack to 216 bytes (432 hex chars), 3510 transistor bits to 439 bytes
(878 chars). A blob of the wrong length is refused at the model boundary,
because a state that decodes to the wrong chip is worse than one that is
rejected.

Memory is sparse on purpose: 64 KiB is mostly fill byte, so it travels as a
fill plus only the 256-byte pages that differ from it. The engine returns it
the same way, canonically (a supplied page that is all fill is dropped).
"""

from __future__ import annotations

from typing import Literal, Optional, Union

from pydantic import BaseModel, Field, field_validator

HEX_NODE_CHARS = 432   # ceil(1725 / 8) bytes, two chars each
HEX_TRANS_CHARS = 878  # ceil(3510 / 8) bytes, two chars each


def _hex(value: str, chars: int, what: str) -> str:
    v = value.lower()
    if len(v) != chars:
        raise ValueError(f"{what} wants {chars} hex chars, got {len(v)}")
    if any(c not in "0123456789abcdef" for c in v):
        raise ValueError(f"{what} contains a non-hex character")
    return v


class LastFetch(BaseModel):
    """The most recent opcode fetch: enough to disassemble the instruction
    in flight, which the instruction register alone is not."""

    addr: int = Field(ge=0, le=0xFFFF)
    opcode: int = Field(ge=0, le=0xFF)


class ChipState(BaseModel):
    """Every switch and every latch, as a value. Restoring this into a fresh
    engine resumes the simulation bit for bit (proven in tests/state.rs over
    every node at every half-cycle)."""

    version: Literal[1] = 1
    half_cycle: int = Field(ge=0)
    last_fetch: Optional[LastFetch] = None
    value: str = Field(description="node levels, 432 hex chars")
    pullup: str = Field(description="per-node pullup, 432 hex chars")
    pulldown: str = Field(description="per-node pulldown, 432 hex chars")
    trans_on: str = Field(description="conducting transistors, 878 hex chars")

    @field_validator("value", "pullup", "pulldown")
    @classmethod
    def _nodes(cls, v: str) -> str:
        return _hex(v, HEX_NODE_CHARS, "a node bitset")

    @field_validator("trans_on")
    @classmethod
    def _trans(cls, v: str) -> str:
        return _hex(v, HEX_TRANS_CHARS, "the transistor bitset")


class SparseMemory(BaseModel):
    """64 KiB as a fill byte plus the pages that differ from it."""

    fill: str = "00"
    pages: dict[str, str] = Field(default_factory=dict)

    @field_validator("fill")
    @classmethod
    def _fill(cls, v: str) -> str:
        return _hex(v, 2, "fill")

    @field_validator("pages")
    @classmethod
    def _pages(cls, v: dict[str, str]) -> dict[str, str]:
        out: dict[str, str] = {}
        for k, page in v.items():
            out[_hex(k, 2, "a page number")] = _hex(page, 512, f"page {k}")
        return out

    def flat(self) -> bytearray:
        image = bytearray(bytes.fromhex(self.fill) * 65536)
        for k, page in self.pages.items():
            base = int(k, 16) * 256
            image[base : base + 256] = bytes.fromhex(page)
        return image

    @classmethod
    def from_flat(cls, image: bytes, fill: str = "00") -> "SparseMemory":
        fb = bytes.fromhex(fill)[0]
        pages = {
            f"{p:02x}": image[p * 256 : (p + 1) * 256].hex()
            for p in range(256)
            if any(b != fb for b in image[p * 256 : (p + 1) * 256])
        }
        return cls(fill=fill, pages=pages)


class Machine(BaseModel):
    """The unit of statelessness: chip plus memory. POST it back to continue
    exactly where the last response left off."""

    state: ChipState
    memory: SparseMemory


class Rom(BaseModel):
    """A program as source. Assembled by the site's own assembler (web/asm.js
    through a node bridge), so the service and the site cannot disagree about
    what a line of assembly means."""

    source: str
    org: int = Field(default=0x0200, ge=0, le=0xFFFF)


class ListingLine(BaseModel):
    n: int
    text: str
    label: Optional[str] = None
    addr: Optional[int] = None
    bytes: Optional[str] = None


class AssembleResponse(BaseModel):
    org: int
    end: int
    size: int
    bytes: str
    labels: dict[str, int]
    listing: list[ListingLine]


class Observation(BaseModel):
    """What a learner reads off the chip at one instant. Everything here is
    read back out of storage nodes, not modelled: the registers are the
    levels of their own silicon, the T-states the timing chain's."""

    half_cycle: int
    cycle: int
    clk0: bool
    phase: Literal["phi1", "phi2"]
    addr: int
    data: int
    rw: Literal["read", "write"]
    sync: bool
    pc: int
    a: int
    x: int
    y: int
    s: int
    p: int
    ir: int
    flags: str
    tstates: str
    hidden: str
    store_data: str
    alu: int = Field(description="the adder's hold register: where a sum is real before any register holds it")
    alua: int = Field(description="the adder's A input latch")
    alub: int = Field(description="the adder's B input latch (loaded inverted by nDBADD for SBC)")
    sb: int = Field(description="the special bus. Precharged: idles high where nothing drives it")
    idb: int = Field(description="the internal data bus")
    idl: int = Field(description="the input data latch: what memory answered, held")
    dor: int = Field(description="the data output register: what a write cycle will drive")
    adl: int = Field(description="internal address bus, low byte")
    adh: int = Field(description="internal address bus, high byte")
    abl: int = Field(description="address output latch, low byte: what the pins hold steady")
    abh: int = Field(description="address output latch, high byte")
    pclp: int = Field(description="the program counter's low prime latch: the incremented next PC")
    pchp: int = Field(description="the program counter's high prime latch")
    fetch: Optional[LastFetch] = None
    watch: Optional[dict[str, bool]] = None


class BootRequest(BaseModel):
    """Start a machine. A rom is laid over the memory at its org, and the
    reset vector defaults to that org so the program is what runs."""

    rom: Optional[Rom] = None
    memory: SparseMemory = Field(default_factory=SparseMemory)
    reset_vector: Optional[int] = Field(default=None, ge=0, le=0xFFFF)
    watch: list[str] = Field(default_factory=list)


class StepRequest(BaseModel):
    """Advance a machine. Exactly one of: a half-cycle count,
    `until="instruction"` (run to the next opcode fetch), `until="cycle"`
    (one whole clock cycle, two half-cycles), or `until_pc` (run to the
    opcode fetch AT an address: a breakpoint). The until forms are bounded
    by max_half_cycles, because a JAM opcode never reaches another fetch and
    a loop may never fetch the named address."""

    machine: Machine
    half_cycles: Optional[int] = Field(default=None, ge=1)
    until: Optional[Literal["instruction", "cycle"]] = None
    until_pc: Optional[int] = Field(default=None, ge=0, le=0xFFFF)
    max_half_cycles: int = Field(default=200, ge=1)
    watch: list[str] = Field(default_factory=list)
    trace: bool = False
    format: Literal["objects", "rows"] = "objects"
    pins: dict[str, int] = Field(
        default_factory=dict,
        description="input pins to drive before stepping: res, irq, nmi, "
        "rdy, so, each to 0 or 1. LEVELS, not assertions: four of the five "
        "are active low, so 0 asserts them. The drive lives in the "
        "machine's own pull state, so a pin stays where it was put across "
        "requests until set again.",
    )

    @field_validator("pins")
    @classmethod
    def _pins(cls, v: dict[str, int]) -> dict[str, int]:
        for k, lvl in v.items():
            if k not in ("res", "irq", "nmi", "rdy", "so"):
                raise ValueError(f"unknown pin {k!r} (res, irq, nmi, rdy, so)")
            if lvl not in (0, 1):
                raise ValueError(f"pin {k} wants 0 or 1, got {lvl}")
        return v


class TraceRows(BaseModel):
    """The trace as columnar rows: the same information as the object form
    in fewer bytes. Measured on the trace payload alone (the machine,
    identical under both formats, is excluded): 3.7x smaller at 45
    half-cycles watching 2 nodes, 7.5x at 133 watching 22. Gzipped, the
    two forms nearly converge, because repeated key names compress away;
    rows then earns its keep as parse time and allocation rather than
    bytes.

    Encodings, stated: clk0 and sync are 0/1; phase is 1 or 2; rw is 0 for
    read, 1 for write; tstates is a bitmask, bit n for Tn (T1 meaning the
    T1x/T+ state); hidden is 0 none, 1 T1, 2 VEC0, 3 T6; store_data is 0
    none, 1 SD1, 2 SD2; a fetch that has not happened is addr -1 and
    opcode -1. watch is a lowercase HEX bitset over watch_names (bit i in
    byte i/8, LSB first: the convention /v1/meta states for the state
    blobs), fixed width of ceil(names/8) bytes, an empty string with no
    watches. Hex and not an integer because a JSON number is a float64 to
    every browser: past 53 names an integer mask silently corrupts, found
    by a consumer watching 64. watch_encoding says so on the wire. The
    flags string is dropped: it derives from p."""

    cols: list[str]
    watch_names: list[str]
    watch_encoding: Literal["hex"] = "hex"
    rows: list[list[Union[int, str]]]


class StepResponse(BaseModel):
    machine: Machine
    observe: Observation
    stepped: int
    completed: bool
    trace: Optional[list[Observation]] = None
    trace_rows: Optional[TraceRows] = None
    assembled: Optional[AssembleResponse] = None


class NodesResponse(BaseModel):
    """Every watchable node name, grouped. The grouping is a reading of the
    names (an authored convenience, like the site's STEMS table), never a
    measurement; the names and ids are the die's own. 846 raw entries in the
    die's name table collapse to 834 distinct keys (12 duplicates) and two
    of those are the bit-5 sentinels p5 and Pout5, which name storage the
    6502 does not have: 832 resolve."""

    count: int
    groups: dict[str, dict[str, int]]


# ---------------------------------------------------------------------------
# The chip atlas: derived containers over the die.
#
# These carry deliberately loose inner types. The shapes are wide (a group
# names its parent, its children, the blocks its nodes are filed in, every
# container it overlaps and every bundle it anchors) and they are generated
# by `tools/export-groups.mjs` from the same module the tracer draws with. A
# second, hand-written declaration of each field here would be a copy that
# drifts; the exporter refuses to write a file that fails its own structural
# checks, and `service/test_service.py` holds the served shape to the file.
# ---------------------------------------------------------------------------


class AtlasResponse(BaseModel):
    """What the atlas contains: the kinds, the functional blocks, the roles
    and the counts. Static: the die does not change."""

    format: str
    counts: dict[str, int]
    kinds: list[dict]
    blocks: list[dict]
    roles: list[str]
    limits: dict[str, int]


class GroupsResponse(BaseModel):
    """Derived containers, filtered. `layer` says which of the two layers was
    asked for: `partition` (132 disjoint groups, every node once),
    `containers` (138, overlapping) or `absorbed` (the 6 that exist only in
    the overlapping layer)."""

    count: int
    layer: str
    groups: list[dict]


class NodeListResponse(BaseModel):
    """Nodes with their tags, filtered. `total` is how many matched;
    `nodes` is the page asked for."""

    total: int
    count: int
    offset: int
    nodes: list[dict]


class NeighborsResponse(BaseModel):
    """One node's neighbours, by relation. `drives`/`driven_by` are the two
    ends of a gate edge; `channel` is a pass transistor, which conducts both
    ways and therefore has no direction; `opens` is a control line reaching
    the switch it operates, which is a third relation again and is not a path
    through the node at all."""

    node: dict
    via: str
    direction: str
    depth: int
    count: int
    rails: int
    truncated: bool
    neighbors: list[dict]


# -- cartridges --------------------------------------------------------------
#
# A game on this chip is a ROM plus the addresses the host and the ROM have
# agreed on, and there is no hardware to consult about either: the console is
# a contract (see cartridge.py). These shapes are that contract as a request.


class TileArt(BaseModel):
    """The sprite sheet, in either of the two forms it can arrive in.

    `pixels` is eight strings of eight '0'..'3' per tile, which is the form
    something writing a cartridge from text can actually emit. `chr` is the
    binary tile format as hex, which is what a converter emits. Give one;
    both are written into the cartridge either way, so a reader never has to
    decode and a drawing tool never has to parse ASCII."""

    pixels: Optional[list[list[str]]] = None
    chr: Optional[str] = None


class Peek(BaseModel):
    """A byte a headless cartridge asks to have read out after its run."""

    addr: int = Field(ge=0, le=0xFFFF)
    name: str = Field(max_length=24, pattern=r"^[A-Za-z0-9_.$-]+$")


class ConsoleSpec(BaseModel):
    """Where the host and the ROM meet. `tick`, `input` and the screen are
    the console; everything else is a cartridge saying what else it uses.

    `kind: "headless"` is a cartridge that draws nothing: a program on the
    chip with no screen page and no tick flag. It is run for `half_cycles`
    and what is read out is the registers and the bytes it names in `peek`.
    The seven programs the explorer boots are this kind, and it exists so
    they can be minted, listed and measured like any other cartridge rather
    than living in a JavaScript file."""

    kind: Literal["console", "headless"] = "console"
    half_cycles: int = Field(
        default=2000, ge=1, le=200000,
        description="headless only: how long to run when verifying",
    )
    peek: list[Peek] = Field(default_factory=list, max_length=8,
                             description="headless only: bytes to read out after the run")
    tick: int = Field(default=0x000D, ge=0, le=0xFFFF)
    input: int = Field(default=0x0002, ge=0, le=0xFFFF)
    screen: int = Field(default=0x0500, ge=0, le=0xFFFF)
    width: int = Field(default=16, ge=1, le=64)
    height: int = Field(default=16, ge=1, le=64)
    status: Optional[int] = Field(default=None, ge=0, le=0xFFFF)
    score: Optional[int] = Field(default=None, ge=0, le=0xFFFF)
    entropy: Optional[int] = Field(default=None, ge=0, le=0xFFFF)
    gate_mask: Optional[int] = Field(default=None, ge=0, le=0xFFFF)
    frame_cost: Optional[int] = Field(default=None, ge=1, le=200000)
    dirs: dict[str, int] = Field(default_factory=dict)
    watch: list[str] = Field(default_factory=list)


class CartMeta(BaseModel):
    name: str = Field(default="untitled", max_length=64)
    author: Optional[str] = Field(default=None, max_length=64)
    blurb: Optional[str] = Field(default=None, max_length=400)


class CartridgeRequest(BaseModel):
    """Mint a cartridge: assemble the source, check the layout can work, run
    it on the chip, and pack the lot into one file."""

    rom: Rom
    console: ConsoleSpec = Field(default_factory=ConsoleSpec)
    tiles: Optional[TileArt] = None
    meta: CartMeta = Field(default_factory=CartMeta)
    reset_vector: Optional[int] = Field(default=None, ge=0, le=0xFFFF)
    verify: bool = True
    frames: int = Field(
        default=3, ge=0, le=16,
        description="frames to run when verifying. The first is usually the "
        "expensive one: a cartridge that clears its screen pays for it once.",
    )
    frame_budget: int = Field(default=60000, ge=1, le=200000)


class VerifyReport(BaseModel):
    """What the chip did, not what the cartridge claims. `booted` is the
    weakest claim here and `frames_completed` the strongest: a ROM that
    assembles and boots and never raises its tick flag is a ROM that does
    not run on this console."""

    booted: bool
    frames_requested: int
    frames_completed: int
    half_cycles: list[int]
    frame_cost: Optional[int]
    screen_changed: bool
    tiles_used: list[int]
    status: Optional[int]
    score: Optional[int]
    notes: list[str]
    # A headless cartridge has no frames to complete; what it has is a run.
    kind: Literal["console", "headless"] = "console"
    draws_nothing: bool = False
    registers: Optional[dict[str, int]] = Field(
        default=None, description="headless: pc, a, x, y, s, p after the run, read off the silicon")
    flags: Optional[str] = None
    peeked: Optional[dict[str, int]] = Field(
        default=None, description="headless: the bytes the cartridge named, after the run")
    pc_moved: Optional[bool] = Field(
        default=None, description="headless: whether the pc changed over the last quarter of the run")


class CartridgeResponse(BaseModel):
    cartridge: dict
    verify: Optional[VerifyReport] = None
    size: int
    packed_size: int
    sha256: str


# -- the registry ------------------------------------------------------------
#
# The one stateful corner of the service. The chip is unaffected: what is
# stored is a catalogue of who published what, and running a ROM still means
# POSTing the machine.


class TileArtIn(BaseModel):
    """A picture in the console's four colours, as tiles.

    `pixels` is one entry per 8x8 tile in row-major order, each eight strings
    of eight '0'..'3'. The server decodes no images: a photo is converted in
    the client (games/art.js, in a canvas), so there is no image parser in the
    request path and what lands on disk is CHR, the same encoding a sprite
    sheet uses."""

    w: int = Field(ge=1, le=24, description="width in 8-pixel tiles")
    h: int = Field(ge=1, le=24, description="height in 8-pixel tiles")
    pixels: list[list[str]]


class ClaimRequest(BaseModel):
    handle: str = Field(description="the page's URL: /b/<handle>")
    name: str


class BuilderPatch(BaseModel):
    """Only what is present is changed, so a client editing a bio cannot
    blank an avatar it did not send."""

    name: Optional[str] = None
    bio: Optional[str] = None
    links: Optional[list[dict]] = None
    avatar: Optional[TileArtIn] = None


class PublishRequest(BaseModel):
    """A cartridge, and what to call it.

    Everything measurable comes out of the file and is then measured again on
    the chip here: the size, the tile count and the frame cost are not fields
    a builder can set. Title and blurb default to the cartridge's own."""

    cart: str = Field(description="the .cart.gz, base64")
    title: Optional[str] = None
    blurb: Optional[str] = None
    cover: Optional[TileArtIn] = None
    frames: int = Field(default=3, ge=1, le=8)
