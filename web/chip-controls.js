// The chip's transport and clock rate, owned by the site header.
//
// Four pages ran the chip and each carried its own copy of this. They had three
// different transports, two different speed lists, and the exploded view had no
// speed control at all -- so "the same program at the same speed on two pages"
// was not something the site could actually do. Worse, every one of those speed
// numbers meant *half-cycles per animation frame*, which is not a property of
// the chip: the same setting ran at a different rate on a 60 Hz display, a 120 Hz
// display and the software rasteriser the headless checks use.
//
// So the rate here is the **simulated clock in Hz**, paced against wall-clock
// time. That is a fact about the 6502 being simulated rather than about the
// browser drawing it, it is the same number on every page, and it is what the
// readouts were already trying to report.
//
// One store, one setter per thing, and every control is a view of it. That is
// the same arrangement the program picker uses, for the same reason: two
// controls that each keep their own copy of a setting are two controls that
// will eventually disagree.

/**
 * The clock steps.
 *
 * A 6502 cycle is two half-cycles, so 1 Hz is two half-cycles a second, which
 * is about as slow as watching one edge happen needs. `0` is max: run as much
 * as the frame budget allows, which lands near 14 kHz here.
 */
export const CLOCKS = [
  { hz: 1, label: '1 Hz' },
  { hz: 2, label: '2 Hz' },
  { hz: 5, label: '5 Hz' },
  { hz: 20, label: '20 Hz' },
  { hz: 100, label: '100 Hz' },
  { hz: 1000, label: '1 kHz' },
  { hz: 0, label: 'max' },
];

/** The slowest step, deliberately: the point of this view is one edge at a time. */
export const DEFAULT_HZ = CLOCKS[0].hz;

/** How many half-cycles a frame runs at max, when the caller has no deadline. */
const MAX_BATCH = 512;

const KEY = 'v6502.clock';

const state = {
  running: false,
  hz: DEFAULT_HZ,
  debt: 0,      // fractional half-cycles carried between frames
  last: 0,      // wall clock of the previous pacing call
  powered: false, // a machine is registered and holds state
  booting: false, // setPower(true) is in flight
  engine: 'local', // 'local': the page's wasm steps; 'api': halfwave steps, over HTTP
  latency: null,   // ms of the last API round trip, or null when none has happened
  engineError: null, // the last API failure's message, cleared by the next success
};

const ENGINE_KEY = 'v6502.engine';

/** Written when power is switched off, so the next page opens off too. */
const POWER_KEY = 'v6502.power';

const views = new Set();
let driver = null;

// --------------------------------------------------------------------------
// Reading
// --------------------------------------------------------------------------

export function clockHz() { return state.hz; }
export function isMaxClock() { return state.hz === 0; }
export function isRunning() { return state.running; }
export function hasDriver() { return driver !== null; }

/**
 * The chip's half-cycle count, or null if the page has not offered one.
 *
 * The header's clock indicator blinks on this rather than on a timer. A timer
 * would keep blinking after the chip had stopped and would go on claiming a
 * rate the machine was not delivering, which is the kind of decoration this
 * site exists to avoid.
 */
export function chipHalfCycle() {
  if (!driver || !driver.halfCycle) return null;
  const hc = driver.halfCycle();
  return Number.isFinite(hc) ? hc : null;
}

/**
 * What the registered driver can do, so a transport shows exactly that.
 *
 * A driver may state `caps` itself; otherwise they are read off the methods it
 * has. An empty object when nothing is registered. `power` and `rate` are the
 * store's own and are true for any driver.
 */
export function driverCaps() {
  if (!driver) return {};
  if (driver.caps) return { ...(typeof driver.caps === 'function' ? driver.caps() : driver.caps) };
  return {
    power: true,
    rate: true,
    back: typeof driver.back === 'function',
    step: typeof driver.step === 'function',
    cycle: typeof driver.step === 'function',
    op: typeof driver.op === 'function',
    seek: typeof driver.seek === 'function',
  };
}

export function isPowered() { return state.powered; }

/**
 * Which engine steps the chip. `local` is the page's own wasm Machine.
 * `api` is halfwave behind /v1/step: the machine travels out whole and
 * comes back stepped, and the page's Machine is loaded with the answer, so
 * every view draws exactly as before. The same machine JSON crosses both
 * ways, which is what makes switching mid-run a transfer rather than a
 * reboot (chip-machine.js does the crossing).
 */
export function engine() { return state.engine; }
export function isApiEngine() { return state.engine === 'api'; }
/** The last API round trip in ms, or null; and the last failure, or null. */
export function engineLatency() { return state.latency; }
export function engineError() { return state.engineError; }
export function isBooting() { return state.booting; }

/**
 * The oldest half-cycle the driver can seek to, or null. A wasm machine keeps
 * a rewind window; a recording starts at 0; a driver without `earliest`
 * cannot seek back at all, and says so by returning the current count.
 */
