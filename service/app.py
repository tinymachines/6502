"""6502 as a service: a stateless HTTP surface over the transistor-level chip.

    uvicorn app:app --app-dir service

Nothing here simulates a 6502. Every request carries the whole machine (the
four state bitsets and the sparse memory) to a warm engine process, which
settles the real switch network and hands the whole machine back. The server
keeps no sessions: the client's copy of the Machine object IS the session,
which is what lets any instance answer any request.

The flow a learner follows:

    POST /v1/assemble   source            -> bytes, listing, labels
    POST /v1/boot       rom (or memory)   -> a Machine at its first fetch
    POST /v1/step       machine + n       -> the Machine n half-cycles later,
                                             with an Observation per step if
                                             trace is on
"""

from __future__ import annotations

import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from assembler import AssemblyError, assemble
from atlas import GROUPS_PATH, MAX_DEPTH, MAX_LIMIT, Atlas, AtlasError
from engine import EngineError, Pool
from models import (
    AssembleResponse,
    AtlasResponse,
    BootRequest,
    ChipState,
    GroupsResponse,
    Machine,
    NeighborsResponse,
    NodeListResponse,
    NodesResponse,
    Observation,
    Rom,
    SparseMemory,
    StepRequest,
    StepResponse,
    TraceRows,
)

pool: Pool | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global pool
    pool = Pool()
    yield
    pool.close()
    pool = None


app = FastAPI(
    title="6502 as a service",
    description="A transistor-level MOS 6502, one half-cycle at a time. "
    "State travels with the request; the server remembers nothing.",
    lifespan=lifespan,
)

# Open on purpose: the server holds no user state and no credentials, so a
# third-party notebook or classroom page POSTing a machine here risks
# nothing. This is what lets the API be used from anywhere.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["content-type"],
)


def _state_line(m: Machine) -> str:
    st = m.state
    fetch = "-" if st.last_fetch is None else f"{st.last_fetch.addr:04x}{st.last_fetch.opcode:02x}"
    return (
        f"STATE {st.value} {st.pullup} {st.pulldown} {st.trans_on} "
        f"{st.half_cycle} {fetch}"
    )


def _memory_lines(mem: SparseMemory) -> list[str]:
    lines = [f"FILL {mem.fill}"]
    lines += [f"PAGE {k} {v}" for k, v in sorted(mem.pages.items())]
    return lines


def _machine_from(res: dict) -> Machine:
    st = res["state"]
    return Machine(
        state=ChipState(
            half_cycle=st["half_cycle"],
            last_fetch=st["last_fetch"],
            value=st["value"],
            pullup=st["pullup"],
            pulldown=st["pulldown"],
            trans_on=st["trans_on"],
        ),
        memory=SparseMemory(fill=res["memory"]["fill"], pages=res["memory"]["pages"]),
    )


def _engine(lines: list[str]) -> dict:
    assert pool is not None, "service not started"
    try:
        return pool.request(lines)
    except EngineError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


API_PAGE = Path(__file__).resolve().parent / "api.html"


@app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
def api_page() -> FileResponse:
    """The API reference, in the site's own design language. The generated
    /docs and /redoc stay beside it; this page is the one that explains the
    ideas (statelessness, the state object, what an observation is)."""
    return FileResponse(API_PAGE, media_type="text/html")


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


@app.get("/v1/meta")
def meta() -> dict:
    res = _engine(["META"])
    return res["meta"]


# The grouping is a reading of the names, kept in one small table the way
# the site keeps STEMS: an authored convenience beside measured data, never
# mixed into it. A name no rule claims lands in "other" rather than being
# dropped, so the groups always sum to the count.
_GROUP_RULES: list[tuple[str, re.Pattern]] = [
    ("rails", re.compile(r"v(ss|cc)$")),
    ("pins", re.compile(r"(ab\d+|db\d|rw|sync|clk0|clk1out|clk2out|res|irq|nmi|rdy|so)$")),
    ("registers", re.compile(r"((not)?(a|x|y|s|ir|idl|pcl|pch|pclp|pchp)\d|dor\d|notdor\d|p\d|Pout\d)$")),
    ("buses", re.compile(r"((not)?(sb|idb|adl|adh|alua|alub|alu)\d|dasb\d|abl\d|abh\d)$")),
    ("datapath", re.compile(r"dpc.*")),
    ("decode", re.compile(r"(op-.*|PD-.*|irline3|ONEBYTE|fetch|clearIR)$")),
    ("timing", re.compile(r"(clock1|clock2|t2|t3|t4|t5|VEC0|VEC1|cclk|cp1|pipe.*)$")),
]

_nodes_cache: NodesResponse | None = None


