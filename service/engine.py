"""The warm instances: a pool of resident halfwave processes.

Each worker is the Rust binary with the netlist parsed and one machine
constructed, waiting on stdin. A request is a block of protocol lines ending
in GO; the response is one JSON line. The workers are stateless -- the whole
machine travels in each request -- so the pool is nothing but a set of locks:
any worker can serve any request, and a dead worker is respawned on the next
use rather than mourned.
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent
REPO = SERVICE_DIR.parent
DEFAULT_BINARY = REPO / "target" / "release" / "halfwave"


class EngineError(Exception):
    """The engine refused the request (a client fault: bad blob, unknown
    node name, count over the cap)."""


class Worker:
    def __init__(self, binary: Path):
        self.binary = binary
        self.lock = threading.Lock()
        self.proc: subprocess.Popen | None = None

    def _spawn(self) -> None:
        self.proc = subprocess.Popen(
            [str(self.binary)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        )

    def request(self, lines: list[str]) -> dict:
        with self.lock:
            if self.proc is None or self.proc.poll() is not None:
                self._spawn()
            assert self.proc and self.proc.stdin and self.proc.stdout
            try:
                self.proc.stdin.write("\n".join(lines) + "\nGO\n")
                self.proc.stdin.flush()
                raw = self.proc.stdout.readline()
            except (BrokenPipeError, OSError):
                raw = ""
            if not raw:
                # The worker died mid-request. Kill it so the next request
                # respawns; this request is the casualty.
                self.proc.kill()
                self.proc = None
                raise EngineError("engine worker died; retry the request")
            res = json.loads(raw)
            if not res.get("ok"):
                raise EngineError(res.get("error", "engine error"))
            return res


class Pool:
    def __init__(self, size: int | None = None, binary: Path | None = None):
        self.binary = Path(binary or os.environ.get("HALFWAVE_BIN", DEFAULT_BINARY))
        if not self.binary.exists():
            raise FileNotFoundError(
                f"halfwave binary not found at {self.binary}; build it with "
                "`cargo build --release -p v6502-sim --bin halfwave` "
                "or set HALFWAVE_BIN"
            )
        n = size or int(os.environ.get("HALFWAVE_POOL", "2"))
        self.workers = [Worker(self.binary) for _ in range(max(1, n))]
        self._i = 0
        self._pick = threading.Lock()

    def request(self, lines: list[str]) -> dict:
        # Round-robin; the per-worker lock serialises actual use, so two
        # concurrent requests land on two warm chips.
        with self._pick:
            w = self.workers[self._i % len(self.workers)]
            self._i += 1
        return w.request(lines)

    def close(self) -> None:
        for w in self.workers:
            if w.proc is not None:
                if w.proc.stdin:
                    w.proc.stdin.close()
                w.proc.wait(timeout=5)
