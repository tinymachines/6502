#!/usr/bin/env python3
"""The datapath control lines, measured on the chip and checked against the
visual6502 wiki's own claims about them.

A third independent oracle, in the shape of `check-timing-vs-manual.py`: the
measurement path consults no table, so agreeing with a published one is
evidence rather than tautology.  Two claims are checked, both from
`archive/wiki-raw/wikitext/6502_datapath.wiki`:

  * the CLOCK PHASE each line is effective in ("effective on the next phi1"
    against "effective on phi2 and the next phi1"), measured by watching every
    line against clk1out and clk2out while the chip runs; and
  * the three-way name table (Balazs / Hanson / JSSim) resolving to real nodes.

The wiki names are Hanson's, from the block diagram he drew off the 1975 MOS
blueprints; the die's own `dpc<N>_` prefix is visual6502's, assigned by
position across the chip.  Neither is ours, which is the point.

SKIPS when the archive or the halfwave binary is absent.  REQUIRE_DPC=1 makes
either absence a failure.  MUTATE=1 inverts the phase reading and must go red:
an all-green comparison is exactly what a broken one produces.

    cargo build --release -p v6502-sim --bin halfwave
    python3 tools/check-dpc-vs-wiki.py
"""
import json, os, re, subprocess, sys
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WIKI = os.path.join(ROOT, "archive/wiki-raw/wikitext/6502_datapath.wiki")
BIN  = os.path.join(ROOT, "target/release/halfwave")
REQUIRE = os.environ.get("REQUIRE_DPC") == "1"
MUTATE  = os.environ.get("MUTATE") == "1"

def skip(why):
    if REQUIRE:
        print("FAIL " + why + " (REQUIRE_DPC=1)"); sys.exit(1)
    print("SKIP " + why); sys.exit(0)

if not os.path.exists(WIKI): skip("no %s" % os.path.relpath(WIKI, ROOT))
if not os.path.exists(BIN):  skip("no target/release/halfwave -- cargo build --release -p v6502-sim --bin halfwave")

wt = open(WIKI, encoding="utf-8", errors="replace").read()

# ---- the three-way name table, parsed from the wiki's own table ------------
rows = []
for chunk in wt[wt.index("! Balazs"):].split("|-"):
    cells = [c.strip() for c in re.split(r"\n\s*\|", chunk) if c.strip() and not c.startswith("!")]
    if len(cells) >= 3 and "dpc" in cells[2]:
        rows.append({"balazs": cells[0].lstrip("| ").strip(),
                     "hanson": cells[1],
                     "jssim":  cells[2].split("||")[0].strip()})
if len(rows) != 44:
    print("FAIL the wiki cross-reference table read as %d rows, want 44" % len(rows)); sys.exit(1)
LINES = [r["jssim"] for r in rows]
h2j   = {r["hanson"]: r["jssim"] for r in rows}

# ---- the phase claims. One entry is a ';' line plus the ':' lines under it,
# and NOTHING past the next ';'. A fixed-size window instead of the entry's own
# bounds makes an entry inherit its neighbour's claim: with 400 characters Y/SB
# picked up S/SB's "phi2 and the next phi1" and 16 rows read as disagreements.
ents, cur = [], None
for ln in wt.splitlines():
    if ln.startswith(";"):
        if cur: ents.append(cur)
        cur = [ln]
    elif cur is not None:
        if ln.startswith(":"): cur.append(ln)
        else: ents.append(cur); cur = None
if cur: ents.append(cur)

claims = {}
for e in ents:
    txt = " ".join(e)
    v = ("both" if re.search(r"phi2 and the next phi1|next phi1 and phi2", txt)
         else "phi1" if re.search(r"[Ee]ffective on the next phi1", txt) else None)
    if not v: continue
    head = re.split(r",?\s*effective", e[0].lstrip(";").split(":")[0])[0]
    for nm in re.split(r",\s*", head):
        nm = nm.strip().rstrip(":").strip()
        if nm in h2j: claims[nm] = v

