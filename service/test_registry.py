"""The registry: tokens, pages, and what a builder cannot make up.

    python3 -m pytest service/test_registry.py -q

Every test runs against its own SQLite file in a tmpdir, so the suite never
touches a real registry and the order of tests cannot matter.

The two that earn their keep are `test_the_registry_measures_rather_than_
believes` -- a cartridge whose own verify block claims a frame costs 12
half-cycles is published with the number the chip produced -- and
`test_a_patch_touches_only_what_it_names`, because "save the bio" silently
blanking an avatar is the kind of bug a person discovers by losing work.
"""

from __future__ import annotations

import base64
import gzip
import json
import sqlite3
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cartridge  # noqa: E402
import registry  # noqa: E402

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

# A ROM that assembles and boots and never finishes a frame.
NEVER = """        .org $0200
loop    NOP
        JMP loop"""


def tile(rows):
    return [rows] if isinstance(rows[0], str) else rows


def art(w, h, glyph="1"):
    return {"w": w, "h": h, "pixels": [[glyph * 8] * 8 for _ in range(w * h)]}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """A registry of its own per test. REGISTRY_DB is read at import time into
    registry.DB_PATH, so the module attribute is what has to move."""
    monkeypatch.setattr(registry, "DB_PATH", tmp_path / "registry.db")
    import app
    with TestClient(app.app) as c:
        yield c


@pytest.fixture()
def token(client):
    db = registry.connect()
    registry.init(db)
    t = registry.mint_token(db, "test")
    db.close()
    return t


def auth(token):
    return {"authorization": f"Bearer {token}"}


def mint_cart(client, name="Tiny", source=TINY, frames=2):
    r = client.post("/v1/cartridge?format=json",
                    json={"rom": {"source": source}, "meta": {"name": name},
                          "frames": frames})
    assert r.status_code == 200, r.text
    return cartridge.pack(r.json()["cartridge"])


def b64(blob):
    return base64.b64encode(blob).decode()


# -- tokens ------------------------------------------------------------------

def test_the_token_is_never_stored(client, token, tmp_path):
    """A copy of this database must not be a copy of everybody's credentials.
    Read the file as bytes, because a token stored in any column at all would
    show up there."""
    raw = (tmp_path / "registry.db").read_bytes()
    assert token.encode() not in raw
    assert registry.hash_token(token).encode() in raw


def test_a_token_becomes_one_page_and_only_one(client, token):
    r = client.post("/v1/registry/claim", json={"handle": "grok", "name": "Grok"},
                    headers=auth(token))
    assert r.status_code == 200, r.text
    assert r.json()["handle"] == "grok"
    again = client.post("/v1/registry/claim", json={"handle": "grok2", "name": "Grok"},
                        headers=auth(token))
    assert again.status_code == 409
    assert "already belongs to 'grok'" in again.json()["detail"]["error"]


def test_an_unknown_token_says_nothing_useful(client):
    r = client.post("/v1/registry/claim", json={"handle": "x1", "name": "X"},
                    headers=auth("tm6502_nope"))
    assert r.status_code == 401
    assert r.json()["detail"]["error"] == "that token is not valid"


def test_a_revoked_token_is_refused_the_same_way(client, token):
    client.post("/v1/registry/claim", json={"handle": "gone", "name": "G"}, headers=auth(token))
    db = registry.connect()
    db.execute("UPDATE tokens SET revoked = ? WHERE hash = ?",
               (registry.now(), registry.hash_token(token)))
    db.commit(); db.close()
    r = client.patch("/v1/registry/b/gone", json={"bio": "hello"}, headers=auth(token))
    assert r.status_code == 401
    # The page survives a revoked token: revoking is about the credential.
    assert client.get("/v1/registry/b/gone").status_code == 200


def test_me_says_whether_a_token_has_claimed_anything(client, token):
    before = client.get("/v1/registry/me", headers=auth(token)).json()
    assert before["claimed"] is False and before["handle"] is None
    client.post("/v1/registry/claim", json={"handle": "who", "name": "Who"}, headers=auth(token))
    after = client.get("/v1/registry/me", headers=auth(token)).json()
    assert after["claimed"] and after["builder"]["name"] == "Who"


