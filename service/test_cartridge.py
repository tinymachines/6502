"""Cartridges: the format, the refusals, and the measurement.

    python3 -m pytest service/test_cartridge.py -q

Needs `target/release/halfwave` built (or HALFWAVE_BIN) and node for the
assembler bridge, like the rest of the service suite.

The load-bearing tests here are the two that could not pass by accident. The
tile encoder is checked against `games/art/tiles.chr`, a file this code did not
write -- it came out of the JavaScript encoder by way of a PNG -- so agreeing
with it is evidence rather than agreeing with itself. And the frame cost is
minted twice from two different *declared* costs and has to come back the same
number, because the failure this measurement replaced was exactly a declared
cost being read back as a measured one.
"""

from __future__ import annotations

import gzip
import json
import re
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cartridge  # noqa: E402
from app import app  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SHEET = ROOT / "games" / "art" / "tiles.chr"
CHR_JS = ROOT / "games" / "chr.js"
DIERUNNER = ROOT / "games" / "rom" / "dierunner.s"

# The smallest thing that satisfies the contract, written out here rather than
# fetched from /v1/console: an expectation derived from the code under test
# proves nothing. It clears the screen, draws one cell where the controller
# says, and raises the flag.
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

# A ROM that runs forever and never raises the flag. Assembles perfectly.
NEVER = """        .org $0200
loop    NOP
        JMP loop"""

# Three bytes ending at $FFFB, which is inside the vector table. Written
# small on purpose: a ROM at $FFF0 runs off the top of memory first and is
# refused for that instead, which is a different check passing.
VECTORS_ROM = """        .org $FFF8
loop    JMP loop"""

# Short enough that a screen can be placed one byte past its end.
PAD_ROM = """        .org $0200
loop    LDA #$01
        STA $0D
        JMP loop"""


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def mint(client, **over):
    body = {"rom": {"source": TINY, "org": 0x0200}, "meta": {"name": "tiny"}}
    body.update(over)
    return client.post("/v1/cartridge?format=json", json=body)


# -- the tile format ---------------------------------------------------------

def test_the_palette_is_the_one_the_console_draws():
    """Two files carry these four colours and the point is that they agree.
    Parsing the JavaScript rather than importing it, because this is a check
    that they have not drifted, not a way to avoid a second copy."""
    found = re.findall(r"'(#[0-9A-Fa-f]{6})'", CHR_JS.read_text())
    assert found[:4] == cartridge.PALETTE


def test_pixels_round_trip_through_the_binary_format():
    """The shipped sheet was encoded by the JavaScript, out of a PNG, by a
    different converter. Decoding it here and encoding it back has to give the
    same bytes, or this is a second tile format wearing the same name."""
    blob = SHEET.read_bytes()
    assert len(blob) == 16 * cartridge.BYTES_PER_TILE
    pixels = cartridge.chr_to_pixels(blob)
    assert cartridge.pixels_to_chr(pixels) == blob
    # And the shape is what the format says: eight rows of eight, colours 0..3.
    assert all(len(t) == 8 and all(len(r) == 8 for r in t) for t in pixels)
    assert set("".join("".join(t) for t in pixels)) <= set("0123")


def test_the_converters_own_glyphs_are_accepted():
    """png2chr.py --ascii prints '.:o#', and a row pasted out of it should not
    have to be retyped. A retyped row is a row that can be retyped wrong."""
    a = cartridge.pixels_to_chr([[".:o#...."] * 8])
    b = cartridge.pixels_to_chr([["0123" + "0" * 4] * 8])
    assert a == b


def test_a_bad_pixel_says_which_one():
    with pytest.raises(cartridge.CartridgeError) as e:
        cartridge.pixels_to_chr([["00000000"] * 7 + ["0000x000"]])
    assert "row 7 pixel 4" in str(e.value)


# -- the refusals ------------------------------------------------------------

def test_a_working_layout_mints(client):
    r = mint(client)
    assert r.status_code == 200, r.text
    doc = r.json()["cartridge"]
    assert doc["format"] == cartridge.FORMAT
    assert doc["rom"]["size"] > 0
    assert doc["rom"]["source"] == TINY


