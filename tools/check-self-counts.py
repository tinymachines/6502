#!/usr/bin/env python3
"""Every place this repository counts ITSELF, checked against a measurement.

The chip's numbers are checked in a dozen places already: the golden test, the
manual oracle, the wiki oracle, the generators that refuse to write a table
that fails. Nothing checked the counts the prose keeps of the PROJECT -- how
many tests there are, how many harnesses, how many programs, how many block
pages -- and three of them had drifted silently: 84 tests when cargo ran 91,
174 service tests when pytest collected 182 (with the registry's 48 missing
from the breakdown entirely), thirty-three harnesses when there were
thirty-six.

Those are the claims worth mechanising, because each is an EXACT GLOBAL
quantity with one obvious measurement. A general scan of prose for numbers is
not: it was tried, it raised 53 flags and every one was a subset claim
("the ALU as 17 containers", "273 transistors" in one block), and a check
that cries wolf is one nobody runs.

WHAT THIS DOES NOT COVER, on purpose:
  - the tracer's "twenty-five kinds of container". tracer.js's KINDS array is
    24 entries and is the FOLDABLE kinds, a different set. Asserting 25
    against it would be asserting a number nobody here understands.
  - the archive's URL and byte counts: the archive is fetched, not built, and
    is gitignored.
  - the performance figures. They are timings, not counts, and they move with
    the machine.

Usage:  python3 tools/check-self-counts.py
        REQUIRE_ALL=1 python3 tools/check-self-counts.py   # skips become failures
Exit 1 on any disagreement.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REQUIRE_ALL = os.environ.get("REQUIRE_ALL") == "1"

WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "thirty-three": 33, "thirty-four": 34, "thirty-five": 35, "thirty-six": 36,
    "thirty-seven": 37, "thirty-eight": 38, "thirty-nine": 39, "forty": 40,
}
WORD_OF = {v: k for k, v in WORDS.items()}


def as_number(text: str) -> int:
    """A claim is written either as digits or as a word, and the word form is
    the one that goes stale quietly: nobody greps for 'thirty-three'."""
    t = text.strip().lower().replace(",", "")
    if t.isdigit():
        return int(t)
    if t in WORDS:
        return WORDS[t]
    raise ValueError(f"not a number this check understands: {text!r}")


# ---------------------------------------------------------------------------
# Measurements. Each returns an int, or raises Skip with the reason.
# ---------------------------------------------------------------------------
class Skip(Exception):
    pass


def _json(name: str) -> dict:
    p = ROOT / "web" / name
    if not p.exists():
        raise Skip(f"web/{name} not built (run the exporter)")
    return json.loads(p.read_text())


def pytest_counts() -> dict[str, int]:
    """Collected, not run: the count is what the file says it holds, and one
    collection takes a second where a run takes ninety. ONE invocation, with
    the per-file counts read off the node ids, because six invocations of
    pytest is forty seconds and a check nobody waits for is a check nobody
    runs."""
    r = subprocess.run(
        [sys.executable, "-m", "pytest", "service/", "-q", "--collect-only"],
        cwd=ROOT, capture_output=True, text=True,
    )
    m = re.search(r"(\d+) tests? collected", r.stdout)
    if not m:
        raise Skip("pytest could not collect service/")
    out: dict[str, int] = {"total": int(m.group(1))}
    ids = re.findall(r"^service/(test_\w+)\.py::", r.stdout, re.M)
    for stem in ids:
        out[stem] = out.get(stem, 0) + 1
    # The ids must add up to the total pytest reported, or the parse is wrong
    # and every per-file claim below would be checked against a number this
    # function invented.
    counted = sum(v for k, v in out.items() if k != "total")
    if counted != out["total"]:
        raise Skip(f"parsed {counted} test ids but pytest collected {out['total']}")
    return out


def cargo_tests() -> int:
    """From build-info.json, which deploy.sh writes from the run it just did.
    Listing them instead would mean building the workspace to ask."""
    p = ROOT / "web" / "build-info.json"
    if not p.exists():
        raise Skip("web/build-info.json absent (python3 tools/build-info.py web)")
    info = json.loads(p.read_text()).get("tests")
    if not info:
        raise Skip("build-info.json carries no test counts (it was made by hand)")
    return int(info["cargo"]["passed"])


def node_eval(expr: str, what: str) -> int:
    """Ask the module itself rather than parsing it. web/ is ES modules and
    the counts live in exported arrays and tables."""
    node = os.environ.get("NODE") or "node"
    r = subprocess.run([node, "--input-type=module", "-e", expr],
                       cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        raise Skip(f"node could not read {what}: {r.stderr.strip().splitlines()[-1:] or ''}")
    return int(r.stdout.strip())


MEASURE = {
    "cargo tests": cargo_tests,
    "service tests": lambda: pytest_counts()["total"],
    "harnesses": lambda: len([p for p in (ROOT / "web").glob("_*.html")
                              if "probe" not in p.name]),
    "probes": lambda: len(list((ROOT / "web").glob("_*probe*.html"))),
    "programs": lambda: node_eval(
        "import {PROGRAMS} from './web/programs.js'; console.log(PROGRAMS.length)",
        "web/programs.js"),
    "block pages": lambda: node_eval(
        "import {SLUGS} from './web/block-notes.js'; import fs from 'fs';"
        "const b=JSON.parse(fs.readFileSync('web/blocks.json','utf8')).blocks;"
        "console.log(b.filter(x=>SLUGS[x.name]).length)",
        "web/block-notes.js + blocks.json"),
    "block pages without a lab": lambda: MEASURE["block pages"]() - 1,  # the ALU has one
    "groups": lambda: _json("groups.json")["counts"]["groups"],
    # The overlapping layer minus the partition: the containers absorbed whole
    # by a derivation that outranks them. Counted, never subtracted from a
    # remembered total.
    "absorbed containers": lambda: sum(
        1 for c in _json("groups.json")["containers"]
        if c["key"] not in {g["key"] for g in _json("groups.json")["groups"]}),
    "partition kinds": lambda: _json("groups.json")["counts"]["kinds"],
    "partition nodes": lambda: _json("groups.json")["counts"]["nodes"],
    "bundles": lambda: _json("groups.json")["counts"]["bundles"],
    "gates": lambda: _json("schematic.json")["counts"]["gates"],
    "unresolved gates": lambda: _json("schematic.json")["counts"]["unresolved"],
    "transistors": lambda: _json("schematic.json")["counts"]["transistors"],
    "netlist nodes": lambda: len(_json("schematic.json")["names"]),
    "pla terms": lambda: len(_json("decode.json")["rows"]),
    "control lines": lambda: len(_json("decode.json")["outputs"]),
    "traced control lines": lambda: len(_json("decode.json")["links"]),
}

# ---------------------------------------------------------------------------
# The claims. Each regex must match EXACTLY ONCE in its file and capture the
# number; matching twice or not at all is a failure, because a claim that
# moved out from under its pattern is exactly what this is looking for.
# ---------------------------------------------------------------------------
CLAIMS = [
    ("CLAUDE.md", r"\| Simulation \| Complete\. (\d+) tests,", "cargo tests"),
    ("CLAUDE.md", r"cargo test --workspace\s+# (\d+) tests:", "cargo tests"),
    ("CLAUDE.md", r"pytest service/ -q\s+# (\d+) tests:", "service tests"),
    ("CLAUDE.md", r"end \((\d+)\), the chip atlas", "test_service"),
    ("CLAUDE.md", r"the chip atlas \((\d+)\)", "test_atlas"),
    ("CLAUDE.md", r"cartridges \((\d+)\)", "test_cartridge"),
    ("CLAUDE.md", r"the registry\s+#\s+\((\d+)\)", "test_registry"),
    ("CLAUDE.md", r"MCP \((\d+)\)", "test_mcp"),
    ("CLAUDE.md", r"([A-Za-z-]+) harnesses plus (?:\w+) probes", "harnesses"),
    ("CLAUDE.md", r"[A-Za-z-]+ harnesses plus (\w+) probes", "probes"),
    ("CLAUDE.md", r"\| Programs \| (\w+) programs as", "programs"),
    ("CLAUDE.md", r"Blocks \((\w+) pages\)", "block pages"),
    ("CLAUDE.md", r"\*\*(\w+) of the twelve block pages have no \*labs\*", "block pages without a lab"),
    ("CLAUDE.md", r"\*\*(\d+) groups over \d+ kinds covering", "groups"),
    ("CLAUDE.md", r"\*\*\d+ groups over (\d+) kinds covering", "partition kinds"),
    ("CLAUDE.md", r"covering all (\d+) nodes once\*\*", "partition nodes"),
    ("CLAUDE.md", r"(\d+) counted bundles", "bundles"),
    ("CLAUDE.md", r"\| Schematic \| (\d+) gates recognised", "gates"),
    ("CLAUDE.md", r"All (\d+) PLA product terms", "pla terms"),
    ("CLAUDE.md", r"PLA product terms \+ (\d+) of \d+ control lines", "traced control lines"),
    ("CLAUDE.md", r"PLA product terms \+ \d+ of (\d+) control lines", "control lines"),
    ("CLAUDE.md", r"Facts: \*\*(\d+) nodes,", "netlist nodes"),
    ("CLAUDE.md", r"Facts: \*\*\d+ nodes, (\d+) transistors", "transistors"),
    ("docs/notes/web-shell.md", r"([A-Za-z-]+) harnesses plus (?:\w+) probes", "harnesses"),
    ("docs/notes/web-shell.md", r"[A-Za-z-]+ harnesses plus (\w+) probes", "probes"),
    ("docs/README.md", r"(\d+) groups and the \w+ containers that exist only", "groups"),
    ("docs/README.md", r"\d+ groups and the (\w+) containers that exist only", "absorbed containers"),
    ("docs/README.md", r"All (\d+) are generated into `web/chip-elk/`", "groups"),
]


def main() -> int:
    cache: dict[str, object] = {}

    def measured(key: str):
        if key not in cache:
            try:
                if key.startswith("test_"):
                    cache[key] = pytest_counts()[key]
                else:
                    cache[key] = MEASURE[key]()
            except Skip as e:
                cache[key] = e
        return cache[key]

    ok = fail = skip = 0
    for path, pattern, key in CLAIMS:
        p = ROOT / path
        if not p.exists():
            print(f"SKIP {path}: file absent")
            skip += 1
            continue
        hits = re.findall(pattern, p.read_text())
        if len(hits) != 1:
            print(f"FAIL {path}: pattern for '{key}' matched {len(hits)} times, want 1")
            print(f"     {pattern}")
            fail += 1
            continue
        want = measured(key)
        if isinstance(want, Skip):
            print(f"SKIP {path}: {key} not measurable here ({want})")
            skip += 1
            continue
        claimed_text = hits[0] if isinstance(hits[0], str) else hits[0][0]
        try:
            claimed = as_number(claimed_text)
        except ValueError as e:
            print(f"FAIL {path}: {e}")
            fail += 1
            continue
        if claimed == want:
            ok += 1
        else:
            shown = WORD_OF.get(want, want) if not claimed_text.strip().isdigit() else want
            print(f"FAIL {path}: says {claimed_text.strip()} {key}, measured {want}")
            print(f"     write: {shown}")
            fail += 1

    print(f"\n{ok} claim(s) agree, {fail} disagree, {skip} skipped.")
    if skip and REQUIRE_ALL:
        print("REQUIRE_ALL=1: a skip is a failure")
        return 1
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
