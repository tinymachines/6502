#!/usr/bin/env python3
"""M4 experiment 2: do the 44 lines' documented meanings reproduce the buses?

A Python model of Hanson's block diagram, driven each half-cycle by rung 0's
OWN control-line levels (so sequencing is the chip's and only the datapath
semantics are under test), scored per field against what the chip's nodes
say. A wrong line meaning shows up as one field going wrong at one
half-cycle with a short list of active lines beside it.

    python3 tools/experiments/m4-datapath.py [--show FIELD] [--n 600]
"""
import json, os, subprocess, sys
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BIN = os.path.join(ROOT, "target/release/halfwave")
D = json.load(open(os.path.join(ROOT, "web/decode.json")))
LINES = [o["name"] for o in D["outputs"]]
SHORT = {l: l.split("_", 1)[1] for l in LINES}
EXTRA = ["clk1out", "clk2out", "alucin", "0/ADL0", "0/ADL1", "0/ADL2", "#WR", "sync"]
WATCH = LINES + EXTRA
N = int(sys.argv[sys.argv.index("--n") + 1]) if "--n" in sys.argv else 600
SHOW = sys.argv[sys.argv.index("--show") + 1] if "--show" in sys.argv else None

PROGS = {
    "loads/alu":   [0xa9,0x2e,0x69,0x14,0x85,0x82,0xa2,0x03,0xa0,0x05,0x8a,0xa8,0x98,0x4c,0x00,0x02],
    "logic/shift": [0xa9,0x5a,0x09,0x0f,0x29,0x3c,0x49,0xff,0x4a,0x0a,0x6a,0x2a,0xe9,0x11,0x4c,0x00,0x02],
    "stack/calls": [0xa2,0xff,0x9a,0xba,0x48,0x68,0x08,0x28,0x20,0x10,0x02,0x4c,0x00,0x02,0xea,0xea,0x60],
    "indexed/br":  [0xa2,0x02,0xa0,0x03,0xbd,0x00,0x03,0xb9,0x00,0x03,0x9d,0x20,0x03,0xc9,0x00,0xd0,0x02,
                    0xe6,0x10,0x4c,0x00,0x02],
}

proc = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
def call(lines):
    proc.stdin.write("\n".join(lines) + "\nGO\n"); proc.stdin.flush()
    r = json.loads(proc.stdout.readline())
    if not r.get("ok"): print("FAIL halfwave:", r.get("error")); sys.exit(1)
    return r

def trace(code):
    page = bytearray(b"\xea" * 256); page[:len(code)] = bytes(code)
    P = "PAGE 02 " + page.hex()
    st = call(["FILL ea", P, "VEC 0200", "BOOT"])["state"]; lf = st["last_fetch"]
    S = "STATE %s %s %s %s %s %s" % (st["value"], st["pullup"], st["pulldown"], st["trans_on"], st["half_cycle"],
                                     "-" if lf is None else "%04x%02x" % (lf["addr"], lf["opcode"]))
    return call([S, "FILL ea", P, "WATCH " + " ".join(WATCH), "TRACE", "STEP %d" % N])["trace"]

