"""The ROM registry: builders, their pages, and the cartridges they publish.

    python3 service/registry_admin.py mint --note "who this is for"

**This is the one stateful thing in the service, and the boundary is the
point.** The chip stays stateless: every request still carries the whole
machine, and nothing here changes that. What is stored is a *catalogue* --
who a builder is, and which cartridges they published. Running one still
means POSTing it, and any instance can still answer any request.

Storage is one SQLite file (`REGISTRY_DB`, default beside the service), for
the reason the archive's drip uses one: a row per thing, committed as it
goes, and a kill loses at most the write in flight. No ORM and no migration
framework; `init()` is idempotent DDL.

Two rules that shape everything else:

**Facts about a ROM are read out of the cartridge, and then measured again.**
A builder uploads the .cart.gz and nothing else: the title, the ROM size, the
tile count and the frame cost come out of the file, and the verification is
re-run here on the chip rather than trusting the `verify` block the file
arrived with. A cartridge is a file somebody can edit, so its own report of
how well it works is not evidence. What the registry publishes about a ROM is
what the registry measured.

**The server accepts art only as rows of '0'..'3'.** Converting a photo is the
client's job (games/art.js does it in a canvas), so nothing here decodes an
image: no image parser in the request path, no arbitrary bytes on disk, and
the stored form is CHR -- the console's own tile encoding -- so the same
decodeCHR and drawScreen that draw the game draw the portrait. The four
colours are the die's mask layers, which is why every builder page looks like
the console.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import secrets
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import cartridge

DB_PATH = Path(os.environ.get("REGISTRY_DB") or (Path(__file__).resolve().parent / "registry.db"))

# A handle is a URL. Reserved names are the paths the site already uses, plus
# the ones a person would assume mean something: a builder called `api` whose
# page is /b/api is only confusing, and a builder called `admin` is worse.
# Two characters to thirty-two, no leading or trailing dash. Written as
# first-middle-last rather than as an optional group: the optional-group
# spelling matched lengths of 1 and 3-and-up and never 2, so `rm` was refused
# while `a` was accepted, and the error message said "2 to 32" the whole time.
HANDLE = re.compile(r"^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$")
# Reserved as HANDLES only. A handle is a top-level path (/b/<handle>), so
# one called `api` or `admin` is confusing at best. A slug is not: it lives
# under a builder (/b/ada/game), collides with nothing, and a registry that
# refuses to let somebody call their game "game" is broken. check_slug takes
# the character rule and not this list.
RESERVED = {
    "api", "admin", "root", "www", "mail", "static", "assets", "b", "builders",
    "rom", "roms", "cart", "cartridge", "console", "games", "game", "new",
    "edit", "manage", "login", "logout", "token", "tokens", "help", "about",
    "index", "null", "undefined", "system", "support", "official",
    "tinymachines", "6502",
}

LIMITS = {
    "name": 64, "bio": 600, "title": 64, "blurb": 400,
    "links": 6, "link_label": 32, "link_url": 200,
    "avatar_tiles": 8,        # 8x8 tiles, so 64x64 pixels
    "cover_tiles": 24,        # up to 24x24 tiles, so 192x192
    "cart_bytes": 262144,
    "roms": 32,
    "builders_per_token": 1,
}

LINK_URL = re.compile(r"^https://[a-zA-Z0-9.\-]+(?::\d+)?(?:/[^\s]*)?$")


class RegistryError(Exception):
    """A refusal with a reason the builder can act on."""

    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# -- the store ---------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS builders (
  handle    TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  bio       TEXT NOT NULL DEFAULT '',
  links     TEXT NOT NULL DEFAULT '[]',
  avatar    BLOB,
  avatar_w  INTEGER,
  avatar_h  INTEGER,
  created   TEXT NOT NULL,
  updated   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  hash      TEXT PRIMARY KEY,
  handle    TEXT,
  note      TEXT NOT NULL DEFAULT '',
  created   TEXT NOT NULL,
  used      TEXT,
  revoked   TEXT
);
CREATE TABLE IF NOT EXISTS roms (
  handle    TEXT NOT NULL,
  slug      TEXT NOT NULL,
  title     TEXT NOT NULL,
  blurb     TEXT NOT NULL DEFAULT '',
  cart      BLOB NOT NULL,
  sha256    TEXT NOT NULL,
  rom_size  INTEGER NOT NULL,
  tiles     INTEGER NOT NULL,
  frame_cost INTEGER,
  measured  TEXT NOT NULL,
  cover     BLOB,
  cover_w   INTEGER,
  cover_h   INTEGER,
  created   TEXT NOT NULL,
  updated   TEXT NOT NULL,
  PRIMARY KEY (handle, slug)
);
CREATE INDEX IF NOT EXISTS roms_by_builder ON roms(handle, updated DESC);
"""


