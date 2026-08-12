#!/usr/bin/env python3
"""Emit build-info.json: git metadata for the version footer.

    python3 tools/build-info.py <output-dir> [--kind simulator|archive]

The footer shows what is actually running, so "did my deploy land?" is a glance
rather than an investigation. That means the answer has to come from git at
build time, not from a hand-edited constant that drifts.

The elapsed time is deliberately NOT baked in here -- only the ISO timestamps
are. A static file cannot hold a relative time that stays true; "3m ago" frozen
into HTML is wrong within the hour and quietly misleading after that. The client
computes it from `built` on each load instead.
"""

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def git(*args: str) -> str:
    try:
        return subprocess.check_output(["git", *args], text=True,
                                       stderr=subprocess.DEVNULL).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("usage: build-info.py <output-dir> [--kind simulator|archive]")
    out = Path(sys.argv[1])
    kind = "simulator"
    if "--kind" in sys.argv:
        kind = sys.argv[sys.argv.index("--kind") + 1]

    # No tags in this repo yet, so fall back to the commit count. It is
    # monotonic, meaningful without ceremony, and becomes a real tag the moment
    # one exists.
    version = git("describe", "--tags", "--abbrev=0")
    if not version:
        n = git("rev-list", "--count", "HEAD")
        version = f"v0.{n}" if n else "v0"

    dirty = bool(git("status", "--porcelain"))
    info = {
        "version": version,
        "commit": git("rev-parse", "--short", "HEAD"),
        "commitFull": git("rev-parse", "HEAD"),
        "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
        "committed": git("log", "-1", "--format=%cI"),
        "subject": git("log", "-1", "--format=%s")[:90],
        "built": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "dirty": dirty,
        "kind": kind,
        "repo": "https://github.com/tinymachines/6502",
    }

    out.mkdir(parents=True, exist_ok=True)
    (out / "build-info.json").write_text(json.dumps(info, indent=2) + "\n")
    flag = " +dirty" if dirty else ""
    print(f"  build-info: {version}@{info['commit']}{flag} ({kind})")


if __name__ == "__main__":
    main()
