"""The service, proven end to end.

    python3 -m pytest service/test_service.py -q

Needs `target/release/halfwave` built (or HALFWAVE_BIN) and node for the
assembler bridge. The load-bearing test is statelessness: stepping 41
half-cycles in one request must produce byte-identical state and memory to
stepping 20 and then 21, with the machine serialised through the full
Pydantic JSON round trip between them. The known answer it computes is the
programs page's own: $2E + $14 landing at $82 as $42 by half-cycle 41.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
from app import app  # noqa: E402

# The programs page's "Add two bytes", verbatim.
ADD_SOURCE = """        .org $0200
start:  LDA #$2E
        STA $80         ; put 46 somewhere to add from
        LDA #$14
        STA $81         ; and 20 beside it

sum:    CLC             ; the carry in is part of the sum
        LDA $80
        ADC $81
        STA $82         ; $2E + $14 = $42
        JMP start"""

# The same program hand-assembled, duplicated on purpose: deriving the
# expectation from the assembler under test would prove nothing.
ADD_BYTES = bytes(
    [0xA9, 0x2E, 0x85, 0x80, 0xA9, 0x14, 0x85, 0x81,
     0x18, 0xA5, 0x80, 0x65, 0x81, 0x85, 0x82, 0x4C, 0x00, 0x02]
).hex()


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def boot_add(client, **extra):
    r = client.post("/v1/boot", json={"rom": {"source": ADD_SOURCE}, **extra})
    assert r.status_code == 200, r.text
    return r.json()


def test_meta_reports_the_die(client):
    m = client.get("/v1/meta").json()
    assert m["nodes"] == 1725
    assert m["transistors"] == 3510
    assert m["max_step"] > 0


def test_assemble_matches_hand_assembly(client):
    r = client.post("/v1/assemble", json={"source": ADD_SOURCE})
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["org"] == 0x0200
    assert res["bytes"] == ADD_BYTES
    assert res["labels"]["start"] == 0x0200
    assert res["labels"]["sum"] == 0x0208
    lda = next(l for l in res["listing"] if "LDA #$2E" in l["text"])
    assert lda["addr"] == 0x0200 and lda["bytes"] == "a92e"


def test_assembly_error_names_the_line(client):
    r = client.post("/v1/assemble", json={"source": "        LDA #$2E\n        BAD $12"})
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["line"] == 2


def test_boot_arrives_at_the_first_fetch(client):
    res = boot_add(client)
    o = res["observe"]
    assert o["half_cycle"] == 0
    assert o["sync"] is True
    assert o["pc"] == 0x0200
    assert res["assembled"]["bytes"] == ADD_BYTES
    # The rom is in memory where it claimed it would be.
    page2 = res["machine"]["memory"]["pages"]["02"]
    assert page2.startswith(ADD_BYTES)
    # The reset vector points at the org.
    assert res["machine"]["memory"]["pages"]["ff"][0x1F8:0x1FC] == "0002"


def test_the_add_program_computes_42_by_half_cycle_41(client):
    res = boot_add(client)
    r = client.post("/v1/step", json={"machine": res["machine"], "half_cycles": 41})
    assert r.status_code == 200, r.text
    o = r.json()["observe"]
    assert o["half_cycle"] == 41
    assert o["a"] == 0x42
    page0 = bytes.fromhex(r.json()["machine"]["memory"]["pages"]["00"])
    assert page0[0x80:0x83] == bytes([0x2E, 0x14, 0x42])


def test_statelessness_20_plus_21_equals_41(client):
    res = boot_add(client)
    one = client.post("/v1/step", json={"machine": res["machine"], "half_cycles": 41}).json()
    a = client.post("/v1/step", json={"machine": res["machine"], "half_cycles": 20}).json()
    # The machine goes through a full JSON round trip between the two hops.
    b = client.post("/v1/step", json={"machine": a["machine"], "half_cycles": 21}).json()
    assert b["machine"] == one["machine"], "resumed run diverged from the straight one"
    assert b["observe"] == one["observe"]


def test_until_instruction_stops_on_sync(client):
    res = boot_add(client)
    r = client.post(
        "/v1/step", json={"machine": res["machine"], "until": "instruction"}
    ).json()
    assert r["completed"] is True
    assert r["observe"]["sync"] is True
    assert r["observe"]["clk0"] is False
    # LDA immediate is 2 cycles: the next fetch is 4 half-cycles on.
    assert r["stepped"] == 4


def test_a_jam_never_reaches_another_fetch(client):
    r = client.post("/v1/boot", json={"rom": {"source": "        .org $0200\n        .byte $02"}})
    res = r.json()
    r = client.post(
        "/v1/step",
        json={"machine": res["machine"], "until": "instruction", "max_half_cycles": 60},
    ).json()
    assert r["completed"] is False
    assert r["stepped"] == 60


def test_watch_reads_named_nodes_and_refuses_typos(client):
    res = boot_add(client, watch=["sync", "cclk", "sb0"])
    assert set(res["observe"]["watch"]) == {"sync", "cclk", "sb0"}
    r = client.post(
        "/v1/step",
        json={"machine": res["machine"], "half_cycles": 2, "watch": ["nosuchnode"]},
    )
    assert r.status_code == 400
    assert "nosuchnode" in r.json()["detail"]


def test_trace_is_one_observation_per_half_cycle(client):
    res = boot_add(client)
    r = client.post(
        "/v1/step",
        json={"machine": res["machine"], "half_cycles": 10, "trace": True, "watch": ["sync"]},
    ).json()
    assert len(r["trace"]) == 10
    assert [t["half_cycle"] for t in r["trace"]] == list(range(1, 11))
    # The clock alternates: that is what a half-cycle is.
    assert [t["clk0"] for t in r["trace"]] == [True, False] * 5
    assert all("sync" in t["watch"] for t in r["trace"])


def test_the_model_boundary_refuses_a_corrupt_state(client):
    res = boot_add(client)
    m = res["machine"]
    m["state"]["value"] = m["state"]["value"][:-2]  # truncated blob
    r = client.post("/v1/step", json={"machine": m, "half_cycles": 1})
    assert r.status_code == 422


def test_step_wants_exactly_one_of_count_or_until(client):
    res = boot_add(client)
    r = client.post("/v1/step", json={"machine": res["machine"]})
    assert r.status_code == 422
    r = client.post(
        "/v1/step",
        json={"machine": res["machine"], "half_cycles": 2, "until": "instruction"},
    )
    assert r.status_code == 422


def test_the_api_page_documents_what_the_service_does(client):
    """The reference page is held to the app, not trusted: it must name
    every route the app actually serves, and every number it states about
    the engine and the wire format must be the real one. A docs page that
    can drift is the prose failure this project keeps finding."""
    r = client.get("/")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    page = r.text

    # Every route the app serves is named on the page.
    from fastapi.routing import APIRoute
    for route in app.routes:
        if isinstance(route, APIRoute) and route.path != "/":
            assert route.path in page, f"page does not mention {route.path}"

    # The stated numbers are the measured ones.
    meta = client.get("/v1/meta").json()
    assert str(meta["max_step"]) in page
    assert str(meta["max_traced"]) in page
    assert str(meta["nodes"]) in page
    assert str(meta["transistors"]) in page
    from models import HEX_NODE_CHARS, HEX_TRANS_CHARS
    assert f"{HEX_NODE_CHARS} hex chars" in page
    assert f"{HEX_TRANS_CHARS} hex chars" in page

    # House style: no em dashes in anything shipped.
    assert "\u2014" not in page


def test_memory_stays_sparse_and_fill_is_honoured(client):
    # A fill of $EA (NOP) and no rom: the chip executes NOPs from wherever
    # the fill's reset vector sends it ($EAEA), and no page ever differs
    # from the fill except the stack the interrupt-free NOP run never grows.
    r = client.post("/v1/boot", json={"memory": {"fill": "ea"}})
    res = r.json()
    assert res["machine"]["memory"]["fill"] == "ea"
    assert res["machine"]["memory"]["pages"] == {}
    r2 = client.post("/v1/step", json={"machine": res["machine"], "half_cycles": 20}).json()
    o = r2["observe"]
    assert o["ir"] == 0xEA, "the chip is executing the fill byte"
