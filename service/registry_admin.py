#!/usr/bin/env python3
"""Hand out tokens, and see what the registry holds.

    python3 service/registry_admin.py mint --note "grok"
    python3 service/registry_admin.py tokens
    python3 service/registry_admin.py builders
    python3 service/registry_admin.py revoke <token-or-hash>
    python3 service/registry_admin.py release <handle>

There is no sign-up. A token is minted here, handed to somebody, and they
claim a handle with it: one token, one builder. That is deliberately the
whole of the auth story for now, and it is written down as a limitation
rather than dressed up as a design. What it does get right is the part that
would be painful to change later: **the token is shown once and never
stored.** The table holds its SHA-256, so a copy of this database is not a
copy of everybody's credentials.

REGISTRY_DB names the file; it defaults to service/registry.db, and the
deployed service points it at /var/lib/6502-registry/registry.db.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import registry  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--db", help="override REGISTRY_DB")
    sub = ap.add_subparsers(dest="cmd", required=True)

    m = sub.add_parser("mint", help="make a token; it is printed once")
    m.add_argument("--note", default="", help="who it is for; kept, unlike the token")
    m.add_argument("-n", type=int, default=1, help="mint several")

    sub.add_parser("tokens", help="every token, by hash, and what it claimed")
    sub.add_parser("builders", help="every page and how many ROMs it holds")

    r = sub.add_parser("revoke", help="stop a token working; the page stays")
    r.add_argument("token", help="the token itself, or its hash")

    g = sub.add_parser("grant", help="claim a handle for a token, reserved names included")
    g.add_argument("token")
    g.add_argument("handle")
    g.add_argument("name")

    rel = sub.add_parser("release", help="delete a page and everything on it")
    rel.add_argument("handle")
    rel.add_argument("--yes", action="store_true", help="required: this cannot be undone")

    args = ap.parse_args()
    db = registry.connect(Path(args.db) if args.db else None)
    registry.init(db)

    if args.cmd == "mint":
        for _ in range(args.n):
            token = registry.mint_token(db, args.note)
            print(token)
        print(f"\n# {args.n} token(s). Shown once: only the SHA-256 is stored, so a "
              f"lost token is re-minted, never recovered.\n"
              f"# To use one:\n"
              f"#   curl -s https://6502.tinymachines.ai/api/v1/registry/claim \\\n"
              f"#     -H 'authorization: Bearer <token>' -H 'content-type: application/json' \\\n"
              f"#     -d '{{\"handle\": \"your-handle\", \"name\": \"Your Name\"}}'",
              file=sys.stderr)
        return 0

    if args.cmd == "tokens":
        rows = db.execute("SELECT * FROM tokens ORDER BY created").fetchall()
        if not rows:
            print("no tokens")
        for t in rows:
            state = "revoked" if t["revoked"] else (t["handle"] or "unclaimed")
            print(f"{t['hash'][:16]}  {state:<20}  used {t['used'] or 'never':<22}  {t['note']}")
        return 0

    if args.cmd == "builders":
        rows = db.execute(
            "SELECT b.handle, b.name, b.updated, "
            "  (SELECT COUNT(*) FROM roms r WHERE r.handle = b.handle) AS roms "
            "FROM builders b ORDER BY b.updated DESC").fetchall()
        if not rows:
            print("no builders")
        for b in rows:
            print(f"{b['handle']:<24}  {b['roms']:>2} ROMs  {b['updated']}  {b['name']}")
        return 0

    if args.cmd == "grant":
        # The only path that may take a RESERVED name. Run by whoever owns the
        # machine, which is not who that list is protecting those names from.
        try:
            out = registry.claim(db, args.token, args.handle, args.name,
                                 allow_reserved=True)
        except registry.RegistryError as e:
            print(f"grant: {e}", file=sys.stderr)
            return 1
        print(f"{out['handle']} claimed for {out['name']}")
        return 0

    if args.cmd == "revoke":
        h = args.token if len(args.token) == 64 else registry.hash_token(args.token)
        cur = db.execute("UPDATE tokens SET revoked = ? WHERE hash = ? AND revoked IS NULL",
                         (registry.now(), h))
        db.commit()
        if not cur.rowcount:
            print("no such token, or already revoked", file=sys.stderr)
            return 1
        print(f"revoked {h[:16]}; the page and its ROMs are untouched")
        return 0

    if args.cmd == "release":
        if not args.yes:
            print("this deletes the page and every ROM on it; pass --yes", file=sys.stderr)
            return 1
        n = db.execute("DELETE FROM roms WHERE handle = ?", (args.handle,)).rowcount
        b = db.execute("DELETE FROM builders WHERE handle = ?", (args.handle,)).rowcount
        db.execute("UPDATE tokens SET handle = NULL WHERE handle = ?", (args.handle,))
        db.commit()
        print(f"released {args.handle}: {b} page, {n} ROMs")
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
