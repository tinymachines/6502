"""The chip atlas, proven against its own file and against the site's figures.

    python3 -m pytest service/test_atlas.py -q

Needs `web/groups.json` and `web/graph.json`:

    cargo run -p v6502-netlist --bin export-graph -- web/graph.json
    node tools/export-groups.mjs

Nothing here runs the chip. What is being tested is that the API serves the
same derivation the tracer and the chip map draw -- so the numbers pinned
below are the published ones from those pages, not numbers taken from the
served response and written back down. A test that reads a count out of the
response and asserts the response contains it proves nothing.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
from app import app  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
GROUPS_FILE = ROOT / "web" / "groups.json"

pytestmark = pytest.mark.skipif(
    not GROUPS_FILE.exists(),
    reason="web/groups.json is not built; run node tools/export-groups.mjs",
)


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def onfile():
    return json.loads(GROUPS_FILE.read_text())


# ---------------------------------------------------------------------------
# The catalogue, against the chip map's own published figures
# ---------------------------------------------------------------------------


def test_the_atlas_reports_the_chip_maps_own_measurements(client):
    c = client.get("/v1/atlas").json()["counts"]
    # Every one of these is on chipmap.html's statbar and caption.
    assert c["nodes"] == 1547, "the universe is every node the netlist touches, rails out"
    assert c["groups"] == 132
    assert c["kinds"] == 23
    assert c["bundles"] == 534
    assert c["bundledGate"] == 1644
    assert c["bundledSwitch"] == 310
    assert c["insideGate"] == 922
    assert c["insideSwitch"] == 313


def test_the_kinds_are_the_tracers_and_carry_their_sizes(client):
    kinds = {k["key"]: k for k in client.get("/v1/atlas").json()["kinds"]}
    # The arc the tracer built, kind by kind. `control` is absent on purpose:
    # once every derivation has claimed its own lines there is nothing left
    # for the catch-all to cluster, which is a finding rather than dead code.
    assert "control" not in kinds
    assert kinds["alu"]["groups"] == 17, "eight bit slices, shared, inputs, ends, line groups"
    assert kinds["regs"]["groups"] == 18, "four registers, their lines, and the global sharing"
    assert kinds["flags"]["groups"] == 9, "seven flags, shared, and the P readout"
    assert kinds["chain"]["groups"] == 7, "six T-state cells and the shared logic"
    assert sum(k["nodes"] for k in kinds.values()) == 1547


# ---------------------------------------------------------------------------
# The partition is a partition
# ---------------------------------------------------------------------------


def test_the_partition_is_disjoint_and_complete(client):
    """Recomputed from what the API served, never read out of `counts`."""
    rows = client.get("/v1/groups?members=true").json()["groups"]
    seen: dict[int, str] = {}
    for g in rows:
        for n in g["nodes"]:
            assert n["id"] not in seen, (
                f"node {n['id']} is in both {seen.get(n['id'])} and {g['key']}"
            )
            seen[n["id"]] = g["key"]
    assert len(seen) == 1547
    assert len(rows) == 132


def test_every_node_is_owned_by_a_group_it_is_in(client):
    page = client.get("/v1/tags?limit=2000").json()
    assert page["total"] == 1547
    for n in page["nodes"]:
        keys = [g["key"] for g in n["groups"]]
        assert n["owner"] in keys, f"node {n['id']} is owned by {n['owner']}, which it is not in"


# ---------------------------------------------------------------------------
# The overlapping layer, which is the answer to the question that prompted it
# ---------------------------------------------------------------------------


def test_a_node_in_several_containers_reports_all_of_them(client):
    """`pipeUNK39` is the case: five containers reach it, and each of the five
    is a different reading of the same latch. Naming them pins that the
    overlap layer is derived rather than a list."""
    n = client.get("/v1/node/pipeUNK39").json()
    keys = {g["key"] for g in n["groups"]}
    assert keys == {"alat:ADL/ABL", "dbus:rw", "sdp:sd1", "pipe:unk", "alu:out"}
    assert n["owner"] == "alat:ADL/ABL", "the most specific claim wins the partition"
    assert sum(1 for g in n["groups"] if not g["partitioned"]) == 1, "sdp:sd1 is absorbed"


def test_eighty_eight_nodes_are_in_more_than_one_container(client):
    page = client.get("/v1/tags?multi=true&limit=2000").json()
    assert page["total"] == 88
    assert all(len(n["groups"]) > 1 for n in page["nodes"])
    assert max(len(n["groups"]) for n in page["nodes"]) == 5


def test_three_containers_exist_only_in_the_overlapping_layer(client):
    rows = client.get("/v1/groups?layer=absorbed").json()["groups"]
    assert {g["key"] for g in rows} == {"sdp:sd1", "sdp:sd2", "sbus:link"}
    # SD1 and SD2 are the store-data latches the simulator's own timing
    # readout names. The address latches' ADL/ABL cone reads them and
    # outranks them, which is the ownership joint the chip map documents.
    sd1 = client.get("/v1/groups/sdp:sd1").json()
    assert sd1["partitioned"] is False
    assert sd1["absorbed_by"] == ["alat:ADL/ABL"]
    assert sd1["count"] == 4
    assert 440 in [n["id"] for n in sd1["nodes"]], "node 440 is SD1 in the timing readout"


def test_the_layers_are_different_sizes_and_that_is_the_point(client):
    part = client.get("/v1/groups?layer=partition").json()
    cont = client.get("/v1/groups?layer=containers").json()
    assert part["count"] == 132
    assert cont["count"] == 135
    # Summing the containers over-counts, because they overlap. If it did not,
    # there would be no second layer to serve.
    assert sum(g["count"] for g in cont["groups"]) > 1547


# ---------------------------------------------------------------------------
# Hierarchy
# ---------------------------------------------------------------------------


def test_a_register_line_hangs_off_its_register(client):
    g = client.get("/v1/groups/regs:a.SBAC").json()
    assert g["parent"] == "regs:a"
    assert g["path"] == ["regs", "regs:a", "regs:a.SBAC"]
    assert g["depth"] == 2
    parent = client.get("/v1/groups/regs:a").json()
    assert "regs:a.SBAC" in parent["children"]
    assert parent["parent"] == "regs", "a register's own parent is its kind"
    assert parent["depth"] == 1


def test_parents_and_children_agree_in_both_directions(client):
    rows = {g["key"]: g for g in client.get("/v1/groups").json()["groups"]}
    for key, g in rows.items():
        if g["parent"] in rows:
            assert key in rows[g["parent"]]["children"], f"{key} is not among {g['parent']}'s children"
        else:
            assert g["parent"] == g["kind"], f"{key} names a parent that is neither a group nor its kind"
        for child in g["children"]:
            assert rows[child]["parent"] == key


def test_parent_filters_to_exactly_the_children(client):
    kids = client.get("/v1/groups?parent=regs:a").json()
    assert {g["key"] for g in kids["groups"]} == {"regs:a.SBAC", "regs:a.ACDB", "regs:a.ACSB"}


# ---------------------------------------------------------------------------
# Filters filter
# ---------------------------------------------------------------------------


def test_filters_narrow_and_do_not_silently_pass_everything(client):
    everything = client.get("/v1/groups").json()["count"]
    alu = client.get("/v1/groups?kind=alu").json()
    assert 0 < alu["count"] < everything
    assert all(g["kind"] == "alu" for g in alu["groups"])

    big = client.get("/v1/groups?min_nodes=50").json()
    assert 0 < big["count"] < everything
    assert all(g["count"] >= 50 for g in big["groups"])

    q = client.get("/v1/groups?q=decimal").json()
    assert [g["key"] for g in q["groups"]] == ["decimal:bcd"]


def test_a_block_filter_uses_the_dies_own_attribution(client):
    """A group is derived machinery and a block is a region of the die, so a
    filter by block is a real question: which machinery reaches into the ALU."""
    by_id = client.get("/v1/groups?block=8").json()
    by_name = client.get("/v1/groups?block=ALU").json()
    assert by_id["count"] == by_name["count"] > 0
    assert by_id["count"] < client.get("/v1/groups").json()["count"]
    for g in by_id["groups"]:
        assert any(b["id"] == 8 for b in g["blocks"])


def test_node_filters_compose(client):
    terms = client.get("/v1/tags?role=decode term&limit=2000").json()
    assert terms["total"] == 122, "the decode PLA's product terms, all of them"
    lines = client.get("/v1/tags?role=control line&limit=2000").json()
    assert lines["total"] > 0
    named = client.get("/v1/tags?named=true&limit=2000").json()
    unnamed = client.get("/v1/tags?named=false&limit=2000").json()
    assert named["total"] + unnamed["total"] == 1547
    # 832 die names sit on 707 distinct nodes, and two of those are vss and
    # vcc. A rail is not in the universe -- it touches most of the chip and
    # crossing one would join the die into a single group -- so 705 named
    # nodes is the right answer here and 707 would be the wrong one.
    assert named["total"] == 705


def test_paging_walks_the_whole_set_without_repeating(client):
    seen: set[int] = set()
    offset, total = 0, None
    while True:
        page = client.get(f"/v1/tags?limit=300&offset={offset}").json()
        total = page["total"]
        if not page["nodes"]:
            break
        for n in page["nodes"]:
            assert n["id"] not in seen
            seen.add(n["id"])
        offset += len(page["nodes"])
    assert len(seen) == total == 1547


# ---------------------------------------------------------------------------
# Names, including the awkward ones
# ---------------------------------------------------------------------------


def test_a_key_with_a_slash_resolves_as_one_key(client):
    g = client.get("/v1/groups/alat:ADL/ABL").json()
    assert g["key"] == "alat:ADL/ABL"
    assert g["kind"] == "alat"
    assert g["count"] == 18, "the load line's cone, as the tracer derives it"


def test_a_die_name_with_a_slash_resolves(client):
    n = client.get("/v1/node/op-T2-ADL/ADD").json()
    assert n["name"] == "op-T2-ADL/ADD"
    assert n["block_name"] == "Decode PLA"
    # Named `op-...` and filed in the PLA, and still not a product term: it is
    # a signal in the OR plane, which is why the authored name grouping and
    # the measured role disagree about the size of the decoder.
    assert n["role"] == "signal"
    assert n["owner"] == "rest:3"


def test_a_node_answers_to_every_name_it_carries(client):
    """125 nodes carry more than one name. p4 and Pout4 are one node, and
    asking by either has to reach it."""
    a = client.get("/v1/node/p4").json()
    b = client.get("/v1/node/Pout4").json()
    assert a["id"] == b["id"]
    assert a["names"] == b["names"] == ["Pout4", "p4"]


def test_an_unnamed_node_answers_to_its_number(client):
    plain = client.get("/v1/node/1446").json()
    hashed = client.get("/v1/node/%231446").json()
    assert plain["id"] == hashed["id"] == 1446
    assert plain["name"] is None
    assert plain["owner"] == hashed["owner"]


# ---------------------------------------------------------------------------
# Neighbours
# ---------------------------------------------------------------------------


def test_the_four_relations_are_four_different_things(client):
    """`a0` is the accumulator's bit 0. Backward it is a gate output; through
    its switches it reaches its own recirculation latch under `cclk` and the
    special bus under `SBAC`, which is the accumulator's whole write path."""
    sw = client.get("/v1/neighbors?node=a0&via=switch").json()
    controls = {n["control_name"] for n in sw["neighbors"]}
    assert controls == {"cclk", "dpc23_SBAC"}
    assert all(n["relation"] == "channel" for n in sw["neighbors"])