# -- handles -----------------------------------------------------------------

@pytest.mark.parametrize("handle,why", [
    ("a", "not a handle"), ("-nope", "not a handle"), ("nope-", "not a handle"),
    ("Has Caps", "not a handle"), ("under_score", "not a handle"),
    ("api", "reserved"), ("admin", "reserved"), ("builders", "reserved"),
])
def test_a_handle_that_is_not_a_url_is_refused(client, token, handle, why):
    r = client.post("/v1/registry/claim", json={"handle": handle, "name": "X"},
                    headers=auth(token))
    assert r.status_code == 422, handle
    assert why in r.json()["detail"]["error"]


def test_a_two_character_handle_works(client, token):
    """The regex was written as first + optional(middle + last), which matches
    a length of 1 or 3-and-up and never 2: `rm` was refused while `a` was
    accepted, and the message said "2 to 32" throughout. Both ends here."""
    assert client.post("/v1/registry/claim", json={"handle": "rm", "name": "R"},
                       headers=auth(token)).status_code == 200
    db = registry.connect(); other = registry.mint_token(db, "b"); db.close()
    r = client.post("/v1/registry/claim", json={"handle": "a", "name": "A"},
                    headers=auth(other))
    assert r.status_code == 422, "a single character is not a handle"


def test_a_game_can_be_called_game(client, token):
    """Slugs were being checked against the handle reserved list, so `game`,
    `rom`, `console` and `cart` were all refused. A handle is a top-level path
    and a slug is not; they are different questions and the reserved list
    belongs to only one of them."""
    client.post("/v1/registry/claim", json={"handle": "namer", "name": "N"},
                headers=auth(token))
    blob = mint_cart(client)
    for slug in ("game", "rom", "console", "cart", "api"):
        r = client.put(f"/v1/registry/b/namer/roms/{slug}", headers=auth(token),
                       json={"cart": b64(blob)})
        assert r.status_code == 200, f"{slug}: {r.text[:200]}"
    # The character rule still applies to a slug.
    assert client.put("/v1/registry/b/namer/roms/Not_A_Slug", headers=auth(token),
                      json={"cart": b64(blob)}).status_code == 422


def test_a_taken_handle_is_taken(client, token):
    client.post("/v1/registry/claim", json={"handle": "taken", "name": "A"}, headers=auth(token))
    db = registry.connect(); other = registry.mint_token(db, "b"); db.close()
    r = client.post("/v1/registry/claim", json={"handle": "TAKEN", "name": "B"},
                    headers=auth(other))
    assert r.status_code == 409 and "taken" in r.json()["detail"]["error"]


# -- the page ----------------------------------------------------------------

def test_a_page_holds_what_a_builder_put_on_it(client, token):
    client.post("/v1/registry/claim", json={"handle": "ada", "name": "Ada"}, headers=auth(token))
    r = client.patch("/v1/registry/b/ada", headers=auth(token), json={
        "bio": "I write 6502 by hand.",
        "links": [{"label": "site", "url": "https://example.com/ada"}],
        "avatar": art(8, 8, "2"),
    })
    assert r.status_code == 200, r.text
    page = client.get("/v1/registry/b/ada").json()
    assert page["bio"].startswith("I write")
    assert page["links"][0]["url"] == "https://example.com/ada"
    assert page["avatar"]["w"] == 8 and page["avatar"]["h"] == 8
    # The art comes back as CHR and decodes to what was sent.
    blob = bytes.fromhex(page["avatar"]["chr"])
    assert len(blob) == 64 * cartridge.BYTES_PER_TILE
    assert cartridge.chr_to_pixels(blob)[0] == ["22222222"] * 8


def test_a_patch_touches_only_what_it_names(client, token):
    """Saving a bio must not blank an avatar the client never loaded. This is
    what `exclude_unset` buys, and it is worth a test because the failure is
    somebody losing work rather than an error."""
    client.post("/v1/registry/claim", json={"handle": "keep", "name": "K"}, headers=auth(token))
    client.patch("/v1/registry/b/keep", json={"avatar": art(2, 2, "3")}, headers=auth(token))
    client.patch("/v1/registry/b/keep", json={"bio": "just the bio"}, headers=auth(token))
    page = client.get("/v1/registry/b/keep").json()
    assert page["bio"] == "just the bio"
    assert page["avatar"] is not None and page["avatar"]["w"] == 2