export function chipEarliest() {
  if (!driver || !driver.seek) return null;
  if (driver.earliest) {
    const e = driver.earliest();
    return Number.isFinite(e) ? e : null;
  }
  return chipHalfCycle();
}

/**
 * The last half-cycle the driver can seek to, or null for a live machine,
 * which has no end: it can be run further but not seeked past what it has
 * done. A recording (the Lab, halfshot) has a length.
 */
export function chipLength() {
  if (!driver || !driver.seek || !driver.length) return null;
  const n = driver.length();
  return Number.isFinite(n) ? n : null;
}

export function clockLabel(hz = state.hz) {
  const step = CLOCKS.find((c) => c.hz === hz);
  return step ? step.label : `${hz} Hz`;
}

// --------------------------------------------------------------------------
// Writing. Exactly one function per thing that can change.
// --------------------------------------------------------------------------

export function setRunning(on) {
  // A chip that is registered and switched off does not run. With no driver
  // the store still runs (halfshot paces its recording off it without
  // registering one), as it always did.
  const next = !!on && !(driver && !state.powered);
  if (next === state.running) return;
  state.running = next;
  // Starting fresh rather than carrying a debt across a pause: a long pause
  // would otherwise bank nothing (the pacing clamp caps dt) but a short one
  // would deliver a lurch on the first frame back.
  state.debt = 0;
  state.last = 0;
  announce();
}

export function toggleRunning() { setRunning(!state.running); }

export function setClock(hz) {
  const v = Number(hz);
  if (!Number.isFinite(v) || v < 0) return;
  state.hz = v;
  state.debt = 0;
  try { localStorage.setItem(KEY, String(v)); } catch { /* private mode */ }
  announce();
}

/**
 * Register the page's chip. The header transport acts through this.
 *
 * `null` unregisters: a page that leaves takes its machine with it, and the
 * store must not go on offering a step into something that is gone. Power
 * comes on with the driver unless the driver says otherwise (`powered()`),
 * or the switch was left off on the previous page, in which case the new
 * machine sits booted and idle until power is pressed: the choice made once
 * holds across a navigation, the way the clock does.
 */
export function registerDriver(d) {
  driver = d || null;
  if (!driver) {
    state.running = false;
    state.powered = false;
    state.booting = false;
    announce();
    return;
  }
  let off = false;
  try { off = sessionStorage.getItem(POWER_KEY) === '0'; } catch { /* private mode */ }
  state.powered = driver.powered ? !!driver.powered() : !off;
  if (!state.powered) state.running = false;
  announce();
}

/**
 * Power. Off: the chip stops and the store refuses to run or step it; what
 * it holds is the driver's business (the Lab holds nothing, a wasm machine
 * keeps its last state so the page does not jump). On: the driver boots a
 * new machine (`power(true)`, which may be async), or is reset where it has
 * no power of its own, which for a wasm page is the same thing. `booting`
 * is exposed while that settles, so a transport can show it rather than
 * flicker between the two states.
 */
export async function setPower(on) {
  const next = !!on;
  if (!driver) return;
  if (next === state.powered && !state.booting) return;
  if (!next) {
    setRunning(false);
    state.powered = false;
    if (driver.power) await driver.power(false);
    try { sessionStorage.setItem(POWER_KEY, '0'); } catch { /* private mode */ }
    announce();
    return;
  }
  state.booting = true;
  announce();
  try {
    if (driver.power) await driver.power(true);
    else if (driver.reset) driver.reset();
    state.powered = driver.powered ? !!driver.powered() : true;
  } finally {
    state.booting = false;
  }
  try { sessionStorage.setItem(POWER_KEY, state.powered ? '1' : '0'); } catch { /* private mode */ }
  announce();
}

export function togglePower() { return setPower(!state.powered); }

/**
 * Choose the engine. Stops the chip first: a switch is a choice of who steps
 * next, and a half-cycle in flight on one engine must land before the other
 * takes over. Written down, like the clock, so the next page opens on it.
 */
export function setEngine(which) {
  const next = which === 'api' ? 'api' : 'local';
  if (next === state.engine) return;
  setRunning(false);
  state.engine = next;
  state.debt = 0;
  state.last = 0;
  if (next === 'local') { state.latency = null; state.engineError = null; }
  try { localStorage.setItem(ENGINE_KEY, next); } catch { /* private mode */ }
  announce();
}

/** The API engine reports each round trip here (ms), or its failure. */
export function noteEngine({ latency = null, error = null } = {}) {
  state.latency = latency;
  state.engineError = error;
  announce();
}

export function step() {
  setRunning(false);
  if (driver && driver.step && state.powered) driver.step();
  announce();
}

export function stepBack() {
  setRunning(false);
  if (driver && driver.back && state.powered) driver.back();
  announce();
}

export function reset() {
  setRunning(false);
  if (driver && driver.reset && state.powered) driver.reset();
  announce();
}

/**
 * One opcode: forward to the next fetch. The driver's own `op` where it has
 * one (a wasm machine's stepInstruction); otherwise stepped a half-cycle at a
 * time until the driver reports SYNC, bounded so a program that never
 * fetches again cannot hang the page. Refused, silently as the others are,
 * when the driver has neither.
 */