def test_direction_splits_a_gate_edge_and_the_halves_add_up(client):
    """`a0` is the wrong subject for this and a first version used it: it has
    eight switch neighbours and NOTHING driving it, so `direction=in` came
    back empty and a walk that ignored direction entirely passed. `clearIR`
    is driven by two gates and feeds eight, so the split is visible.
    """
    deg = client.get("/v1/node/clearIR").json()["degree"]
    assert deg["drives"] > 1 and deg["driven_by"] > 1, "the subject must exercise both"

    both = client.get("/v1/neighbors?node=clearIR&via=gate&direction=both&limit=2000").json()
    out = client.get("/v1/neighbors?node=clearIR&via=gate&direction=out&limit=2000").json()
    inn = client.get("/v1/neighbors?node=clearIR&via=gate&direction=in&limit=2000").json()

    assert {n["relation"] for n in out["neighbors"]} == {"drives"}
    assert {n["relation"] for n in inn["neighbors"]} == {"driven_by"}
    assert out["count"] == deg["drives"]
    assert inn["count"] == deg["driven_by"]
    assert both["count"] == out["count"] + inn["count"]
    assert {n["id"] for n in out["neighbors"]}.isdisjoint({n["id"] for n in inn["neighbors"]})


def test_drives_and_driven_by_are_inverses(client):
    out = client.get("/v1/neighbors?node=idb0&via=gate&direction=out&limit=2000").json()
    for n in out["neighbors"]:
        back = client.get(f"/v1/neighbors?node={n['id']}&via=gate&direction=in&limit=2000").json()
        assert 0 in [m["id"] for m in back["neighbors"]] or any(
            m["id"] == out["node"]["id"] for m in back["neighbors"]
        ), f"{n['id']} does not name idb0 as an input"


