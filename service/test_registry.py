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


# -- listings that can be paged through ---------------------------------------
#
# The four below are what tinymachines/6502#9 asked for, and each one is here
# because the roof could not do something without it.


@pytest.fixture()
def populated(client, token):
    """One builder with an avatar and two published ROMs, both with covers.

    Enough to make the listings interesting: art on every object, two rows to
    sort, and a builder to filter by.
    """
    client.post("/v1/registry/claim", json={"handle": "ada", "name": "Ada"}, headers=auth(token))
    # The shapes the live registry actually holds: an 8x8 avatar, which is the
    # limit, and a 16x12 cover. The size assertion below is about what a real
    # listing weighs, and a one-tile avatar would make it pass on nothing.
    client.patch("/v1/registry/b/ada", headers=auth(token), json={"avatar": art(8, 8)})
    for slug, name in (("first", "First"), ("second", "Second")):
        r = client.put(f"/v1/registry/b/ada/roms/{slug}", headers=auth(token),
                       json={"cart": b64(mint_cart(client, name)), "frames": 2,
                             "cover": art(16, 12)})
        assert r.status_code == 200, r.text
    return token


def test_art_can_be_declined_and_the_dimensions_stay(client, populated):
    """The one that blocked a listing UI outright.

    A cover is most of what a ROM entry weighs and an avatar most of a
    builder's, and there was no way to ask for the listing without them. The
    dimensions stay, because they are what lets a client lay out a box before
    the bytes arrive, and they are eight bytes rather than eight kilobytes.
    """
    full = client.get("/v1/registry").json()
    lean = client.get("/v1/registry?art=none").json()

    assert "chr" in full["builders"][0]["avatar"]
    assert "chr" not in lean["builders"][0]["avatar"]
    assert lean["builders"][0]["avatar"]["url"] == "/v1/registry/b/ada/avatar"
    assert lean["builders"][0]["avatar"]["w"] == full["builders"][0]["avatar"]["w"]

    assert "chr" not in lean["latest"][0]["cover"]
    assert lean["latest"][0]["cover"]["url"].endswith("/cover")

    # The point of the parameter, stated as a measurement rather than a hope.
    # On the live registry a cover is 6,173 of the 7,016 bytes a ROM entry
    # occupies and an avatar 2,075 of a builder's; this fixture carries the
    # same shapes, so the ratio here is the ratio there.
    big, small = len(json.dumps(full)), len(json.dumps(lean))
    assert small * 4 < big, (
        f"art=none took {big} bytes to {small}, which is not the order of "
        "magnitude that makes a listing pageable"
    )


def test_the_art_is_where_the_listing_says_it_is(client, populated):
    """A url in a listing that does not resolve is worse than no url."""
    lean = client.get("/v1/registry?art=none").json()
    for url in (lean["builders"][0]["avatar"]["url"], lean["latest"][0]["cover"]["url"]):
        r = client.get(url)
        assert r.status_code == 200, f"{url} -> {r.status_code}"
        assert set(r.json()) == {"w", "h", "chr"}, "a different shape from the inline one"

    # Absent and unknown are different facts, and a caller redrawing a page
    # needs to tell them apart.
    client.post("/v1/registry/claim", json={"handle": "bare", "name": "B"},
                headers=auth(registry_token(client)))
    assert client.get("/v1/registry/b/bare/avatar").status_code == 404
    assert client.get("/v1/registry/b/nobody/avatar").status_code == 404


def registry_token(client):
    db = registry.connect()
    registry.init(db)
    t = registry.mint_token(db, "second")
    db.close()
    return t


def test_every_cartridge_in_one_listing(client, populated):
    """Enumerating what has been published used to mean one request per
    builder, each dragging that builder's avatar and every cover."""
    body = client.get("/v1/registry/roms?art=none").json()
    assert body["count"] == 2
    assert [r["slug"] for r in body["roms"]] == ["second", "first"], "not newest first"

    page = client.get("/v1/registry/roms?limit=1&art=none").json()
    assert len(page["roms"]) == 1 and page["count"] == 2, (
        "count is the number matching the filter, not the number returned, or a "
        "caller cannot page without asking twice"
    )
    second = client.get("/v1/registry/roms?limit=1&offset=1&art=none").json()
    assert second["roms"][0]["slug"] != page["roms"][0]["slug"]

    assert client.get("/v1/registry/roms?handle=ada").json()["count"] == 2
    assert client.get("/v1/registry/roms?handle=nobody").json()["count"] == 0


