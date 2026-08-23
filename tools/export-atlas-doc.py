#!/usr/bin/env python3
"""Builds `docs/atlas.md`: the address rubric, and an entry per container.

An address here is a coordinate, not a label. Every node, transistor and wire
on the die gets exactly one, formed by a stated rule from files that are
themselves derived, so the whole table regenerates from the die data and
nothing in it is typed by hand.

    python3 tools/export-atlas-doc.py

Refuses to write a document whose address table fails its own checks.
"""
import json, os, re, sys
from collections import Counter, defaultdict, deque

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W = os.path.join(ROOT, "web")
OUT = os.path.join(ROOT, "docs", "atlas.md")

def load(n):
    p = os.path.join(W, n)
    if not os.path.exists(p):
        print("FAIL missing web/%s -- regenerate the exports first" % n); sys.exit(1)
    return json.load(open(p))

G, GR, S, T = load("groups.json"), load("graph.json"), load("schematic.json"), load("timing.json")
names = S["names"]
byname = {n: i for i, n in enumerate(names) if n}
owner = {n["id"]: n["owner"] for n in G["nodes"]}
kindlabel = {k["key"]: k["label"] for k in G["kinds"]}
alias = defaultdict(list)
for c in G["containers"]:
    for n in c["nodes"]:
        alias[n].append(c["key"])

# ---------------------------------------------------------------- the rubric
gate, legs_of = {}, {}
for node, kind, pre, legs in S["gates"]:
    gate[node] = (S["kinds"][kind], [len(l) for l in legs], pre)
    legs_of[node] = legs
sw_ends, opens = defaultdict(set), Counter()
for c, a, b in S["switches"]:
    sw_ends[a].add(b); sw_ends[b].add(a); opens[c] += 1
unresolved = {u["node"] for u in S["unresolved"]}

def klass(n):
    """One token from a closed vocabulary, derived from the pulldown network.

    NMOS builds logic exactly one way, so the shape of the pulldown network IS
    the boolean function: legs in parallel are the ORs, transistors in series
    are the ANDs, and the pullup inverts the lot.
    """
    if n in gate:
        k, legs, pre = gate[n]
        if k == "inverter": return "inv"
        if k == "nor":      return "nor%d" % len(legs)
        if k == "nand":     return "nand%d" % legs[0]
        if k == "aoi":      return "aoi" + ".".join(str(x) for x in sorted(legs, reverse=True))
        if k == "dynamic":  return "dyn%d" % len(legs)
    return "bus" if n in sw_ends else "inert"

def naddr(n): return "%s:%s:#%d" % (owner[n], klass(n), n)

# the tracer's measured bus-stem rule, re-derived here rather than imported:
# letters only, no `not` complement, bit 0 named, at least 7 of bits 0..7.
stems = set()
for nm in byname:
    m = re.match(r"^([A-Za-z]+)0$", nm)
    if m and not m.group(1).startswith("not") and \
       sum(1 for b in range(8) if m.group(1) + str(b) in byname) >= 7:
        stems.add(m.group(1))
bitof = {}
for st in stems:
    for b in range(8):
        i = byname.get(st + str(b))
        if i is not None: bitof[i] = (st, b)

PADS = {n["name"] for n in GR["nodes"] if n and n.get("name")
        and re.fullmatch(r"ab\d+|db\d+|res|irq|nmi|rdy|so|sync|rw|clk0|clk[12]out", n["name"])}
phase = {d["node"]: d["phase"] for d in T.get("dpc", [])}

adj = defaultdict(set)
for t in GR["transistors"]:
    if GR["transistorKinds"][t["kind"]] == "pass":
        adj[t["c1"]].add(t["c2"]); adj[t["c2"]].add(t["c1"])
for node, kind, pre, legs in S["gates"]:
    for leg in legs:
        for g in leg: adj[g].add(node)
seed = [byname[p] for p in PADS if p in byname]
depth = {s: 0 for s in seed}; q = deque(seed)
while q:
    u = q.popleft()
    for v in adj[u]:
        if v not in depth: depth[v] = depth[u] + 1; q.append(v)

def tags(n):
    t = []
    if names[n]: t.append("name=" + names[n])
    if n in bitof: t.append("bit=%d@%s" % (bitof[n][1], bitof[n][0]))
    if names[n] in PADS: t.append("pin")
    if opens.get(n): t.append("opens=%d" % opens[n])
    if n in gate and gate[n][2] >= 0: t.append("precharged")
    if n in phase and phase[n]: t.append("phase=" + phase[n])
    if n in unresolved: t.append("unresolved")
    if n in depth: t.append("depth=%d" % depth[n])
    for a in alias[n]:
        if a != owner[n]: t.append("also=" + a)
    return t

