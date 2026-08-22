"""MCP over the same stateless engine: five tools, each one a whole errand.

    POST /api/mcp        (streamable HTTP, no session, no SSE)

The HTTP API is stateless because a *program* holds the machine: 2 KB of hex
travels out and back, and the client's copy is the session. An MCP client is a
language model, and a model cannot usefully hold 2 KB of hex -- pasting a
machine back into the next tool call would spend most of a context window
carrying a value it cannot read. So the tools here are coarse where the HTTP
routes are fine-grained: `run` assembles, boots, steps and reports in one call,
and the machine never leaves the server. That is not a different design, it is
the same design serving a different kind of client.

The five:

    console_spec     what a ROM has to agree with. Read this first
    assemble         source -> bytes, labels, listing; errors carry a line
    run              source -> what the chip did: registers, memory, the screen
    mint_cartridge   source + tiles -> a verified cartridge, as one file
    chip_atlas       what a wire is part of, and what it reaches

`run` renders the screen as rows of hex so a model can SEE what its ROM drew.
That is the one thing that turns writing a 6502 game from guessing into
working: an assembler says the bytes are legal, and only the picture says the
program is right.

The transport is hand-written JSON-RPC rather than an SDK, for the reason the
engine parses a line protocol rather than JSON: `initialize`, `tools/list` and
`tools/call` over one POST is forty lines with nothing in it to be wrong
about, and this service's whole promise is that it has no dependencies to go
stale underneath it.
"""

from __future__ import annotations

import base64
import json
from typing import Any, Callable

SERVER = {"name": "6502-as-a-service", "title": "6502 as a service", "version": "1.0.0"}

# Revisions of the MCP spec this speaks. A client asking for one of these gets
# it back; anything else gets our newest, which is what the spec says to do.
SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"]
LATEST = SUPPORTED[0]

INSTRUCTIONS = """A transistor-level MOS 6502 over HTTP: every call settles 3510
real switches on a die photographed out of a physical chip. Nothing here models
6502 behaviour, so a cycle count is emergent and a register is read back out of
its own storage nodes.

To write a game: call console_spec first (it publishes the contract, the memory
map, the tile format and a worked example), write 6502 assembly, call run with
`frames` to see the screen your ROM drew, then mint_cartridge to get one
playable file. run's screen is two hex characters per cell, row major, so you
can read your own picture back and fix it.

Errors are refusals with reasons, never guesses: assembly failures carry a line
number, and a cartridge whose ROM overlaps its own screen is refused rather
than minted into a game that draws over itself."""


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: Any = None):
        super().__init__(message)
        self.code, self.message, self.data = code, message, data


PARSE, INVALID_REQ, NO_METHOD, BAD_PARAMS, INTERNAL = -32700, -32600, -32601, -32602, -32603


def _addr(v: Any, what: str = "address") -> int:
    """Hex with or without a $, or a plain integer. A model writes $0500 and a
    program writes 1280; both mean the same page and neither should have to
    learn the other's spelling."""
    if isinstance(v, int):
        n = v
    else:
        s = str(v).strip().lstrip("$").lstrip("#")
        s = s[2:] if s[:2].lower() == "0x" else s
        try:
            n = int(s, 16)
        except ValueError as e:
            raise RpcError(BAD_PARAMS, f"{what} {v!r} is not a hex address") from e
    if not 0 <= n <= 0xFFFF:
        raise RpcError(BAD_PARAMS, f"{what} ${n:X} is outside 16 bits")
    return n


def parse_read(spec: str) -> tuple[int, int]:
    """"0082" is one byte, "0500:100" is $100 bytes from $0500."""
    text = str(spec)
    addr, _, length = text.partition(":")
    n = 1
    if length:
        try:
            n = int(length.strip().lstrip("$"), 16)
        except ValueError as e:
            raise RpcError(BAD_PARAMS, f"{text!r}: {length!r} is not a hex length") from e
    if not 1 <= n <= 4096:
        raise RpcError(BAD_PARAMS, f"{text!r}: read 1 to 4096 bytes, not {n}")
    return _addr(addr, f"the address in {text!r}"), n


