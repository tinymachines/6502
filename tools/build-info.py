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
import os
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


# The files that ARE each page, for the "recently changed" dot on the menu. A
# page's own document and its own script: not style.css, not the shared
# modules, not the JSON it reads -- those touch every page at once and would
# light every dot at once, which says nothing. Keyed by the menu's own page
# names so the two cannot drift.
#
# This is a measurement, not an editorial call: it is the date git holds for the
# last commit touching these paths. Marking pages "updated" by hand is exactly
# the arrangement that let ten copies of the nav list drift three ways.
PAGE_FILES = {
    "": ["web/index.html", "web/app.js"],
    "primer": ["web/primer.html", "web/primer.js"],
    "programs": ["web/programs.html", "web/programs-page.js"],
    "halfshot": ["web/halfshot.html", "web/halfshot.js", "web/halfshot-codec.js"],
    "exploded": ["web/exploded.html", "web/exploded.js"],
    "block": ["web/block.html", "web/block.js", "web/block-notes.js"],
    "schematic": ["web/schematic.html", "web/schematic.js"],
    "blueprint": ["web/blueprint.html", "web/blueprint.js"],
    "blockdiagram": ["web/blockdiagram.html", "web/blockdiagram.js"],
    "diegraph": ["web/diegraph.html", "web/diegraph.js"],
    "chipmap": ["web/chipmap.html", "web/chipmap.js", "web/chip-groups.js"],
    "tracer": ["web/tracer.html", "web/tracer.js"],
    "pinout": ["web/pinout.html", "web/pinout.js"],
    "trace": ["web/trace.html", "web/trace.js"],
    "decode": ["web/decode.html", "web/decode.js"],
    "timing": ["web/timing.html", "web/timing.js"],
    "talk": ["web/talk.html", "web/talk.js"],
    "designer": ["web/designer.html", "web/designer.js"],
}


# The archive's sections, keyed by the page names ITS menu uses (shell.py). Its
# "pages" are built rather than authored, so what changes them is the builder
# that emits them, the shared shell, and the recovered content it is built from.
# The mirror is excluded on purpose: it is 2.3 GB of somebody else's site,
# preserved exactly, and "changed" is not something we should ever say about it.
ARCHIVE_FILES = {
    "index": ["archive/tools/build-archive.py", "archive/tools/shell.py", "archive/README.md"],
    "wiki": ["archive/tools/build-wiki.py", "archive/tools/harvest-wiki.py", "archive/urls"],
    "gallery": ["archive/tools/build-gallery.py", "archive/urls/site-images.txt"],
}


def page_dates() -> dict:
    """ISO date of the last commit touching each page's own files."""
    out = {}
    for page, files in PAGE_FILES.items():
        iso = git("log", "-1", "--format=%cI", "--", *files)
        if iso:
            out[page] = iso
    return out


def pages_changed_since(commit: str, table: dict = None) -> list:
    """The pages whose own files changed after `commit`.

    "Recently updated" is measured against the previous deploy rather than a
    number of days. A fixed window cannot be tuned: on a site two weeks old any
    window either dots nothing useful or dots everything, and a constant chosen
    against today's history is wrong again a month later. "Changed since you
    could last have seen it" is what a returning reader means, it is a fact
    git holds, and it adjusts itself as the site ages.
    """
    if not commit:
        return []
    out = []
    for page, files in (table or PAGE_FILES).items():
        changed = git("log", "--format=%H", f"{commit}..HEAD", "--", *files)
        if changed:
            out.append(page)
    return out


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
    # What deploy.sh proved before it built anything: the suites and their
    # counts, written to a file it names in TESTS_JSON. Absent when this tool
    # is run by hand, and then the key is absent rather than a zero, because a
    # zero would read as "ran and nothing passed".
    tests_file = os.environ.get("TESTS_JSON", "")
    if tests_file and Path(tests_file).is_file():
        info["tests"] = json.loads(Path(tests_file).read_text())
    prev = os.environ.get("PREVIOUS_DEPLOY", "")
    info["previousDeploy"] = prev[:40] if prev else None
    # An empty list when there was no previous deploy to compare against is not
    # "nothing changed"; `previousDeploy` being null is how a reader of the file
    # tells the two apart. Both deployments carry the pair, each measured over
    # its own pages against its own previous deploy.
    if kind == "simulator":
        info["pages"] = page_dates()
        info["changed"] = pages_changed_since(prev)
    else:
        info["changed"] = pages_changed_since(prev, ARCHIVE_FILES)

    out.mkdir(parents=True, exist_ok=True)
    (out / "build-info.json").write_text(json.dumps(info, indent=2) + "\n")
    flag = " +dirty" if dirty else ""
    print(f"  build-info: {version}@{info['commit']}{flag} ({kind})")


if __name__ == "__main__":
    main()