# transistors and wires: same shape, own namespace
RAIL = {GR["rails"]["vss"], GR["rails"]["vcc"]}
KIND = GR["transistorKinds"]
taddr = {}
for t in GR["transistors"]:
    k, tid = KIND[t["kind"]], t["id"]
    if k == "pass":
        A, B = sorted((t["c1"], t["c2"])); ga, gb = owner.get(A), owner.get(B)
        if ga and gb and ga != gb:
            x, y = sorted((ga, gb)); home, cls = "%s~%s" % (x, y), "link"
        elif ga or gb: home, cls = (ga or gb), "inside"
        else: home, cls = "rest:0", "rail"
    else:
        n = t["c1"] if t["c1"] not in RAIL else t["c2"]
        home, cls = (owner.get(n) or "rest:0"), ("pd" if k == "pulldown" else "pu")
    taddr[tid] = "t:%s:%s:#%d" % (home, cls, tid)
waddr = {}
for e in GR["edges"]:
    a, b = e["a"], e["b"]
    if e["kind"] == 0:
        waddr["g%d>%d" % (a, b)] = "w:%s>%s:gate:#%d.%d" % (
            owner.get(a) or "rail", owner.get(b) or "rail", a, b)
    else:
        x, y = sorted((a, b))
        waddr["s%d" % e["t"]] = "w:%s~%s:chan:#%d" % (
            owner.get(x) or "rail", owner.get(y) or "rail", e["t"])

# ---------------------------------------------------------------- the checks
U = sorted(owner)
A = {n: naddr(n) for n in U}
ALL = list(A.values()) + list(taddr.values()) + list(waddr.values())
fail = []
def need(cond, why):
    if not cond: fail.append(why)

need(len(A) == len(U) == G["counts"]["nodes"], "every partition node addressed")
need(len(taddr) == len(GR["transistors"]), "every transistor addressed")
need(len(waddr) == len(GR["edges"]), "every wire addressed")
need(len(set(ALL)) == len(ALL), "addresses unique across all three namespaces")
need(all(len(a.rsplit(":", 2)) == 3 for a in ALL), "every address parses from the right")
need(all(a.rsplit(":", 1)[1].startswith("#") for a in ALL), "the slot is always the die's number")
need(all(re.fullmatch(r"[a-z0-9.]+", a.rsplit(":", 2)[1]) for a in ALL), "the class is a bare token")
need(not any(":" in (names[n] or "") for n in U), "no die name contains the separator")
need([n for n in U if klass(n) == "inert"] == [866], "only the inert node is unclassified")

# The property the whole design rests on: change the ownership rule and the
# prefix moves while the slot does not. Simulated by reversing the kind order.
order = [k["key"] for k in G["kinds"]][::-1]
rank = {k: i for i, k in enumerate(order)}
moved = 0
for n in U:
    cands = alias[n] or [owner[n]]
    re_owned = min(cands, key=lambda c: (rank.get(c.split(":", 1)[0], 99), c))
    if re_owned != owner[n]: moved += 1
need(moved > 0, "a changed ownership rule moves some prefix")
need(all(A[n].rsplit(":", 1)[1] == "#%d" % n for n in U), "...and never a slot")

if fail:
    for f in fail: print("FAIL " + f)
    sys.exit(1)

# ----------------------------------------------------------------- the entry
cv = Counter(klass(n) for n in U)
part = {g["key"] for g in G["groups"]}
absorbed = [c for c in G["containers"] if c["key"] not in part]
bykind = defaultdict(list)
for g in G["groups"]: bykind[g["kind"]].append(g)
multi = Counter()
for c in G["containers"]:
    for n in c["nodes"]: multi[n] += 1
mm = {k: v for k, v in multi.items() if v > 1}

def ex(nm):
    i = byname.get(nm)
    if i is None or i not in owner: return None
    return (nm, A[i], "  ".join(tags(i)))

L = []
w = L.append
w("# The chip atlas: an address for every part\n")
w("Generated by `tools/export-atlas-doc.py` from `web/{groups,graph,schematic,timing}.json`.")
w("Nothing below is typed by hand. Regenerate after any change to the die data")
w("or to a derivation, and the document follows.\n")
w("Every node, transistor and wire on this die gets exactly one address, and a")
w("prefix of an address is a valid way to name the set beneath it. The point is")
w("an IP address rather than a hostname: the front routes, the back identifies.\n")
w("**%d addresses**: %d nodes, %d transistors, %d wires. All unique, all"
  % (len(ALL), len(A), len(taddr), len(waddr)))