@app.get("/v1/nodes")
def nodes() -> NodesResponse:
    """Every name `watch` accepts, with its node id. Static: the die does
    not change, so cache it as hard as you like."""
    global _nodes_cache
    if _nodes_cache is None:
        res = _engine(["NODES"])
        groups: dict[str, dict[str, int]] = {g: {} for g, _ in _GROUP_RULES}
        groups["other"] = {}
        for name, nid in res["nodes"].items():
            for g, rx in _GROUP_RULES:
                if rx.fullmatch(name):
                    groups[g][name] = nid
                    break
            else:
                groups["other"][name] = nid
        _nodes_cache = NodesResponse(count=res["count"], groups=groups)
    return _nodes_cache


# ---------------------------------------------------------------------------
# The chip atlas
#
# /v1/nodes above answers "what can I watch", and its grouping is a reading of
# the die's NAMES. Everything below answers "what is this node part of", and
# every answer is measured: `web/chip-groups.js` composes the tracer's
# derivations (the ALU as bit slices, one container per status flag, the
# registers as their closures and load lines, the timing chain as the cells
# that compute each T-state) and `tools/export-groups.mjs` exports them. The
# module the pages draw with is the module the API serves, so the two cannot
# disagree.
#
# Loaded lazily and once: a missing file must not stop the chip answering, so
# the failure lands on these routes as a 503 and nowhere else.
# ---------------------------------------------------------------------------
_atlas: Atlas | None = None
_atlas_error: str | None = None


def _at() -> Atlas:
    global _atlas, _atlas_error
    if _atlas is None:
        try:
            _atlas = Atlas()
        except AtlasError as e:
            _atlas_error = str(e)
            raise HTTPException(status_code=503, detail=_atlas_error) from e
        # The die's full name table, aliases and all, from the same engine
        # response /v1/nodes serves: 832 names over 707 nodes, so a node can
        # be asked for by any of its names.
        # Best effort on purpose: the atlas is static data and must answer
        # with no engine behind it, so an engine that is down costs the 125
        # aliases and nothing else.
        try:
            table: dict[str, int] = {}
            for grp in nodes().groups.values():
                table.update(grp)
            _atlas.attach_names(table)
        except (EngineError, AssertionError, HTTPException):
            pass
    return _atlas


@app.get("/v1/atlas", response_model=AtlasResponse)
def atlas() -> dict:
    """What the atlas holds: the container kinds, the twelve functional
    blocks plus the static logic and the residue, the node roles, and the
    bounds a walk is held to. Static, like /v1/nodes."""
    return _at().overview()


@app.get("/v1/atlas/full")
def atlas_full():
    """The whole atlas in one response: every kind, every group with its
    members and bundles, every overlapping container, every node with its
    tags, and the 534 bundles. About 328 KB, 48 KB gzipped, which is less
    than `/v1/tags` alone costs.

    This is `web/groups.json` byte for byte -- the file `tools/export-groups.mjs`
    wrote and every other route on this page is answered from -- rather than
    a re-serialisation of it, so a consumer holding this file is holding
    exactly what the service is holding. Static, so cached a day like the
    rest of the family.

    What it does NOT carry is the die's alias table: `nodes[].name` is one
    name per node, and 125 nodes have more than one. Fetch `/v1/nodes`
    (4.6 KB gzipped) beside it to resolve any of the 832 names.
    """
    a = _at()          # loaded and cross-checked before the file is offered
    assert a is not None
    if not GROUPS_PATH.exists():                      # pragma: no cover
        raise HTTPException(status_code=503, detail=f"{GROUPS_PATH} is missing")
    return FileResponse(GROUPS_PATH, media_type="application/json")


@app.get("/v1/groups", response_model=GroupsResponse)
def groups(
    kind: str | None = Query(None, description="one container kind, e.g. alu, flags, regs"),
    parent: str | None = Query(None, description="only the children of this group key"),
    block: str | None = Query(None, description="functional block, by id or name"),
    q: str | None = Query(None, description="substring of the key or the label"),
    min_nodes: int = Query(0, ge=0, description="drop groups smaller than this"),
    layer: str = Query("partition", description="partition | containers | absorbed"),
    members: bool = Query(False, description="include each group's node list"),
) -> dict:
    """The derived containers.

    `layer=partition` (the default) is the 132 disjoint groups the chip map
    draws: every node in exactly one. `layer=containers` is the same
    derivations unfiltered, so they overlap and a node can be in five.
    `layer=absorbed` is the three that exist only in the overlapping layer,
    having been claimed whole by a container that outranks them.
    """
    a = _at()
    try:
        rows = a.list_groups(kind=kind, parent=parent, block=block, q=q,
                             min_nodes=min_nodes, layer=layer, members=members)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return {"count": len(rows), "layer": layer, "groups": rows}