# ---- measure. Four programs, chosen to reach as many lines as possible. ----
PROGS = {
    "loads/alu":   [0xa9,0x2e,0x69,0x14,0x85,0x82,0xa2,0x03,0xa0,0x05,0x8a,0xa8,0x98,0x4c,0x00,0x02],
    "logic/shift": [0xa9,0x5a,0x09,0x0f,0x29,0x3c,0x49,0xff,0x4a,0x0a,0x6a,0x2a,0xe9,0x11,0x4c,0x00,0x02],
    "stack/calls": [0xa2,0xff,0x9a,0xba,0x48,0x68,0x08,0x28,0x20,0x10,0x02,0x4c,0x00,0x02,0xea,0xea,0x60],
    "indexed/br":  [0xa2,0x02,0xa0,0x03,0xbd,0x00,0x03,0xb9,0x00,0x03,0x9d,0x20,0x03,0xc9,0x00,0xd0,0x02,
                    0xe6,0x10,0x4c,0x00,0x02],
}
WATCH = LINES + ["clk1out", "clk2out"]
proc = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
def call(lines):
    proc.stdin.write("\n".join(lines) + "\nGO\n"); proc.stdin.flush()
    r = json.loads(proc.stdout.readline())
    if not r.get("ok"): print("FAIL halfwave: %s" % r.get("error")); sys.exit(1)
    return r

seen = defaultdict(set); total = both_high = neither = 0
for code in PROGS.values():
    page = bytearray(b"\xea" * 256); page[0:len(code)] = bytes(code)
    PAGE = "PAGE 02 " + page.hex()
    st = call(["FILL ea", PAGE, "VEC 0200", "BOOT"])["state"]
    lf = st["last_fetch"]
    S = "STATE %s %s %s %s %s %s" % (st["value"], st["pullup"], st["pulldown"],
        st["trans_on"], st["half_cycle"],
        "-" if lf is None else "%04x%02x" % (lf["addr"], lf["opcode"]))
    for o in call([S, "FILL ea", PAGE, "WATCH " + " ".join(WATCH), "TRACE", "STEP 900"])["trace"]:
        w = o["watch"]; a, b = w["clk1out"], w["clk2out"]
        if MUTATE: a, b = b, a          # negative control: the clocks, swapped
        total += 1; both_high += (a and b); neither += (not a and not b)
        ph = "phi1" if a else ("phi2" if b else None)
        if ph:
            for L in LINES:
                if w[L]: seen[L].add(ph)
proc.stdin.close()

meas = {L: ("both" if len(seen[L]) == 2 else (next(iter(seen[L])) if seen[L] else None)) for L in LINES}

print("%d half-cycles over %d programs" % (total, len(PROGS)))
print("clock non-overlap: %d half-cycles with both phases high, %d with neither"
      % (both_high, neither))
if both_high or neither:
    print("FAIL the two clock phases are meant to be non-overlapping and total"); sys.exit(1)

bad = []
for n, want in sorted(claims.items(), key=lambda kv: kv[1]):
    got = meas[h2j[n]]
    if got is None: continue
    if got != want: bad.append((n, h2j[n], want, got))
checked = sum(1 for n in claims if meas[h2j[n]] is not None)

print("name table: %d rows, %d resolve to nodes on the die" % (len(rows), len(LINES)))
print("phase: %d of %d lines exercised; %d carry a claim in the wiki; %d checked"
      % (sum(1 for v in meas.values() if v), len(LINES), len(claims), checked))
print("        %s" % dict(Counter(v for v in meas.values() if v)))
never = [L for L in LINES if meas[L] is None]
if never: print("not exercised by these programs: %s" % ", ".join(never))

if bad:
    for n, j, want, got in bad:
        print("  DIFFERS %-14s %-18s wiki=%-5s measured=%s" % (n, j, want, got))
    print("\n%d of %d disagree" % (len(bad), checked))
    sys.exit(1)
print("\nALL %d AGREE" % checked)
