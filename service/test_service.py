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


def test_the_demo_sections_claims_are_measurements(client):
    """The api page's "what to run first" section states what a reader will
    see in their trace: SUMS held high throughout, SBAC pulsing at the
    writeback, A snapping $2E to $42 one half-cycle after the next fetch is
    already underway. Prose is the part of a page most likely to go quietly
    wrong, so every one of those claims is re-run here on the page's exact
    recipe, and the half-cycle number the page prints is derived, not
    trusted. This test exists because the section first shipped pointing at
    SUMS as the line to watch, and a reader measured it high in every
    half-cycle of their run: a claim written from memory instead of from a
    trace."""
    res = boot_add(client)
    r = client.post(
        "/v1/step",
        json={"machine": res["machine"], "half_cycles": 45, "trace": True,
              "watch": ["dpc17_SUMS", "dpc23_SBAC"]},
    ).json()
    trace = r["trace"]

    # SUMS is held: high in every one of the 45 half-cycles.
    assert all(t["watch"]["dpc17_SUMS"] for t in trace)

    # The writeback: the first half-cycle where A reads $42.
    wb = next(t["half_cycle"] for t in trace if t["a"] == 0x42)
    by_h = {t["half_cycle"]: t for t in trace}
    assert by_h[wb]["watch"]["dpc23_SBAC"], "SBAC fires on the writeback"
    assert by_h[wb - 1]["a"] == 0x2E, "A still old the half-cycle before"
    # The homeless sum, on screen: the half-cycle before the writeback, the
    # adder's hold register and the special bus both read $42 while A does
    # not. This is the observation the alu/sb fields exist for. One earlier,
    # the operands themselves sit in the adder's input latches, and the
    # input data latch already holds the NEXT opcode by the time the sum is
    # real: the add happens after the instruction is over, field by field.
    assert by_h[wb - 1]["alu"] == 0x42 and by_h[wb - 1]["sb"] == 0x42
    assert by_h[wb - 2]["alua"] == 0x2E and by_h[wb - 2]["alub"] == 0x14
    assert by_h[wb - 1]["idl"] == 0x85, "the next opcode, already latched"
    # ADC is already over: the fetch before the writeback is the NEXT
    # instruction's (STA, $85), with A still reading the operand's old value.
    assert by_h[wb - 2]["sync"] and by_h[wb - 2]["fetch"]["opcode"] == 0x85
    assert by_h[wb - 2]["a"] == 0x2E

    # The page prints the numbers this run produced, not remembered ones.
    page = client.get("/").text
    assert f"h={wb}" in page, "page names the measured writeback half-cycle"
    assert f"h={wb - 1}" in page, "page names the homeless-sum half-cycle"
    assert f"h={wb - 2}" in page, "page names the next instruction's fetch"
    assert "dpc23_SBAC" in page and "dpc17_SUMS" in page
    assert "$2E" in page and "$42" in page


def test_nodes_lists_every_resolvable_name(client):
    """846 raw entries in the die's name table, 12 duplicate keys, 2 bit-5
    sentinels: 832 resolve, and every one of them is watchable. The groups
    partition the count (nothing dropped, nothing double-filed), and a name
    picked from the response works as a watch, which is the discoverability
    the route exists for."""
    r = client.get("/v1/nodes")
    assert r.status_code == 200
    res = r.json()
    assert res["count"] == 832
    total = sum(len(g) for g in res["groups"].values())
    assert total == res["count"], "groups partition the count"
    assert "sync" in res["groups"]["pins"]
    # The dpc* lines are decode's outputs but the datapath's controls, and
    # they are filed by what they operate: a learner hunting the datapath
    # finds them, and the count is the measured one.
    assert "dpc23_SBAC" in res["groups"]["datapath"]
    assert len(res["groups"]["datapath"]) == 49
    assert all(n.startswith("dpc") for n in res["groups"]["datapath"])
    assert "op-T0-lda" in res["groups"]["decode"]
    assert "sb0" in res["groups"]["buses"]
    assert "vcc" in res["groups"]["rails"]
    assert "49" in client.get("/").text, "page states the datapath group's count"
    # A name discovered here is accepted by watch.
    name = sorted(res["groups"]["decode"])[0]
    boot = boot_add(client, watch=[name])
    assert name in boot["observe"]["watch"]
    # And the page states the measured count.
    assert str(res["count"]) in client.get("/").text


def test_until_pc_is_a_breakpoint(client):
    res = boot_add(client)
    # The `sum` label assembles at $0208; run to its fetch.
    assert res["assembled"]["labels"]["sum"] == 0x0208
    r = client.post(
        "/v1/step",
        json={"machine": res["machine"], "until_pc": 0x0208},
    ).json()
    assert r["completed"] is True
    assert r["observe"]["pc"] == 0x0208
    assert r["observe"]["sync"] is True
    assert r["observe"]["fetch"]["addr"] == 0x0208
    # An address the program never fetches: the bound answers honestly.
    r = client.post(
        "/v1/step",
        json={"machine": res["machine"], "until_pc": 0x1234, "max_half_cycles": 60},
    ).json()
    assert r["completed"] is False
    assert r["stepped"] == 60


def test_until_cycle_is_two_half_cycles(client):
    res = boot_add(client)
    r = client.post("/v1/step", json={"machine": res["machine"], "until": "cycle"}).json()
    assert r["stepped"] == 2
    assert r["observe"]["half_cycle"] == 2