@pytest.mark.parametrize(
    "over,expect",
    [
        # Each of these assembles and boots. Every one is a mistake made here.
        ({"console": {"screen": 0x0200}}, "covers its own screen"),
        ({"console": {"screen": 0x0100}}, "stack page"),
        ({"console": {"screen": 0xFFF0}}, "past the top of memory"),
        ({"console": {"tick": 0x0210, "screen": 0x0500}}, "inside the ROM"),
        ({"console": {"tick": 0x0505, "screen": 0x0500}}, "inside the screen"),
        ({"console": {"tick": 0x000D, "input": 0x000D}}, "cannot share one"),
        ({"rom": {"source": VECTORS_ROM, "org": 0xFFF8}}, "vectors"),
        ({"rom": {"source": TINY.replace("$0200", "$0100"), "org": 0x0100}}, "stack page"),
    ],
)
def test_a_layout_that_cannot_work_is_refused(client, over, expect):
    r = mint(client, **over)
    assert r.status_code == 422, f"minted anyway: {r.text[:300]}"
    assert expect in r.json()["detail"]["error"], r.json()["detail"]["error"]


def test_the_overlap_check_is_exact_at_its_own_edge(client):
    """One byte either side of the boundary, because `end` is the assembler's
    LAST byte and reading it as one-past left every check a byte short: a ROM
    whose final byte was the screen's first minted cleanly. Both halves are
    needed here. The refusal alone would pass on a check that refuses
    everything."""
    size = len(bytes.fromhex(
        client.post("/v1/assemble", json={"source": PAD_ROM, "org": 0x0200}).json()["bytes"]))
    last = 0x0200 + size - 1
    assert mint(client, rom={"source": PAD_ROM, "org": 0x0200},
                console={"screen": last}).status_code == 422
    assert mint(client, rom={"source": PAD_ROM, "org": 0x0200},
                console={"screen": last + 1}).status_code == 200


def test_the_screen_overlap_refusal_is_about_the_overlap(client):
    """The proof that the check can tell: the same ROM with its screen one
    page clear of it mints, so the refusal above is the overlap and not the
    address."""
    assert mint(client, console={"screen": 0x0300}).status_code == 200


# -- what the chip says ------------------------------------------------------

def test_verification_runs_the_thing(client):
    r = mint(client, frames=3)
    v = r.json()["verify"]
    assert v["booted"] and v["frames_completed"] == 3
    assert v["screen_changed"] is False or v["screen_changed"] is True
    # It drew: the screen is not one value everywhere.
    assert v["tiles_used"] == [0, 2], v["tiles_used"]


def test_a_rom_that_never_raises_the_flag_is_reported_not_hidden(client):
    """It assembles. It boots. It is not a cartridge, and only running it
    says so."""
    r = mint(client, rom={"source": NEVER, "org": 0x0200}, frames=2, frame_budget=3000)
    v = r.json()["verify"]
    assert v["frames_completed"] == 0
    assert any("never raised the tick flag" in n for n in v["notes"]), v["notes"]
    assert any("nothing was drawn" in n for n in v["notes"]), v["notes"]


def test_the_frame_cost_is_measured_and_not_the_request_size(client):
    """The strongest test in this file. `frame_cost` seeds the first chunk, so
    a cost that was merely reported back would move with it: that is precisely
    how Die Runner's page came to claim 12,000 half-cycles for a frame. Mint
    the same ROM under two very different declared costs and the measurement
    has to be the same number."""
    a = mint(client, console={"frame_cost": 512}, frames=2).json()["verify"]
    b = mint(client, console={"frame_cost": 20000}, frames=2).json()["verify"]
    assert a["frame_cost"] == b["frame_cost"], (a["half_cycles"], b["half_cycles"])
    assert a["half_cycles"] == b["half_cycles"]
    assert a["frame_cost"] < 20000


def test_die_runner_mints_and_is_the_cost_its_page_now_claims(client):
    """The shipped game, through the same door as anything else. 8704 is
    written into games/game.js; if this ever disagrees, one of the two is
    stale and the measurement is the one to believe."""
    r = mint(
        client,
        rom={"source": DIERUNNER.read_text(), "org": 0x0200},
        meta={"name": "Die Runner"},
        console={"tick": 0x0D, "input": 0x02, "status": 0x03, "score": 0x11,
                 "screen": 0x0500, "width": 16, "height": 16, "gate_mask": 0x14},
        tiles={"chr": SHEET.read_bytes().hex()},
        frames=4,
    )
    assert r.status_code == 200, r.text
    v = r.json()["verify"]
    assert v["frames_completed"] == 4
    assert v["frame_cost"] == 8704, v["half_cycles"]
    assert v["screen_changed"]
    assert len(v["tiles_used"]) > 2
    js = (ROOT / "games" / "game.js").read_text()
    assert f"frameCost: {v['frame_cost']}," in js