def test_a_channel_is_symmetric(client):
    a = client.get("/v1/neighbors?node=sb0&via=switch&limit=2000").json()
    for n in a["neighbors"]:
        if n.get("rail"):
            continue
        back = client.get(f"/v1/neighbors?node={n['id']}&via=switch&limit=2000").json()
        assert any(m["id"] == a["node"]["id"] for m in back["neighbors"]), (
            f"a pass transistor joins sb0 to {n['id']} but not the other way"
        )


def test_a_control_line_opens_switches_rather_than_being_on_a_path(client):
    """`cclk` gates 273 transistors. Following it as if it were a signal is
    what buries whatever was asked about, so it is a relation of its own."""
    r = client.get("/v1/neighbors?node=cclk&via=control&limit=2000").json()
    assert r["count"] > 100
    assert all(n["relation"] == "opens" for n in r["neighbors"])
    assert all(n["control_name"] == "cclk" for n in r["neighbors"])


def test_a_rail_is_reported_and_never_walked(client):
    """Eleven gates take vss as an input: the permanently-off pull-up the
    pinout page's direction rule turns on. RDY is one of them."""
    r = client.get("/v1/neighbors?node=rdy&via=gate&depth=3").json()
    rails = [n for n in r["neighbors"] if n.get("rail")]
    assert rails and rails[0]["name"] == "vss"
    assert r["rails"] == len(rails)
    assert all(n["from"] != rails[0]["id"] for n in r["neighbors"]), "nothing was reached THROUGH a rail"