def test_since_asks_for_what_changed(client, populated):
    """A poller's parameter. `updated` is ISO 8601 in UTC and they all have the
    same shape, so lexical order is chronological order."""
    all_of_them = client.get("/v1/registry/roms?art=none").json()
    newest = all_of_them["roms"][0]["updated"]
    # Passed exactly as a caller would copy it out of the previous response,
    # `+00:00` and all. A query string turns that `+` into a space, and the
    # filter used to match everything as a result.
    assert client.get(f"/v1/registry/roms?since={newest}&art=none").json()["count"] == 0
    assert client.get("/v1/registry/roms",
                      params={"since": newest, "art": "none"}).json()["count"] == 0
    assert client.get("/v1/registry/roms?since=1970-01-01T00:00:00+00:00&art=none").json()["count"] == 2


@pytest.mark.parametrize("path", [
    "/v1/registry",
    "/v1/registry/roms",
    "/v1/registry/b/ada",
    "/v1/registry/b/ada/avatar",
])
def test_a_client_that_already_has_it_is_told_so(client, populated, path):
    """These were `no-store` with no validator, so a client watching for
    changes re-downloaded everything or showed stale data with nothing to say
    how stale."""
    first = client.get(path)
    assert first.status_code == 200
    tag = first.headers.get("etag")
    assert tag, f"{path} sends no ETag"

    again = client.get(path, headers={"if-none-match": tag})
    assert again.status_code == 304, f"{path} did not honour If-None-Match"
    assert again.headers.get("etag") == tag
    assert not again.content, "a 304 must carry no body"

    # A tag that is not this one still gets the document.
    assert client.get(path, headers={"if-none-match": 'W/"nope"'}).status_code == 200


def test_the_tag_follows_the_representation_not_the_row(client, populated):
    """`?art=none` and `?art=inline` are different bytes from the same rows.
    A tag derived from max(updated) would have given them the same one, and a
    client switching between them would have been served the wrong body."""
    inline = client.get("/v1/registry").headers["etag"]
    lean = client.get("/v1/registry?art=none").headers["etag"]
    assert inline != lean


def test_the_tag_changes_when_something_is_published(client, populated):
    before = client.get("/v1/registry/roms?art=none").headers["etag"]
    r = client.put("/v1/registry/b/ada/roms/third", headers=auth(populated),
                   json={"cart": b64(mint_cart(client, "Third")), "frames": 2})
    assert r.status_code == 200, r.text
    assert client.get("/v1/registry/roms?art=none").headers["etag"] != before, (
        "the tag survived a publish, which makes it a promise the service cannot keep"
    )


@pytest.mark.parametrize("path", ["/healthz", "/v1/registry", "/v1/registry/roms", "/v1/meta"])
def test_head_is_answered_wherever_get_is(client, populated, path):
    """HEAD was 405 everywhere. RFC 9110 defines it as GET without a body, so a
    resource that answers one answers the other, and a 405 tells a monitor the
    endpoint is broken rather than that it is fine."""
    get, head = client.get(path), client.head(path)
    assert head.status_code == get.status_code == 200
    assert not head.content, "HEAD returned a body"
    assert head.headers.get("content-length") == get.headers.get("content-length"), (
        "the headers should be the ones GET would send, so a client can ask how "
        "big something is without fetching it"
    )


def test_a_headless_cartridge_publishes_and_is_listed_as_one(client, token):
    """The registry runs it (a headless run, not frames) and the listing
    carries the kind, so a page can say "draws nothing" beside it rather
    than a frame cost it does not have."""
    client.post("/v1/registry/claim", json={"handle": "quiet", "name": "Q"}, headers=auth(token))
    r = client.post("/v1/cartridge", json={
        "rom": {"source": "        .org $0200\nloop    INC $0F\n        JMP loop", "org": 0x0200},
        "console": {"kind": "headless", "half_cycles": 400, "peek": [{"addr": 0x0F, "name": "n"}]},
        "meta": {"name": "quiet counter"}})
    assert r.status_code == 200, r.text
    r = client.put("/v1/registry/b/quiet/roms/counter", headers=auth(token),
                   json={"cart": b64(r.content), "frames": 3})
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["kind"] == "headless"
    assert got["frame_cost"] is None and got["tiles"] == 0
    assert got["measured"]["draws_nothing"] is True
    assert got["measured"]["peeked"]["n"] > 0
    listed = client.get("/v1/registry/b/quiet").json()["roms"][0]
    assert listed["kind"] == "headless"