@app.get("/v1/groups/{key:path}")
def group(
    key: str,
    members: bool = Query(True),
    layer: str = Query("partition", description="partition | containers"),
) -> dict:
    """One container: its parent and children, the blocks its nodes are filed
    in, every other container it shares nodes with, the bundles it anchors
    (the gate legs and switches crossing to each neighbouring group, with the
    control lines on them), and its members.

    `layer=containers` returns the derivation's OWN node set instead of the
    partition's: `intr:nmi` is 20 nodes as a walk and 18 as a box, because the
    pipeline latch file outranks the interrupts and keeps `pipeVectorA2`. The
    response then also carries `owned` and `claimed_elsewhere`, so the
    difference is visible rather than implied.

    The path converter is `:path` because five keys carry a slash of their
    own -- `alat:ADL/ABL` is a load line, not two path segments.
    """
    try:
        return _at().group_full(key, members=members, layer=layer)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@app.get("/v1/tags", response_model=NodeListResponse)
def tags(
    group: str | None = Query(None, description="every node in this group key"),
    kind: str | None = Query(None, description="every node in any container of this kind"),
    block: str | None = Query(None, description="functional block, by id or name"),
    role: str | None = Query(None, description="signal | decode term | control line"),
    q: str | None = Query(None, description="substring of the node name"),
    named: bool | None = Query(None, description="true for named nodes only, false for unnamed"),
    multi: bool = Query(False, description="only nodes in more than one container"),
    limit: int = Query(200, ge=1, le=MAX_LIMIT),
    offset: int = Query(0, ge=0),
) -> dict:
    """Nodes with their tags: the group that owns each, every container it is
    in, its functional block, role, pull-up, centroid and degree.

    This is a separate route from /v1/nodes rather than a mode of it, because
    /v1/nodes answers a different question and consumers depend on its shape.
    """
    a = _at()
    try:
        rows, total = a.list_nodes(group=group, kind=kind, block=block, role=role,
                                   q=q, named=named, multi=multi, limit=limit, offset=offset)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return {"total": total, "count": len(rows), "offset": offset, "nodes": rows}


@app.get("/v1/neighbors", response_model=NeighborsResponse)
def neighbors(
    node: str = Query(..., description="a die name or a node number"),
    via: str = Query("all", description="all | gate | switch | control"),
    direction: str = Query("both", description="both | in | out, for gate edges"),
    depth: int = Query(1, ge=1, le=MAX_DEPTH),
    limit: int = Query(200, ge=1, le=MAX_LIMIT),
) -> dict:
    """What one node reaches, with each neighbour's own tags.

    Four relations, kept apart because they are four different things:
    `drives` (this node is an input to that gate), `driven_by` (that node is
    an input to the gate driving this one), `channel` (a pass transistor,
    which conducts both ways and therefore has no direction, reported with
    the control line that opens it) and `opens` (this node IS a control line,
    reaching the two ends of the switch it operates -- not a path through it).

    `direction` applies to the gate relations only. A control line is never
    followed as if it were a signal path, which is the rule the schematic
    walks by: `cclk` gates 273 transistors, and expanding controls buries
    whatever was asked about.
    """
    a = _at()
    # Resolution and the walk are caught separately, deliberately: a KeyError
    # raised inside the walk is a bug in the walk, and a blanket 404 around
    # both would report it as "no such node" forever.
    try:
        nid = a.resolve(node)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    try:
        return a.neighbors(nid, via=via, direction=direction, depth=depth, limit=limit)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@app.get("/v1/node/{ref:path}")
def node(ref: str) -> dict:
    """One node, by die name or by number: every name it carries, the group
    that owns it, every container it is in, its block, role, pull-up,
    centroid and degree.

    `:path` because 47 die names carry a slash (`op-T2-ADL/ADD`).
    """
    a = _at()
    try:
        nid = a.resolve(ref)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    return a.node_full(nid)


@app.post("/v1/assemble")
def do_assemble(rom: Rom) -> AssembleResponse:
    try:
        res = assemble(rom.source, rom.org)
    except AssemblyError as e:
        raise HTTPException(status_code=422, detail={"error": str(e), "line": e.line}) from e
    return AssembleResponse(
        org=res["org"],
        end=res["end"],
        size=res["size"],
        bytes=res["bytes"],
        labels=res["labels"],
        listing=res["listing"],
    )


def _overlay(mem: SparseMemory, org: int, blob: bytes) -> SparseMemory:
    image = mem.flat()
    image[org : org + len(blob)] = blob
    return SparseMemory.from_flat(bytes(image), fill=mem.fill)


