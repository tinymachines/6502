#!/usr/bin/env python3
"""Slowly pull everything the Wayback Machine holds for visual6502.org.

    python3 archive/tools/drip.py --index      # load the CDX index into the DB
    python3 archive/tools/drip.py              # fetch, resumable, Ctrl-C safe
    python3 archive/tools/drip.py --status     # progress and ETA
    python3 archive/tools/drip.py --delay 3    # be gentler

This is the completionist pass. The targeted harvest recovered the wiki and the
die photography -- the parts that were known to be worth having. This one takes
the whole domain index and works through it, on the assumption that the cheapest
time to collect something is before anyone has decided it matters.

Designed to run for days:

* **Resumable at any moment.** State lives in SQLite, one row per URL, committed
  as it goes. Killing the process loses at most the request in flight.
* **Content-addressed with hardlinks.** The CDX index carries a digest per
  capture, so a URL whose content we already hold is hardlinked rather than
  refetched. On a wiki this is most of the corpus -- MediaWiki serves the same
  navigation chrome under thousands of distinct URLs -- and on a drip measured in
  requests per second, not fetching is the only real optimisation available.
* **Polite by construction.** One request at a time, a delay between each, and
  exponential backoff on the 429s the Archive uses to push back. The Internet
  Archive is a charity preserving this material for everyone; hammering it to
  save ourselves an afternoon would be a poor trade.

Failures are recorded, not fatal. A URL that fails is left pending with its
error and attempt count, so a later run retries it without disturbing the rest.
"""

import argparse
import hashlib
import json
import os
import random
import re
import signal
import sqlite3
import sys
import time
import urllib.error
import urllib.parse as up
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CDX = ROOT / "cdx-full"
OUT = ROOT / "wayback"
FILES = OUT / "files"
DB = OUT / "state.db"

UA = ("Mozilla/5.0 (compatible; archival retrieval for preservation; "
      "contact via github.com/tinymachines/6502)")
MAX_NAME = 150          # leave room for the digest suffix within 255-byte names

stop = False


def _sigint(*_):
    global stop
    stop = True
    print("\n  stopping after the current request (state is already saved)...")


# --------------------------------------------------------------------------

