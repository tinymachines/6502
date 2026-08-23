#!/usr/bin/env python3
"""A place to keep the tokens the registry deliberately cannot.

    python3 tools/keys.py put grok tm6502_...  --note "handed over 2026-08-22"
    python3 tools/keys.py list
    python3 tools/keys.py get grok
    python3 tools/keys.py rm grok

The registry stores only a SHA-256 of every token it mints, which is right:
a copy of that database must not be a copy of everybody's credentials. The
consequence is that **we cannot recover a token we handed out**, and the first
one lived in /tmp, which clears on reboot.

So this is the other half, and it is a different thing with a different rule.
The registry is the *verifier* and keeps no secrets. This is the *issuer's
notebook* and keeps nothing else. Losing this file costs the ability to
re-send a token to whoever holds it; it does not let anybody in, because the
registry authenticates against its own hashes and never reads this.

**SQLite has no server.** It is a library, a file and a lock, so this is a
local store at `~/.tinymachines/keys.db` with the directory 700 and the file
600, reachable by one account on one machine. Putting credentials on a network
port is a different decision with a different threat model, and it is not this.

`list` never prints a secret. `get` does, one at a time, because that is the
whole point of having kept it.
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

HOME = Path(os.environ.get("TM_KEYS_DIR") or (Path.home() / ".tinymachines"))
DB = HOME / "keys.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS keys (
  name    TEXT PRIMARY KEY,
  secret  TEXT NOT NULL,
  kind    TEXT NOT NULL DEFAULT 'token',
  note    TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    # 700 on the directory and 600 on the file, set before anything is written
    # rather than after: a secret that exists world-readable for even an
    # instant has been world-readable.
    HOME.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(HOME, 0o700)
    existed = DB.exists()
    db = sqlite3.connect(DB)
    if not existed:
        os.chmod(DB, 0o600)
    db.row_factory = sqlite3.Row
    db.executescript(SCHEMA)
    db.commit()
    # WAL leaves two sidecar files, and they hold the same bytes the database
    # does. Belt and braces on all three.
    for p in (DB, DB.with_suffix(".db-wal"), DB.with_suffix(".db-shm")):
        if p.exists():
            os.chmod(p, 0o600)
    return db


def redact(secret: str) -> str:
    """Enough to recognise it, not enough to use it."""
    return f"{secret[:10]}...{secret[-3:]}" if len(secret) > 18 else "..."


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("put", help="store or replace a secret")
    p.add_argument("name")
    p.add_argument("secret", nargs="?", help="omit to read one line from stdin")
    p.add_argument("--kind", default="token")
    p.add_argument("--note", default="")

    sub.add_parser("list", help="what is stored. Never prints a secret")
    g = sub.add_parser("get", help="print one secret, and nothing else")
    g.add_argument("name")
    r = sub.add_parser("rm", help="forget one")
    r.add_argument("name")
    sub.add_parser("where", help="print the database path")

    args = ap.parse_args()
    db = connect()

    if args.cmd == "where":
        print(DB)
        return 0

    if args.cmd == "put":
        secret = args.secret
        if secret is None:
            # Reading from stdin keeps a secret out of the shell history and
            # out of the process table, where a command-line argument is
            # visible to every account on the machine.
            secret = sys.stdin.readline().strip()
        if not secret:
            print("keys: nothing to store", file=sys.stderr)
            return 1
        stamp = now()
        db.execute(
            "INSERT INTO keys (name, secret, kind, note, created, updated) "
            "VALUES (?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET "
            "  secret=excluded.secret, kind=excluded.kind, note=excluded.note, "
            "  updated=excluded.updated",
            (args.name, secret, args.kind, args.note, stamp, stamp))
        db.commit()
        print(f"stored {args.name} ({redact(secret)})")
        return 0

    if args.cmd == "list":
        rows = db.execute("SELECT * FROM keys ORDER BY name").fetchall()
        if not rows:
            print(f"nothing stored in {DB}")
            return 0
        print(f"{'name':<16} {'kind':<10} {'secret':<18} {'updated':<22} note")
        for k in rows:
            print(f"{k['name']:<16} {k['kind']:<10} {redact(k['secret']):<18} "
                  f"{k['updated']:<22} {k['note']}")
        return 0

    if args.cmd == "get":
        row = db.execute("SELECT secret FROM keys WHERE name = ?", (args.name,)).fetchone()
        if row is None:
            print(f"keys: no secret called {args.name!r}", file=sys.stderr)
            return 1
        print(row["secret"])
        return 0

    if args.cmd == "rm":
        n = db.execute("DELETE FROM keys WHERE name = ?", (args.name,)).rowcount
        db.commit()
        print(f"removed {args.name}" if n else f"keys: no secret called {args.name!r}")
        return 0 if n else 1

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
