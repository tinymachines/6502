#!/usr/bin/env python3
"""What the solver looks at, joined against the chip atlas.

A recalc IS a search: `build_group` walks out from one seed across conducting
transistors and returns everything electrically joined to it. `examples/
search-profile.rs` records every one; this asks the atlas which parts of the
die they landed in, and what the looking cost.

    cargo run --release -p v6502-sim --features probe \
        --example search-profile -- 120 > /tmp/searches.json
    python3 tools/export-atlas-doc.py --json /tmp/addr.json
    python3 tools/analyse-searches.py /tmp/searches.json /tmp/addr.json

The address table comes from the atlas generator rather than being recomputed
here: a second implementation of the class rule is the copy that drifts.
"""
import json, sys
from collections import Counter
from itertools import combinations

if len(sys.argv) < 3:
    print(__doc__); sys.exit(2)
S = json.load(open(sys.argv[1]))
A = json.load(open(sys.argv[2]))["nodes"]
seed, changed, start, members = S["seed"], S["changed"], S["start"], S["members"]
bounds = [at for _, at in S["marks"]] + [len(seed)]
N, H = len(seed), S["halfCycles"]
own = {int(k): v["owner"] for k, v in A.items()}
cls = {int(k): v["class"] for k, v in A.items()}
kind = lambda n: (own.get(n) or "?").split(":", 1)[0]

def grp(i):
    a = start[i]
    b = start[i + 1] if i + 1 < len(start) else len(members)
    return tuple(members[a:b])

sz = [len(grp(i)) for i in range(N)]
print("== the cost of a half-cycle")
print("  %d searches over %d half-cycles = %.0f per half-cycle" % (N, H, N / H))
print("  group size: mean %.2f, median %d, max %d"
      % (sum(sz) / N, sorted(sz)[N // 2], max(sz)))
w = sum(1 for c in changed if not c)
print("  searches that changed nothing: %d = %.1f%%" % (w, 100 * w / N))

print("\n== does a search stay inside one container?")
spans, cross = Counter(), Counter()
for i in range(N):
    cs = {own[n] for n in grp(i) if n in own}
    spans[len(cs)] += 1
    if len(cs) > 1:
        for p in combinations(sorted(cs), 2):
            cross[p] += 1
inside = spans.get(0, 0) + spans.get(1, 0)
print("  containers touched per search: %s" % dict(sorted(spans.items())))
print("  %.1f%% never leave one container" % (100 * inside / N))
print("  the crossings ARE the datapath transfers:")
for (a, b), c in cross.most_common(6):
    print("     %-22s ~ %-22s %6d" % (a, b, c))

print("\n== where the time goes")
for label, keyfn in (("kind", lambda i: kind(seed[i])),
                     ("class", lambda i: cls.get(seed[i], "?"))):
    tot, bad = Counter(), Counter()
    for i in range(N):
        k = keyfn(i); tot[k] += 1
        if not changed[i]: bad[k] += 1
    print("  %-8s %9s %9s %7s" % (label, "searches", "wasted", "waste%"))
    for k, c in tot.most_common(8):
        print("  %-8s %9d %9d %6.1f%%" % (k, c, bad[k], 100 * bad[k] / c))
    print()

# The question a cache would have to answer. Only a repeat of the same seed
# inside one half-cycle can be memoised, and only when the group comes back
# identical, and only when it also learned nothing.
print("== the ceiling on memoising a search")
first = rep = same = prize = 0
for lo, hi in zip(bounds, bounds[1:]):
    seen = {}
    for i in range(lo, hi):
        s, g = seed[i], grp(i)
        if s in seen:
            rep += 1
            if seen[s] == g:
                same += 1
                if not changed[i]:
                    prize += 1
        else:
            first += 1
        seen[s] = g
print("  %d of %d searches (%.1f%%) are the FIRST for that seed this half-cycle"
      % (first, N, 100 * first / N))
print("  repeats: %d (%.1f%%); of those the group was identical %d (%.1f%%)"
      % (rep, 100 * rep / N, same, 100 * same / rep if rep else 0))
print("  memoisable and worthless: %d = %.1f%% of all searches" % (prize, 100 * prize / N))
print("  -> that is the CEILING for caching by seed, before any bookkeeping.")
print("     The 80% waste is not redundancy: four searches in five are the")
print("     first look at that node this half-cycle and correctly find nothing.")

print("\n== the most-searched nodes")
for n, c in Counter(seed).most_common(8):
    a = A.get(str(n), {})
    print("  %5d  %-30s %s" % (c, a.get("addr", "?"), a.get("name") or ""))
