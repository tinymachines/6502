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
// 3. The API engine. When the store's engine is `api`, the driver's step,
//    opcode step and forward seek go to halfwave over HTTP: the Machine is
//    exported whole, /v1/step steps it, and the answer is imported back into
//    the same Machine, so the page draws exactly as it did. A runner paces
//    the running chip the same way, one request per frame's worth. What the
//    API does not keep is history, so back and rewind are refused in API
//    mode (the driver's caps say so) and the strip greys them. Every round
//    trip's latency is reported to the store; a failure stops the chip and is
//    reported too, rather than a page that goes quietly still.
//
// Imports the store (for the engine choice and the pacing), so build-web.py
// rewrites that one import as it does for demos.js.

import {
  isApiEngine, halfCyclesFor, noteEngine, setRunning, isRunning,
} from './chip-controls.js';

const KEY = 'v6502.machine';

/** Half-cycles a single API request may run at max clock: a frame's worth. */
const API_BATCH_MAX = 512;

/** Where the API answers: the page says (`data-chip-api`), else this origin. */
export function chipApiBase() {
  const el = document.querySelector('[data-chip-api]');
  return (el && el.dataset.chipApi) || `${location.origin}/api`;
}

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
export function chipDriver(m, { reset, after = () => {}, api = null, fetch: f = null, ...overrides } = {}) {
  if (typeof reset !== 'function') throw new Error('chipDriver: a reset is required');
  const doFetch = (...a) => (f || globalThis.fetch)(...a);
  let busy = false;

  /**
   * One request to halfwave: the whole machine out, the stepped machine
   * back and into `m`. `body` is the step's own fields (`half_cycles`, or
   * `until` with `max_half_cycles`). Resolves true when the machine moved.
   */
  async function remote(body) {
    if (busy) return false;
    busy = true;
    const t0 = performance.now();
    try {
      const res = await doFetch(`${api || chipApiBase()}/v1/step`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ machine: JSON.parse(m.exportMachine()), ...body }),
      });
      if (!res.ok) throw new Error(`/v1/step answered ${res.status}`);
      const out = await res.json();
      importWhole(m, out.machine || out);
      noteEngine({ latency: Math.round(performance.now() - t0) });
      after();
      return true;
    } catch (e) {
      // A chip that stops answering is stopped, and says why. It is not a
      // chip that goes quietly still.
      setRunning(false);
      noteEngine({ latency: null, error: String((e && e.message) || e) });
      return false;
    } finally {
      busy = false;
    }
  }

  const driver = {
    caps: () => (isApiEngine()
      ? { power: true, back: false, step: true, cycle: true, op: true, rate: true, seek: false, engine: true }
      : { power: true, back: true, step: true, cycle: true, op: true, rate: true, seek: true, engine: true }),
    step() {
      if (isApiEngine()) { remote({ half_cycles: 1 }); return; }
      m.halfStep(); after();
    },
    back() { if (isApiEngine()) return; m.stepBack(); after(); },
    reset() { reset(); after(); },
    halfCycle: () => m.halfCycle(),
    sync: () => m.sync(),
    op() {
      if (isApiEngine()) { remote({ until: 'instruction', max_half_cycles: 400 }); return; }
      m.stepInstruction(400); after();
    },
    earliest() {
      const e = m.earliestHalfCycle();
      return e < 0 ? m.halfCycle() : e;
    },
    seek(h) {
      if (isApiEngine()) return false;
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
    /**
     * The API runner's one tick: what the pacing owes, as one request. The
     * page's own loop gets nothing from halfCyclesFor while the engine is
     * the API, so this is the only thing that moves the chip. Exposed so a
     * harness can drive it with its own clock.
     */
    pump(now = performance.now()) {
      if (!isApiEngine() || !isRunning() || busy) return Promise.resolve(false);
      const n = Math.min(halfCyclesFor(now, 'api'), API_BATCH_MAX);
      if (n <= 0) return Promise.resolve(false);
      return remote({ half_cycles: n });
    },
    ...overrides,
  };

  // The runner: a frame loop that only ever does anything in API mode.
  if (typeof requestAnimationFrame === 'function') {
    const tick = (now) => { driver.pump(now); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }
  return driver;
}
