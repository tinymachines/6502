#!/usr/bin/env python3
"""The data-free wasm build ships no die data. Checked, not asserted.

    python3 tools/check-wasm-nodata.py

`v6502-wasm --no-default-features` exists so a published JavaScript package
can be MIT the way `halfphi` is: the netlist blob is derived from CC BY-NC-SA
material and carries NonCommercial and ShareAlike into anything that embeds
it, so that build embeds none and takes one at runtime.

That is exactly the kind of property that regresses silently. Someone adds a
convenience, reaches for `mos6502()` to implement it, and the dependency comes
back without anything failing: the build still works, the tests still pass,
and the package quietly stops being MIT. So the guard is the dependency tree,
which is fast and catches it at the source, plus the built artefact when one
is lying around.

Exit 1 on any failure.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
# The one crate in this workspace that embeds die data.
DATA_CRATE = "v6502-netlist"
MAGIC = b"HALFPHI1"

fails = []


def ok(name: str, cond: bool, detail: str = "") -> None:
    print(f"  {'OK  ' if cond else 'FAIL'} {name}" + (f" [{detail}]" if detail else ""))
    if not cond:
        fails.append(name)


def tree(*args: str) -> str:
    p = subprocess.run(["cargo", "tree", "-p", "v6502-wasm", "--edges", "normal", *args],
                       cwd=REPO, capture_output=True, text=True, timeout=180)
    if p.returncode != 0:
        raise SystemExit(f"cargo tree failed: {p.stderr.strip()[:300]}")
    return p.stdout


def main() -> int:
    print("the data-free wasm build")

    # The load-bearing one. A dependency cannot hide.
    without = tree("--no-default-features")
    ok(f"{DATA_CRATE} is absent without the feature", DATA_CRATE not in without)

    # And the check can tell: it must be there WITH the feature, or the test
    # above would pass on a workspace where the crate had simply been deleted.
    with_data = tree()
    ok(f"...and present with it", DATA_CRATE in with_data,
       "so the check above is testing the feature, not an empty workspace")

    # The artefact, when one exists. Not built here: wasm-pack takes minutes
    # and a check nobody runs is worth nothing.
    checked = 0
    for pkg in (Path("/tmp/pkg-nodata"), REPO / "web" / "pkg-nodata"):
        wasm = next(iter(pkg.glob("*_bg.wasm")), None) if pkg.is_dir() else None
        if wasm is None:
            continue
        checked += 1
        blob = wasm.read_bytes()
        ok(f"{wasm.name} carries no netlist blob", MAGIC not in blob,
           f"{len(blob)/1024:.0f} KB")
    if not checked:
        print("  SKIP the built bundle: none found. Build one with\n"
              "       wasm-pack build crates/v6502-wasm --target nodejs \\\n"
              "         --out-dir /tmp/pkg-nodata -- --no-default-features")

    print("\n" + ("ALL PASS" if not fails else f"RED: {len(fails)} failed"))
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
