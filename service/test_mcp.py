"""The MCP surface: the transport, and the one tool that makes it worth having.

    python3 -m pytest service/test_mcp.py -q

Two kinds of check here. The transport ones are cheap and pin the protocol:
version negotiation, a notification getting no body, an unknown method
getting -32601, a batch coming back as a batch. The one that matters is
`run`: it has to reproduce this project's own witness ($2E + $14 landing at
$0082 as $42 by half-cycle 41, the number the programs page and the service
suite both use), and it has to hand back a screen a model can read, with the
drawn cell moving when the controller byte moves. A screen that came back
looking plausible but did not answer the input would be the exact failure
this surface exists to prevent.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mcp_server  # noqa: E402
from app import app  # noqa: E402

ADD = """        .org $0200
start:  LDA #$2E
        STA $80
        LDA #$14
        STA $81
sum:    CLC
        LDA $80
        ADC $81
        STA $82
        JMP start"""

TINY = """        .org $0200
reset   LDX #$00
clear   LDA #$00
        STA $0500,X
        INX
        BNE clear
        LDA $02
        AND #$0F
        TAX
        LDA #$02
        STA $0500,X
        LDA #$01
        STA $0D
wait    LDA $0D
        BNE wait
        JMP reset"""


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def rpc(client, method, params=None, mid=1):
    msg = {"jsonrpc": "2.0", "method": method}
    if mid is not None:
        msg["id"] = mid
    if params is not None:
        msg["params"] = params
    return client.post("/mcp", json=msg)


def call(client, name, args=None, mid=9):
    r = rpc(client, "tools/call", {"name": name, "arguments": args or {}}, mid)
    assert r.status_code == 200, r.text
    res = r.json()["result"]
    text = res["content"][0]["text"]
    # A refusal is plain text, not JSON: the model reads the reason.
    return res, (text if res["isError"] else json.loads(text))


# -- the transport -----------------------------------------------------------

def test_initialize_negotiates_a_version_it_speaks(client):
    for want in mcp_server.SUPPORTED:
        got = rpc(client, "initialize", {"protocolVersion": want, "capabilities": {},
                                         "clientInfo": {"name": "t", "version": "0"}})
        assert got.json()["result"]["protocolVersion"] == want
    # An unknown revision gets our newest, which is what the spec asks for.
    got = rpc(client, "initialize", {"protocolVersion": "1999-01-01", "capabilities": {}})
    r = got.json()["result"]
    assert r["protocolVersion"] == mcp_server.LATEST
    assert r["capabilities"]["tools"] == {"listChanged": False}
    assert r["serverInfo"]["name"] and r["instructions"]


def test_a_notification_gets_no_body(client):
    r = client.post("/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"})
    assert r.status_code == 202
    assert r.content == b""


def test_an_unknown_method_is_a_protocol_error(client):
    r = rpc(client, "tools/wat")
    assert r.json()["error"]["code"] == mcp_server.NO_METHOD


def test_a_batch_comes_back_as_a_batch(client):
    r = client.post("/mcp", json=[
        {"jsonrpc": "2.0", "id": 1, "method": "ping"},
        {"jsonrpc": "2.0", "method": "notifications/cancelled"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    ])
    body = r.json()
    assert isinstance(body, list) and len(body) == 2, "the notification should get no reply"
    assert [m["id"] for m in body] == [1, 2]


def test_there_is_no_stream_and_it_says_so(client):
    r = client.get("/mcp")
    assert r.status_code == 405 and r.headers["allow"] == "POST"


def test_every_tool_is_listed_with_a_schema(client):
    tools = rpc(client, "tools/list", mid=2).json()["result"]["tools"]
    assert {t["name"] for t in tools} == {
        "console_spec", "assemble", "run", "mint_cartridge", "chip_atlas"}
    for t in tools:
        assert t["description"] and t["inputSchema"]["type"] == "object"


# -- the tools ---------------------------------------------------------------

def test_run_reproduces_the_projects_own_witness(client):
    """$2E + $14 = $42 at $0082 by half-cycle 41: the number the programs
    page, the api page and the service suite all state. Nothing here consults
    an instruction table, so agreeing is evidence."""
    res, out = call(client, "run", {"source": ADD, "half_cycles": 41,
                                    "read": ["0082"], "watch": ["sync"]})
    assert res["isError"] is False
    assert out["read"]["0082"] == "42"
    assert out["registers"]["a"] == "$42"
    assert "sync" in out["watch"]


def test_a_breakpoint_stops_at_the_fetch(client):
    """$020B is the ADC, and it is an instruction boundary. $020A is not: it
    is the operand byte of the LDA before it, and asking to break there is
    asking for a fetch that never happens. Both answers are here, because a
    breakpoint that reported success on an address the chip never fetches
    would be worse than one that never fired."""
    _, out = call(client, "run", {"source": ADD, "until_pc": "$020B"})
    assert out["reached"] is True
    assert out["registers"]["pc"] == "$020B", out["registers"]


def test_a_breakpoint_in_the_middle_of_an_instruction_says_so(client):
    _, out = call(client, "run", {"source": ADD, "until_pc": "$020A"})
    assert out["reached"] is False
    assert "never fetched an opcode at $020A" in out["warning"]


def test_the_screen_is_what_the_rom_drew_and_answers_the_controller(client):
    """The one that earns the surface. A model reading its own picture back
    is the difference between writing a 6502 game and guessing at one, so the
    picture has to be the chip's and not a plausible grid: the drawn cell
    moves with the controller byte."""
    seen = {}
    for held in ("03", "0b"):
        _, out = call(client, "run", {"source": TINY, "frames": 2, "input": held})
        assert out["frames_completed"] == 2
        rows = out["screen"]["rows"]
        assert len(rows) == 16 and all(len(r) == 32 for r in rows)
        cells = [rows[0][i:i + 2] for i in range(0, 32, 2)]
        seen[held] = [i for i, c in enumerate(cells) if c != "00"]
    assert seen["03"] == [3] and seen["0b"] == [11], seen


def test_a_tool_that_refuses_is_a_result_not_a_protocol_error(client):
    """The model has to be able to read why and try again. A JSON-RPC error
    is for the client, and most clients will not show it to the model at all."""
    res, out = call(client, "assemble", {"source": "        LDA #$ZZ"})
    assert res["isError"] is False, "assembly failures are answers, not crashes"
    assert out["ok"] is False and out["line"] == 1

    r = rpc(client, "tools/call", {"name": "run", "arguments": {"source": ADD}})
    res = r.json()["error"]
    assert res["code"] == mcp_server.BAD_PARAMS
    assert "exactly one of" in res["message"]


def test_an_address_can_be_written_either_way(client):
    """A model writes $0500 and a program writes 1280. Neither should have to
    learn the other's spelling."""
    assert mcp_server._addr("$0500") == mcp_server._addr("0500") == mcp_server._addr(1280)
    assert mcp_server.parse_read("0500:100") == (0x0500, 0x100)
    assert mcp_server.parse_read("82") == (0x82, 1)
    with pytest.raises(mcp_server.RpcError):
        mcp_server._addr("nope")