def test_rows_trace_carries_the_same_information(client):
    """The rows form must agree with the object form column for column on
    the same run: same machine in, so the trace is deterministic and the
    two encodings are two readings of one thing."""
    res = boot_add(client)
    objs = client.post(
        "/v1/step",
        json={"machine": res["machine"], "half_cycles": 10, "trace": True,
              "watch": ["sync", "dpc23_SBAC"]},
    ).json()
    rows = client.post(
        "/v1/step",
        json={"machine": res["machine"], "half_cycles": 10, "trace": True,
              "watch": ["sync", "dpc23_SBAC"], "format": "rows"},
    ).json()
    assert rows["trace"] is None and rows["trace_rows"] is not None
    tr = rows["trace_rows"]
    assert tr["watch_names"] == ["sync", "dpc23_SBAC"]
    assert tr["watch_encoding"] == "hex"
    assert len(tr["rows"]) == 10
    cols = tr["cols"]
    for o, row in zip(objs["trace"], tr["rows"]):
        r = dict(zip(cols, row))
        assert r["half_cycle"] == o["half_cycle"]
        assert r["a"] == o["a"] and r["pc"] == o["pc"] and r["alu"] == o["alu"]
        assert r["clk0"] == int(o["clk0"])
        assert r["rw"] == (0 if o["rw"] == "read" else 1)
        wbyte = int(r["watch"], 16) if r["watch"] else 0
        assert (wbyte & 1 != 0) == o["watch"]["sync"]
        assert (wbyte & 2 != 0) == o["watch"]["dpc23_SBAC"]
        # The tstates bitmask decodes to the same set the string names.
        names = set(o["tstates"].split("+")) - {""}
        got = {f"T{i}" for i in range(6) if r["tstates"] >> i & 1}
        assert got == names
    # The point of the format, held to the page's own measured claim: the
    # page says 3.7x on the 45-half-cycle shape, re-measured below. This
    # short 10-row trace amortises the cols header badly and only clears
    # about 3x, which is why the band is asserted on the page's shape and
    # this line asks merely for "much smaller".
    import json as _json
    assert len(_json.dumps(tr)) < len(_json.dumps(objs["trace"])) / 2.5
    o45 = client.post(
        "/v1/step",
        json={"machine": res["machine"], "half_cycles": 45, "trace": True,
              "watch": ["sync", "dpc23_SBAC"]},
    ).json()
    r45 = client.post(
        "/v1/step",
        json={"machine": res["machine"], "half_cycles": 45, "trace": True,
              "watch": ["sync", "dpc23_SBAC"], "format": "rows"},
    ).json()
    ratio = len(_json.dumps(o45["trace"])) / len(_json.dumps(r45["trace_rows"]))
    assert 3.2 < ratio < 4.2, f"page claims 3.7x on this shape; measured {ratio:.1f}x"
    page = client.get("/").text
    assert "3.7x" in page and "7.5x" in page


def test_latch_fields_agree_with_their_own_bits(client):
    """Findings issue 03: the named latches are first-class fields so a
    consumer stops rebuilding each byte from 8 watched bits. The check
    that keeps that honest: every promoted field must equal the byte
    rebuilt from watching its own bits, on every half-cycle of a run, or
    the promotion changed the meaning while claiming convenience."""
    stems = ["alua", "alub", "idb", "idl", "dor", "abl", "abh", "pclp", "pchp"]
    names = [f"{s}{i}" for s in stems for i in range(8)]
    res = boot_add(client)
    r = client.post(
        "/v1/step",
        json={"machine": res["machine"], "half_cycles": 30, "trace": True,
              "watch": names},
    ).json()
    for t in r["trace"]:
        for si, stem in enumerate(stems):
            rebuilt = sum(t["watch"][f"{stem}{i}"] << i for i in range(8))
            assert t[stem] == rebuilt, f"{stem} at h={t['half_cycle']}"


def test_watch_survives_past_53_names(client):
    """The findings' precision bug, made a regression: a JSON integer is a
    float64 to every browser, so an integer watch mask silently corrupts
    past 53 names. watch is a hex bitset now (bit i in byte i/8, LSB
    first, the state blobs' own convention), and this test watches 64
    names, requires at least one row's mask to exceed 2^53 so the
    regression is actually exercised, and checks every bit of every row
    against the object form."""
    names = [f"{stem}{i}" for stem in
             ("idb", "idl", "dor", "alua", "alub", "pclp", "pchp", "abl")
             for i in range(8)]
    res = boot_add(client)
    objs = client.post(
        "/v1/step",
        json={"machine": res["machine"], "half_cycles": 40, "trace": True,
              "watch": names},
    ).json()
    rows = client.post(
        "/v1/step",
        json={"machine": res["machine"], "half_cycles": 40, "trace": True,
              "watch": names, "format": "rows"},
    ).json()
    tr = rows["trace_rows"]
    wi = tr["cols"].index("watch")
    assert all(len(row[wi]) == 16 for row in tr["rows"]), "8 bytes, fixed width"
    masks = [int.from_bytes(bytes.fromhex(row[wi]), "little") for row in tr["rows"]]
    assert any(m > 2**53 for m in masks), "the trace must exercise the float64 ceiling"
    for o, m in zip(objs["trace"], masks):
        for i, name in enumerate(names):
            assert bool(m >> i & 1) == o["watch"][name], f"bit {i} ({name})"


def test_cors_is_open_for_any_origin(client):
    r = client.options(
        "/v1/step",
        headers={"Origin": "https://example.org",
                 "Access-Control-Request-Method": "POST",
                 "Access-Control-Request-Headers": "content-type"},
    )
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "*"


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
