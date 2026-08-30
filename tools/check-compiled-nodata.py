#!/usr/bin/env python3
"""The compiled kernel names no chip.

`crates/v6502-compiled/build.rs` emits the recognised network as Rust into
OUT_DIR. That file is derived from the CC BY-NC-SA die data and is never
committed or shipped, but the die's NAME table is a separate, MIT-licensed
thing, and nothing from it should leak into generated code either: the
kernel is numbers. This finds the newest generated kernel.rs and fails if it
contains a string literal or any identifier outside the small set the
generator is allowed to use. SKIPS if no kernel has been generated
(`cargo build -p v6502-compiled`); REQUIRE_KERNEL=1 makes that a failure.
"""
import glob
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALLOWED = {
    # Rust
    "pub", "const", "static", "usize", "u16", "u64", "fn", "let", "mut", "mod", "inline", "always",
    # the generator's own vocabulary
    "NODES", "TRANS", "VSS", "VCC", "FOLDED_GATES", "GATES_LEFT_AS_SWITCHES", "ABSORBED", "SWITCHES",
    "DEAD", "JUNCTIONS", "MISSING", "GATE_OF", "sig", "gate_planes", "spread_once", "junctions",
    "both", "oneway", "on", "moved", "next", "top", "bot", "v", "p", "s",
    "CLK0", "RW", "SYNC", "RES", "IRQ", "NMI", "RDY", "SO", "AB", "DB", "A", "X", "Y", "S", "PCL", "PCH", "IR",
    "Vec",
}

paths = glob.glob(os.path.join(ROOT, "target", "*", "build", "v6502-compiled-*", "out", "kernel.rs"))
if not paths:
    print("SKIP: no generated kernel.rs under target/ (cargo build -p v6502-compiled)")
    sys.exit(1 if os.environ.get("REQUIRE_KERNEL") == "1" else 0)
path = max(paths, key=os.path.getmtime)
text = open(path).read()
body = "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("//"))
bad = []
if '"' in body:
    bad.append("a string literal")
idents = set(re.findall(r"[A-Za-z_][A-Za-z_0-9]*", body))
idents = {i for i in idents if not re.fullmatch(r"[0-9]+", i)}
leaked = sorted(i for i in idents if i not in ALLOWED)
if leaked:
    bad.append(f"identifiers outside the generator's vocabulary: {', '.join(leaked[:20])}")
lines = body.count("\n")
if bad:
    print(f"FAIL {os.path.relpath(path, ROOT)}: " + "; ".join(bad))
    sys.exit(1)
print(f"ok {os.path.relpath(path, ROOT)}: {lines} lines, {len(idents)} distinct identifiers, all in the generator's vocabulary, no string literal")
