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
import shutil
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


def _timing():
    """(all timed, ending on a T0 term, nothing arriving, arriving but not a
    term). The predicate is web/timing.js's: a term whose name starts
    op-T0-."""
    T = _json("timing.json")
    terms = T["terms"]
    timed = [o for o in T["opcodes"] if not o["jam"]]
    is_t0 = lambda i: bool(terms[i]) and str(terms[i]).startswith("op-T0-")
    with_t0 = [o for o in timed if any(is_t0(i) for i in o["arrived"])]
    nothing = [o for o in timed if not o["arrived"]]
    other = [o for o in timed if o["arrived"] and not any(is_t0(i) for i in o["arrived"])]
    if len(with_t0) + len(nothing) + len(other) != len(timed):
        raise Skip("the timing split does not partition; the predicate moved")
    return timed, with_t0, nothing, other


_BITSLICE: dict | None = None


def _bitslice() -> dict:
    """Run examples/bitslice at 3000 half-cycles (the length the note quotes)
    and parse its counted lines. Once per process; the run is a couple of
    seconds after the build. Skips if cargo is not there or the run fails."""
    global _BITSLICE
    if _BITSLICE is not None:
        return _BITSLICE
    cargo = shutil.which("cargo") or os.path.expanduser("~/.cargo/bin/cargo")
    if not os.path.exists(cargo):
        raise Skip("cargo not found; the slice counts come from examples/bitslice")
    r = subprocess.run([cargo, "run", "--release", "-q", "-p", "v6502-sim",
                        "--example", "bitslice", "3000"],
                       cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        raise Skip(f"examples/bitslice did not run: {r.stderr.strip().splitlines()[-1:] or ''}")
    out = r.stdout
    m1 = re.search(r"trajectory: (\d+)/3000 half-cycles identical on all (\d+) live nodes", out)
    m2 = re.search(r"first divergence at half-cycle (\d+); worst half-cycle differed on (\d+) of", out)
    m3 = re.search(r"advances all (\d+) machines", out)
    if not (m1 and m2 and m3):
        raise Skip("examples/bitslice output did not parse; its lines moved")
    _BITSLICE = {"agree": int(m1.group(1)), "live": int(m1.group(2)),
                 "first": int(m2.group(1)), "worst": int(m2.group(2)),
                 "lanes": int(m3.group(1))}
    return _BITSLICE


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
    # The precharged half: gates whose output has no pullup, held by charge
    # between phases. The shipped page said 150 for as long as it existed and
    # the export has counted 142; nothing compared them until this row.
    "dynamic gates": lambda: _json("schematic.json")["counts"]["dynamic"],
    "absorbed transistors": lambda: _json("schematic.json")["counts"]["absorbed"],
    "switches": lambda: _json("schematic.json")["counts"]["switches"],
    # The timing page's split, recomputed with the page's OWN predicate
    # (a term named op-T0-*), because the first attempt at this used a
    # plausible different rule and made the page look wrong when it was right.
    "timed instructions": lambda: len(_timing()[0]),
    "t0 endings": lambda: len(_timing()[1]),
    "no arrivals": lambda: len(_timing()[2]),
    "arrivals that are not terms": lambda: len(_timing()[3]),
    "pla terms": lambda: len(_json("decode.json")["rows"]),
    "control lines": lambda: len(_json("decode.json")["outputs"]),
    "traced control lines": lambda: len(_json("decode.json")["links"]),
    # The bit-sliced kernel against the scalar engine, from the example that
    # makes the comparison. Counted columns only: the throughput it prints is
    # a timing and lives under the same rule as the rate above.
    "slice agreeing half-cycles": lambda: _bitslice()["agree"],
    "slice live nodes": lambda: _bitslice()["live"],
    "slice first divergence": lambda: _bitslice()["first"],
    "slice worst divergence": lambda: _bitslice()["worst"],
    "slice lanes": lambda: _bitslice()["lanes"],
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
    # The shipped pages. A number in a page's prose is a number nothing
    # recomputes, which is how "150 signals have no pullup" survived.
    ("web/schematic.html", r"<h2>(\d+) signals have no pullup</h2>", "dynamic gates"),
    ("web/schematic.html", r"<strong>(\d+) nodes work this way</strong>", "dynamic gates"),
    ("web/schematic.html", r"One gate shape,[^0-9]{0,40}(\d+) times", "gates"),
    ("web/schematic.html", r"Coverage of the (\d+)\s*transistors", "transistors"),
    ("web/schematic.html", r"(\d+) symbols absorb", "gates"),
    ("web/schematic.html", r"symbols absorb\s*(\d+) of", "absorbed transistors"),
    ("web/schematic.html", r"remaining\s*(\d+) stay as switches", "switches"),
    ("web/timing.html", r"For \d+ of the (\d+) instructions", "timed instructions"),
    ("web/timing.html", r"For (\d+) of the \d+ instructions", "t0 endings"),
    ("web/timing.html", r"For (\d+) of them nothing new arrives", "no arrivals"),
    ("web/timing.html", r"The other (\d+) do have\s+something arriving", "arrivals that are not terms"),
    ("docs/notes/schematic-and-blocks.md", r"holding charge\. (\d+) nodes work this way", "dynamic gates"),
    ("docs/notes/web-shell.md", r"([A-Za-z-]+) harnesses plus (?:\w+) probes", "harnesses"),
    ("docs/notes/web-shell.md", r"[A-Za-z-]+ harnesses plus (\w+) probes", "probes"),
    ("docs/README.md", r"(\d+) groups and the \w+ containers that exist only", "groups"),
    ("docs/README.md", r"\d+ groups and the (\w+) containers that exist only", "absorbed containers"),
    ("docs/README.md", r"All (\d+) are generated into `web/chip-elk/`", "groups"),
    # The kernel section of the engine note, held to the example's own output.
    ("docs/notes/engine.md", r"\*\*(\d+) of 3000 half-cycles agree on all \d+ live nodes\*\*", "slice agreeing half-cycles"),
    ("docs/notes/engine.md", r"\*\*\d+ of 3000 half-cycles agree on all (\d+) live nodes\*\*", "slice live nodes"),
    ("docs/notes/engine.md", r"the first divergence is at half-cycle (\d+), and the worst", "slice first divergence"),
    ("docs/notes/engine.md", r"the worst half-cycle differs on\s+(\d+) of \d+ nodes", "slice worst divergence"),
    ("docs/notes/engine.md", r"so that (\d+) machines can\s+share one instruction stream", "slice lanes"),
]


