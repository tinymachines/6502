#!/usr/bin/env python3
"""`importMachine` restores a whole machine, and restores the same one.

    wasm-pack build crates/v6502-wasm --target nodejs --out-dir /tmp/pkg-node
    python3 tools/check-wasm-import.py

`importState` restores the chip and not its memory. That is documented, and it
is still the kind of thing a caller gets wrong once: forgetting the memory does
not raise anything or produce an empty machine, it leaves the PREVIOUS program
in RAM under a program counter belonging to a different one. It runs, and what
it does looks like a simulation bug.

`importMachine` does both in one call. This checks the two claims that makes:

  1. It agrees with the two-call sequence exactly. A convenience that is subtly
     not equivalent is worse than no convenience, so the same machine is
     resumed both ways and both are required to be identical.
  2. It refuses a page list it cannot cut apart, rather than writing whatever
     happens to line up.

And one claim about the thing it replaces, kept here because a warning nobody
demonstrates is a warning nobody believes: resuming with `importState` alone
really does leave the old program behind.

SKIPS when the nodejs-target build is absent, like check-wasm-parity.
REQUIRE_WASM=1 makes its absence a failure.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PKG = Path(os.environ.get("WASM_PKG", "/tmp/pkg-node"))
BRIDGE = REPO / "tools" / "wasm-bridge.mjs"

# The same hand-assembled program check-wasm-parity uses: $2E + $14 landing at
# $0082. Hand-assembled on purpose, because an expectation derived from the
# assembler under test proves nothing.
ADD = "a92e8580a914858118a580658185824c0002"
ORG = 0x0200
SPLIT, REST = 20, 21

fails: list[str] = []


def ok(name: str, cond: bool, detail: str = "") -> None:
    print(f"  {'OK  ' if cond else 'FAIL'} {name}" + (f" [{detail}]" if detail else ""))
    if not cond:
        fails.append(name)


def wasm(req: dict) -> dict:
    node = os.environ.get("NODE", "node")
    p = subprocess.run([node, str(BRIDGE)], input=json.dumps(req),
                       capture_output=True, text=True, timeout=120,
                       env={**os.environ, "WASM_PKG": str(PKG)})
    if p.returncode != 0:
        raise SystemExit(f"bridge failed: {p.stderr.strip()[:400]}")
    return json.loads(p.stdout)


def require_ok(res: dict) -> dict:
    if not res.get("ok"):
        raise SystemExit(f"bridge error: {res.get('error')}")
    return res


def main() -> int:
    if not (PKG / "v6502_wasm.js").exists():
        msg = f"no nodejs build at {PKG}"
        if os.environ.get("REQUIRE_WASM"):
            print(f"check-wasm-import: {msg}")
            return 1
        print(f"check-wasm-import: SKIP, {msg}")
        return 0

    # Run the program partway and take the machine out.
    first = require_ok(wasm({"op": "run", "program": ADD, "org": ORG,
                             "half_cycles": SPLIT, "export": True}))
    machine = first["machine"]
    ok("a machine came out of the wasm build", bool(machine.get("state")))

    # Resume it both ways and finish the run.
    two_calls = require_ok(wasm({"op": "resume", "machine": machine,
                                 "half_cycles": REST, "export": True,
                                 "peek": [0x82]}))
    one_call = require_ok(wasm({"op": "resume-whole", "machine": machine,
                                "half_cycles": REST, "export": True,
                                "peek": [0x82]}))

    ok("importMachine agrees with importState plus writeMemory",
       one_call["machine"] == two_calls["machine"],
       "byte for byte" if one_call["machine"] == two_calls["machine"] else "diverged")
    ok("and reports the same registers", one_call["report"] == two_calls["report"])

    # The witness the whole project uses: $2E + $14 is $42 at $0082.
    got = one_call.get("peek", {}).get("130")
    ok("the sum is at $0082", got == 0x42, f"${(got or 0):02X}")

    # The warning, demonstrated. Resume the machine into a build whose memory
    # holds something else, using importState alone, and the something else is
    # still there.
    other = dict(machine)
    other = {"state": machine["state"],
             "memory": {"fill": "ea", "pages": {}}}
    stale = require_ok(wasm({"op": "resume", "machine": other,
                             "half_cycles": 0, "export": True, "peek": [ORG]}))
    ok("importState alone leaves the old memory in place",
       stale["peek"][str(ORG)] == 0xEA, "found $EA where the program should be")

    # The refusal: page bytes that are not a whole number of pages.
    bad = require_ok(wasm({"op": "run", "program": ADD, "org": ORG,
                           "half_cycles": 1, "export": True}))["machine"]
    bad["memory"] = {"fill": "00", "pages": {"02": "abcd"}}
    res = wasm({"op": "resume-whole", "machine": bad, "half_cycles": 0})
    refused = (not res.get("ok")) and "cut apart" in str(res.get("error", ""))
    ok("a page list it cannot cut apart is refused", refused,
       str(res.get("error", ""))[:60])

    if fails:
        print(f"\ncheck-wasm-import: {len(fails)} failure(s): {', '.join(fails)}")
        return 1
    print("\ncheck-wasm-import: importMachine restores a whole machine, identically")
    return 0


if __name__ == "__main__":
    sys.exit(main())