def test_depth_reaches_further_and_says_when_it_stopped(client):
    one = client.get("/v1/neighbors?node=idb0&depth=1&limit=2000").json()
    two = client.get("/v1/neighbors?node=idb0&depth=2&limit=2000").json()
    assert two["count"] > one["count"]
    assert max(n["depth"] for n in two["neighbors"]) == 2
    capped = client.get("/v1/neighbors?node=idb0&depth=2&limit=5").json()
    assert capped["truncated"] is True
    assert capped["count"] == 5


def test_a_neighbour_carries_its_own_tags(client):
    r = client.get("/v1/neighbors?node=a0&via=switch").json()
    sb0 = next(n for n in r["neighbors"] if n["name"] == "sb0")
    assert sb0["owner"] == "sbus:sb"
    assert "sbus:sb" in sb0["groups"]


# ---------------------------------------------------------------------------
# Bundles: the wiring between groups
# ---------------------------------------------------------------------------


def test_a_groups_bundles_are_the_wiring_leaving_it(client):
    g = client.get("/v1/groups/regs:a").json()
    assert g["bundles"], "the accumulator is wired to something"
    for b in g["bundles"]:
        assert b["gate"] + b["switch"] > 0
        assert b["gate_out"] + b["gate_in"] == b["gate"]
    # The accumulator's switches reach the special bus, and the control on
    # them is the line that writes it: SBAC in, ACSB out.
    sb = next((b for b in g["bundles"] if b["key"] == "sbus:sb"), None)
    assert sb is not None and sb["switch"] > 0
    assert any("SBAC" in c or "ACSB" in c for c in sb["controls"])


def test_every_bundle_is_reported_from_both_ends(client, onfile):
    b = max(onfile["bundles"], key=lambda x: x["gate"] + x["switch"])
    a_side = client.get(f"/v1/groups/{b['a']}").json()
    b_side = client.get(f"/v1/groups/{b['b']}").json()
    ab = next(x for x in a_side["bundles"] if x["key"] == b["b"])
    ba = next(x for x in b_side["bundles"] if x["key"] == b["a"])
    assert ab["gate"] == ba["gate"] == b["gate"]
    assert ab["switch"] == ba["switch"] == b["switch"]
    # Direction is reported from the asking group's side, so the two mirror.
    assert ab["gate_out"] == ba["gate_in"]
    assert ab["gate_in"] == ba["gate_out"]


# ---------------------------------------------------------------------------
# Known containers, against the site's published derivations
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "key,count,must_contain",
    [
        # Every one of these counts is stated on the tracer's own page.
        ("clock:gen", 16, ["cclk", "cp1", "clk1out", "clk2out"]),
        ("decimal:bcd", 51, ["dpc18_#DAA", "dpc22_#DSA", "DC34", "DC78"]),
        ("incr:pc", 86, ["dpc36_#IPC", "dpc34_PCLC", "dpc35_PCHC"]),
        ("sync:sync", 4, ["sync"]),
        ("rdy:master", 1, ["notRdy0"]),
        ("alu:bit3", 11, ["alu3", "notalu3", "AxB3"]),
        ("intr:nmi", 18, ["NMIL", "NMIP", "#NMIG"]),
    ],
)
def test_a_derived_container_is_what_the_site_says_it_is(client, key, count, must_contain):
    g = client.get(f"/v1/groups/{key}").json()
    assert g["count"] == count
    names = {n["name"] for n in g["nodes"]}
    for want in must_contain:
        assert want in names, f"{key} does not contain {want}"


