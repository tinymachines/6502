#!/usr/bin/env python3
"""M4 experiment 1: is the control sequence per opcode context-invariant?

For every opcode, run it from several contexts (registers, flags, operands
and base page all varied) on rung 0 through halfwave, and record, from the
opcode's own fetch, the vector of the 46 datapath control lines plus rw,
sync, the T-state and pipeline nodes, per half-cycle. Then compare the
sequences across contexts. If they agree except at a few identifiable
half-cycles, rung 3's table can be MEASURED and the authored part is a list.

    python3 tools/experiments/m4-control-vectors.py [--window 40]
"""
import json, os, subprocess, sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BIN = os.path.join(ROOT, "target/release/halfwave")
D = json.load(open(os.path.join(ROOT, "web/decode.json")))
LINES = [o["name"] for o in D["outputs"]]
# Control: what the table would have to say. Data: what the random logic reads
# to pick between table entries; these differ by construction and are kept
# apart so they cannot be mistaken for a control line that varies.
CONTROL_EXTRA = ["rw", "sync", "t2", "t3", "t4", "t5", "clock1", "clock2", "VEC0", "VEC1", "#WR",
                 "pipeT-SYNC", "pipe#T0", "pipe#VEC", "#TWOCYCLE", "ONEBYTE", "fetch", "pipeIPCrelated"]
DATA = ["#BRtaken", "#op-branch-done", "short-circuit-branch-add", "short-circuit-idx-add", "alucin", "#DBZ", "DBNeg"]
CONTROL = LINES + CONTROL_EXTRA
WATCH = CONTROL + DATA
NC = len(CONTROL)
WINDOW = int(sys.argv[sys.argv.index("--window") + 1]) if "--window" in sys.argv else 40

# (name, base, preamble, operands): the opcode goes right after the preamble.
CONTEXTS = [
    ("plain",    0x0200, [0xa9, 0x41, 0xa2, 0x02, 0xa0, 0x03, 0x18], [0x34, 0x12, 0x00]),
    ("setflags", 0x0200, [0xa9, 0x80, 0xa2, 0xff, 0xa0, 0xff, 0x38], [0xff, 0x02, 0x00]),
    ("zero",     0x0200, [0xa9, 0x00, 0xa2, 0x00, 0xa0, 0x00, 0x18], [0x00, 0x03, 0x00]),
    ("pagecross",0x02f0, [0x38, 0xa9, 0x80, 0xa2, 0xff, 0xa0, 0x01], [0x7f, 0x02, 0x00]),
]

proc = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
def call(lines):
    proc.stdin.write("\n".join(lines) + "\nGO\n"); proc.stdin.flush()
    r = json.loads(proc.stdout.readline())
    if not r.get("ok"):
        print("FAIL halfwave:", r.get("error")); sys.exit(1)
    return r

def run(op, base, preamble, operands):
    at = base + len(preamble)
    mem = bytearray(b"\xea" * 0x10000)
    mem[base:base + len(preamble)] = bytes(preamble)
    mem[at:at + 4] = bytes([op] + operands)
    mem[0x0300:0x0303] = bytes([0x4c, 0x00, 0x03])
    mem[0xfffa:0x10000] = bytes([0x00, 0x03, base & 0xff, base >> 8, 0x00, 0x03])
    pages = []
    for p in range(256):
        chunk = mem[p * 256:(p + 1) * 256]
        if chunk != b"\xea" * 256:
            pages.append("PAGE %02x %s" % (p, chunk.hex()))
    st = call(["FILL ea"] + pages + ["VEC %04x" % base, "BOOT"])["state"]
    lf = st["last_fetch"]
    S = "STATE %s %s %s %s %s %s" % (st["value"], st["pullup"], st["pulldown"], st["trans_on"], st["half_cycle"],
                                     "-" if lf is None else "%04x%02x" % (lf["addr"], lf["opcode"]))
    tr = call([S, "FILL ea"] + pages + ["WATCH " + " ".join(WATCH), "TRACE", "STEP %d" % (WINDOW + 40)])["trace"]
    # from the opcode's own fetch: sync high with its address on the bus
    start = next((i for i, o in enumerate(tr) if o["watch"]["sync"] and o["addr"] == at), None)
    if start is None:
        return None
    seq = []
    for o in tr[start:start + WINDOW]:
        w = o["watch"]
        seq.append((tuple(int(w[n]) for n in WATCH), o["addr"], o["data"], o["rw"]))
    # the opcode's own span: up to the next fetch (sync high again), h >= 2
    end = next((i for i in range(2, len(seq)) if seq[i][0][CONTROL.index("sync")]), len(seq))
    return seq[:end]

def vec(s):
    return s[0][:NC]

classes = defaultdict(list)
detail = {}
detail_len = {}
for op in range(256):
    seqs = {}
    for name, base, pre, ops in CONTEXTS:
        s = run(op, base, pre, ops)
        if s is None:
            print("op %02x: no fetch in context %s" % (op, name)); continue
        seqs[name] = s
    ref = seqs["plain"]
    diffs = {}
    lengths = {n: len(s) for n, s in seqs.items()}
    for name, s in seqs.items():
        if name == "plain": continue
        n = min(len(s), len(ref))
        first = next((i for i in range(2, n) if vec(s[i]) != vec(ref[i])), None)
        if first is not None:
            names = [CONTROL[k] for k in range(NC) if vec(s[first])[k] != vec(ref[first])[k]]
            diffs[name] = (first, names, len(s), len(ref))
        elif len(s) != len(ref):
            diffs[name] = (n, ["(length only)"], len(s), len(ref))
    key = "invariant" if not diffs else "varies"
    detail_len[op] = lengths
    classes[key].append(op)
    detail[op] = diffs

print("window %d half-cycles from the opcode's fetch, %d contexts, %d watched nodes" % (WINDOW, len(CONTEXTS), len(WATCH)))
print("invariant across all contexts: %d opcodes" % len(classes["invariant"]))
print("vary somewhere:               %d opcodes" % len(classes["varies"]))
from collections import Counter
kinds = Counter()
for op in classes["varies"]:
    for name, (h, ns, ls, lr) in detail[op].items():
        kinds[(name, "length %d vs %d" % (ls, lr) if ns == ["(length only)"] else "content at h=%d" % h)] += 1
print("\nkind of variation (context, what): opcodes")
for (name, what), c in sorted(kinds.items(), key=lambda x: (-x[1], x[0])):
    print("  %-10s %-22s %3d" % (name, what, c))
print("\nper varying opcode: context -> (first half-cycle, lines, length vs plain)")
for op in classes["varies"]:
    parts = ["%s@%d:%s[%d/%d]" % (n, h, ",".join(ns[:5]), ls, lr) for n, (h, ns, ls, lr) in detail[op].items()]
    print("  %02x  %s" % (op, "  ".join(parts)))
print("\nlengths (half-cycles from fetch to next fetch) of the invariant opcodes, by value:")
lc = Counter(detail_len[op]["plain"] for op in classes["invariant"])
print("  " + "  ".join("%d:%d" % (k, v) for k, v in sorted(lc.items())))
json.dump({"invariant": classes["invariant"], "varies": {"%02x" % op: detail[op] for op in classes["varies"]}},
          open(os.path.join(ROOT, "tools/experiments/m4-control-vectors.json"), "w"))
