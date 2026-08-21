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

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from assembler import AssemblyError, assemble
from engine import EngineError, Pool
from models import (
    AssembleResponse,
    BootRequest,
    ChipState,
    Machine,
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
    "pc", "a", "x", "y", "s", "p", "ir", "alu", "sb", "adl", "adh",
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
            t["alu"], t["sb"], t["adl"], t["adh"],
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
