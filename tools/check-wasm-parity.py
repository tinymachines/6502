#!/usr/bin/env python3
"""One engine, two ways in: proof that a machine moves between them.

    wasm-pack build crates/v6502-wasm --target nodejs --out-dir /tmp/pkg-node
    python3 tools/check-wasm-parity.py

The claim is that somebody can wire the engine into their own page OR call the
API and work with the same thing. That is only true if a machine started in one
can be finished in the other, so this splits a run in half and hands it across,
both directions, and requires the answer to be the one a single uninterrupted
run gives.

The witness is the project's own: $2E + $14 landing at $0082 as $42 by
half-cycle 41. Nothing in either path consults an instruction table.

SKIPS when the nodejs-target build is absent, like the golden trace and the
manual. REQUIRE_WASM=1 makes its absence a failure.
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

# The programs page's "Add two bytes", hand-assembled here on purpose: an
# expectation derived from the assembler under test proves nothing.
ADD = "a92e8580a914858118a580658185824c0002"
ORG = 0x0200
SPLIT, REST = 20, 21          # 41 half-cycles, split anywhere

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
    res = json.loads(p.stdout)
    if not res.get("ok"):
        raise SystemExit(f"bridge error: {res.get('error')}")
    return res


def main() -> int:
    if not (PKG / "v6502_wasm.js").exists():
        msg = (f"no nodejs-target build at {PKG}. Build it with:\n"
               f"  wasm-pack build crates/v6502-wasm --target nodejs --out-dir {PKG}")
        if os.environ.get("REQUIRE_WASM"):
            print(f"check-wasm-parity: {msg}", file=sys.stderr)
            return 1
        print(f"check-wasm-parity: SKIP, {msg}")
        return 0

    sys.path.insert(0, str(REPO / "service"))
    from fastapi.testclient import TestClient  # noqa: E402
    from models import Machine  # noqa: E402
    from app import app  # noqa: E402

    print("one engine, two ways in")

    with TestClient(app) as api:
        # -- the control: each side alone, all 41 half-cycles ---------------
        solo = wasm({"op": "run", "program": ADD, "org": ORG,
                     "half_cycles": SPLIT + REST, "peek": [0x82]})
        ok("the wasm engine alone reaches the witness",
           solo["report"]["a"] == 0x42 and solo["peek"]["130"] == 0x42,
           f"A=${solo['report']['a']:02X} $0082=${solo['peek']['130']:02X}")

        boot = api.post("/v1/boot", json={"rom": {"source":
              "        .org $0200\nstart:  LDA #$2E\n        STA $80\n"
              "        LDA #$14\n        STA $81\n        CLC\n        LDA $80\n"
              "        ADC $81\n        STA $82\n        JMP start"}}).json()
        whole = api.post("/v1/step", json={"machine": boot["machine"],
                                           "half_cycles": SPLIT + REST}).json()
        ok("the API alone reaches the witness", whole["observe"]["a"] == 0x42,
           f"A=${whole['observe']['a']:02X}")

        # -- the shape is the API's, not merely similar ---------------------
        part = wasm({"op": "run", "program": ADD, "org": ORG, "half_cycles": SPLIT})
        exported = part["machine"]
        try:
            Machine.model_validate(exported)
            valid, why = True, "accepted by the service's own model"
        except Exception as e:  # noqa: BLE001
            valid, why = False, str(e)[:120]
        ok("an exported machine validates as the API's Machine", valid, why)

        # -- browser to server ----------------------------------------------
        crossed = api.post("/v1/step", json={"machine": exported,
                                             "half_cycles": REST}).json()
        ok("a machine started in the browser finishes on the server",
           crossed["observe"]["a"] == 0x42
           and crossed["machine"]["state"]["half_cycle"] == SPLIT + REST,
           f"A=${crossed['observe']['a']:02X} at h={crossed['machine']['state']['half_cycle']}")
        ok("...bit-exact, every node, not just the registers",
           crossed["machine"]["state"]["value"] == whole["machine"]["state"]["value"],
           "value bitsets identical")

        # -- server to browser ----------------------------------------------
        half = api.post("/v1/step", json={"machine": boot["machine"],
                                          "half_cycles": SPLIT}).json()
        back = wasm({"op": "resume", "machine": half["machine"],
                     "half_cycles": REST, "peek": [0x82]})
        ok("a machine started on the server finishes in the browser",
           back["report"]["a"] == 0x42 and back["peek"]["130"] == 0x42,
           f"A=${back['report']['a']:02X} $0082=${back['peek']['130']:02X}")
        ok("...bit-exact against the uninterrupted run",
           back["machine"]["state"]["value"] == whole["machine"]["state"]["value"],
           "value bitsets identical")

        # -- the check can tell ---------------------------------------------
        # An assertion that cannot fail is not an assertion. Resume the same
        # machine one half-cycle short and the bitsets must NOT match.
        short = wasm({"op": "resume", "machine": half["machine"],
                      "half_cycles": REST - 1})
        ok("and it would notice a machine one half-cycle out",
           short["machine"]["state"]["value"] != whole["machine"]["state"]["value"])

    print("\n" + ("ALL PASS" if not fails else f"RED: {len(fails)} failed"))
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
