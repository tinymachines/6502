// The pieces the runnable examples are built from.
//
// Shared rather than reimplemented per page: a lamp strip that disagreed with
// another lamp strip about which end bit 7 is on would be the kind of quiet
// difference this whole site exists to avoid. Everything here is a view of a
// running `Machine` and holds no state about the 6502 of its own.
//
// The one genuinely new primitive is the scope. Every other page reports what is
// true *now*; "two edges, not one blip" is a claim about time, and a claim about
// time needs something that remembers. It records what the pins did and draws
// the recording -- so the waveform is measured rather than illustrated, the same
// rule the rest of the site follows.

import {
  isRunning, setRunning, step as stepChip, stepBack, reset as resetChip,
  registerDriver, subscribe, halfCyclesFor,
} from './chip-controls.js';

const NS = 'http://www.w3.org/2000/svg';

export const hex2 = (v) => v.toString(16).padStart(2, '0').toUpperCase();
export const hex4 = (v) => v.toString(16).padStart(4, '0').toUpperCase();

/** A value as lamps, high bit first. */
export function lamps(v, bits) {
  let out = '';
  for (let b = bits - 1; b >= 0; b--) {
    const on = (v >> b) & 1;
    out += `<i class="${on ? 'on' : ''}">${on}</i>`;
  }
  return `<span class="dm-lamps">${out}</span>`;
}

export function el(tag, attrs = {}, parent) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  if (parent) parent.append(node);
  return node;
}

function svgEl(tag, attrs, parent) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.append(node);
  return node;
}

/**
 * One chip, shared by every example on the page.
 *
 * They are five views of the same silicon, so they run off one machine and one
 * clock: stepping in any of them steps all of them, which is the honest
 * arrangement and also the cheap one. Anything that wants to be told when the
 * chip moves subscribes.
 */
export function createChip({ Machine, program, loadAddr }) {
  const m = new Machine();
  m.load(loadAddr, new Uint8Array(program));
  // Without this the chip resets to $0000, reads $00 -- a BRK -- and runs a BRK
  // loop against itself forever while looking perfectly busy.
  m.setResetVector(loadAddr);
  m.powerCycle();

  const listeners = new Set();
  const state = { awake: true };

  const announce = () => { for (const fn of listeners) fn(m); };

  const advance = () => { m.halfStep(); announce(); };

  // Whether it is running and how fast are the header's, not this chip's. It
  // does know how to step, though, so it registers itself as what the header
  // drives -- and repaints its own transports whenever the store moves.
  registerDriver({
    step: advance,
    back: () => { m.stepBack(); announce(); },
    reset: () => { m.powerCycle(); announce(); },
    halfCycle: () => m.halfCycle(),
  });
  subscribe(announce);

  function frame(now) {
    const n = halfCyclesFor(now);
    if (state.awake) for (let i = 0; i < n; i++) advance();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    machine: m,
    on(fn) { listeners.add(fn); fn(m); return () => listeners.delete(fn); },
    get running() { return isRunning(); },
    setRunning(on) { setRunning(on); },
    /** Whether anything is on screen to watch. Off screen, nothing runs. */
    setAwake(on) { state.awake = !!on; },
    step() { stepChip(); },
    /**
     * Run forward before anybody is looking.
     *
     * Two reasons, both about arriving to something worth seeing. The chip comes
     * out of a power cycle in the middle of its reset sequence, which is not what
     * a page about fetching instructions wants on screen; and the scope is a
     * recording, so at rest it has nothing to show. Announcing each half-cycle
     * rather than the last one is what fills it.
     */
    warm(n) {
      for (let i = 0; i < n; i++) advance();
    },
    back() { stepBack(); },
    reset() { resetChip(); },
    announce,
  };
}

/**
 * The transport, which every example carries a copy of.
 *
 * They all drive the one chip, so the label has to be painted from the chip
 * rather than from whichever button was last pressed -- otherwise two of them
 * disagree about whether it is running the moment you use the other.
 */
export function transport(host, chip, { label = '' } = {}) {
  const bar = el('div', { class: 'dm-bar' }, host);
  if (label) el('span', { class: 'dm-bar-label', html: label }, bar);
  const mk = (text, title, fn) => {
    const b = el('button', { class: 'dm-btn', type: 'button', title,
                             'aria-label': title }, bar);
    b.textContent = text;
    b.addEventListener('click', fn);
    return b;
  };
  mk('◀', 'Back one half-cycle', () => chip.back());
  const run = mk('▶', 'Run', () => chip.setRunning(!chip.running));
  mk('▶❙', 'Forward one half-cycle', () => chip.step());
  mk('⏻', 'Power cycle', () => chip.reset());
  const clock = el('span', { class: 'dm-clock mono' }, bar);

  chip.on((m) => {
    run.textContent = chip.running ? '❚❚' : '▶';
    run.classList.toggle('on', chip.running);
    const text = `½cyc ${m.halfCycle()} · ${m.clk0() ? 'φ1' : 'φ2'}`
      + `${m.sync() ? ' · sync' : ''}`;
    if (clock.textContent !== text) clock.textContent = text;
  });
  return bar;
}