def test_somebody_elses_token_cannot_edit_a_page(client, token):
    client.post("/v1/registry/claim", json={"handle": "mine", "name": "M"}, headers=auth(token))
    db = registry.connect(); other = registry.mint_token(db, "them"); db.close()
    r = client.patch("/v1/registry/b/mine", json={"bio": "hi"}, headers=auth(other))
    # 404 rather than 403: a token that is not this builder's has no business
    # learning whether this builder exists.
    assert r.status_code == 404
    assert client.patch("/v1/registry/b/mine", json={"bio": "hi"}).status_code == 401


@pytest.mark.parametrize("bad,why", [
    ({"w": 2, "h": 2, "pixels": [["00000000"] * 8]}, "which needs 4"),
    ({"w": 1, "h": 1, "pixels": [["0000000x"] * 8]}, "is not a colour"),
    ({"w": 1, "h": 1, "pixels": [["000000"] * 8]}, "a row is 8"),
])
def test_art_that_is_not_art_is_refused(client, token, bad, why):
    client.post("/v1/registry/claim", json={"handle": "artist", "name": "A"}, headers=auth(token))
    r = client.patch("/v1/registry/b/artist", json={"avatar": bad}, headers=auth(token))
    assert r.status_code == 422, r.text
    assert why in r.json()["detail"]["error"]


def test_a_link_has_to_be_https(client, token):
    client.post("/v1/registry/claim", json={"handle": "linker", "name": "L"}, headers=auth(token))
    r = client.patch("/v1/registry/b/linker", headers=auth(token),
                     json={"links": [{"label": "x", "url": "javascript:alert(1)"}]})
    assert r.status_code == 422
    assert "not an https URL" in r.json()["detail"]["error"]


# -- ROMs --------------------------------------------------------------------

def test_publishing_stores_the_cartridge_byte_for_byte(client, token):
    client.post("/v1/registry/claim", json={"handle": "pub", "name": "P"}, headers=auth(token))
    blob = mint_cart(client, "Tiny One")
    r = client.put("/v1/registry/b/pub/roms/tiny", headers=auth(token),
                   json={"cart": b64(blob), "blurb": "a first thing",
                         "cover": art(4, 3, "2")})
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["title"] == "Tiny One" and got["blurb"] == "a first thing"
    assert got["cover"]["w"] == 4 and got["cover"]["h"] == 3
    back = client.get("/v1/registry/b/pub/roms/tiny/cart")
    assert back.status_code == 200
    assert back.content == blob, "a cartridge must come back exactly as published"
    assert back.headers["content-type"] == "application/gzip"


def test_the_registry_measures_rather_than_believes(client, token):
    """The load-bearing one. A cartridge is a file somebody can edit, so its
    own verify block is a claim by its author. Publish one that claims a
    12-half-cycle frame and the registry prints what the chip did."""
    client.post("/v1/registry/claim", json={"handle": "liar", "name": "L"}, headers=auth(token))
    doc = json.loads(gzip.decompress(mint_cart(client, "Fast")))
    doc["verify"]["frame_cost"] = 12
    doc["verify"]["frames_completed"] = 999
    doc["console"]["frame_cost"] = 12
    r = client.put("/v1/registry/b/liar/roms/fast", headers=auth(token),
                   json={"cart": b64(cartridge.pack(doc)), "frames": 2})
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["frame_cost"] > 1000, "the registry believed the file"
    assert got["measured"]["frames_completed"] == 2
    assert got["measured"]["frame_cost"] == got["frame_cost"]


def test_a_rom_that_does_not_run_is_not_published(client, token):
    client.post("/v1/registry/claim", json={"handle": "broke", "name": "B"}, headers=auth(token))
    blob = mint_cart(client, "Broken", source=NEVER, frames=0)
    r = client.put("/v1/registry/b/broke/roms/broken", headers=auth(token),
                   json={"cart": b64(blob), "frames": 2})
    assert r.status_code == 422
    assert "not publishable" in r.json()["detail"]["error"]
    assert client.get("/v1/registry/b/broke").json()["roms"] == []