class Model:
    """Hanson's block diagram. Everything is a byte; buses precharge to $FF
    and drivers AND into them (NMOS, low wins)."""
    def __init__(self, o):
        # Seed the registers from the chip at the first observation: the
        # experiment is about what the LINES do, not about power-on.
        self.a, self.x, self.y = o["a"], o["x"], o["y"]
        self.s_in = self.s_out = o["s"]
        self.pcl, self.pch = o["pc"] & 0xff, o["pc"] >> 8
        self.pclp, self.pchp = o["pclp"], o["pchp"]
        self.abl, self.abh = o["abl"], o["abh"]
        self.dl, self.dor, self.add = o["idl"], o["dor"], o["alu"]
        self.ai, self.bi = o["alua"], o["alub"]
        self.sb = self.db = self.adl = self.adh = 0xff

    def step(self, w, phase, data_in):
        L = lambda name: bool(w[name])
        on = {SHORT[l] for l in LINES if w[l]}
        # The incrementer latch: PC + IPC, taken during phi2 and held through
        # the next phi1. Every PC-to-bus drive is from this latch, and the
        # routine increment is latch -> ADL -> ADL/PCL, not PCL/PCL (which
        # is the hold path, PC from its own latch).
        if phase == "phi2":
            ipc = not L("dpc36_#IPC")
            self.pclp = (self.pcl + ipc) & 0xff
            self.pchp = (self.pch + (1 if ipc and self.pcl == 0xff else 0)) & 0xff
        pcl_inc, pch_inc = self.pclp, self.pchp

        # --- buses: precharge, then drivers AND in, then pass-connects ---
        # The wiki's phase rule: register-to-bus drives from X, Y, A and DL
        # are effective in phi1 only; S, ADD, the PC and the constants are
        # effective in phi2 and the next phi1.
        p1 = phase == "phi1"
        sb = db = adl = adh = 0xff
        if "YSB" in on and p1: sb &= self.y
        if "XSB" in on and p1: sb &= self.x
        if "SSB" in on: sb &= self.s_out
        if "ACSB" in on and p1: sb &= self.a
        if "ADDSB06" in on: sb &= self.add | 0x80
        if "ADDSB7" in on: sb &= self.add | 0x7f
        if "ACDB" in on and p1: db &= self.a
        if "PCHDB" in on: db &= pch_inc
        if "PCLDB" in on: db &= pcl_inc
        if "DL/DB" in on and p1: db &= self.dl
        if "SADL" in on: adl &= self.s_out
        if "ADDADL" in on: adl &= self.add
        if "PCLADL" in on: adl &= pcl_inc
        if "DL/ADL" in on and p1: adl &= self.dl
        if L("0/ADL0"): adl &= ~1 & 0xff
        if L("0/ADL1"): adl &= ~2 & 0xff
        if L("0/ADL2"): adl &= ~4 & 0xff
        if "PCHADH" in on: adh &= pch_inc
        if "DL/ADH" in on and p1: adh &= self.dl
        if "0ADH0" in on: adh &= 0xfe
        if "0ADH17" in on: adh &= 0x01
        if "SBDB" in on: sb = db = sb & db
        if "SBADH" in on: sb = adh = sb & adh
        if "SBDB" in on and "SBADH" in on: sb = db = adh = sb & db & adh
        self.sb, self.db, self.adl, self.adh = sb, db, adl, adh

        if phase == "phi1":
            if "ADL/ABL" in on: self.abl = adl
            if "ADH/ABH" in on: self.abh = adh
            if "SBY" in on: self.y = sb
            if "SBX" in on: self.x = sb
            if "SBS" in on: self.s_in = sb
            elif "SS" in on: self.s_in = self.s_out
            if "SBAC" in on: self.a = sb
            if "SBADD" in on: self.ai = sb
            if "0ADD" in on: self.ai = 0
            if "DBADD" in on: self.bi = db
            if "nDBADD" in on: self.bi = (~db) & 0xff
            if "ADLADD" in on: self.bi = adl
            if "ADLPCL" in on: self.pcl = adl
            elif "PCLPCL" in on: self.pcl = self.pclp
            if "ADHPCH" in on: self.pch = adh
            elif "PCHPCH" in on: self.pch = self.pchp
            self.dor = db
        else:
            cin = 1 if L("alucin") else 0
            a, b = self.ai, self.bi
            if "SUMS" in on: self.add = (a + b + cin) & 0xff
            elif "ANDS" in on: self.add = a & b
            elif "ORS" in on: self.add = a | b
            elif "EORS" in on: self.add = a ^ b
            elif "SRS" in on: self.add = (a | b) >> 1
            self.dl = data_in
            self.s_out = self.s_in

FIELDS = ["abl", "abh", "pc", "pclp", "pchp", "a", "x", "y", "s", "alu", "dor", "idl", "sb", "idb", "adl", "adh"]
def model_value(m, f):
    return {"abl": m.abl, "abh": m.abh, "pc": m.pch << 8 | m.pcl, "pclp": m.pclp, "pchp": m.pchp, "a": m.a, "x": m.x, "y": m.y, "s": m.s_in,
            "alu": m.add, "dor": m.dor, "idl": m.dl, "sb": m.sb, "idb": m.db, "adl": m.adl, "adh": m.adh}[f]

total = 0
ok = Counter(); ok_ph = Counter()
first = {}
shown = 0
for pname, code in PROGS.items():
    tr = trace(code)
    m = Model(tr[0])
    for i in range(1, len(tr)):
        o = tr[i]; w = o["watch"]
        phase = "phi1" if w["clk1out"] else "phi2"
        m.step(w, phase, o["data"] if o["rw"] == "read" else m.dor)
        total += 1
        for f in FIELDS:
            good = model_value(m, f) == o[f]
            ok[f] += good; ok_ph[(f, phase)] += good
            if not good and f not in first:
                first[f] = (pname, o["half_cycle"], phase, model_value(m, f), o[f], o["tstates"], [SHORT[l] for l in LINES if w[l]])
            if SHOW == f and not good and shown < 12:
                shown += 1
                print("  %s hc %d %s %s: model %02x chip %02x  T=%s  lines %s" % (pname, o["half_cycle"], phase, f, model_value(m, f), o[f], o["tstates"], " ".join(SHORT[l] for l in LINES if w[l])))

print("%d half-cycles over %d programs; agreement per field (all / phi1 / phi2):" % (total, len(PROGS)))
for f in FIELDS:
    p1 = ok_ph[(f, "phi1")]; p2 = ok_ph[(f, "phi2")]
    print("  %-4s %5.1f%%   phi1 %5.1f%%  phi2 %5.1f%%" % (f, 100 * ok[f] / total, 200 * p1 / total, 200 * p2 / total))
print("\nfirst mismatch per field:")
for f in FIELDS:
    if f in first:
        pname, hc, ph, mv, cv, ts, lines = first[f]
        print("  %-4s %s hc %d %s T=%s model %02x chip %02x  lines: %s" % (f, pname, hc, ph, ts, mv, cv, " ".join(lines)))
