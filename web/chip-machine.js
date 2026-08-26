// One chip across the pages, and the driver every page hands the store.
//
// Each page builds its own Machine, because each has a renderer bound to it
// and a program picker of its own. What was NOT true before this module is
// that the machine you left on one page is the machine you arrive at on the
// next: every page booted from the reset vector, so the half-cycle count on
// the tracer had nothing to do with the one the explorer was just showing.
//
// Two things fix that, and this file is both:
//
// 1. `adopt(m, program)`: the page's machine, once it has loaded its program,
//    is restored from the snapshot the previous page left (if it left one, and
//    for the same program), and the page arms itself to leave a snapshot of
//    its own when it goes. The snapshot is the machine's own export, the same
//    JSON `/v1/step` takes, so nothing here knows what is in it.
//
// 2. `chipDriver(m, hooks)`: the driver for chip-controls.js, with everything
//    the store can now ask: capabilities, an opcode step, seek within the
//    rewind window, power. Eight pages wrote the four-method driver by hand
//    and would have written the ten-method one by hand eight times.
//
// A leaf: imports nothing, so build-web.py hashes it like solo-palette.js.

const KEY = 'v6502.machine';

/** The furthest a seek forward will run, so a slider dragged to the end is bounded. */
const SEEK_FORWARD_MAX = 4096;

/**
 * Restore `m` from the previous page's snapshot when it was the same
 * program, and arm this page to leave one. Returns true when a snapshot was
 * applied. The rewind window starts fresh after a restore: a restored
 * machine can step back only over what it has done here, and `earliest`
 * reports exactly that.
 */
export function adopt(m, program) {
  let restored = false;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) {
      const snap = JSON.parse(raw);
      if (snap && snap.program === program && snap.machine) {
        importWhole(m, snap.machine);
        restored = true;
      }
    }
  } catch (e) {
    // A snapshot that does not fit this build of the machine is dropped, not
    // worked around: the page boots from the reset vector as it always did.
    console.warn('chip-machine: snapshot not restored', e);
    try { sessionStorage.removeItem(KEY); } catch { /* private mode */ }
  }
  const keep = () => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ program, machine: JSON.parse(m.exportMachine()) }));
    } catch { /* private mode, or a freed machine */ }
  };
  addEventListener('pagehide', keep);
  return restored;
}

/** Forget the snapshot: the next page boots from the reset vector. */
export function forget() {
  try { sessionStorage.removeItem(KEY); } catch { /* private mode */ }
}

/** The same restore tools/wasm-bridge.mjs does for `resume-whole`. */
function importWhole(m, machine) {
  const s = machine.state;
  const ids = [];
  const bytes = [];
  for (const [page, hex] of Object.entries(machine.memory.pages || {})) {
    ids.push(parseInt(page, 16));
    for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  m.importMachine(s.value, s.pullup, s.pulldown, s.trans_on, s.half_cycle,
                  s.last_fetch ? s.last_fetch.addr : -1,
                  s.last_fetch ? s.last_fetch.opcode : 0,
                  parseInt(machine.memory.fill ?? '00', 16),
                  Uint8Array.from(ids), Uint8Array.from(bytes));
}

/**
 * The driver for a page that runs a wasm Machine.
 *
 * `reset` boots the page's program again (its own loadProgram, which knows
 * which program its picker holds); `after` is called once after every action
 * so the page repaints. A page whose step does more than `halfStep` (the
 * tracer records every fetch) passes its own `step` and `back`.
 *
 * Power off keeps the machine: the readouts show the last thing the chip
 * did rather than jumping, which is what the Lab's off state does too. Power
 * on is a reset: memory back to the program image, every pin released.
 */
export function chipDriver(m, { reset, after = () => {}, ...overrides } = {}) {
  if (typeof reset !== 'function') throw new Error('chipDriver: a reset is required');
  return {
    caps: { power: true, back: true, step: true, cycle: true, op: true, rate: true, seek: true },
    step() { m.halfStep(); after(); },
    back() { m.stepBack(); after(); },
    reset() { reset(); after(); },
    halfCycle: () => m.halfCycle(),
    sync: () => m.sync(),
    op() { m.stepInstruction(400); after(); },
    earliest() {
      const e = m.earliestHalfCycle();
      return e < 0 ? m.halfCycle() : e;
    },
    seek(h) {
      const cur = m.halfCycle();
      if (h < cur) {
        if (!m.rewindTo(h)) return false;
      } else if (h > cur) {
        m.runHalfCycles(Math.min(h - cur, SEEK_FORWARD_MAX));
      }
      after();
      return true;
    },
    power(on) { if (on) reset(); after(); },
    ...overrides,
  };
}
