// The transport and clock select in the site header.
//
// A companion to program-nav.js and built the same way: the header is where the
// choice is made, every other copy of the control is a view of the same store,
// and there is exactly one function that changes each thing.
//
// It fills `[data-chip-nav]` only on a page that registered a chip. A transport
// on Decode or Timing would be a button with nothing behind it -- those pages
// are measurements taken over 768 runs, not a chip you can start -- and the
// slot collapses to nothing when it is left empty.
//
// A file rather than an inline handler: the CSP is `script-src 'self'` with no
// 'unsafe-inline'.

import {
  CLOCKS, clockHz, isRunning, setClock, toggleRunning, step, reset,
  subscribe, registerDriver, initClock, chipHalfCycle,
} from './chip-controls.js';

/**
 * Put the header in charge of the chip.
 *
 * `driver` is how the header reaches the page's machine: `step` advances one
 * half-cycle, `reset` power-cycles, `back` steps backwards if the page can.
 * Running and the clock rate are not the page's to hold -- they live in the
 * store, and the page reads them.
 */
export function setupChipNav(driver, { root = document } = {}) {
  // Omitted when the chip registered itself -- demos.js does, because there the
  // chip is the thing that knows how to step.
  if (driver) registerDriver(driver);
  initClock();

  const hosts = [...root.querySelectorAll('[data-chip-nav]')];
  if (!hosts.length) return null;

  const runs = [];

  for (const host of hosts) {
    host.replaceChildren();

    const group = document.createElement('div');
    group.className = 'nav-transport';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Chip transport');

    const btn = (cls, glyph, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `nav-tbtn ${cls}`;
      b.textContent = glyph;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('click', fn);
      group.append(b);
      return b;
    };

    const run = btn('is-run', '▶', 'Run', () => toggleRunning());
    run.setAttribute('aria-pressed', 'false');
    btn('', '▶❙', 'One half-cycle', () => step());
    btn('', '⏻', 'Power cycle', () => reset());
    runs.push(run);

    const rate = document.createElement('select');
    rate.className = 'nav-clock-select';
    rate.id = host.id ? `${host.id}-clock` : 'nav-clock';
    rate.setAttribute('aria-label', 'Simulated clock rate');
    rate.title = 'Simulated clock. A cycle is two half-cycles.';
    for (const c of CLOCKS) rate.add(new Option(c.label, String(c.hz)));
    rate.addEventListener('change', () => setClock(Number(rate.value)));

    host.append(group, rate);

    subscribe(() => {
      const on = isRunning();
      run.textContent = on ? '❚❚' : '▶';
      run.title = on ? 'Pause' : 'Run';
      run.setAttribute('aria-label', run.title);
      run.setAttribute('aria-pressed', String(on));
      run.classList.toggle('on', on);
      const hz = String(clockHz());
      if (rate.value !== hz) rate.value = hz;
      paintTick(rate);
    });

    watchTheClock(rate);
  }

  return { runButtons: runs };
}

/**
 * Blink the rate control on the chip's own phase.
 *
 * `.tick` is held while the half-cycle count is even, so the control goes on
 * and off once per cycle. That is what a cycle *is* here: two half-cycles, the
 * fact the whole Timing page is about.
 *
 * Read off the machine rather than run from a timer. A timer would keep
 * blinking after the chip stopped, and would go on claiming a rate the machine
 * was not delivering -- on the software rasteriser the headless checks use, the
 * requested rate and the delivered one are routinely different numbers. This
 * cannot show anything the chip is not doing.
 */
function paintTick(rate) {
  const hc = chipHalfCycle();
  if (hc === null) return;
  rate.classList.toggle('tick', hc % 2 === 0);
}

/**
 * Keep it blinking while the chip free-runs.
 *
 * The discrete case is handled by `paintTick` from the subscription instead,
 * because a step that waits for an animation frame is exactly the
 * responsiveness bug this file already exists downstream of -- and it is
 * invisible until the page is driven somewhere frames are throttled, which is
 * where the harness drives it.
 *
 * A page whose driver offers no `halfCycle` never blinks, and the loop stops
 * rather than spinning for nothing.
 */
function watchTheClock(rate) {
  const frame = () => {
    if (chipHalfCycle() === null) return;   // nothing to watch; do not reschedule
    paintTick(rate);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