# ---------------------------------------------------------------------------
# Derived claims: numbers that are RELATED to each other rather than counted.
#
# Throughput is a timing, so nothing here can tell you it is stale -- only a
# re-run of the benchmark can, and the deploy is not going to do that. What it
# CAN tell you is that the tree contradicts itself, which is the failure that
# actually happened: the site said 28,500 half-cycles/s and "94x", CLAUDE.md
# said 25,800 and "85x", each looked plausible on its own, and nothing related
# them. The measured figure is stated ONCE and every other number derives from
# it.
# ---------------------------------------------------------------------------
FLAT = lambda s: re.sub(r"\s+", " ", s)
STRIP_TAGS = lambda s: re.sub(r"<[^>]+>", " ", s)


def derived_checks() -> list[tuple[bool, str]]:
    """The throughput claim, in the four places it is stated.

    Nothing here can tell you the measurement is STALE -- only re-running the
    benchmark can, and the deploy is not going to spend wall-clock on a timing.
    What it tells you is that the tree contradicts itself, which is what
    happened: CLAUDE.md and the engine note said 25,800 and 85x, the site and
    the README said 28,500 and 94x, each internally consistent, nothing
    relating them, split two against two.

    CLAUDE.md is the source. Every other number is derived from its rate: the
    kHz is half of it, the multiple is it over the reference engine's measured
    302, and the "slower than the part" range is a 1-2 MHz 6502 over it.
    """
    out: list[tuple[bool, str]] = []
    flat = lambda s: re.sub(r"\s+", " ", s)
    # Tags are stripped from HTML and NOT from markdown. `<[^>]+>` looks
    # harmless until it meets prose containing a bare `<`: CLAUDE.md documents
    # the drive lattice as "Floating < ChargedHigh < PullDown < ...", so the
    # pattern matched from there to the next `>` in the file and swallowed
    # whole sections, including the one being checked. The failure looked like
    # a regex that would not match a sentence that was plainly there.
    def load(rel: str) -> str:
        s = (ROOT / rel).read_text()
        if rel.endswith(".html"):
            s = re.sub(r"<[^>]+>", " ", s)
        return flat(s)

    text = {
        rel: load(rel)
        for rel in ("CLAUDE.md", "docs/notes/engine.md", "web/index.html", "README.md")
    }
    num = lambda s: int(s.replace(",", ""))

    src = re.search(
        r"\*\*~([\d,]+) half-cycles/s native \(~([\d.]+) kHz simulated 6502\)\*\*,"
        r" against the reference JavaScript's ([\d,]+): \*\*([\d,]+)x faster\*\*\."
        r" A real 6502 runs at 1 to 2 MHz, so this is ([\d,]+)x to ([\d,]+)x slower",
        text["CLAUDE.md"],
    )
    if not src:
        return [(False, "CLAUDE.md's Performance claim did not parse; every other check keys off it")]
    rate, khz, ref, mult, lo, hi = (
        num(src.group(1)), float(src.group(2)), num(src.group(3)),
        num(src.group(4)), num(src.group(5)), num(src.group(6)),
    )

    # CLAUDE.md against itself
    out.append((abs(khz - round(rate / 2000, 1)) < 0.05,
                f"CLAUDE.md says {khz} kHz; half of {rate:,} half-cycles/s is {round(rate/2000,1)}"))
    out.append((mult == round(rate / ref),
                f"CLAUDE.md says {mult}x; {rate:,}/{ref} is {round(rate/ref)}x"))
    out.append((lo == round(1e6 / (rate / 2)) and hi == round(2e6 / (rate / 2)),
                f"CLAUDE.md says {lo}x to {hi}x slower than the part; a 1-2 MHz 6502 over "
                f"{round(rate/2000,1)} kHz is {round(1e6/(rate/2))}x to {round(2e6/(rate/2))}x"))

    # the engine note repeats the sentence verbatim apart from one unit word
    en = re.search(r"\*\*~([\d,]+) half-cycles/s native \(~([\d.]+) kHz simulated 6502\)\*\*,"
                   r" against the reference JavaScript's [\d,]+ half-cycles/s: \*\*([\d,]+)x faster\*\*",
                   text["docs/notes/engine.md"])
    out.append((bool(en) and num(en.group(1)) == rate and num(en.group(3)) == mult,
                "docs/notes/engine.md restates the rate and multiple; they must be CLAUDE.md's"
                + (f" (found {en.group(1)} and {en.group(3)}x)" if en else " (did not parse)")))

    # the shipped page and the README
    for rel, pat in (
        ("web/index.html",
         r"About ([\d,]+) half-cycles per second natively, roughly ([\d,]+)\u00d7 the original JavaScript"),
        ("README.md",
         r"~([\d,]+) half-cycles/s natively .? about ([\d,]+)\u00d7 the original JavaScript"),
    ):
        m = re.search(pat, text[rel])
        out.append((bool(m) and num(m.group(1)) == rate and num(m.group(2)) == mult,
                    f"{rel} states the rate and multiple; they must be CLAUDE.md's {rate:,} and {mult}x"
                    + (f" (found {m.group(1)} and {m.group(2)}x)" if m else " (did not parse)")))
    return out


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

    for good, why in derived_checks():
        if good:
            ok += 1
        else:
            print(f"FAIL derived: {why}")
            fail += 1

    print(f"\n{ok} claim(s) agree, {fail} disagree, {skip} skipped.")
    if skip and REQUIRE_ALL:
        print("REQUIRE_ALL=1: a skip is a failure")
        return 1
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