def test_the_nmi_path_reaches_the_address_bit_that_distinguishes_the_vector(client):
    """`pipeVectorA2` on the NMI path is the finding, not a leak: bit 2 is the
    one address bit by which $FFFA differs from $FFFE, and the walk found it
    without being told.

    It is also why both layers are served. The walk is 20 nodes; the box on
    the chip map is 18, because the pipeline latch file outranks the
    interrupts and keeps that latch. Asking the partition alone would report
    the finding as absent.
    """
    box = client.get("/v1/groups/intr:nmi").json()
    walk = client.get("/v1/groups/intr:nmi?layer=containers").json()
    assert box["count"] == 18 and walk["count"] == 20
    assert walk["owned"] == 18
    assert "pipe:named" in walk["claimed_elsewhere"]
    assert "pipeVectorA2" not in {n["name"] for n in box["nodes"]}
    assert "pipeVectorA2" in {n["name"] for n in walk["nodes"]}

    irq = client.get("/v1/groups/intr:irq?layer=containers").json()
    assert "pipeVectorA2" not in {n["name"] for n in irq["nodes"]}, (
        "only the NMI vector differs from the IRQ vector in bit 2"
    )


def test_a_group_read_as_a_walk_never_loses_nodes_to_the_box(client):
    """For every key in both layers, the box is a subset of the walk. The
    partition can only ever take nodes away."""
    for key in ["intr:nmi", "alu:bit3", "decimal:bcd", "regs:a", "alat:ADL/ABL", "flags:C"]:
        box = client.get(f"/v1/groups/{key}").json()
        walk = client.get(f"/v1/groups/{key}?layer=containers").json()
        b = {n["id"] for n in box["nodes"]}
        w = {n["id"] for n in walk["nodes"]}
        assert b <= w, f"{key} owns nodes its own derivation never reached"
        assert walk["owned"] == len(b)
        for n in walk["nodes"]:
            if n["id"] not in b:
                assert n["owner"] in walk["claimed_elsewhere"]


# ---------------------------------------------------------------------------
# The served data is the file, and the old route is untouched
# ---------------------------------------------------------------------------


def test_the_service_serves_the_file_it_was_given(client, onfile):
    served = client.get("/v1/atlas").json()
    assert served["counts"] == onfile["counts"]
    assert served["format"] == onfile["format"]
    assert [k["key"] for k in served["kinds"]] == [k["key"] for k in onfile["kinds"]]


def test_v1_nodes_still_answers_exactly_as_it_did(client):
    """The name grouping is a different claim from the atlas and consumers
    depend on its shape. Adding the atlas must not have moved it."""
    j = client.get("/v1/nodes").json()
    assert set(j) == {"count", "groups"}
    assert j["count"] == 832
    assert set(j["groups"]) == {
        "rails", "pins", "registers", "buses", "datapath", "decode", "timing", "other",
    }
    assert j["groups"]["rails"] == {"vcc": 657, "vss": 558}


def test_the_authored_grouping_and_the_measured_one_are_different_claims(client):
    """The decode NAME group is 132 nodes; the decode PLA's product terms are
    122. They are not the same set and the API must not imply they are."""
    named = client.get("/v1/nodes").json()["groups"]["decode"]
    terms = client.get("/v1/tags?role=decode term&limit=2000").json()
    assert len(named) == 132
    assert terms["total"] == 122


# ---------------------------------------------------------------------------
# Refusals
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url,status",
    [
        ("/v1/groups?layer=nope", 422),
        ("/v1/groups?block=nowhere", 422),
        ("/v1/tags?role=nope", 422),
        ("/v1/tags?group=nope:1", 404),
        ("/v1/neighbors?node=a0&depth=9", 422),
        ("/v1/neighbors?node=a0&via=telepathy", 422),
        ("/v1/neighbors?node=nosuchwire", 404),
        ("/v1/groups/nope:1", 404),
        ("/v1/groups/alu:bit3?layer=nope", 422),
        ("/v1/node/nosuchwire", 404),
        ("/v1/node/99999", 404),
    ],
)
def test_a_bad_request_is_refused_rather_than_guessed(client, url, status):
    assert client.get(url).status_code == status
