#!/usr/bin/env python3
"""M4 experiment 3: is the control vector a function of (IR, T-state, phase)?

Over all 256 opcodes in the four contexts of experiment 1, key every
observed half-cycle by what the chip itself reports (the instruction
register, the T-state string, the hidden state, the phase) and record the
control vector. If one key ever maps to two vectors, that is a place the
sequencer needs a selector beyond the key; the experiment lists them.
"""
import json, os, subprocess, sys
from collections import defaultdict, Counter

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(ROOT, "target/release/halfwave")
D = json.load(open(os.path.join(ROOT, "web/decode.json")))
LINES = [o["name"] for o in D["outputs"]]
CONTROL = LINES + ["rw", "sync", "#WR"]
WATCH = CONTROL + ["clk1out"]
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
    if not r.get("ok"): print("FAIL halfwave:", r.get("error")); sys.exit(1)
    return r

table = defaultdict(Counter)   # key -> Counter(vector -> occurrences)
examples = defaultdict(dict)
for op in range(256):
    for cname, base, pre, ops in CONTEXTS:
        at = base + len(pre)
        mem = bytearray(b"\xea" * 0x10000)
        mem[base:base + len(pre)] = bytes(pre); mem[at:at + 4] = bytes([op] + ops)
        mem[0x0300:0x0303] = bytes([0x4c, 0x00, 0x03])
        mem[0xfffa:0x10000] = bytes([0x00, 0x03, base & 0xff, base >> 8, 0x00, 0x03])
        pages = ["PAGE %02x %s" % (p, mem[p*256:(p+1)*256].hex()) for p in range(256) if mem[p*256:(p+1)*256] != b"\xea"*256]
        st = call(["FILL ea"] + pages + ["VEC %04x" % base, "BOOT"])["state"]; lf = st["last_fetch"]
        S = "STATE %s %s %s %s %s %s" % (st["value"], st["pullup"], st["pulldown"], st["trans_on"], st["half_cycle"], "-" if lf is None else "%04x%02x" % (lf["addr"], lf["opcode"]))
        tr = call([S, "FILL ea"] + pages + ["WATCH " + " ".join(WATCH), "TRACE", "STEP 60"])["trace"]
        start = next((i for i, o in enumerate(tr) if o["sync"] and o["addr"] == at), None)
        if start is None: continue
        # the opcode's own span plus the two overlap half-cycles of the next fetch
        end = next((i for i in range(start + 2, len(tr)) if tr[i]["sync"]), len(tr) - 2)
        for o in tr[start:end + 2]:
            w = o["watch"]
            key = (o["ir"], o["tstates"], o["hidden"], "phi1" if w["clk1out"] else "phi2")
            vec = tuple(int(w[n]) for n in CONTROL)
            table[key][vec] += 1
            examples[key].setdefault(vec, (op, cname, o["half_cycle"]))

keys = len(table)
conflicts = {k: v for k, v in table.items() if len(v) > 1}
print("keys (ir, tstates, hidden, phase): %d; with one vector: %d; with more: %d" % (keys, keys - len(conflicts), len(conflicts)))
byop = Counter(k[0] for k in conflicts)
print("opcodes with a conflicting key: %d" % len(byop))
print("\nconflicts: key -> the lines that differ, and one example run per vector")
for k in sorted(conflicts):
    vecs = list(conflicts[k])
    diff = [CONTROL[i] for i in range(len(CONTROL)) if len({v[i] for v in vecs}) > 1]
    ex = "; ".join("%02x/%s@%d" % examples[k][v] for v in vecs[:3])
    print("  ir=%02x T=%-6s hid=%-4s %s: %s  [%s]" % (k[0], k[1], k[2], k[3], ",".join(diff), ex))
