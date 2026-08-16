// The Program dropdown in the site header, shared by every page.
//
// It replaced the "Run it" call to action, and it inherits that button's job
// rather than merely taking its place: choosing a program is how you start the
// chip on something. On a page that runs the chip the choice is applied where
// you are; on a page that does not, it is recorded for the page you go to next.
//
// One choice across the whole site is the point. Comparing the Blueprint's view
// of a program with the Explorer's is only meaningful if both are running the
// same program, and before this they each defaulted to the first one and
// forgot anything you picked the moment you navigated.
//
// A file rather than an inline handler, for the same reason site-nav.js is one:
// the CSP is `script-src 'self'` with no 'unsafe-inline'.

import { PROGRAMS, selectedProgram, setSelectedProgram } from './programs.js';

/**
 * Fill in every `[data-program-nav]` in the header.
 *
 * `onChange(index)` is called by a page that can load a program in place. A
 * page without a chip omits it, and the dropdown then only records the choice
 * -- which is why those pages label it as such rather than implying that
 * something on screen just changed.
 */
export function setupProgramNav({ onChange, root = document } = {}) {
  const hosts = [...root.querySelectorAll('[data-program-nav]')];
  if (!hosts.length) return null;

  const index = selectedProgram();
  const selects = [];

  for (const host of hosts) {
    host.replaceChildren();
    const label = document.createElement('span');
    label.className = 'nav-prog-label';
    label.textContent = 'Program';

    const select = document.createElement('select');
    select.className = 'nav-prog-select';
    select.id = host.id ? `${host.id}-select` : 'nav-program';
    select.setAttribute('aria-label', onChange
      ? 'Program to run'
      : 'Program to run. This page shows measurements rather than running one.');
    if (!onChange) {
      select.title = 'Chosen here, run on the pages that drive the chip.';
    }
    // The short name here, the full one everywhere with room for it. Clipping a
    // name mid-word is worse than shortening it: the reader cannot tell which
    // program is selected, which is the one thing this control exists to say.
    PROGRAMS.forEach((p, i) => {
      const opt = new Option(p.short || p.name, String(i));
      opt.title = p.name;
      select.add(opt);
    });
    select.value = String(index);

    select.addEventListener('change', () => {
      const i = Number(select.value);
      setSelectedProgram(i);
      for (const other of selects) if (other !== select) other.value = String(i);
      if (onChange) onChange(i);
    });

    host.append(label, select);
    selects.push(select);
  }

  return {
    get value() { return Number(selects[0].value); },
    /** Reflect a change made elsewhere on the page, without re-firing onChange. */
    set(i) {
      if (!PROGRAMS[i]) return;
      for (const s of selects) s.value = String(i);
      setSelectedProgram(i);
    },
  };
}