def test_a_file_that_is_not_a_cartridge_is_refused(client, token):
    client.post("/v1/registry/claim", json={"handle": "nope", "name": "N"}, headers=auth(token))
    for payload, why in [(b64(gzip.compress(b"hello")), "not a cartridge"),
                         ("not base64!!", "not base64")]:
        r = client.put("/v1/registry/b/nope/roms/x", headers=auth(token),
                       json={"cart": payload})
        assert r.status_code == 422, payload[:20]
        assert why in r.json()["detail"]["error"]


def test_republishing_keeps_the_slug_and_the_created_date(client, token):
    client.post("/v1/registry/claim", json={"handle": "iter", "name": "I"}, headers=auth(token))
    first = client.put("/v1/registry/b/iter/roms/game", headers=auth(token),
                       json={"cart": b64(mint_cart(client, "V1"))}).json()
    second = client.put("/v1/registry/b/iter/roms/game", headers=auth(token),
                        json={"cart": b64(mint_cart(client, "V2"))}).json()
    assert second["created"] == first["created"]
    assert second["title"] == "V2"
    assert len(client.get("/v1/registry/b/iter").json()["roms"]) == 1


def test_republishing_without_a_cover_keeps_the_one_there(client, token):
    client.post("/v1/registry/claim", json={"handle": "cov", "name": "C"}, headers=auth(token))
    client.put("/v1/registry/b/cov/roms/go", headers=auth(token),
               json={"cart": b64(mint_cart(client)), "cover": art(2, 2, "3")})
    again = client.put("/v1/registry/b/cov/roms/go", headers=auth(token),
                       json={"cart": b64(mint_cart(client))}).json()
    assert again["cover"] is not None and again["cover"]["w"] == 2


def test_unpublishing_removes_it(client, token):
    client.post("/v1/registry/claim", json={"handle": "rm", "name": "R"}, headers=auth(token))
    client.put("/v1/registry/b/rm/roms/go", headers=auth(token),
               json={"cart": b64(mint_cart(client))})
    assert client.delete("/v1/registry/b/rm/roms/go", headers=auth(token)).status_code == 200
    assert client.get("/v1/registry/b/rm/roms/go").status_code == 404
    assert client.delete("/v1/registry/b/rm/roms/go", headers=auth(token)).status_code == 404


def test_the_index_lists_builders_and_what_is_new(client, token):
    client.post("/v1/registry/claim", json={"handle": "idx", "name": "Index"}, headers=auth(token))
    client.put("/v1/registry/b/idx/roms/go", headers=auth(token),
               json={"cart": b64(mint_cart(client, "Listed"))})
    index = client.get("/v1/registry").json()
    assert index["count"] == 1 and index["roms"] == 1
    assert index["builders"][0]["handle"] == "idx"
    assert index["latest"][0]["title"] == "Listed"
    assert index["latest"][0]["play_url"].endswith("/b/idx/go")
    assert index["limits"]["roms"] == registry.LIMITS["roms"]


def test_a_missing_builder_is_a_404_not_a_crash(client):
    assert client.get("/v1/registry/b/ghost").status_code == 404
    assert client.get("/v1/registry/b/ghost/roms/x").status_code == 404
    assert client.get("/v1/registry/b/ghost/roms/x/cart").status_code == 404


def test_a_reserved_handle_needs_the_admin_path(client, token):
    """The list stops somebody CLAIMING a name that implies they speak for the
    project. It is not protecting those names from whoever owns the machine,
    so `grant` may take one and the HTTP route may not. Weakening the list so
    the project could have its own page would have removed the protection for
    everybody."""
    assert client.post("/v1/registry/claim", json={"handle": "tinymachines", "name": "TM"},
                       headers=auth(token)).status_code == 422
    db = registry.connect()
    out = registry.claim(db, token, "tinymachines", "Tiny Machines", allow_reserved=True)
    db.close()
    assert out["handle"] == "tinymachines"
    assert client.get("/v1/registry/b/tinymachines").status_code == 200
