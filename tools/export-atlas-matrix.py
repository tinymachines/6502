#!/usr/bin/env python3
"""The chip as a 132 x 132 adjacency matrix -> `docs/atlas-matrix.svg`.

The complement to the ELK diagrams, and the reason both exist: a node-link
layout of the whole chip is 90% empty canvas because this graph is dense and
full of feedback, which is exactly the case a matrix reads better than a
drawing. Nothing is thresholded away.

Rows and columns are the chip map's own ordering, recomputed here: a group's
column is the median, over its nodes, of the hop distance from the input and
bidirectional pins, and within a column groups sit in die order. So reading
left to right is reading the chip from its pads inward.

The matrix is DIRECTED. Cell (row a, column b) carries the gate edges by which
a drives b, so the two triangles differ, and a pair that is bright in both is
feedback. Switch bundles have no direction to have -- a pass transistor
conducts both ways -- so they are drawn in both cells, in their own colour.

    python3 tools/export-atlas-matrix.py
"""
import json, os, sys
from collections import defaultdict, deque

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W = os.path.join(ROOT, "web")
OUT = os.path.join(ROOT, "docs", "atlas-matrix.svg")

def load(n):
    p = os.path.join(W, n)
    if not os.path.exists(p):
        print("FAIL missing web/%s" % n); sys.exit(1)
    return json.load(open(p))

G, GR, S = load("groups.json"), load("graph.json"), load("schematic.json")
groups = G["groups"]
key2g = {g["key"]: g for g in groups}
nodeY = {n["id"]: n["y"] for n in GR["nodes"] if n}

# ---- the chip map's column rule, recomputed ------------------------------
PIN_IN = {"res", "irq", "nmi", "rdy", "so", "clk0"}
PINS = PIN_IN | {"db%d" % i for i in range(8)}
byname = {n: i for i, n in enumerate(S["names"]) if n}
adj = defaultdict(set)
for t in GR["transistors"]:
    if GR["transistorKinds"][t["kind"]] == "pass":
        adj[t["c1"]].add(t["c2"]); adj[t["c2"]].add(t["c1"])
for node, kind, pre, legs in S["gates"]:
    for leg in legs:
        for g in leg: adj[g].add(node)
seed = [byname[p] for p in PINS if p in byname]
dist = {s: 0 for s in seed}; q = deque(seed)
while q:
    u = q.popleft()
    for v in adj[u]:
        if v not in dist: dist[v] = dist[u] + 1; q.append(v)

