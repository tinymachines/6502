"""The warm instances: a pool of resident halfwave processes.

Each worker is the Rust binary with the netlist parsed and one machine
constructed, waiting on stdin. A request is a block of protocol lines ending
in GO; the response is one JSON line. The workers are stateless -- the whole
machine travels in each request -- so the pool is nothing but a set of locks:
any worker can serve any request, and a dead worker is respawned on the next
use rather than mourned.

**A chip costs about 3 ms to start and 2.3 MB resident**, measured, because
the netlist is 31 KiB and the binary parses it once. That is what makes a pool
of twelve free rather than a decision.

What twelve chips DO NOT buy is twelve times the throughput, and the reason is
worth knowing before sizing anything. Measured on this host, 24 concurrent
requests of 3000 half-cycles each:

    pool    1     2     4     6     8    12
    speedup 1.00  1.94  3.73  4.15  4.55  5.77

Near-linear to four, then it flattens, because this is a **6-core** part with
two threads per core. Twelve logical CPUs are six physical ones, and the
solver is compute-bound with an IPC of 2.04 and a 1.28% L1 miss rate, so the
second thread on a core has nothing to interleave with. Twelve still beats
eight, which is why the pool is twelve: SMT is worth something, and spare
chips absorb scheduling jitter on a busy box for the price of 2.3 MB each.

The HTTP layer is not the limit and was checked rather than assumed: with the
work set to one half-cycle the same path serves about 980 requests a second at
roughly 1 ms each.
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

# Twelve, for the reasons in the module docstring. `HALFWAVE_POOL` overrides.
DEFAULT_POOL = 12


class EngineError(Exception):
    """The engine refused the request (a client fault: bad blob, unknown
    node name, count over the cap)."""


class Worker:
    """One warm chip. `lock` is public because the pool acquires it without
    blocking in order to find an idle worker."""

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

    def ensure(self) -> None:
        """Bring this chip up if it is not already, so that `warm` means warm."""
        with self.lock:
            if self.proc is None or self.proc.poll() is not None:
                self._spawn()

    def run(self, lines: list[str]) -> dict:
        """Serve one request. **The caller must already hold `self.lock`.**

        Split out from `request` so the pool can take a worker with a
        non-blocking acquire and know it has that chip to itself.
        """
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

    def request(self, lines: list[str]) -> dict:
        with self.lock:
            return self.run(lines)


class Pool:
    def __init__(self, size: int | None = None, binary: Path | None = None):
        self.binary = Path(binary or os.environ.get("HALFWAVE_BIN", DEFAULT_BINARY))
        if not self.binary.exists():
            raise FileNotFoundError(
                f"halfwave binary not found at {self.binary}; build it with "
                "`cargo build --release -p v6502-halfwave --bin halfwave` "
                "or set HALFWAVE_BIN"
            )
        n = size or int(os.environ.get("HALFWAVE_POOL", str(DEFAULT_POOL)))
        self.workers = [Worker(self.binary) for _ in range(max(1, n))]
        self._i = 0
        self._pick = threading.Lock()

    def warm(self) -> int:
        """Start every chip now rather than on its first request.

        Lazy spawning made "a pool of twelve warm instances" false for the
        first twelve requests, each of which paid a start it did not have to.
        The whole pool costs about 40 ms and 28 MB, so there is nothing to
        weigh: a worker that fails to start is left for `run` to retry, since
        one dead chip is not a reason to refuse to boot.
        """
        up = 0
        for w in self.workers:
            try:
                w.ensure()
                up += 1
            except OSError:
                pass
        return up

    def request(self, lines: list[str]) -> dict:
        """Serve on a chip that is free right now, falling back to waiting.

        Round-robin alone hands out the next worker whether or not it is busy,
        so a request could queue behind a chip mid-settle while eleven others
        sat idle. The sweep starts at the round-robin cursor, so an unloaded
        pool still spreads out rather than hammering worker zero.
        """
        with self._pick:
            start = self._i
            self._i += 1
        n = len(self.workers)
        for off in range(n):
            w = self.workers[(start + off) % n]
            if w.lock.acquire(blocking=False):
                try:
                    return w.run(lines)
                finally:
                    w.lock.release()
        # Every chip is busy. Wait for the one this request was owed.
        return self.workers[start % n].request(lines)

    def close(self) -> None:
        for w in self.workers:
            if w.proc is not None:
                if w.proc.stdin:
                    w.proc.stdin.close()
                w.proc.wait(timeout=5)
