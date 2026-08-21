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