# -- the container -----------------------------------------------------------

def test_the_file_is_gzipped_json_and_says_what_it_is(client):
    r = mint(client, meta={"name": "Hello Die"})
    assert r.status_code == 200
    doc = r.json()["cartridge"]
    blob = cartridge.pack(doc)
    assert blob[:2] == b"\x1f\x8b"
    back = cartridge.unpack(blob)
    assert back == doc
    # Everything a reader needs to decode it is in the file itself.
    assert set(doc["encoding"]) >= {"chr", "pixels", "screen", "container"}
    assert set(doc["contract"]) >= {"tick", "input"}


def test_minting_the_same_cartridge_twice_gives_the_same_bytes():
    """mtime zero, so two cartridges can be diffed. A container that changes
    every time it is written cannot be, and diffing two of them is how a
    person sees what an edit did."""
    doc = {"format": cartridge.FORMAT, "version": cartridge.VERSION, "x": 1}
    assert cartridge.pack(doc) == cartridge.pack(doc)


def test_a_file_that_is_not_a_cartridge_is_refused():
    with pytest.raises(cartridge.CartridgeError, match="not a gzip"):
        cartridge.unpack(b"nope")
    with pytest.raises(cartridge.CartridgeError, match="not JSON"):
        cartridge.unpack(gzip.compress(b"nope"))
    with pytest.raises(cartridge.CartridgeError, match="format is"):
        cartridge.unpack(gzip.compress(json.dumps({"format": "other"}).encode()))


def test_the_gzip_response_is_a_file(client):
    r = client.post("/v1/cartridge", json={"rom": {"source": TINY}, "meta": {"name": "Hello Die"}})
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/gzip"
    assert 'filename="hello-die.cart.gz"' in r.headers["content-disposition"]
    doc = json.loads(gzip.decompress(r.content))
    assert doc["format"] == cartridge.FORMAT
    assert int(r.headers["x-cartridge-frame-cost"]) == doc["console"]["frame_cost"]


def test_the_console_spec_is_the_one_the_code_uses(client):
    """The published defaults have to be the model's defaults, or a reader
    following the page writes a ROM against addresses nothing uses."""
    spec = client.get("/v1/console").json()
    from models import ConsoleSpec
    d = ConsoleSpec().model_dump()
    for k, v in spec["defaults"].items():
        if k == "org":
            continue
        assert d[k] == v, k
    # A field with no default is published as a convention and marked as one,
    # rather than being dressed up as a default it does not have.
    assert d["status"] is None and spec["conventional"]["status"] == 0x0003
    assert spec["cartridge"]["version"] == cartridge.VERSION
    assert spec["tiles"]["bytes_per_tile"] == cartridge.BYTES_PER_TILE
    assert [p["colour"] for p in spec["tiles"]["palette"]] == cartridge.PALETTE


# -- what a watched line opens -----------------------------------------------

WATCH = ["dpc25_SBDB", "dpc9_DBADD", "dpc10_ADLADD", "dpc21_ADDADL",
         "dpc23_SBAC", "dpc30_ADHPCH", "dpc40_ADLPCL", "dpc2_XSB"]


def test_what_each_watched_line_opens_is_derived(client):
    """Die Runner had these eight written out by hand beside the eight names,
    which is two claims where there is one fact. The atlas is asked instead,
    and the three answers that differ from the hand-written ones are the
    reason to ask: two lines open one switch a bit and the hand-written pair
    had named bit 2 and bit 3 where bit 0 is canonical, and XSB joins sb0 to a
    node the die never named at all.
    """
    from app import _joins_for
    got = _joins_for(WATCH)
    assert got["dpc23_SBAC"] == "a0 - sb0"
    assert got["dpc40_ADLPCL"] == "adl0 - pcl0"
    # The bit picked is the lowest, not whichever transistor is numbered
    # lowest: ADLPCL's bit 7 switch is transistor 1984 and bit 0's is 3374.
    assert got["dpc21_ADDADL"] == "adl0 - alu0"
    assert got["dpc30_ADHPCH"] == "adh0 - pch0"
    # An end with no name of its own is reported as the container that owns
    # it, which is measured, rather than as the register a reader assumes.
    assert got["dpc2_XSB"] == "regs:x - sb0"
    assert len(got) == len(WATCH)