def test_mint_returns_a_file_and_its_verification(client):
    _, out = call(client, "mint_cartridge", {
        "source": TINY, "name": "Probe", "frames": 2,
        "tiles": [["00000000"] * 8, ["33333333"] * 8, ["01230123"] * 8]})
    assert out["ok"] and out["verify"]["frames_completed"] == 2
    assert out["file"]["name"] == "probe.cart.gz"
    import base64
    import cartridge
    doc = cartridge.unpack(base64.b64decode(out["file"]["base64"]))
    assert doc["tiles"]["count"] == 3
    assert doc["rom"]["source"] == TINY


def test_a_layout_that_cannot_work_refuses_here_too(client):
    res, text = call(client, "mint_cartridge",
                     {"source": TINY, "console": {"screen": "$0200"}})
    assert res["isError"] is True
    assert "own screen" in text, text


def test_the_atlas_answers_what_a_wire_is_part_of(client):
    res, out = call(client, "chip_atlas", {"node": "dpc23_SBAC", "neighbors": True})
    assert res["isError"] is False
    # One group owns it and others may claim it: the partition and the
    # overlapping containers are two different readings, kept apart.
    assert out["owner"] and out["groups"]
    assert out["neighbors"]["count"] >= 1
    _, over = call(client, "chip_atlas", {})
    assert over["counts"]["groups"] == 132 and over["counts"]["nodes"] == 1547
    assert len(over["kinds"]) == over["counts"]["kinds"] == 23


def test_console_spec_is_what_a_rom_has_to_agree_with(client):
    _, out = call(client, "console_spec")
    assert out["contract"]["addresses"]["tick"]
    assert out["defaults"]["tick"] == 0x000D
    assert out["tiles"]["bytes_per_tile"] == 16
    # The example it publishes has to be a cartridge, not prose about one.
    _, ran = call(client, "run", {"source": out["example"]["source"], "frames": 1})
    assert ran["frames_completed"] == 1