@app.post("/v1/boot")
def boot(req: BootRequest) -> StepResponse:
    memory = req.memory
    vector = req.reset_vector
    assembled: AssembleResponse | None = None

    if req.rom is not None:
        try:
            res = assemble(req.rom.source, req.rom.org)
        except AssemblyError as e:
            raise HTTPException(status_code=422, detail={"error": str(e), "line": e.line}) from e
        assembled = AssembleResponse(
            org=res["org"],
            end=res["end"],
            size=res["size"],
            bytes=res["bytes"],
            labels=res["labels"],
            listing=res["listing"],
        )
        memory = _overlay(memory, res["org"], bytes.fromhex(res["bytes"]))
        if vector is None:
            vector = res["org"]

    lines = ["BOOT"]
    if vector is not None:
        lines.append(f"VEC {vector:04x}")
    lines += _memory_lines(memory)
    if req.watch:
        lines.append("WATCH " + " ".join(req.watch))

    res = _engine(lines)
    return StepResponse(
        machine=_machine_from(res),
        observe=Observation(**res["observe"]),
        stepped=res["stepped"],
        completed=res["completed"],
        assembled=assembled,
    )


_ROW_COLS = [
    "half_cycle", "cycle", "clk0", "phase", "addr", "data", "rw", "sync",
    "pc", "a", "x", "y", "s", "p", "ir",
    "alu", "alua", "alub", "sb", "idb", "idl", "dor",
    "adl", "adh", "abl", "abh", "pclp", "pchp",
    "tstates", "hidden", "store_data", "fetch_addr", "fetch_opcode", "watch",
]
_HIDDEN = {"": 0, "T1": 1, "VEC0": 2, "T6": 3}
_SD = {"": 0, "SD1": 1, "SD2": 2}


def _pack_rows(trace: list[dict], watch_names: list[str]) -> TraceRows:
    rows = []
    nbytes = (len(watch_names) + 7) // 8
    for t in trace:
        tmask = 0
        for part in t["tstates"].split("+"):
            if part:
                tmask |= 1 << int(part[1])
        w = t.get("watch") or {}
        wmask = 0
        for i, name in enumerate(watch_names):
            if w.get(name):
                wmask |= 1 << i
        # Hex, not an integer: a JSON number is a float64 to every browser,
        # so an integer mask silently corrupts past 53 names. Same bit
        # convention as the state blobs (bit i in byte i/8, LSB first),
        # fixed width, empty with no watches.
        whex = wmask.to_bytes(nbytes, "little").hex()
        f = t["fetch"]
        rows.append([
            t["half_cycle"], t["cycle"], int(t["clk0"]),
            1 if t["phase"] == "phi1" else 2,
            t["addr"], t["data"], 0 if t["rw"] == "read" else 1, int(t["sync"]),
            t["pc"], t["a"], t["x"], t["y"], t["s"], t["p"], t["ir"],
            t["alu"], t["alua"], t["alub"], t["sb"], t["idb"], t["idl"], t["dor"],
            t["adl"], t["adh"], t["abl"], t["abh"], t["pclp"], t["pchp"],
            tmask, _HIDDEN[t["hidden"]], _SD[t["store_data"]],
            f["addr"] if f else -1, f["opcode"] if f else -1, whex,
        ])
    return TraceRows(cols=_ROW_COLS, watch_names=watch_names, rows=rows)


@app.post("/v1/step")
def step(req: StepRequest) -> StepResponse:
    chosen = [
        x for x in (req.half_cycles, req.until, req.until_pc) if x is not None
    ]
    if len(chosen) != 1:
        raise HTTPException(
            status_code=422,
            detail="give exactly one of half_cycles, until, or until_pc",
        )
    if req.until_pc is not None:
        verb = f"RUNTO {req.max_half_cycles} {req.until_pc:04x}"
    elif req.until == "instruction":
        verb = f"RUN {req.max_half_cycles}"
    elif req.until == "cycle":
        verb = "STEP 2"
    else:
        verb = f"STEP {req.half_cycles}"

    lines = [verb, _state_line(req.machine)]
    lines += _memory_lines(req.machine.memory)
    for pin, level in req.pins.items():
        lines.append(f"PIN {pin} {level}")
    if req.watch:
        lines.append("WATCH " + " ".join(req.watch))
    if req.trace:
        lines.append("TRACE")

    res = _engine(lines)
    rows = req.trace and req.format == "rows"
    return StepResponse(
        machine=_machine_from(res),
        observe=Observation(**res["observe"]),
        stepped=res["stepped"],
        completed=res["completed"],
        trace=[Observation(**t) for t in res["trace"]] if req.trace and not rows else None,
        trace_rows=_pack_rows(res["trace"], req.watch) if rows else None,
    )
