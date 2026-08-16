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
  subscribe, registerDriver, initClock,
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
      run.classList.toggle('on', on);
      const hz = String(clockHz());
      if (rate.value !== hz) rate.value = hz;
    });
  }

  return { runButtons: runs };
}
