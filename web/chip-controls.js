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
};

const views = new Set();
let driver = null;

// --------------------------------------------------------------------------
// Reading
// --------------------------------------------------------------------------

export function clockHz() { return state.hz; }
export function isMaxClock() { return state.hz === 0; }
export function isRunning() { return state.running; }
export function hasDriver() { return driver !== null; }

export function clockLabel(hz = state.hz) {
  const step = CLOCKS.find((c) => c.hz === hz);
  return step ? step.label : `${hz} Hz`;
}

// --------------------------------------------------------------------------
// Writing. Exactly one function per thing that can change.
// --------------------------------------------------------------------------

export function setRunning(on) {
  const next = !!on;
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

/** Register the page's chip. The header transport acts through this. */
export function registerDriver(d) {
  driver = d;
  announce();
}

export function step() {
  setRunning(false);
  if (driver && driver.step) driver.step();
  announce();
}

export function stepBack() {
  setRunning(false);
  if (driver && driver.back) driver.back();
  announce();
}

export function reset() {
  setRunning(false);
  if (driver && driver.reset) driver.reset();
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
export function halfCyclesFor(now = performance.now()) {
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
  driver = null;
  announce();
}
