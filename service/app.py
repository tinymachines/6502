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

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from assembler import AssemblyError, assemble
from engine import EngineError, Pool
from models import (
    AssembleResponse,
    BootRequest,
    ChipState,
    Machine,
    Observation,
    Rom,
    SparseMemory,
    StepRequest,
    StepResponse,
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


@app.post("/v1/step")
def step(req: StepRequest) -> StepResponse:
    if (req.half_cycles is None) == (req.until is None):
        raise HTTPException(
            status_code=422,
            detail="give exactly one of half_cycles or until='instruction'",
        )
    if req.until is not None:
        verb = f"RUN {req.max_half_cycles}"
    else:
        verb = f"STEP {req.half_cycles}"

    lines = [verb, _state_line(req.machine)]
    lines += _memory_lines(req.machine.memory)
    if req.watch:
        lines.append("WATCH " + " ".join(req.watch))
    if req.trace:
        lines.append("TRACE")

    res = _engine(lines)
    return StepResponse(
        machine=_machine_from(res),
        observe=Observation(**res["observe"]),
        stepped=res["stepped"],
        completed=res["completed"],
        trace=[Observation(**t) for t in res["trace"]] if req.trace else None,
    )