def connect(path: Path | None = None) -> sqlite3.Connection:
    db = sqlite3.connect(path or DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    # A registry write is one row and a read is a page load; WAL keeps a
    # publish from blocking every reader while the chip is being run.
    db.execute("PRAGMA journal_mode = WAL")
    return db


def init(db: sqlite3.Connection) -> None:
    db.executescript(SCHEMA)
    db.commit()


# -- tokens ------------------------------------------------------------------
#
# A token is shown once, at minting, and never stored: what the table holds is
# its SHA-256. That is not ceremony -- a registry whose database contains
# every builder's credential in the clear is one backup away from handing them
# out, and nothing here needs the original.


def hash_token(token: str) -> str:
    return hashlib.sha256(token.strip().encode()).hexdigest()


def mint_token(db: sqlite3.Connection, note: str = "") -> str:
    token = "tm6502_" + secrets.token_urlsafe(24)
    db.execute("INSERT INTO tokens (hash, note, created) VALUES (?, ?, ?)",
               (hash_token(token), note[:120], now()))
    db.commit()
    return token


def authorise(db: sqlite3.Connection, token: str | None) -> sqlite3.Row:
    if not token:
        raise RegistryError("no token: send Authorization: Bearer <token>", 401)
    row = db.execute("SELECT * FROM tokens WHERE hash = ?", (hash_token(token),)).fetchone()
    if row is None or row["revoked"]:
        # One message for both, on purpose: telling the difference between an
        # unknown token and a revoked one is telling somebody which guesses
        # were close.
        raise RegistryError("that token is not valid", 401)
    db.execute("UPDATE tokens SET used = ? WHERE hash = ?", (now(), row["hash"]))
    db.commit()
    return row


def owner_of(db: sqlite3.Connection, token: str | None, handle: str) -> sqlite3.Row:
    row = authorise(db, token)
    if row["handle"] != handle:
        # 404 rather than 403: a token that is not this builder's has no
        # business learning whether this builder exists.
        raise RegistryError(f"no builder {handle!r}", 404)
    return row


# -- validation --------------------------------------------------------------

def check_handle(handle: str, allow_reserved: bool = False) -> str:
    h = (handle or "").strip().lower()
    if not HANDLE.match(h):
        raise RegistryError(
            f"{handle!r} is not a handle: 2 to 32 characters, lowercase letters, "
            f"digits and dashes, starting and ending with a letter or digit"
        )
    # `allow_reserved` is reachable only from registry_admin.py, which is run
    # by whoever owns the machine. The list exists so that nobody CLAIMS a
    # name implying they speak for the project; the person who can already
    # read the database is not who it is protecting the name from. Weakening
    # the list to let the project have its own page would have removed the
    # protection for everyone.
    if h in RESERVED and not allow_reserved:
        raise RegistryError(f"{h!r} is reserved")
    return h


def check_slug(slug: str) -> str:
    """A ROM's name in a URL. Same characters as a handle, no reserved list:
    see RESERVED for why the two are different questions."""
    sl = (slug or "").strip().lower()
    if not HANDLE.match(sl):
        raise RegistryError(
            f"{slug!r} is not a name for a URL: 2 to 32 characters, lowercase "
            f"letters, digits and dashes, starting and ending with a letter or digit"
        )
    return sl


def check_text(value: str | None, field: str, limit: int, required: bool = False) -> str:
    text = (value or "").strip()
    if required and not text:
        raise RegistryError(f"{field} is required")
    if len(text) > limit:
        raise RegistryError(f"{field} is {len(text)} characters; the limit is {limit}")
    # A control character in a name is either a mistake or an attempt to make
    # one row look like another in a listing.
    if any(ord(c) < 32 and c not in "\n\t" for c in text):
        raise RegistryError(f"{field} contains a control character")
    return text


def check_links(links: list | None) -> str:
    out = []
    for i, link in enumerate(links or []):
        if len(out) >= LIMITS["links"]:
            raise RegistryError(f"at most {LIMITS['links']} links")
        if not isinstance(link, dict):
            raise RegistryError(f"link {i} is not an object with a label and a url")
        url = check_text(link.get("url"), f"link {i} url", LIMITS["link_url"], required=True)
        if not LINK_URL.match(url):
            raise RegistryError(
                f"link {i}: {url!r} is not an https URL. Only https is accepted, "
                f"because these are printed on a page other people click."
            )
        out.append({
            "label": check_text(link.get("label"), f"link {i} label",
                                LIMITS["link_label"], required=True),
            "url": url,
        })
    return json.dumps(out)


def check_art(art: dict | None, field: str, max_tiles: int) -> tuple[bytes | None, int, int]:
    """Rows of '0'..'3', into the console's own tile encoding.

    Nothing here decodes an image. The client converts a photo in a canvas and
    sends the grid, so the request path has no image parser in it and what
    lands on disk is CHR: the same bytes a sprite sheet is made of, drawn back
    by the same decodeCHR the game uses.
    """
    if not art:
        return None, 0, 0
    try:
        w, h = int(art.get("w", 0)), int(art.get("h", 0))
    except (TypeError, ValueError) as e:
        raise RegistryError(f"{field}: w and h are tile counts") from e
    if not (1 <= w <= max_tiles and 1 <= h <= max_tiles):
        raise RegistryError(f"{field} is {w}x{h} tiles; 1x1 to {max_tiles}x{max_tiles}")
    pixels = art.get("pixels")
    if not isinstance(pixels, list) or len(pixels) != w * h:
        raise RegistryError(
            f"{field}: {len(pixels) if isinstance(pixels, list) else 'no'} tiles for a "
            f"{w}x{h} image, which needs {w * h}, row major"
        )
    try:
        blob = cartridge.pixels_to_chr(pixels)
    except cartridge.CartridgeError as e:
        raise RegistryError(f"{field}: {e}") from e
    return blob, w, h


# -- builders ----------------------------------------------------------------

def claim(db: sqlite3.Connection, token: str, handle: str, name: str,
          allow_reserved: bool = False) -> dict:
    row = authorise(db, token)
    if row["handle"]:
        raise RegistryError(
            f"that token already belongs to {row['handle']!r}. One token, one "
            f"builder; ask for another if you want a second page.", 409
        )
    h = check_handle(handle, allow_reserved=allow_reserved)
    name = check_text(name, "name", LIMITS["name"], required=True)
    if db.execute("SELECT 1 FROM builders WHERE handle = ?", (h,)).fetchone():
        raise RegistryError(f"{h!r} is taken", 409)
    stamp = now()
    db.execute(
        "INSERT INTO builders (handle, name, created, updated) VALUES (?, ?, ?, ?)",
        (h, name, stamp, stamp))
    db.execute("UPDATE tokens SET handle = ? WHERE hash = ?", (h, row["hash"]))
    db.commit()
    return builder(db, h)


def update_builder(db: sqlite3.Connection, handle: str, patch: dict) -> dict:
    fields, values = [], []
    if "name" in patch:
        fields.append("name = ?")
        values.append(check_text(patch["name"], "name", LIMITS["name"], required=True))
    if "bio" in patch:
        fields.append("bio = ?")
        values.append(check_text(patch["bio"], "bio", LIMITS["bio"]))
    if "links" in patch:
        fields.append("links = ?")
        values.append(check_links(patch["links"]))
    if "avatar" in patch:
        blob, w, h = check_art(patch["avatar"], "avatar", LIMITS["avatar_tiles"])
        fields += ["avatar = ?", "avatar_w = ?", "avatar_h = ?"]
        values += [blob, w or None, h or None]
    if not fields:
        raise RegistryError("nothing to change")
    fields.append("updated = ?")
    values += [now(), handle]
    db.execute(f"UPDATE builders SET {', '.join(fields)} WHERE handle = ?", values)
    db.commit()
    return builder(db, handle)


def builder(db: sqlite3.Connection, handle: str, with_roms: bool = True) -> dict:
    row = db.execute("SELECT * FROM builders WHERE handle = ?", (handle,)).fetchone()
    if row is None:
        raise RegistryError(f"no builder {handle!r}", 404)
    out = {
        "handle": row["handle"],
        "name": row["name"],
        "bio": row["bio"],
        "links": json.loads(row["links"]),
        "avatar": ({"w": row["avatar_w"], "h": row["avatar_h"], "chr": row["avatar"].hex()}
                   if row["avatar"] else None),
        "created": row["created"],
        "updated": row["updated"],
    }
    if with_roms:
        out["roms"] = [rom_brief(r) for r in db.execute(
            "SELECT * FROM roms WHERE handle = ? ORDER BY updated DESC", (handle,))]
    return out


def builders(db: sqlite3.Connection, limit: int = 100, offset: int = 0) -> dict:
    rows = db.execute(
        "SELECT b.*, (SELECT COUNT(*) FROM roms r WHERE r.handle = b.handle) AS roms "
        "FROM builders b ORDER BY b.updated DESC LIMIT ? OFFSET ?", (limit, offset))
    return {
        "count": db.execute("SELECT COUNT(*) FROM builders").fetchone()[0],
        "roms": db.execute("SELECT COUNT(*) FROM roms").fetchone()[0],
        "builders": [{
            "handle": r["handle"], "name": r["name"], "bio": r["bio"],
            "roms": r["roms"], "updated": r["updated"],
            "avatar": ({"w": r["avatar_w"], "h": r["avatar_h"], "chr": r["avatar"].hex()}
                       if r["avatar"] else None),
        } for r in rows],
    }


# -- roms --------------------------------------------------------------------

def rom_brief(r: sqlite3.Row) -> dict:
    return {
        "slug": r["slug"], "handle": r["handle"], "title": r["title"], "blurb": r["blurb"],
        "rom_size": r["rom_size"], "tiles": r["tiles"], "frame_cost": r["frame_cost"],
        "sha256": r["sha256"], "bytes": len(r["cart"]),
        "measured": json.loads(r["measured"]),
        "cover": ({"w": r["cover_w"], "h": r["cover_h"], "chr": r["cover"].hex()}
                  if r["cover"] else None),
        "created": r["created"], "updated": r["updated"],
        "cart_url": f"/v1/registry/b/{r['handle']}/roms/{r['slug']}/cart",
        "play_url": f"https://games.tinymachines.ai/b/{r['handle']}/{r['slug']}",
    }


def read_cartridge(blob: bytes) -> dict:
    if len(blob) > LIMITS["cart_bytes"]:
        raise RegistryError(
            f"that cartridge is {len(blob)} bytes; the limit is {LIMITS['cart_bytes']}")
    try:
        return cartridge.unpack(blob)
    except cartridge.CartridgeError as e:
        raise RegistryError(f"that is not a cartridge: {e}")


def publish(db: sqlite3.Connection, handle: str, slug: str, blob: bytes,
            measured: dict, patch: dict) -> dict:
    """Store a cartridge, with what the registry measured about it.

    `measured` is the caller's verification report, run here on the chip. It
    is not the file's own `verify` block: a cartridge is a file somebody can
    edit, so its account of how well it works is not evidence. What is
    published is what was measured.
    """
    slug = check_slug(slug)
    doc = read_cartridge(blob)
    existing = db.execute("SELECT created FROM roms WHERE handle = ? AND slug = ?",
                          (handle, slug)).fetchone()
    if existing is None:
        n = db.execute("SELECT COUNT(*) FROM roms WHERE handle = ?", (handle,)).fetchone()[0]
        if n >= LIMITS["roms"]:
            raise RegistryError(f"{handle} already has {n} ROMs; the limit is {LIMITS['roms']}")

    title = check_text(patch.get("title") or doc["meta"].get("name"), "title",
                       LIMITS["title"], required=True)
    blurb = check_text(patch.get("blurb") if patch.get("blurb") is not None
                       else doc["meta"].get("blurb"), "blurb", LIMITS["blurb"])
    cover, cw, ch = check_art(patch.get("cover"), "cover", LIMITS["cover_tiles"])
    stamp = now()
    db.execute(
        "INSERT INTO roms (handle, slug, title, blurb, cart, sha256, rom_size, tiles, "
        "  frame_cost, measured, cover, cover_w, cover_h, created, updated) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(handle, slug) DO UPDATE SET "
        "  title=excluded.title, blurb=excluded.blurb, cart=excluded.cart, "
        "  sha256=excluded.sha256, rom_size=excluded.rom_size, tiles=excluded.tiles, "
        "  frame_cost=excluded.frame_cost, measured=excluded.measured, "
        "  cover=COALESCE(excluded.cover, roms.cover), "
        "  cover_w=COALESCE(excluded.cover_w, roms.cover_w), "
        "  cover_h=COALESCE(excluded.cover_h, roms.cover_h), updated=excluded.updated",
        (handle, slug, title, blurb, blob, hashlib.sha256(blob).hexdigest(),
         doc["rom"]["size"], doc["tiles"]["count"], measured.get("frame_cost"),
         json.dumps(measured), cover, cw or None, ch or None,
         existing["created"] if existing else stamp, stamp))
    db.commit()
    return rom(db, handle, slug)


def rom(db: sqlite3.Connection, handle: str, slug: str) -> dict:
    r = db.execute("SELECT * FROM roms WHERE handle = ? AND slug = ?",
                   (handle, slug)).fetchone()
    if r is None:
        raise RegistryError(f"no ROM {handle}/{slug}", 404)
    return rom_brief(r)


def rom_bytes(db: sqlite3.Connection, handle: str, slug: str) -> bytes:
    r = db.execute("SELECT cart FROM roms WHERE handle = ? AND slug = ?",
                   (handle, slug)).fetchone()
    if r is None:
        raise RegistryError(f"no ROM {handle}/{slug}", 404)
    return r["cart"]


def unpublish(db: sqlite3.Connection, handle: str, slug: str) -> dict:
    cur = db.execute("DELETE FROM roms WHERE handle = ? AND slug = ?", (handle, slug))
    db.commit()
    if not cur.rowcount:
        raise RegistryError(f"no ROM {handle}/{slug}", 404)
    return {"removed": f"{handle}/{slug}"}


def latest(db: sqlite3.Connection, limit: int = 24) -> list[dict]:
    return [rom_brief(r) for r in db.execute(
        "SELECT * FROM roms ORDER BY updated DESC LIMIT ?", (limit,))]