def connect() -> sqlite3.Connection:
    OUT.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB, timeout=60)
    db.execute("PRAGMA journal_mode=WAL")     # survives a hard kill mid-write
    db.execute("""CREATE TABLE IF NOT EXISTS urls (
        url        TEXT PRIMARY KEY,
        timestamp  TEXT,
        mime       TEXT,
        length     INTEGER,
        digest     TEXT,
        path       TEXT,            -- relative to files/, once fetched
        state      TEXT DEFAULT 'pending',   -- pending|done|failed|skipped
        attempts   INTEGER DEFAULT 0,
        error      TEXT,
        fetched_at TEXT
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS idx_state ON urls(state)")
    # Digest -> first local path holding those bytes, for hardlink dedupe.
    db.execute("""CREATE TABLE IF NOT EXISTS blobs (
        digest TEXT PRIMARY KEY, path TEXT)""")
    db.commit()
    return db


def safe_path(url: str) -> str:
    """A filesystem path mirroring the URL, including its query string.

    MediaWiki puts the entire page identity in the query (index.php?title=X),
    so dropping it would collapse thousands of distinct pages onto one file.
    Long or awkward names are truncated and given a hash suffix, which keeps
    them unique without any component exceeding what a filesystem accepts.
    """
    u = up.urlparse(url)
    host = u.netloc.lower().replace(":80", "")
    path = up.unquote(u.path)
    parts = [p for p in path.split("/") if p not in ("", ".", "..")]
    # A URL ending in "/" is a directory listing, and something else in the
    # index almost certainly lives underneath it. Naming it index.html keeps the
    # directory free for its children instead of racing them for the name.
    if not parts or path.endswith("/"):
        parts.append("index.html")
    if u.query:
        parts[-1] += "@" + up.unquote(u.query)

    clean = []
    for p in parts:
        p = re.sub(r'[\x00-\x1f<>:"\\|?*]', "_", p).strip() or "_"
        if len(p.encode()) > MAX_NAME:
            h = hashlib.sha1(p.encode()).hexdigest()[:10]
            p = p.encode()[:MAX_NAME].decode("utf-8", "ignore") + "~" + h
        clean.append(p)
    # A path that is a file in one capture and a directory in another would
    # collide; the suffix keeps both.
    return "/".join([host] + clean)


def wb_url(timestamp: str, original: str) -> str:
    """Original archived bytes: no toolbar, no rewritten links."""
    return f"https://web.archive.org/web/{timestamp}id_/{original}"


def prepare_dest(db: sqlite3.Connection, rel: str) -> Path:
    """Resolve file/directory name collisions, self-healing in either order.

    A URL can be both a page and a directory prefix -- /images serves a listing
    and /images/6502/x.png lives under it -- and the index yields them in
    arbitrary order. Whichever arrives first would otherwise claim the name and
    make the other unwritable, which is how the first run of this died.

    The web's own convention resolves it: a path that is also a directory keeps
    its content at <path>/index.html. Applied to whichever side is already on
    disk, so neither ordering loses.
    """
    dest = FILES / rel

    # An ancestor already written as a file: move it into its own directory.
    for i in range(1, len(dest.relative_to(FILES).parts)):
        anc = FILES / Path(*dest.relative_to(FILES).parts[:i])
        if anc.is_file():
            tmp = anc.with_name(anc.name + ".__tmp")
            anc.rename(tmp)
            anc.mkdir(parents=True, exist_ok=True)
            tmp.rename(anc / "index.html")
            moved = str((anc / "index.html").relative_to(FILES))
            db.execute("UPDATE urls SET path=? WHERE path=?",
                       (moved, str(anc.relative_to(FILES))))
            db.execute("UPDATE blobs SET path=? WHERE path=?",
                       (moved, str(anc.relative_to(FILES))))
            db.commit()

    # The target itself is already a directory: put the page inside it.
    if dest.is_dir():
        dest = dest / "index.html"
    return dest


# --------------------------------------------------------------------------

def load_index(db: sqlite3.Connection) -> None:
    if not CDX.exists() or not any(CDX.glob("*.json")):
        sys.exit(f"no CDX index in {CDX} -- fetch it first (see README)")
    n_new = n_seen = 0
    for f in sorted(CDX.glob("*.json")):
        try:
            rows = json.loads(f.read_text())
        except json.JSONDecodeError:
            print(f"  skipping unreadable {f.name}")
            continue
        if rows and rows[0][0] == "original":
            rows = rows[1:]
        for r in rows:
            orig, ts, mime, length, digest = (r + [None] * 5)[:5]
            n_seen += 1
            try:
                length = int(length)
            except (TypeError, ValueError):
                length = 0
            cur = db.execute(
                "INSERT OR IGNORE INTO urls(url,timestamp,mime,length,digest) "
                "VALUES(?,?,?,?,?)", (orig, ts, mime, length, digest))
            n_new += cur.rowcount
        db.commit()
        print(f"  {f.name}: {len(rows)} rows")
    print(f"index: {n_seen} rows, {n_new} new URLs")


def fetch(url: str, tries: int = 4) -> tuple:
    """Return (body, error). Backs off on the Archive's throttling responses."""
    for attempt in range(tries):
        if stop:
            return None, "interrupted"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=300) as r:
                return r.read(), None
        except urllib.error.HTTPError as e:
            if e.code in (429, 503, 502, 504) and attempt < tries - 1:
                # The Archive is asking us to slow down. Obey generously.
                time.sleep(30 * (attempt + 1) + random.uniform(0, 10))
                continue
            return None, f"HTTP {e.code}"
        except Exception as e:  # noqa: BLE001
            if attempt < tries - 1:
                time.sleep(10 * (attempt + 1))
                continue
            return None, f"{type(e).__name__}: {e}"
    return None, "exhausted"


