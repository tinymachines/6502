#!/usr/bin/env python3
"""Backfill site files the origin no longer serves, from the Wayback Machine.

    python3 archive/tools/fill-gaps.py            # report and fetch
    python3 archive/tools/fill-gaps.py --dry-run  # report only

harvest-site.sh fetches from visual6502.org because the origin holds the
authoritative bytes. But the origin is exactly what is decaying, and the first
run of this pipeline already found two files listed in the Wayback index that
now 404 at source -- two Atari TIA die scans. They exist only in the Archive.

So this is the second pass: diff the manifest against what actually landed on
disk, and pull anything missing from the Wayback snapshot instead. Anything that
fails both ways is genuinely gone, and gets reported rather than quietly skipped.
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse as up
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "urls" / "site-manifest.json"
BASE = ROOT / "mirror" / "visual6502.org"
UA = ("Mozilla/5.0 (compatible; archival retrieval for preservation; "
      "contact via github.com/tinymachines/6502)")


def fetch(url: str, tries: int = 3) -> bytes | None:
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=300) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (429, 503, 502, 504) and attempt < tries - 1:
                time.sleep(10 * (attempt + 1))
                continue
            return None
        except Exception:  # noqa: BLE001
            if attempt < tries - 1:
                time.sleep(5 * (attempt + 1))
                continue
            return None
    return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not MANIFEST.exists():
        sys.exit("no site-manifest.json; run archive/tools/wayback-index.py")
    files = json.loads(MANIFEST.read_text())["files"]

    missing = [f for f in files
               if not (BASE / up.unquote(f["path"]).lstrip("/")).exists()]
    print(f"{len(files)} in manifest, {len(missing)} missing on disk")
    if not missing:
        return

    gone, filled = [], 0
    for f in missing:
        rel = up.unquote(f["path"]).lstrip("/")
        print(f"  {rel}")
        if args.dry_run:
            continue
        # Origin first -- it may simply have been a transient failure.
        body = fetch(f["origin"]) or fetch(f["wayback"])
        if body is None:
            gone.append(rel)
            continue
        dest = BASE / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(body)
        filled += 1
        print(f"    recovered {len(body) / 1e6:.1f} MB")
        time.sleep(1.5)

    if not args.dry_run:
        print(f"\nrecovered {filled}, unrecoverable {len(gone)}")
        for g in gone:
            print(f"  LOST: {g}")


if __name__ == "__main__":
    main()