TOOLS: list[dict] = [
    {
        "name": "console_spec",
        "title": "The console contract",
        "description": (
            "What a ROM has to agree with to be playable on this chip: the tick "
            "handshake, the controller byte, where the screen is, the memory map, "
            "the 8x8 two-bit tile format, the four-colour palette, and a worked "
            "example ROM. There is no video hardware on this die and no interrupt "
            "in use, so a frame is an agreement rather than something the silicon "
            "knows about. Read this before writing a cartridge."
        ),
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "assemble",
        "title": "Assemble 6502 source",
        "description": (
            "Assemble 6502 assembly to bytes. Returns the bytes as hex, the size, "
            "every label with its address, and a listing line by line. An error "
            "carries the line number. This is the site's own assembler, which "
            "inverts its disassembler's table, so anything that assembles "
            "disassembles back to the same instruction."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "source": {"type": "string", "description": "6502 assembly. Labels in "
                           "column one, .org and .byte supported."},
                "org": {"type": "string", "description": "where it loads, hex. Default $0200."},
            },
            "required": ["source"],
            "additionalProperties": False,
        },
    },
    {
        "name": "run",
        "title": "Run a program on the die",
        "description": (
            "Assemble a program, power-cycle the chip through its real reset "
            "sequence, run it, and report what happened. Give exactly one of "
            "`half_cycles` (the fundamental unit: the chip does work on both clock "
            "edges), `until_pc` (a breakpoint at an opcode fetch), or `frames` (run "
            "the console's tick handshake N times and read the screen back). "
            "`read` pulls memory out afterwards; `screen` renders the display as "
            "two hex characters a cell, row major, so you can see what your ROM "
            "actually drew."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "source": {"type": "string"},
                "org": {"type": "string", "description": "hex, default $0200"},
                "half_cycles": {"type": "integer", "minimum": 1, "maximum": 200000},
                "until_pc": {"type": "string", "description": "hex address to break at"},
                "frames": {"type": "integer", "minimum": 1, "maximum": 16,
                           "description": "run the console contract this many frames"},
                "console": {"type": "object", "description": "override the console "
                            "addresses (tick, input, screen, width, height); see "
                            "console_spec for the defaults"},
                "input": {"type": "string", "description": "the controller byte to hold "
                          "down, hex. Only with frames."},
                "read": {"type": "array", "items": {"type": "string"},
                         "description": 'memory to read back: "0082" is one byte, '
                                        '"0500:100" is $100 bytes from $0500'},
                "watch": {"type": "array", "items": {"type": "string"},
                          "description": "named wires on the die to report the level of, "
                                         "e.g. sync, sb0, dpc23_SBAC"},
            },
            "required": ["source"],
            "additionalProperties": False,
        },
    },
    {
        "name": "mint_cartridge",
        "title": "Mint a playable cartridge",
        "description": (
            "Assemble a ROM, check its layout can work, run it on the chip, and "
            "pack the ROM, its tiles and the contract it was written to into one "
            "gzipped file. Returns the verification report and the file as base64. "
            "Tiles are eight strings of eight '0'..'3' per tile, one character a "
            "pixel. A layout that cannot work is refused with the reason: a ROM "
            "that reaches its own screen assembles perfectly and then draws over "
            "itself."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "source": {"type": "string"},
                "org": {"type": "string", "description": "hex, default $0200"},
                "name": {"type": "string"},
                "author": {"type": "string"},
                "blurb": {"type": "string"},
                "console": {"type": "object"},
                "tiles": {
                    "type": "array",
                    "description": "each tile is 8 strings of 8 characters from '0123'",
                    "items": {"type": "array", "items": {"type": "string"}},
                },
                "frames": {"type": "integer", "minimum": 0, "maximum": 16},
            },
            "required": ["source"],
            "additionalProperties": False,
        },
    },
    {
        "name": "chip_atlas",
        "title": "What a wire is part of",
        "description": (
            "Ask the die about one of its 1725 nodes: which derived container owns "
            "it (the ALU's bit 3 slice, the clock generator, the decimal correction), "
            "every overlapping container that also claims it, and what it reaches. "
            "132 groups cover every node exactly once. Give a node name or number; "
            "with no argument you get the list of kinds."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "node": {"type": "string", "description": "a die name (sb0, dpc23_SBAC) "
                         "or a node number"},
                "neighbors": {"type": "boolean", "description": "include what it drives, "
                              "what drives it, and its pass-transistor channels"},
                "group": {"type": "string", "description": "a group key such as alu:bit3 "
                          "or clock:gen, to list its members instead"},
            },
            "additionalProperties": False,
        },
    },
]


def make_handler(impls: dict[str, Callable[[dict], Any]]) -> Callable[[Any], Any]:
    """One JSON-RPC message in, one response out (or None for a notification).

    Batches are handled by the caller, which is the only part of the transport
    that needs to know a batch from a message.
    """
    names = {t["name"] for t in TOOLS}
    missing = names - set(impls)
    assert not missing, f"tools with no implementation: {sorted(missing)}"

    def call_tool(params: dict) -> dict:
        name = params.get("name")
        if name not in impls:
            raise RpcError(BAD_PARAMS, f"no tool named {name!r}")
        args = params.get("arguments") or {}
        if not isinstance(args, dict):
            raise RpcError(BAD_PARAMS, "arguments must be an object")
        try:
            result = impls[name](args)
        except RpcError:
            raise
        except Exception as e:  # noqa: BLE001
            # A tool that refuses is a normal result with isError, not a
            # protocol error: the model has to be able to read the reason and
            # try again, and a JSON-RPC error is for the client, not the model.
            return {
                "content": [{"type": "text", "text": f"{type(e).__name__}: {e}"}],
                "isError": True,
            }
        text = result if isinstance(result, str) else json.dumps(result, indent=1)
        return {"content": [{"type": "text", "text": text}], "isError": False}

    def handle(msg: Any) -> dict | None:
        if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
            raise RpcError(INVALID_REQ, "not a JSON-RPC 2.0 message")
        method, mid = msg.get("method"), msg.get("id")
        params = msg.get("params") or {}
        if method is None:
            raise RpcError(INVALID_REQ, "no method")

        if method.startswith("notifications/"):
            return None  # nothing to acknowledge; the spec wants no body
        if method == "initialize":
            want = params.get("protocolVersion")
            result = {
                "protocolVersion": want if want in SUPPORTED else LATEST,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": SERVER,
                "instructions": INSTRUCTIONS,
            }
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": TOOLS}
        elif method == "tools/call":
            result = call_tool(params)
        else:
            raise RpcError(NO_METHOD, f"method {method!r} is not implemented")

        if mid is None:
            return None
        return {"jsonrpc": "2.0", "id": mid, "result": result}

    return handle


def error_body(mid: Any, e: RpcError) -> dict:
    body: dict = {"jsonrpc": "2.0", "id": mid, "error": {"code": e.code, "message": e.message}}
    if e.data is not None:
        body["error"]["data"] = e.data
    return body


def b64(blob: bytes) -> str:
    return base64.b64encode(blob).decode("ascii")
