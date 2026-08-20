"""Assembly, by the one assembler this project has.

`web/asm.js` inverts the disassembler's opcode table, so the two are one
table read in two directions; a Python re-implementation here would be the
second copy that drifts. Instead each request shells to node with
`asm-bridge.mjs`, which does one assembly and exits. Slow is fine: this is a
learning tool, and an assembly is one process spawn.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

BRIDGE = Path(__file__).resolve().parent / "asm-bridge.mjs"


class AssemblyError(Exception):
    def __init__(self, message: str, line: int | None):
        super().__init__(message)
        self.line = line


def assemble(source: str, org: int = 0x0200) -> dict:
    node = os.environ.get("NODE", "node")
    proc = subprocess.run(
        [node, str(BRIDGE)],
        input=json.dumps({"source": source, "org": org}),
        capture_output=True,
        text=True,
        timeout=30,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"asm bridge failed: {proc.stderr.strip()[:400]}")
    res = json.loads(proc.stdout)
    if not res.get("ok"):
        raise AssemblyError(res.get("error", "assembly failed"), res.get("line"))
    return res
