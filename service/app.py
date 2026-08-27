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

import base64
import binascii
import hashlib
import json
import re
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.docs import get_redoc_html, get_swagger_ui_html
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response

import cartridge
import mcp_server
import registry
from assembler import AssemblyError, assemble
from atlas import GROUPS_PATH, MAX_DEPTH, MAX_LIMIT, Atlas, AtlasError
from engine import EngineError, Pool
from models import (
    AssembleResponse,
    BuilderPatch,
    CartMeta,
    CartridgeRequest,
    CartridgeResponse,
    ClaimRequest,
    ConsoleSpec,
    AtlasResponse,
    BootRequest,
    ChipState,
    GroupsResponse,
    Machine,
    NeighborsResponse,
    NodeListResponse,
    NodesResponse,
    Observation,
    PublishRequest,
    Rom,
    SparseMemory,
    StepRequest,
    StepResponse,
    TileArt,
    TraceRows,
    VerifyReport,
)

pool: Pool | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global pool
    pool = Pool()
    # Start every chip before the first request rather than on it. Lazily
    # spawned workers made "a pool of warm instances" false for exactly as
    # many requests as there are workers, each paying a start it did not have
    # to. The whole pool is about 40 ms and 28 MB.
    up = pool.warm()
    if up < len(pool.workers):
        print(f"halfwave: {up} of {len(pool.workers)} chips warmed", flush=True)
    yield
    pool.close()
    pool = None


app = FastAPI(
    title="6502 as a service",
    description="A transistor-level MOS 6502, one half-cycle at a time. "
    "State travels with the request; the server remembers nothing.",
    lifespan=lifespan,
    # The built-in /openapi.json, /docs and /redoc are declared per-door below
    # instead. FastAPI's own openapi route ACCUMULATES root paths into the
    # schema's servers list (self.servers.insert on every new root_path it
    # sees), which is harmless with one front door and wrong with two: after
    # one fetch through each, every schema fetch from either door lists both
    # servers, and a client resolving servers[0] against the wrong origin
    # calls a path that is not there, or a different service that is.
    openapi_url=None,
    docs_url=None,
    redoc_url=None,
)