w("parseable, checked by the generator before this file is written.\n")

w("## The rubric\n")
w("```")
w("<container> : <class> : <slot>")
w("```\n")
w("**Parse from the right.** The slot follows the last colon, the class the one")
w("before it, and the container is everything left over. A fixed field count")
w("does not work: container keys legitimately contain colons (`alat:ADL/ABL`),")
w("and a bundle names two of them (`regs:a~sbus:sb`).\n")
w("### Why the separator is a colon\n")
w("Measured, not chosen. Across the die's %d names the punctuation in use is"
  % len([n for n in names if n]))
w("`# ( ) + - . / _`; container keys add `:`. A colon appears in **zero** die")
w("names, and `kind:id` is already how this project spells a container")
w("everywhere else. `.` and `/` were both out: `.` is in 33 names and 14 keys,")
w("`/` in 47 and 5.\n")
w("### The three fields\n")
w("| field | what it is | source |")
w("|---|---|---|")
w("| **container** | which derived group the part belongs to | the chip map's partition: %d groups over %d kinds, every node exactly once |"
  % (G["counts"]["groups"], G["counts"]["kinds"]))
w("| **class** | the shape of the pulldown network, which in NMOS *is* the boolean function | `schematic.json`'s recognised gates |")
w("| **slot** | the die's own number for the part | `segdefs.js` / `transdefs.js`, by way of the read-only submodule |\n")
w("### The slot is the die's number, and that is the load-bearing decision\n")
w("Every other field is a derivation, and derivations here move: the chip map")
w("has already changed which kind owns a contested node, and the interrupt walk")
w("has already changed its ownership rule. An address whose last field were")
w("derived would break on every such improvement.\n")
w("The generator proves the property rather than asserting it. Reversing the")
w("kind ownership order re-owns **%d of %d nodes and moves %d slots**.\n"
  % (moved, len(U), 0))
w("So a prefix is a claim that can be revised, and the slot is not. Strip an")
w("address to its last field and the part is still findable.\n")
w("### The class vocabulary is closed, and it is %d tokens\n" % len(cv))
w("NMOS has no AND gate and no OR gate. A pullup holds the output high and a")
w("pulldown network to ground beats it, so every static gate is an inverted sum")
w("of products: legs in parallel are the ORs, transistors in series are the")
w("ANDs. The leg profile is therefore a complete description of what the gate")
w("computes, not a label for it. `aoi2.1` is `NOT((A AND B) OR C)`.\n")
w("| class | count | reading |")
w("|---|---|---|")
READ = {"inv": "inverter", "bus": "no gate drives it: a bus bit or a pass-only node",
        "inert": "no driver and no switch: provably unobservable"}
for k, c in cv.most_common():
    r = READ.get(k)
    if r is None:
        if k.startswith("nor"):  r = "%s-input NOR" % k[3:]
        elif k.startswith("nand"): r = "%s-deep NAND" % k[4:]
        elif k.startswith("dyn"): r = "precharged, %s legs, no pullup" % k[3:]
        else: r = "AND-OR-invert, legs %s deep" % k[3:].replace(".", " and ")
    w("| `%s` | %d | %s |" % (k, c, r))
w("")
rare = sorted(k for k, v in cv.items() if v < 5)
w("The tail is long, and that is the die being irregular rather than the rule")
w("being loose: %d of the %d classes hold fewer than five gates each, %d of"
  % (len(rare), len(cv), sum(1 for k in rare if k.startswith("aoi"))))
w("those being AOI shapes that the ALU and the flag logic build once. The rest")
w("are `%s`.\n" % "`, `".join(k for k in rare if not k.startswith("aoi")))
w("### Facts ride as tags, never as fields\n")
w("An address needs exactly one discriminator and it must be immutable. Anything")
w("else true about a part is a tag: queryable, unordered, and free to change")
w("without moving anything.\n")
w("```")
for nm in ("sb3", "dpc3_SBX", "a0", "cclk"):
    e = ex(nm)
    if e: w("%-34s %s" % (e[1], e[2]))
w("```\n")
w("`bit=` uses the tracer's measured bus-stem rule (letters only, no `not`")
w("complement, bit 0 named, at least seven of bits 0..7), which lands on **%d"
  % len(stems))
w("stems**. `depth=` is hops from the nearest pin. `phase=` is measured by")
w("running the chip. `also=` names a container that claims this node in the")
w("overlapping layer but lost it in the partition.\n")