def median(xs):
    xs = sorted(xs)
    return None if not xs else xs[len(xs) // 2]

for g in groups:
    d = [dist[n] for n in g["nodes"] if n in dist]
    g["_col"] = median(d)
    g["_y"] = median([nodeY[n] for n in g["nodes"] if n in nodeY]) or 0
# a group the pins never reach goes last, stated rather than dropped
cols = sorted({g["_col"] for g in groups if g["_col"] is not None})
colrank = {c: i for i, c in enumerate(cols)}
for g in groups:
    g["_c"] = colrank.get(g["_col"], len(cols))
order = sorted(groups, key=lambda g: (g["_c"], g["_y"], g["key"]))
idx = {g["key"]: i for i, g in enumerate(order)}
N = len(order)

# ---- the cells -----------------------------------------------------------
gate = defaultdict(int); swi = defaultdict(int)
for b in G["bundles"]:
    ia, ib = idx[b["a"]], idx[b["b"]]
    if b.get("ab"): gate[(ia, ib)] += b["ab"]
    if b.get("ba"): gate[(ib, ia)] += b["ba"]
    if b.get("switch"):
        swi[(ia, ib)] += b["switch"]; swi[(ib, ia)] += b["switch"]

KINDS = [k["key"] for k in G["kinds"]]
HUE = ["#4fbfd4", "#e0a24b", "#3e93a6", "#8f7fd0", "#d07f9a", "#7fd08f",
       "#d0c07f", "#7f9fd0", "#c07fd0", "#9ad07f", "#d0937f", "#7fd0c8",
       "#b0b0c8", "#d4b45f", "#6fa8dc", "#c98fb0", "#8fc9a8", "#c9a88f",
       "#a88fc9", "#8fa8c9", "#c98f8f", "#9c9c9c", "#6f6f80"]
kindhue = {k: HUE[i % len(HUE)] for i, k in enumerate(KINDS)}

CELL, PAD, STRIP = 7, 150, 9
PAD_T = 74   # the title needs far less room than the labels do
Wpx = PAD + N * CELL + 20
Hpx = PAD_T + N * CELL + 20
mx = max(list(gate.values()) + [1])

def alpha(v, top):
    # log, because the weights span 1..166 and a linear ramp shows only the
    # heaviest pair. The caption states it rather than leaving it to the eye.
    import math
    return 0.18 + 0.82 * (math.log(1 + v) / math.log(1 + top))

o = []
o.append('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" '
         'viewBox="0 0 %d %d" font-family="ui-monospace,Menlo,monospace">' % (Wpx, Hpx, Wpx, Hpx))
o.append('<rect width="%d" height="%d" fill="#0b1120"/>' % (Wpx, Hpx))
# column separators where the measured column changes
prev = None
for i, g in enumerate(order):
    if prev is not None and g["_c"] != prev:
        x = PAD + i * CELL
        o.append('<line x1="%d" y1="%d" x2="%d" y2="%d" stroke="#243049" stroke-width="1"/>'
                 % (x, PAD_T, x, PAD_T + N * CELL))
        y = PAD_T + i * CELL
        o.append('<line x1="%d" y1="%d" x2="%d" y2="%d" stroke="#243049" stroke-width="1"/>'
                 % (PAD, y, PAD + N * CELL, y))
    prev = g["_c"]
# kind strips on both axes
for i, g in enumerate(order):
    c = kindhue[g["kind"]]
    o.append('<rect x="%d" y="%d" width="%d" height="%d" fill="%s"/>'
             % (PAD + i * CELL, PAD_T - STRIP - 2, CELL, STRIP, c))
    o.append('<rect x="%d" y="%d" width="%d" height="%d" fill="%s"/>'
             % (PAD - STRIP - 2, PAD_T + i * CELL, STRIP, CELL, c))
# labels, every row, small
for i, g in enumerate(order):
    lab = g["key"]
    # the shared-line groups carry every line they are shared by in the id and
    # run off the edge; the full key is in docs/atlas.md.
    if len(lab) > 24: lab = lab[:23] + "\u2026"
    o.append('<text x="%d" y="%.1f" font-size="5.2" fill="#8fa3c0" text-anchor="end">%s</text>'
             % (PAD - STRIP - 5, PAD_T + i * CELL + CELL - 1.6, lab.replace("&", "&amp;")))
# cells
for (r, c), v in gate.items():
    o.append('<rect x="%d" y="%d" width="%d" height="%d" fill="#4fbfd4" fill-opacity="%.3f"/>'
             % (PAD + c * CELL, PAD_T + r * CELL, CELL - 1, CELL - 1, alpha(v, mx)))
for (r, c), v in swi.items():
    o.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="none" '
             'stroke="#e0a24b" stroke-width="1" stroke-opacity="%.3f"/>'
             % (PAD + c * CELL + 0.5, PAD_T + r * CELL + 0.5, CELL - 2, CELL - 2,
                alpha(v, max(swi.values()))))
o.append('<text x="%d" y="22" font-size="13" fill="#e6edf6">The 6502 as a %d x %d container matrix</text>' % (PAD - STRIP - 5, N, N))
o.append('<text x="%d" y="40" font-size="9" fill="#8fa3c0">row drives column. filled cyan = gate edges (log scale, max %d). gold outline = switches, drawn both ways because a pass transistor has no direction.</text>' % (PAD - STRIP - 5, mx))
o.append('<text x="%d" y="54" font-size="9" fill="#8fa3c0">ordered by measured hop distance from the pins, then die position. vertical rules are column boundaries. axis strips are the 23 kinds.</text>' % (PAD - STRIP - 5))
o.append("</svg>")
os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, "w").write("\n".join(o))

pairs = N * (N - 1) // 2
filled = len({tuple(sorted(k)) for k in list(gate) + list(swi)})
feedback = sum(1 for (r, c) in gate if r < c and (c, r) in gate)
isolated = [g["key"] for g in order
            if not any(idx[g["key"]] in k for k in list(gate) + list(swi))]
top = sorted(G["bundles"], key=lambda b: -(b["gate"] + b["switch"]))[:6]
print("wrote %s: %d x %d, %d of %d possible pairs wired (%.1f%%)"
      % (os.path.relpath(OUT, ROOT), N, N, filled, pairs, 100.0 * filled / pairs))
print("  %d ordered columns; %d pairs carry gate edges BOTH ways (feedback)" % (len(cols), feedback))
print("  groups with no bundle at all: %d %s" % (len(isolated), isolated))
print("  heaviest: %s" % ", ".join("%s~%s %d" % (b["a"], b["b"], b["gate"] + b["switch"]) for b in top))