def test_the_page_and_the_mint_say_the_same_thing(client):
    """games/game.js draws these labels beside the gates. It is a second copy
    of the same fact, so it has to be the same copy: if this ever fails, the
    derivation moved and the page is stale."""
    from app import _joins_for
    js = (ROOT / "games" / "game.js").read_text()
    derived = _joins_for(WATCH)
    for name in WATCH:
        assert f"'{derived[name]}'" in js, f"{name}: {derived[name]!r} not in game.js"


def test_a_minted_cartridge_carries_them(client):
    r = mint(client, console={"watch": WATCH[:3], "screen": 0x0500})
    joins = r.json()["cartridge"]["console"]["joins"]
    assert len(joins) == 3 and all(" - " in j for j in joins)


# -- the headless kind -------------------------------------------------------
#
# A cartridge that draws nothing: no screen page, no tick flag. The seven
# programs the explorer boots are this kind. What verifying one says is where
# it got to, read off the silicon, and the layout checks are only the ones
# that still mean something.

COUNTER = """        .org $0200
start:  LDA #$00
loop:   JSR bump
        JMP loop
        .org $0210
bump:   INX
        DEY
        INC $0F
        SEC
        ADC #$02
        RTS"""

JAM = """        .org $0200
        LDA #$07
        STA $0F
        .byte $02"""


def mint_headless(client, source=COUNTER, **console):
    body = {"rom": {"source": source, "org": 0x0200},
            "console": {"kind": "headless", "half_cycles": 800,
                        "peek": [{"addr": 0x000F, "name": "counter"}], **console},
            "meta": {"name": "counter"}}
    return client.post("/v1/cartridge?format=json", json=body)


def test_a_headless_cartridge_mints_with_no_screen_and_no_tiles(client):
    r = mint_headless(client)
    assert r.status_code == 200, r.text
    doc = r.json()["cartridge"]
    assert doc["console"]["kind"] == "headless"
    assert "screen" not in doc["console"] and "tick" not in doc["console"], doc["console"]
    assert doc["tiles"]["count"] == 0
    assert any(n.startswith("headless: this cartridge draws nothing") for n in doc["notes"])


def test_verifying_a_headless_cartridge_reads_the_run_off_the_silicon(client):
    v = mint_headless(client).json()["verify"]
    assert v["kind"] == "headless" and v["draws_nothing"] is True
    assert v["half_cycles"] == [800] and v["frames_requested"] == 0
    # The counter loop INCs $0F every pass and the pc keeps moving.
    assert v["peeked"]["counter"] > 0, v
    assert v["pc_moved"] is True
    assert set(v["registers"]) == {"pc", "a", "x", "y", "s", "p"}
    assert 0x0200 <= v["registers"]["pc"] < 0x0220


def test_a_headless_cartridge_that_jams_says_the_pc_stopped(client):
    v = mint_headless(client, source=JAM).json()["verify"]
    assert v["peeked"]["counter"] == 7, "the store landed before the JAM"
    assert v["pc_moved"] is False
    assert any("stayed at" in n for n in v["notes"]), v["notes"]


def test_the_headless_layout_checks_are_the_ones_that_still_mean_something(client):
    # No screen, so no screen overlap; the stack and the vectors still count.
    r = mint_headless(client, source=COUNTER.replace("$0200", "$0100"))
    assert r.status_code == 422 and "stack page" in r.json()["detail"]["error"]
    r = client.post("/v1/cartridge?format=json", json={
        "rom": {"source": COUNTER, "org": 0x0200},
        "console": {"kind": "headless", "peek": [{"addr": 1, "name": "a"}, {"addr": 2, "name": "a"}]}})
    assert r.status_code == 422 and "both called" in r.json()["detail"]["error"]


def test_a_console_cartridge_does_not_carry_the_headless_fields(client):
    doc = mint(client).json()["cartridge"]
    assert "kind" not in doc["console"] and "peek" not in doc["console"]
    assert mint(client).json()["verify"]["kind"] == "console"