/**
 * A rolling recording of what some pins did, drawn as a waveform.
 *
 * This is the primitive the primer needed and no other page had. It samples on
 * demand -- once per half-cycle -- and keeps the last `span` samples, so the
 * picture is of the chip's own history rather than of an idealised clock. Cycle
 * boundaries are drawn every second sample, which is the entire point being
 * made: a cycle is two of these, not one.
 */
export function createScope({ channels, span = 16, height = 26, gap = 8, width = 480 }) {
  const w = width;
  const left = 46;
  const svg = svgEl('svg', {
    class: 'dm-scope', viewBox: `0 0 ${w} ${channels.length * (height + gap) + 16}`,
    role: 'img', 'aria-label': 'Recorded pin levels',
  });
  const grid = svgEl('g', { class: 'dm-scope-grid' }, svg);
  const traces = svgEl('g', {}, svg);
  const labels = svgEl('g', {}, svg);

  channels.forEach((ch, i) => {
    const t = svgEl('text', {
      x: 0, y: i * (height + gap) + height / 2 + 4, class: 'dm-scope-label',
    }, labels);
    t.textContent = ch.label;
  });

  const samples = [];
  // Where the "now" line is drawn: the newest sample while recording, or a
  // chosen sample when a page hands over a window with a cursor in it.
  let nowAt = null;
  const step = () => (w - left - 6) / span;

  function paint() {
    grid.replaceChildren();
    traces.replaceChildren();
    const dx = step();
    // A boundary every second sample: one cycle, two half-cycles, and the thing
    // a reader is supposed to notice.
    for (let i = 0; i <= span; i += 2) {
      svgEl('line', {
        x1: left + i * dx, y1: 0, x2: left + i * dx,
        y2: channels.length * (height + gap) - gap, class: 'dm-scope-tick',
      }, grid);
    }
    channels.forEach((ch, ci) => {
      const top = ci * (height + gap);
      let d = '';
      samples.forEach((s, i) => {
        const on = !!s[ch.key];
        const y = top + (on ? 2 : height - 2);
        const x = left + i * dx;
        d += (i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`) + ` L ${x + dx} ${y}`;
      });
      if (d) svgEl('path', { d, class: `dm-scope-trace ${ch.cls || ''}` }, traces);
    });
    if (samples.length) {
      const at = nowAt == null ? samples.length - 1 : Math.min(nowAt, samples.length - 1);
      const x = left + at * dx + dx / 2;
      svgEl('line', {
        x1: x, y1: -2, x2: x, y2: channels.length * (height + gap) - gap + 2,
        class: 'dm-scope-now',
      }, grid);
    }
  }
  paint();

  return {
    el: svg,
    record(sample) {
      samples.push(sample);
      while (samples.length > span) samples.shift();
      paint();
    },
    clear() { samples.length = 0; nowAt = null; paint(); },
    /**
     * Show a window of samples with the cursor at index `at`, instead of the
     * rolling record. The halfshot page uses this: its history is the recording,
     * and the reader moves through it in both directions.
     */
    set(list, at) {
      samples.length = 0;
      samples.push(...list.slice(0, span));
      nowAt = at;
      paint();
    },
    get length() { return samples.length; },
  };
}

/**
 * A key/value readout that only touches the DOM when something changed.
 *
 * Every example repaints on every half-cycle, and several of them are mostly
 * unchanged from one to the next.
 */
export function readout(host, rows) {
  const dl = el('dl', { class: 'dm-kv' }, host);
  const cells = new Map();
  for (const [key, label] of rows) {
    el('dt', { html: label }, dl);
    cells.set(key, el('dd', {}, dl));
  }
  return (values) => {
    for (const [key, cell] of cells) {
      const v = values[key];
      if (v === undefined) continue;
      if (cell.innerHTML !== v) cell.innerHTML = v;
    }
  };
}

/** Only run the chip while something is on screen to watch. */
export function runWhileVisible(chip, root) {
  if (typeof IntersectionObserver !== 'function') return;
  const io = new IntersectionObserver((entries) => {
    chip.setAwake(entries.some((e) => e.isIntersecting));
  }, { rootMargin: '80px' });
  io.observe(root);
  document.addEventListener('visibilitychange', () => {
    chip.setAwake(!document.hidden);
  });
}