class HeadAsGet:
    """Answer HEAD wherever GET is answered.

    Every route here replied 405 to HEAD. That is the wrong answer twice over:
    RFC 9110 defines HEAD as GET without a body, so a resource that answers one
    answers the other, and a 405 tells a monitor the endpoint is broken rather
    than that it is fine.

    FastAPI's APIRoute registers only the methods named on the decorator.
    Starlette's own Route quietly adds HEAD to any GET; APIRoute does not, and
    the difference is invisible until something sends one.

    Done here rather than by adding methods=["GET", "HEAD"] to two dozen
    decorators, for a documentation reason: that would put a HEAD operation on
    every path in openapi.json, describing something HTTP already guarantees,
    in a document whose whole claim is that every line earns its place. This is
    transport behaviour, so it lives in the transport.

    The headers are the ones GET would send, Content-Length included, so a
    client can ask how big something is without fetching it. more_body is
    forced off so a streaming response cannot leave the connection waiting for
    a chunk that will never come.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or scope.get("method") != "HEAD":
            await self.app(scope, receive, send)
            return

        scope = dict(scope, method="GET")

        async def send_without_body(message):
            if message["type"] == "http.response.body":
                await send({"type": "http.response.body", "body": b"", "more_body": False})
                return
            await send(message)

        await self.app(scope, receive, send_without_body)


app.add_middleware(HeadAsGet)

# Open on purpose: the server holds no user state and, for everything except
# the registry, no credentials, so a third-party notebook or classroom page
# POSTing a machine here risks nothing. This is what lets the API be used
# from anywhere.
#
# HEAD is listed because the middleware above answers it, and a preflight for
# a method the policy does not name is refused before it reaches the app.
#
# PATCH, PUT, DELETE and the authorization header are the registry's writing
# half (#12). Before these, tinymachines.ai/6502/builders could read the
# registry cross-origin but a browser there could not send a bearer token at
# all: the preflight refused the header, the request was never made, and the
# server log had nothing to show for it. Naming them costs nothing to the
# open POST surface: allow_origins stays *, and a bearer in a header is not a
# cookie, so no credentialed-request rules are involved. A token is only ever
# sent by a page that holds one, and the routes verify it either way.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["content-type", "authorization"],
    # So a cross-origin caller can revalidate. A browser hides every response
    # header from script except a short safelist, and ETag is not on it: the
    # tag would arrive, be invisible to the page, and If-None-Match would never
    # be sent. Naming it here is what makes the validator reachable from
    # tinymachines.ai, which is where the roof reads this service from.
    expose_headers=["ETag"],
)


class ForwardedPrefix:
    """Let the proxy say where this service is mounted, per request.

    One service, several front doors. Each site's nginx proxies its own /api
    to this process, and since 2026-08-24 the apex proxies /6502/api here too.
    The unit's --root-path /api covers every door that mounts at /api without
    those vhosts changing anything; a door mounted anywhere else says so with
    X-Forwarded-Prefix, and this middleware makes the generated URLs (the
    schema's servers entry, /docs asking for its schema) tell the truth for
    the door the request actually came through.

    Trusting the header is the same argument entropy-gate makes for
    X-Forwarded-For: this binds 127.0.0.1, so nginx on this box is the only
    thing that can send anything at all. The check below is not a defence
    against nginx; it keeps a malformed value from becoming a malformed URL.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") == "http":
            prefix = None
            for name, value in scope.get("headers", []):
                if name == b"x-forwarded-prefix":
                    prefix = value.decode("latin-1")
                    break
            # A mount point is an absolute path: leading slash, no scheme, no
            # doubled slashes, nothing a URL would have to escape. Anything
            # else is ignored rather than obeyed, so the fallback root path
            # still applies and the door still works.
            if (
                prefix
                and prefix.startswith("/")
                and "//" not in prefix
                and re.fullmatch(r"[A-Za-z0-9/_.-]+", prefix)
            ):
                # Both fields move together. Under the current ASGI reading
                # (uvicorn 0.26+), scope["path"] INCLUDES the root path: the
                # unit's --root-path /api makes uvicorn deliver
                # path=/api/openapi.json, root_path=/api. Replacing root_path
                # alone leaves a path that no longer starts with it, and
                # Starlette then routes the full old path, which is a 404 for
                # everything. Measured on the live door, not deduced: the
                # first version of this changed only root_path, passed a test
                # that sent the wrong scope shape, and 404d in production.
                new_root = prefix.rstrip("/")
                old_root = scope.get("root_path", "")
                path = scope.get("path", "")
                inner = path[len(old_root):] if old_root and path.startswith(old_root) else path
                scope = dict(scope, root_path=new_root, path=new_root + inner)
        await self.app(scope, receive, send)


app.add_middleware(ForwardedPrefix)


# The schema and the documents that render it, declared here per door rather
# than by the framework, for the accumulation reason on the constructor. Each
# response names exactly one server: the door the request came through. The
# schema itself is generated once and cached by app.openapi(); only the
# servers entry is per-request, on a shallow copy so the cache stays clean.
@app.get("/openapi.json", include_in_schema=False)
async def openapi_at_this_door(request: Request) -> JSONResponse:
    doc = dict(app.openapi())
    root = request.scope.get("root_path", "").rstrip("/")
    doc["servers"] = [{"url": root or "/"}]
    return JSONResponse(doc)


@app.get("/docs", include_in_schema=False)
async def docs_at_this_door(request: Request) -> HTMLResponse:
    root = request.scope.get("root_path", "").rstrip("/")
    return get_swagger_ui_html(openapi_url=f"{root}/openapi.json", title=f"{app.title} - docs")


@app.get("/redoc", include_in_schema=False)
async def redoc_at_this_door(request: Request) -> HTMLResponse:
    root = request.scope.get("root_path", "").rstrip("/")
    return get_redoc_html(openapi_url=f"{root}/openapi.json", title=f"{app.title} - redoc")


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
    `layer=absorbed` is the six that exist only in the overlapping layer,
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


# -- cartridges --------------------------------------------------------------
#
# A game on this chip is a ROM plus the handful of addresses the host and the
# ROM have agreed on. There is no video hardware and no interrupt in use, so a
# "frame" is not something the silicon knows about: it is that agreement, and
# the agreement IS the console. See cartridge.py for the file it packs into.


def _peek(mem: SparseMemory, addr: int) -> int:
    page = mem.pages.get(f"{addr >> 8:02x}")
    if page is None:
        return int(mem.fill, 16)
    return int(page[(addr & 0xFF) * 2 : (addr & 0xFF) * 2 + 2], 16)


def _poke(mem: SparseMemory, addr: int, value: int) -> SparseMemory:
    """One byte, without expanding 64 KiB to change it. `flat()` is correct
    and costs a megabyte of hex per write; a frame writes three or four."""
    key = f"{addr >> 8:02x}"
    page = mem.pages.get(key) or (mem.fill * 256)
    off = (addr & 0xFF) * 2
    page = page[:off] + f"{value & 0xFF:02x}" + page[off + 2 :]
    return SparseMemory(fill=mem.fill, pages={**mem.pages, key: page})


def _step_machine(m: Machine, n: int) -> Machine:
    return _machine_from(_engine([f"STEP {n}", _state_line(m), *_memory_lines(m.memory)]))


def _step_observed(m: Machine, n: int) -> tuple[Machine, dict]:
    res = _engine([f"STEP {n}", _state_line(m), *_memory_lines(m.memory)])
    return _machine_from(res), res["observe"]


# The measurement ladder: absolute, and deliberately not seeded from anything
# the cartridge declares. It is what makes a measured cost a measurement --
# see _run_frame.
_LADDER = ((16384, 128), (65536, 1024), (None, 8192))


def _chunk(spent: int) -> int:
    for edge, size in _LADDER:
        if edge is None or spent < edge:
            return size
    return _LADDER[-1][1]


def _run_frame(m: Machine, con: dict, budget: int) -> tuple[Machine, int, bool]:
    """One frame of the console contract: drop the tick flag, let the ROM go,
    and come back when it raises the flag again, with the cost measured.

    A step that lands past the flag cannot say when the flag went up, so the
    number this returns is only as good as the step that found it. The steps
    therefore come from a **fixed ladder** -- 128 half-cycles until 16k, then
    1024, then 8192 -- and from nothing the cartridge says about itself.

    That is the whole point, and it was learned twice. Sizing the first step
    from the declared `frame_cost` is what a host should do (it makes an
    ordinary frame one round trip) and is exactly wrong for a measurement:
    the same ROM minted with `frame_cost` at 512 and at 20000 measured 6400
    and 6250, because each number was its own request rounded up. Die
    Runner's page had carried a declared 12,000 for the same reason: the
    console requests `frameCost` and then reports what it spent, so whatever
    was written there confirmed itself.

    Chip time is what a measurement costs, not requests: this engine runs
    about 26,000 half-cycles a second against roughly 1.5 ms of request
    overhead, so walking a frame in 128s costs the frame plus a tenth.
    """
    tick = con["tick"]
    m = Machine(state=m.state, memory=_poke(m.memory, tick, 0))
    spent = 0
    while spent < budget:
        n = min(_chunk(spent), budget - spent)
        m = _step_machine(m, n)
        spent += n
        if _peek(m.memory, tick) != 0:
            return m, spent, True
    return m, spent, False


def _screen_of(m: Machine, con: dict) -> bytes:
    base, cells = con["screen"], con["width"] * con["height"]
    image = m.memory.flat()
    return bytes(image[base : base + cells])


def _verify_headless(doc: dict) -> VerifyReport:
    """A headless cartridge has no frame to complete. What running it says
    is where it got to: boot, run for the half-cycles it declares, and read
    the registers and the bytes it named off the silicon. The last quarter is
    run apart so the report can say whether the pc still moves, which is
    the difference between a loop and a JAM, and between a program that
    finished (a BRK loop moves, too) and one that never started."""
    con = doc["console"]
    rom = doc["rom"]
    total = int(con.get("half_cycles") or 2000)
    memory = _overlay(SparseMemory(), rom["org"], bytes.fromhex(rom["bytes"]))
    m = _machine_from(_engine(["BOOT", f"VEC {rom['reset']:04x}", *_memory_lines(memory)]))
    first = max(1, total - total // 4)
    m, obs = _step_observed(m, first)
    # The last quarter in four pieces, so "the pc moved" is four readings
    # apart rather than two instants that a short loop can land on twice:
    # a BRK loop three bytes long read as stopped when it was sampled at
    # two points a whole number of laps apart.
    rest = total - first
    pcs = [obs["pc"]]
    for i in range(4):
        n = rest // 4 + (1 if i < rest % 4 else 0)
        if n <= 0:
            continue
        m, obs = _step_observed(m, n)
        pcs.append(obs["pc"])
    peeked = {p["name"]: _peek(m.memory, p["addr"]) for p in con.get("peek") or []}
    regs = {k: obs[k] for k in ("pc", "a", "x", "y", "s", "p")}
    notes = ["draws nothing: a headless cartridge has no screen"]
    moved = len(set(pcs)) > 1
    if not moved:
        notes.append(f"the pc stayed at ${obs['pc']:04X} over the last {rest} half-cycles")
    return VerifyReport(
        booted=True, frames_requested=0, frames_completed=0, half_cycles=[total],
        frame_cost=None, screen_changed=False, tiles_used=[], status=None, score=None,
        notes=notes, kind="headless", draws_nothing=True, registers=regs,
        flags=obs.get("flags"), peeked=peeked, pc_moved=moved,
    )


def _verify(doc: dict, frames: int, budget: int) -> VerifyReport:
    """What the chip did with this cartridge, which is a different claim from
    "it assembled". A ROM that assembles, boots, and never raises its tick
    flag is a ROM that does not run on this console, and nothing short of
    running it says so."""
    if doc["console"].get("kind") == "headless":
        return _verify_headless(doc)
    con = doc["console"]
    rom = doc["rom"]
    notes: list[str] = []

    memory = _overlay(SparseMemory(), rom["org"], bytes.fromhex(rom["bytes"]))
    res = _engine(["BOOT", f"VEC {rom['reset']:04x}", *_memory_lines(memory)])
    m = _machine_from(res)

    costs: list[int] = []
    completed = 0
    before = _screen_of(m, con)
    changed = False
    for _ in range(frames):
        if con.get("entropy") is not None:
            m = Machine(state=m.state, memory=_poke(m.memory, con["entropy"], 0x5A))
        m, spent, done = _run_frame(m, con, budget)
        costs.append(spent)
        if not done:
            notes.append(
                f"frame {completed + 1} never raised the tick flag at "
                f"${con['tick']:04X} within {budget} half-cycles. Either the ROM "
                f"does not write it, or it costs more than the budget."
            )
            break
        completed += 1
        after = _screen_of(m, con)
        changed = changed or after != before
        before = after

    screen = _screen_of(m, con)
    used = sorted(set(screen))
    if used == [0]:
        notes.append("the screen is one value everywhere: nothing was drawn on it")
    elif len(used) == 1:
        notes.append(f"the screen is tile {used[0]} everywhere")
    if completed >= 2 and not changed:
        notes.append("the screen never changed between frames")
    tiles = doc["tiles"]["count"]
    if tiles and used and max(used) >= tiles:
        notes.append(
            f"the screen uses tile {max(used)} and the sheet has {tiles} "
            f"(0..{tiles - 1}); the host will draw whatever it falls back to"
        )
    # The steady cost, not the first: a cartridge that clears its screen or
    # lays out a level pays for that once, and sizing every later request by
    # it would spend a round trip's worth of chip time in the spin loop.
    steady = costs[1:] if len(costs) > 1 else costs
    return VerifyReport(
        booted=True,
        frames_requested=frames,
        frames_completed=completed,
        half_cycles=costs,
        frame_cost=max(steady) if steady else None,
        screen_changed=changed,
        tiles_used=used,
        status=_peek(m.memory, con["status"]) if con.get("status") is not None else None,
        score=_peek(m.memory, con["score"]) if con.get("score") is not None else None,
        notes=notes,
    )


_BIT = re.compile(r"(\d+)$")


def _joins_for(names: list[str]) -> dict[str, str]:
    """What each watched control line opens, named: `dpc23_SBAC` -> `sb0 - a0`.

    Derived from the switch network rather than carried as prose. Die Runner
    had these eight written out by hand beside the eight names, which is two
    claims where there is one fact. Asked for them, the atlas agrees on five
    and the three it does not are the interesting part:

    - `dpc40_ADLPCL` opens one switch a bit, and bit 7's transistor happens to
      carry the LOWEST number on the die. Picking the lowest transistor is
      therefore arbitrary; picking the lowest bit index is not, and gives the
      `adl0 - pcl0` a reader expects.
    - `dpc2_XSB` joins `sb0..sb7` to nodes the die never named. The authored
      label said `x0 - sb0`, naming the register a reader knows is there; the
      atlas says those nodes are owned by `regs:x`, so an unnamed end is
      reported as its container. That is the measured version of the same
      claim.
    - The two ends come back in either order, and there is no order to get
      right: a pass transistor conducts both ways, which is why the atlas
      keeps `channel` apart from `drives` and `driven_by`. Sorted here for
      determinism, and the pair is unordered.
    """
    try:
        a = _at()
    except HTTPException:
        return {}                       # the atlas is an extra, never the mint
    out: dict[str, str] = {}
    for name in names:
        try:
            nid = a.resolve(name)
        except KeyError:
            continue
        opened: dict[int, list[dict]] = {}
        for n in a.neighbors(nid, via="control", direction="both",
                             depth=1, limit=64)["neighbors"]:
            if n.get("relation") == "opens":
                opened.setdefault(n["transistor"], []).append(n)
        best, rank = None, None
        for t, ends in sorted(opened.items()):
            if len(ends) != 2:
                continue
            bits = [int(m.group(1)) for e in ends
                    if e.get("name") and (m := _BIT.search(e["name"]))]
            here = (min(bits) if bits else 99, t)
            if rank is None or here < rank:
                best, rank = ends, here
        if best:
            out[name] = " - ".join(sorted(
                e.get("name") or e.get("owner") or f"#{e['id']}" for e in best))
    return out


@app.get("/v1/console")
def console_spec() -> dict:
    """The console: what a ROM has to agree with to be playable, published so
    it does not have to be inferred from a game that already works.

    Static, and a reading of nothing: these are addresses two programs agree
    on, not facts about the silicon. The chip has no video and no timer.
    """
    return {
        "console": "tinymachines.die",
        "contract": {
            "how": [
                "the host clears one byte; the ROM notices, runs a frame, and sets it back",
                "the host writes one byte before each frame; that byte is the controller",
                "the host reads a page of memory; that page is the screen",
            ],
            "why": "there is no video hardware on this die and no interrupt in "
            "use, so a frame is an agreement rather than a thing the chip knows "
            "about. The ROM busy-waits on the flag, which is the only way to "
            "synchronise with the outside when you have no interrupt and no timer.",
            "addresses": cartridge.CONTRACT,
        },
        # Derived from the model that validates a request, never retyped:
        # a reader following this page has to be writing against the
        # addresses the service actually defaults to.
        "defaults": {
            **{k: v for k, v in ConsoleSpec().model_dump().items() if v not in (None, {}, [])},
            "org": 0x0200,
        },
        "conventional": {
            "status": 0x0003,
            "note": "optional, so it has no default; $0003 is what the shipped "
                    "cartridges use and a host reads it to know the game is over",
        },
        "memory_map": [
            {"range": "$0000-$00FF", "what": "zero page: the contract bytes live here, "
             "and it is where a 6502 keeps its variables. Two bytes an instruction "
             "instead of three"},
            {"range": "$0100-$01FF", "what": "the stack. A cartridge is refused if its "
             "ROM or its screen covers this"},
            {"range": "$0200-", "what": "the usual .org for a ROM"},
            {"range": "the screen", "what": "width x height bytes, one tile index a "
             "cell, row major. Put it ABOVE the ROM: a ROM that reaches its own "
             "screen is overwritten by the picture it draws, and it assembles and "
             "boots first"},
            {"range": "$FFFA-$FFFF", "what": "the vectors. Booting writes the reset "
             "vector at $FFFC"},
        ],
        "tiles": {
            "size": cartridge.TILE,
            "bytes_per_tile": cartridge.BYTES_PER_TILE,
            "bits_per_pixel": 2,
            "encoding": cartridge.ENCODING["chr"],
            "pixels": cartridge.ENCODING["pixels"],
            "palette": [
                {"index": 0, "colour": cartridge.PALETTE[0], "layer": "substrate"},
                {"index": 1, "colour": cartridge.PALETTE[1], "layer": "diffusion"},
                {"index": 2, "colour": cartridge.PALETTE[2], "layer": "polysilicon"},
                {"index": 3, "colour": cartridge.PALETTE[3], "layer": "metal"},
            ],
            "note": "four colours a tile is the constraint that makes the art look "
            "like the era. Colour 0 is drawn, not skipped: this is a tiled screen, "
            "not a sprite layer.",
        },
        "cartridge": {
            "format": cartridge.FORMAT,
            "version": cartridge.VERSION,
            "container": cartridge.ENCODING["container"],
            "mint": "POST /v1/cartridge",
            "play": "https://games.tinymachines.ai/?cart=<url to the .cart.gz>",
        },
        "example": {
            "note": "the smallest ROM that satisfies the contract: it draws one "
            "cell and raises the flag. Everything else is a game.",
            "source": _EXAMPLE_ROM,
        },
    }


_EXAMPLE_ROM = """        .org $0200
; The smallest thing that is a cartridge: it fills the screen with
; substrate, puts one charge packet where the controller says, and raises
; the tick flag. The host clears that flag to ask for the next frame.
reset   LDX #$00
clear   LDA #$00
        STA $0500,X
        INX
        BNE clear
        LDA $02         ; the controller byte
        AND #$0F
        TAX
        LDA #$02        ; tile 2: a charge packet
        STA $0500,X
        LDA #$01
        STA $0D         ; the frame is finished
wait    LDA $0D
        BNE wait        ; the host clears it when it wants another
        JMP reset"""


@app.post("/v1/cartridge")
def mint(req: CartridgeRequest, format: str = Query("gzip", pattern="^(gzip|json)$")):
    """Mint a cartridge: assemble, check the layout can work, run it on the
    chip, and pack the lot into one gzipped file.

    The checking is the part worth having. A ROM that overlaps its own screen
    assembles perfectly and then draws over itself; a tick flag inside the
    ROM is written by the host into the code. Both were found here the hard
    way, and both are refusals now rather than a game that runs and is wrong.
    """
    try:
        res = assemble(req.rom.source, req.rom.org)
    except AssemblyError as e:
        raise HTTPException(status_code=422, detail={"error": str(e), "line": e.line}) from e
    res["source"] = req.rom.source

    try:
        doc = cartridge.build(
            meta=req.meta.model_dump(),
            assembled=res,
            console=req.console.model_dump(),
            tiles=req.tiles.model_dump() if req.tiles else None,
            reset=req.reset_vector,
        )
    except cartridge.CartridgeError as e:
        raise HTTPException(status_code=422, detail={"error": str(e)}) from e

    watched = doc["console"].get("watch") or []
    if watched:
        joins = _joins_for(watched)
        if joins:
            doc["console"]["joins"] = [joins.get(n, "") for n in watched]

    report = None
    if req.verify and (req.frames or req.console.kind == "headless"):
        report = _verify(doc, req.frames, req.frame_budget)
        doc["verify"] = report.model_dump()
        # A measured cost beats a declared one, and a cartridge with no cost
        # at all makes every host that plays it guess.
        if report.frame_cost and not doc["console"].get("frame_cost"):
            doc["console"]["frame_cost"] = report.frame_cost
            doc["notes"] = [n for n in doc["notes"] if not n.startswith("no frame_cost")]
            doc["notes"].append(
                f"frame_cost {report.frame_cost} was measured here, not declared"
            )

    blob = cartridge.pack(doc)
    if format == "json":
        return CartridgeResponse(
            cartridge=doc,
            verify=report,
            size=len(json.dumps(doc).encode()),
            packed_size=len(blob),
            sha256=hashlib.sha256(blob).hexdigest(),
        )
    stem = re.sub(r"[^a-z0-9]+", "-", req.meta.name.lower()).strip("-") or "cartridge"
    return Response(
        content=blob,
        media_type="application/gzip",
        headers={
            "content-disposition": f'attachment; filename="{stem}.cart.gz"',
            "x-cartridge-sha256": hashlib.sha256(blob).hexdigest(),
            "x-cartridge-frames": str(report.frames_completed) if report else "0",
            "x-cartridge-frame-cost": str(report.frame_cost or 0) if report else "0",
        },
    )


# -- MCP ---------------------------------------------------------------------
#
# The same engine, for a client that is a language model rather than a program.
# See mcp_server.py for why the tools are coarse where the HTTP routes are
# fine-grained: a model cannot usefully hold 2 KB of hex, so the machine never
# leaves the server on this surface.


def _mcp_console(override: dict | None) -> dict:
    con = ConsoleSpec().model_dump()
    for k, v in (override or {}).items():
        if k not in con:
            raise mcp_server.RpcError(
                mcp_server.BAD_PARAMS,
                f"console has no field {k!r} ({', '.join(sorted(con))})",
            )
        con[k] = mcp_server._addr(v, f"console.{k}") if k in cartridge.CONTRACT or k == "screen" else v
    return {k: v for k, v in con.items() if v is not None}


def _screen_rows(screen: bytes, width: int) -> list[str]:
    """Two hex characters a cell, row major. A model reading this back is the
    difference between writing a 6502 game and guessing at one: the assembler
    says the bytes are legal and only the picture says the program is right."""
    return [screen[y : y + width].hex() for y in range(0, len(screen), width)]


def _tool_assemble(args: dict) -> dict:
    org = mcp_server._addr(args.get("org", 0x0200), "org")
    try:
        res = assemble(args["source"], org)
    except AssemblyError as e:
        return {"ok": False, "error": str(e), "line": e.line}
    return {
        "ok": True, "org": res["org"], "end": res["end"], "size": res["size"],
        "bytes": res["bytes"],
        "labels": {k: f"${v:04X}" for k, v in res["labels"].items()},
        "listing": res["listing"],
    }


def _tool_run(args: dict) -> dict:
    org = mcp_server._addr(args.get("org", 0x0200), "org")
    try:
        res = assemble(args["source"], org)
    except AssemblyError as e:
        return {"ok": False, "error": str(e), "line": e.line}

    given = [k for k in ("half_cycles", "until_pc", "frames") if args.get(k) is not None]
    if len(given) != 1:
        raise mcp_server.RpcError(
            mcp_server.BAD_PARAMS,
            "give exactly one of half_cycles, until_pc or frames, not "
            + (", ".join(given) or "none"),
        )
    watch = list(args.get("watch") or [])
    memory = _overlay(SparseMemory(), res["org"], bytes.fromhex(res["bytes"]))
    lines = ["BOOT", f"VEC {res['org']:04x}", *_memory_lines(memory)]
    if watch:
        lines.append("WATCH " + " ".join(watch))
    boot = _engine(lines)
    m = _machine_from(boot)
    out: dict = {"ok": True, "org": res["org"], "size": res["size"]}

    if args.get("frames") is not None:
        con = _mcp_console(args.get("console"))
        held = mcp_server._addr(args["input"], "input") & 0xFF if args.get("input") else None
        costs, completed = [], 0
        for _ in range(int(args["frames"])):
            if held is not None:
                m = Machine(state=m.state, memory=_poke(m.memory, con["input"], held))
            m, spent, done = _run_frame(m, con, 60000)
            costs.append(spent)
            if not done:
                out["warning"] = (
                    f"frame {completed + 1} never raised the tick flag at "
                    f"${con['tick']:04X}. Does the ROM write it, and does it wait "
                    f"for the host to clear it?"
                )
                break
            completed += 1
        screen = _screen_of(m, con)
        out |= {
            "frames_completed": completed,
            "half_cycles_per_frame": costs,
            "screen": {
                "at": f"${con['screen']:04X}",
                "size": f"{con['width']}x{con['height']}",
                "encoding": "two hex characters a cell, row major",
                "rows": _screen_rows(screen, con["width"]),
                "tiles_used": sorted(set(screen)),
            },
        }
    elif args.get("until_pc") is not None:
        target = mcp_server._addr(args["until_pc"], "until_pc")
        r = _engine([f"RUNTO 200000 {target:04x}", _state_line(m), *_memory_lines(m.memory),
                     *(["WATCH " + " ".join(watch)] if watch else [])])
        m, out["reached"] = _machine_from(r), r["completed"]
        if not r["completed"]:
            out["warning"] = f"never fetched an opcode at ${target:04X} within 200000 half-cycles"
    else:
        n = int(args["half_cycles"])
        r = _engine([f"STEP {n}", _state_line(m), *_memory_lines(m.memory),
                     *(["WATCH " + " ".join(watch)] if watch else [])])
        m = _machine_from(r)

    obs = _engine(["STEP 0", _state_line(m), *_memory_lines(m.memory),
                   *(["WATCH " + " ".join(watch)] if watch else [])])["observe"]
    out["half_cycle"] = m.state.half_cycle
    out["registers"] = {
        "pc": f"${obs['pc']:04X}", "a": f"${obs['a']:02X}", "x": f"${obs['x']:02X}",
        "y": f"${obs['y']:02X}", "s": f"${obs['s']:02X}", "p": f"${obs['p']:02X}",
        "flags": obs["flags"],
    }
    if watch:
        out["watch"] = obs.get("watch")
    reads = args.get("read") or []
    if reads:
        image = m.memory.flat()
        out["read"] = {
            str(spec): image[a : a + n].hex()
            for spec, (a, n) in ((s, mcp_server.parse_read(s)) for s in reads)
        }
    return out


def _tool_mint(args: dict) -> dict:
    tiles = args.get("tiles")
    req = CartridgeRequest(
        rom=Rom(source=args["source"], org=mcp_server._addr(args.get("org", 0x0200), "org")),
        console=ConsoleSpec(**_mcp_console(args.get("console"))),
        tiles=TileArt(pixels=tiles) if tiles else None,
        meta=CartMeta(
            name=args.get("name") or "untitled",
            author=args.get("author"),
            blurb=args.get("blurb"),
        ),
        frames=args.get("frames", 3),
    )
    res = mint(req, format="json")
    blob = cartridge.pack(res.cartridge)
    return {
        "ok": True,
        "verify": res.verify.model_dump() if res.verify else None,
        "notes": res.cartridge["notes"],
        "file": {
            "name": re.sub(r"[^a-z0-9]+", "-", req.meta.name.lower()).strip("-") + ".cart.gz",
            "bytes": len(blob),
            "sha256": res.sha256,
            "base64": mcp_server.b64(blob),
            "how": "write these bytes to the named file; it is gzipped JSON and "
                   "carries the ROM, the tiles and the contract together",
        },
        "play": "https://games.tinymachines.ai/ , which loads a cartridge from "
                "?cart=<url> or from the file picker",
    }


def _tool_atlas(args: dict) -> dict:
    a = _at()
    if args.get("group"):
        return a.group_full(args["group"], members=True, layer="partition")
    if not args.get("node"):
        return a.overview()
    try:
        nid = a.resolve(str(args["node"]))
    except KeyError as e:
        raise mcp_server.RpcError(mcp_server.BAD_PARAMS, str(e)) from e
    out = a.node_full(nid)
    if args.get("neighbors"):
        out["neighbors"] = a.neighbors(nid, via="gate", direction="both", depth=1, limit=40)
    return out


_MCP = mcp_server.make_handler({
    "console_spec": lambda a: console_spec(),
    "assemble": _tool_assemble,
    "run": _tool_run,
    "mint_cartridge": _tool_mint,
    "chip_atlas": _tool_atlas,
})


@app.post("/mcp", include_in_schema=False)
async def mcp_endpoint(request: Request):
    """Streamable HTTP, minus the stream. The spec lets a server answer a POST
    with a plain JSON body when it has nothing to stream, and this one never
    does: every tool is a single errand that either finishes or refuses. No
    session id is issued for the same reason the API keeps no sessions."""
    try:
        body = json.loads(await request.body() or b"null")
    except ValueError as e:
        return JSONResponse(
            mcp_server.error_body(None, mcp_server.RpcError(mcp_server.PARSE, str(e))),
            status_code=400,
        )
    batch = isinstance(body, list)
    msgs = body if batch else [body]
    if batch and not msgs:
        return JSONResponse(
            mcp_server.error_body(None, mcp_server.RpcError(mcp_server.INVALID_REQ, "empty batch")),
            status_code=400,
        )
    out = []
    for msg in msgs:
        mid = msg.get("id") if isinstance(msg, dict) else None
        try:
            res = _MCP(msg)
        except mcp_server.RpcError as e:
            res = mcp_server.error_body(mid, e)
        except HTTPException as e:
            res = mcp_server.error_body(
                mid, mcp_server.RpcError(mcp_server.INTERNAL, str(e.detail))
            )
        if res is not None:
            out.append(res)
    if not out:
        # Every message was a notification. 202 with no body is what the
        # transport asks for, and a client that gets a body here reconnects.
        return Response(status_code=202)
    return JSONResponse(out if batch else out[0])


@app.get("/mcp", include_in_schema=False)
def mcp_no_stream() -> Response:
    """405 is the spec's own answer for a server that offers no SSE stream."""
    return JSONResponse(
        {"error": "this server answers MCP on POST only; it opens no SSE stream"},
        status_code=405,
        headers={"allow": "POST"},
    )



# -- conditional requests -----------------------------------------------------
#
# The registry's listings were `cache-control: no-store` with no validator at
# all, so a client watching for changes re-downloaded everything or showed
# stale data with nothing to say how stale. Neither is necessary: the answer
# only changes when somebody publishes.
#
# The tag is a hash of the body rather than of `updated`, and that is the
# cheaper thing to be right about. A max(updated) tag has to know which rows
# an answer depended on, and gets it wrong the first time a parameter changes
# which rows those are: `?art=none` and `?art=inline` are different bytes from
# the same rows, and would have shared a tag. Hashing what is about to be sent
# cannot disagree with what is sent.
#
# Weak, because that is what this is. A strong tag promises byte equality for
# range requests; this promises the representation is unchanged, which is what
# If-None-Match is asked.

def _etag(payload: object) -> str:
    body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return 'W/"' + hashlib.sha256(body).hexdigest()[:32] + '"'


def _conditional(request: Request, payload: object) -> Response:
    """A 304 when the client already has this, or the payload with its tag.

    max-age=0 with must-revalidate rather than no-store: the client keeps the
    copy and asks whether it is still good, which is the whole point of having
    a validator. no-store told it to keep nothing, which made the tag useless.
    """
    tag = _etag(payload)
    headers = {"ETag": tag, "Cache-Control": "max-age=0, must-revalidate"}

    # If-None-Match is a list, and a proxy may have added the W/ prefix or
    # taken it off. Compare on the opaque part so a weak tag matches itself.
    def bare(t: str) -> str:
        return t.strip().removeprefix("W/").strip()

    seen = [bare(t) for t in (request.headers.get("if-none-match") or "").split(",") if t.strip()]
    if bare(tag) in seen or "*" in seen:
        return Response(status_code=304, headers=headers)
    return JSONResponse(payload, headers=headers)


# -- the registry ------------------------------------------------------------
#
# Builders, their pages, and the cartridges they publish. See registry.py for
# why this is the one stateful thing here and what that does NOT change: the
# chip is still stateless, and running a ROM still means POSTing the machine.


def _reg() -> sqlite3.Connection:
    db = registry.connect()
    registry.init(db)
    return db


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization") or ""
    kind, _, value = header.partition(" ")
    return value.strip() if kind.lower() == "bearer" else None


def _reg_error(e: registry.RegistryError) -> HTTPException:
    return HTTPException(status_code=e.status, detail={"error": str(e)})


def _measure_cartridge(doc: dict, frames: int) -> VerifyReport:
    """Run a published cartridge here rather than believing its own report.

    A cartridge is a file somebody can edit, so the `verify` block it arrives
    with is a claim by its author. Every number the registry prints beside a
    ROM is this function's, which costs a few seconds on publish and means a
    listing cannot be gamed by editing a JSON field.
    """
    return _verify(doc, frames, 60000)


ART = Query("inline", pattern="^(inline|none)$",
            description="`none` replaces every CHR block with a URL, keeping the "
                        "dimensions. A cover is most of a ROM entry's bytes, so a "
                        "listing that cannot decline the art is a listing that cannot "
                        "be paged through.")


@app.get("/v1/registry")
def registry_index(request: Request,
                   limit: int = Query(100, ge=1, le=200), offset: int = Query(0, ge=0),
                   art: str = ART) -> Response:
    """Everyone with a page, and the most recently published ROMs."""
    db = _reg()
    try:
        out = registry.builders(db, limit=limit, offset=offset, art=art)
        out["latest"] = registry.latest(db, art=art)
        out["limits"] = registry.LIMITS
        return _conditional(request, out)
    finally:
        db.close()


@app.get("/v1/registry/roms")
def registry_roms(request: Request,
                  limit: int = Query(100, ge=1, le=200), offset: int = Query(0, ge=0),
                  handle: str | None = Query(None, description="Only this builder's."),
                  since: str | None = Query(None, description="Only those updated after this "
                                                              "ISO 8601 timestamp."),
                  art: str = ART) -> Response:
    """Every cartridge, newest first.

    The index carries a `latest` slice and a per-builder count. Enumerating
    what has actually been published meant walking one document per builder,
    each one dragging that builder's avatar and every one of its covers.
    """
    db = _reg()
    try:
        return _conditional(request, registry.roms(
            db, limit=limit, offset=offset, handle=handle, since=since, art=art))
    finally:
        db.close()


@app.get("/v1/registry/me")
def registry_me(request: Request) -> dict:
    """What this token is: whether it has claimed a handle yet, and which."""
    db = _reg()
    try:
        row = registry.authorise(db, _bearer(request))
        return {
            "handle": row["handle"],
            "claimed": bool(row["handle"]),
            "note": row["note"],
            "created": row["created"],
            "builder": registry.builder(db, row["handle"]) if row["handle"] else None,
        }
    except registry.RegistryError as e:
        raise _reg_error(e) from e
    finally:
        db.close()


@app.post("/v1/registry/claim")
def registry_claim(req: ClaimRequest, request: Request) -> dict:
    """Turn a token into a page. One token, one builder."""
    db = _reg()
    try:
        return registry.claim(db, _bearer(request) or "", req.handle, req.name)
    except registry.RegistryError as e:
        raise _reg_error(e) from e
    finally:
        db.close()


@app.get("/v1/registry/b/{handle}")
def registry_builder(request: Request, handle: str, art: str = ART) -> Response:
    """One builder's page as data: who they are and everything they publish."""
    db = _reg()
    try:
        return _conditional(request, registry.builder(db, handle.lower(), art=art))
    except registry.RegistryError as e:
        raise _reg_error(e) from e
    finally:
        db.close()


@app.get("/v1/registry/b/{handle}/avatar")
def registry_avatar(request: Request, handle: str) -> Response:
    """One builder's avatar, on its own.

    The other half of `art=none`. Same shape it has inline, so a client that
    can already draw a CHR block does not learn a second format.
    """
    db = _reg()
    try:
        return _conditional(request, registry.art_bytes(db, handle.lower()))
    except registry.RegistryError as e:
        raise _reg_error(e) from e
    finally:
        db.close()


@app.get("/v1/registry/b/{handle}/roms/{slug}/cover")
def registry_cover(request: Request, handle: str, slug: str) -> Response:
    """One ROM's cover art, on its own."""
    db = _reg()
    try:
        return _conditional(request, registry.art_bytes(db, handle.lower(), slug.lower()))
    except registry.RegistryError as e:
        raise _reg_error(e) from e
    finally:
        db.close()


@app.patch("/v1/registry/b/{handle}")
def registry_edit(handle: str, patch: BuilderPatch, request: Request) -> dict:
    """Edit a page. Only the fields present are touched, so a client saving a
    bio cannot blank an avatar it never loaded."""
    db = _reg()
    try:
        handle = handle.lower()
        registry.owner_of(db, _bearer(request), handle)
        return registry.update_builder(db, handle, patch.model_dump(exclude_unset=True))
    except registry.RegistryError as e:
        raise _reg_error(e) from e
    finally:
        db.close()


@app.get("/v1/registry/b/{handle}/roms/{slug}")
def registry_rom(handle: str, slug: str) -> dict:
    db = _reg()
    try:
        return registry.rom(db, handle.lower(), slug.lower())
    except registry.RegistryError as e:
        raise _reg_error(e) from e
    finally:
        db.close()


@app.get("/v1/registry/b/{handle}/roms/{slug}/cart")
def registry_cart(handle: str, slug: str) -> Response:
    """The cartridge itself, byte for byte as it was published."""
    db = _reg()
    try:
        blob = registry.rom_bytes(db, handle.lower(), slug.lower())
    except registry.RegistryError as e:
        raise _reg_error(e) from e
    finally:
        db.close()
    return Response(
        content=blob,
        media_type="application/gzip",
        headers={
            "content-disposition": f'attachment; filename="{slug.lower()}.cart.gz"',
            "cache-control": "public, max-age=300",
        },
    )


@app.put("/v1/registry/b/{handle}/roms/{slug}")
def registry_publish(handle: str, slug: str, req: PublishRequest, request: Request) -> dict:
    """Publish a cartridge, or replace one already published under this slug.

    The cartridge is unpacked, RUN here, and stored with what this run
    measured. Nothing a builder writes in the request decides a number.
    """
    db = _reg()
    try:
        handle = handle.lower()
        registry.owner_of(db, _bearer(request), handle)
        try:
            blob = base64.b64decode(req.cart, validate=True)
        except (ValueError, binascii.Error) as e:
            raise registry.RegistryError(f"cart is not base64: {e}") from e
        doc = registry.read_cartridge(blob)
        report = _measure_cartridge(doc, req.frames)
        if report.kind == "console" and report.frames_completed < req.frames:
            raise registry.RegistryError(
                f"that cartridge completed {report.frames_completed} of {req.frames} "
                f"frames on the chip here, so it is not publishable. "
                f"{' '.join(report.notes)}"
            )
        patch = req.model_dump(exclude_unset=True)
        patch.pop("cart", None)
        return registry.publish(db, handle, slug.lower(), blob,
                                report.model_dump(), patch)
    except registry.RegistryError as e:
        raise _reg_error(e) from e
    finally:
        db.close()


@app.delete("/v1/registry/b/{handle}/roms/{slug}")
def registry_unpublish(handle: str, slug: str, request: Request) -> dict:
    db = _reg()
    try:
        handle = handle.lower()
        registry.owner_of(db, _bearer(request), handle)
        return registry.unpublish(db, handle, slug.lower())
    except registry.RegistryError as e:
        raise _reg_error(e) from e
    finally:
        db.close()