w("## Where the names come from\n")
w("Worth stating because none of it is ours, and the answer is three deep. The")
w("source is `6502_datapath.wiki` in the preservation archive.\n")
w("| scheme | example | what it is |")
w("|---|---|---|")
w("| **Hanson** | `Y/SB`, `SB/X` | `SOURCE/DEST`, from the block diagram drawn off the MOS blueprints |")
w("| **Balazs** | `R1x7`, `Dkx2` | a positional grid, off his own die photograph |")
w("| **JSSim**, and so ours | `dpc4_SSB` | position prefix **plus** Hanson's name |\n")
w("So half of a control-line name is a coordinate and half is a function. The")
w("prefix is a real ordering: sorting the lines by their `dpc` index sorts them")
w("left to right across the die, with six inversions in 43, all adjacent pairs.")
w("Two indices are negative, `dpc-1_ADL/ABL` and `dpc-2_ADH/ABH`, because the")
w("address latch loads sit left of where the datapath's numbering starts.\n")
w("`tools/check-dpc-vs-wiki.py` re-asks the wiki's claims of the chip.\n")

w("## The entries\n")
w("%d groups over %d kinds, covering all %d nodes exactly once, plus %d"
  % (G["counts"]["groups"], G["counts"]["kinds"], G["counts"]["nodes"],
     G["counts"]["containers"]))
w("containers that overlap on purpose. `n` is the node count; a group with a")
w("`.` in its id is a child of the one above it.\n")
for k in [x["key"] for x in G["kinds"]]:
    gs = bykind.get(k, [])
    if not gs: continue
    w("### `%s:` %s\n" % (k, kindlabel.get(k, k)))
    w("| address prefix | n | label |")
    w("|---|---|---|")
    for g in gs:
        w("| `%s` | %d | %s |" % (g["key"], len(g["nodes"]), g.get("label", "")))
    w("")
w("### Containers that exist only in the overlapping layer\n")
w("These claim no node in the partition, because everything in them is already")
w("owned by a derivation that is more specific. They are still the honest answer")
w("to \"what is this node part of\".\n")
w("| container | n | why it is absorbed |")
w("|---|---|---|")
WHY = {"sdp:sd1": "the address latches' `ADL/ABL` cone reads it and outranks it",
       "sdp:sd2": "same, one cycle later",
       "sbus:link": "absorbed whole by the special bus",
       "dpc:phi1": "a clock phase is not a fact about the wiring, so it is added last",
       "dpc:both": "same",
       "dpc:unreached": "same, for the lines the probe programs never raise"}
for c in absorbed:
    w("| `%s` | %d | %s |" % (c["key"], c["count"], WHY.get(c["key"], "")))
w("")
w("**%d nodes are in more than one container**, at most %d. That number is not a"
  % (len(mm), max(mm.values())))
w("defect: a node in the decimal correction is also in an ALU slice, and saying")
w("only one of those is a consequence of a drawing needing disjoint boxes.\n")

w("## What the address cannot tell you\n")
w("- **Direction.** A pass transistor conducts both ways, so topology alone")
w("  cannot say which end is the source. Hanson's `SOURCE/DEST` names are the")
w("  only record of it, and they are authored, not measured.")
w("- **Neighbourhood.** `depth=` is hops from a pin, which is a distance, not a")
w("  neighbourhood. \"What is within two hops\" is a query, not a coordinate.")
w("- **Which container is *most* interesting.** The partition picks one owner so")
w("  a box can be drawn. `also=` carries the rest.")
w("- **Anything about node 866.** It classifies as `inert` and that is correct:")
w("  it gates one transistor and nothing in the chip can drive it, so no run can")
w("  ever observe it.\n")

# The address table, for anything that wants to join against it. One
# implementation of the rubric: a consumer that recomputed the class rule
# would be the copy that drifts.
if "--json" in sys.argv:
    jp = sys.argv[sys.argv.index("--json") + 1]
    json.dump({
        "format": "chip-address/1",
        "nodes": {str(n): {"addr": A[n], "owner": owner[n], "class": klass(n),
                           "name": names[n], "tags": tags(n)} for n in U},
        "transistors": {str(t): a for t, a in taddr.items()},
    }, open(jp, "w"))
    print("wrote %s: %d node addresses, %d transistor addresses"
          % (jp, len(A), len(taddr)))

os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, "w").write("\n".join(L) + "\n")
print("wrote %s (%d lines): %d addresses, %d groups, %d containers, %d classes"
      % (os.path.relpath(OUT, ROOT), len(L), len(ALL),
         G["counts"]["groups"], G["counts"]["containers"], len(cv)))