def run(db: sqlite3.Connection, delay: float, limit: int) -> None:
    todo = db.execute(
        "SELECT url,timestamp,digest FROM urls "
        "WHERE state IN ('pending','failed') AND attempts < 5 "
        "ORDER BY attempts, rowid").fetchall()
    if limit:
        todo = todo[:limit]
    total = len(todo)
    print(f"{total} URLs to fetch (delay {delay}s)")
    if not total:
        return

    done = linked = failed = 0
    t0 = time.time()
    for i, (url, ts, digest) in enumerate(todo, 1):
        if stop:
            break
        try:
            dest = prepare_dest(db, safe_path(url))
        except OSError as e:
            db.execute("UPDATE urls SET state='failed', attempts=attempts+1, "
                       "error=? WHERE url=?", (f"path: {e}", url))
            db.commit()
            failed += 1
            continue
        rel = str(dest.relative_to(FILES))

        # Content we already hold under another URL: hardlink instead of
        # refetching. This is where most of the time is saved.
        prior = db.execute("SELECT path FROM blobs WHERE digest=?",
                           (digest,)).fetchone() if digest else None
        if prior and (FILES / prior[0]).is_file():
            try:
                dest.parent.mkdir(parents=True, exist_ok=True)
                if not dest.exists():
                    os.link(FILES / prior[0], dest)
                db.execute("UPDATE urls SET state='done', path=?, "
                           "fetched_at=datetime('now') WHERE url=?", (rel, url))
                db.commit()
                linked += 1
                continue
            except OSError:
                pass   # cross-device or name clash: fall through and fetch

        body, err = fetch(wb_url(ts, url))
        if body is None:
            db.execute("UPDATE urls SET state='failed', attempts=attempts+1, "
                       "error=? WHERE url=?", (err, url))
            db.commit()
            failed += 1
            if err == "interrupted":
                break
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            try:
                dest.write_bytes(body)
            except OSError as e:
                db.execute("UPDATE urls SET state='failed', attempts=attempts+1,"
                           " error=? WHERE url=?", (f"write: {e}", url))
                db.commit()
                failed += 1
                continue
            if digest:
                db.execute("INSERT OR IGNORE INTO blobs(digest,path) VALUES(?,?)",
                           (digest, rel))
            db.execute("UPDATE urls SET state='done', path=?, "
                       "fetched_at=datetime('now') WHERE url=?", (rel, url))
            db.commit()
            done += 1
            time.sleep(delay + random.uniform(0, delay * 0.4))

        if i % 25 == 0 or i == total:
            el = time.time() - t0
            rate = i / el if el else 0
            eta = (total - i) / rate if rate else 0
            print(f"  {i}/{total}  fetched={done} linked={linked} failed={failed}"
                  f"  {rate * 60:.0f}/min  eta {eta / 3600:.1f}h", flush=True)

    print(f"\nfetched {done}, hardlinked {linked}, failed {failed}")


def status(db: sqlite3.Connection) -> None:
    rows = dict(db.execute("SELECT state, count(*) FROM urls GROUP BY state"))
    total = sum(rows.values())
    print(f"{total} URLs in index")
    for k in ("done", "pending", "failed", "skipped"):
        if rows.get(k):
            print(f"  {rows[k]:7} {k}")
    n_blob = db.execute("SELECT count(*) FROM blobs").fetchone()[0]
    if n_blob:
        print(f"  {n_blob} distinct content blobs "
              f"({rows.get('done', 0) - n_blob} URLs deduplicated)")
    size = sum(f.stat().st_size for f in FILES.rglob("*") if f.is_file()) \
        if FILES.exists() else 0
    print(f"  {size / 1e9:.2f} GB on disk (hardlinks counted once by du)")
    errs = db.execute("SELECT error, count(*) c FROM urls WHERE state='failed' "
                      "GROUP BY error ORDER BY c DESC LIMIT 6").fetchall()
    for e, c in errs:
        print(f"  {c:6} failed: {e}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", action="store_true", help="load CDX into the DB")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--delay", type=float, default=1.5,
                    help="seconds between requests (default 1.5)")
    ap.add_argument("--limit", type=int, default=0, help="stop after N URLs")
    args = ap.parse_args()

    signal.signal(signal.SIGINT, _sigint)
    signal.signal(signal.SIGTERM, _sigint)
    db = connect()

    if args.index:
        load_index(db)
        status(db)
        return
    if args.status:
        status(db)
        return

    if not db.execute("SELECT count(*) FROM urls").fetchone()[0]:
        print("index is empty; loading it first")
        load_index(db)
    FILES.mkdir(parents=True, exist_ok=True)
    run(db, args.delay, args.limit)
    status(db)


if __name__ == "__main__":
    main()