export function stepOp(maxHalfCycles = 400) {
  setRunning(false);
  if (!driver || !state.powered) { announce(); return; }
  if (driver.op) driver.op();
  else if (driver.sync && driver.step) {
    for (let i = 0; i < maxHalfCycles; i++) {
      driver.step();
      if (driver.sync()) break;
    }
  }
  announce();
}

/** Go to half-cycle `h`. Stops the chip first; a seek is a choice of where to look. */
export function seek(h) {
  setRunning(false);
  const n = Number(h);
  if (driver && driver.seek && state.powered && Number.isFinite(n)) driver.seek(n);
  announce();
}

// --------------------------------------------------------------------------
// Views
// --------------------------------------------------------------------------

/**
 * Be told when anything changes. Called immediately with the current state, so
 * a control paints itself correctly on the way in rather than on the next edit.
 */
export function subscribe(fn) {
  views.add(fn);
  fn();
  return () => views.delete(fn);
}

/**
 * Repaint every control now, rather than on the next animation frame.
 *
 * A discrete action that waits for a frame is a real responsiveness bug on its
 * own, and it is invisible until the page is driven somewhere frames are
 * throttled -- which is exactly what an iframe does, and how it was found.
 */
export function announce() {
  for (const fn of views) fn();
}

// --------------------------------------------------------------------------
// Pacing
// --------------------------------------------------------------------------

/**
 * How many half-cycles this frame should advance, from wall-clock time.
 *
 * Below one half-cycle per frame the shortfall is carried rather than dropped,
 * or every slow setting rounds to "every frame" and they all look identical.
 * `dt` is clamped so a backgrounded tab does not come back and run a thousand
 * cycles in one frame.
 *
 * One caller per page: it advances the pacing clock as a side effect.
 */
export function halfCyclesFor(now = performance.now(), who = 'page') {
  // In API mode the page's own loop advances nothing: the runner in
  // chip-machine.js is the one caller, and asks as 'api'. Two callers sharing
  // one debt would each take half the rate.
  if (state.engine === 'api' && who !== 'api') return 0;
  // The clamp is what stops a tab backgrounded for ten minutes coming back and
  // running a million half-cycles in one frame. It is 500ms rather than
  // something tighter because the software rasteriser the headless checks run
  // on manages 2-5 fps: a clamp shorter than a frame silently caps the rate,
  // and the page would then be slower than the number on the control says.
  const dt = state.last ? Math.min(now - state.last, 500) : 0;
  state.last = now;
  if (!state.running) { state.debt = 0; return 0; }
  if (state.hz === 0) return MAX_BATCH;
  state.debt += (dt / 1000) * state.hz * 2;   // two half-cycles to the cycle
  const n = Math.floor(state.debt);
  state.debt -= n;
  return n;
}

/** Half-cycles a second at the current setting, for a page that paces itself. */
export function halfCycleRate() {
  return state.hz === 0 ? Infinity : state.hz * 2;
}

// --------------------------------------------------------------------------
// Where the initial rate comes from
// --------------------------------------------------------------------------

/**
 * `?speed=` first, then what was chosen last, then the slowest step.
 *
 * Same precedence as the program picker, and for the same reason: a link that
 * names a rate is somebody asking for it, and a saved preference overruling
 * them would be the page arguing with whoever sent the link.
 *
 * `speed` is in Hz. It used to be half-cycles per animation frame, which was a
 * number about the browser rather than about the chip.
 */
export function initClock(search = location.search) {
  const p = new URLSearchParams(search);
  // The engine, the same way: the link first, then the saved choice.
  if (p.get('engine') === 'api' || p.get('engine') === 'local') {
    state.engine = p.get('engine');
    try { localStorage.setItem(ENGINE_KEY, state.engine); } catch { /* private mode */ }
  } else {
    try { const e = localStorage.getItem(ENGINE_KEY); if (e === 'api' || e === 'local') state.engine = e; } catch { /* private mode */ }
  }
  if (p.has('speed')) {
    const v = Number(p.get('speed'));
    if (Number.isFinite(v) && v >= 0) { setClock(v); return state.hz; }
  }
  try {
    const saved = Number(localStorage.getItem(KEY));
    if (Number.isFinite(saved) && saved >= 0 && localStorage.getItem(KEY) !== null) {
      state.hz = saved;
    }
  } catch { /* private mode */ }
  announce();
  return state.hz;
}

/** Test seam: forget everything, so a harness starts from a known state. */
export function resetControls() {
  state.running = false;
  state.hz = DEFAULT_HZ;
  state.debt = 0;
  state.last = 0;
  state.powered = false;
  state.booting = false;
  state.engine = 'local';
  state.latency = null;
  state.engineError = null;
  driver = null;
  try { sessionStorage.removeItem(POWER_KEY); localStorage.removeItem(ENGINE_KEY); } catch { /* private mode */ }
  announce();
}
