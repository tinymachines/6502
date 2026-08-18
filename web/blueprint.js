// The idealised datapath: an SVG block diagram laid out from `blueprint.json`,
// driven by the same engine as the die view.
//
// SVG rather than WebGL, deliberately. The die is 83,227 triangles and needs a
// GPU; this is ~120 elements with real text in them. SVG gives crisp type at
// any zoom, styling from the same CSS tokens as the rest of the site, and
// hit-testing for free.
//
// Nothing here decides what the 6502 contains. The units, the edges, the
// control line on each edge and the order things sit in all arrive in the JSON,
// derived from switch topology by `crates/v6502-netlist/src/blueprint.rs`. This
// file is a layout engine and a state binding, and it should stay that way: if
// a fact about the chip ever gets hardcoded below, it is in the wrong file.

import init, { Machine } from './pkg/v6502_wasm.js';
// The layout and the symbols live in blueprint-draw.js, shared with the
// halfshot page: two copies of where the accumulator goes would drift.
import { layOut, draw, placeLabels, unitValue, label } from './blueprint-draw.js';
import { PROGRAMS, LOAD_ADDR, selectedProgram, setSelectedProgram } from './programs.js';
import { setupProgramNav } from './program-nav.js';
import { setupChipNav } from './chip-nav.js';
import {
  CLOCKS, clockHz, isRunning, setClock, setRunning, toggleRunning,
  step as stepChip, reset as resetChip, subscribe, halfCyclesFor,
} from './chip-controls.js';

const $ = (id) => document.getElementById(id);
const hex = (v, n) => v.toString(16).padStart(n, '0').toUpperCase();

const state = {
  machine: null,
  bp: null,
  layout: null,
  // Whether it is running and how fast are in chip-controls.js, set from the
  // header. Watching a switch open is the point of this diagram, so it starts
  // at the slowest step like everything else on the site.
  raf: 0,
  selected: null,        // control name of a pinned link
  lastHalfCycle: -1,
};

// ---------------------------------------------------------------------------
// Live state
// ---------------------------------------------------------------------------

function refresh(svg, bp, machine) {
  const levels = machine.nodeLevels();

  for (const u of bp.units) {
    const t = svg.querySelector(`[data-value="${u.name}"]`);
    if (!t) continue;
    const { value, mask } = unitValue(levels, u);
    // The status register has no bit 5, so it gets no digit for one -- the hole
    // is real and printing a 0 there would invent a flag.
    t.textContent = mask === 0xff ? '$' + hex(value, 2) : '$' + hex(value, 2) + '*';
  }

  for (const l of bp.links) {
    const g = svg.querySelector(`[data-control="${CSS.escape(l.control)}"]`);
    if (!g) continue;
    // Closed means the control line is high: the switch is conducting and the
    // two units are one wire this half-cycle.
    g.classList.toggle('open', !!levels[l.controlNode]);
  }
  svg.classList.toggle('phase-high', machine.clk0());
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function describe(bp, control) {
  const l = bp.links.find((x) => x.control === control);
  if (!l) return '';
  const a = bp.units[l.a];
  const b = bp.units[l.b];
  const bits = [];
  for (let i = 7; i >= 0; i--) bits.push((l.bits >> i) & 1 ? i : '·');
  return `
    <h3>${l.control}</h3>
    <p class="bp-detail-path"><strong>${label(a)}</strong> ↔ <strong>${label(b)}</strong></p>
    <dl>
      <dt>Switches</dt><dd>${l.switches.length} pass transistors, one per bit</dd>
      <dt>Bits carried</dt><dd class="mono">${bits.join(' ')}</dd>
      <dt>Control node</dt><dd class="mono">#${l.controlNode}</dd>
      <dt>Transistors</dt><dd class="mono">${l.switches.map((s) => 't' + s[1]).join(', ')}</dd>
    </dl>
    <p class="bp-detail-note">
      Every one of these was found by looking for a transistor whose two
      terminals are the same bit of two different named units. The name on the
      gate is what the decode PLA calls the operation.
    </p>`;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  const status = $('bp-status');
  try {
    const [, bpJson] = await Promise.all([
      init(),
      fetch('blueprint.json').then((r) => {
        if (!r.ok) throw new Error(`blueprint.json: HTTP ${r.status}`);
        return r.json();
      }),
    ]);

    const bp = bpJson;
    // The switches arrive as [bit, transistor] pairs; keep them that way and
    // note it here rather than inflating 159 two-element arrays into objects.
    state.bp = bp;
    state.machine = new Machine();
    state.layout = layOut(bp);

    const svg = $('bp-svg');
    draw(svg, bp, state.layout);
    loadProgram(0);

    $('bp-coverage').textContent =
      `${bp.units.length} units · ${bp.links.length} paths · `
      + `${bp.coverage.transistorsDrawn} of ${bp.coverage.transistorsTotal} transistors`;

    wireUp(svg);
    $('bp-boot').hidden = true;
    $('bp-main').hidden = false;
    // Only now can the labels be measured -- see placeLabels().
    placeLabels(svg);
    refresh(svg, bp, state.machine);
    tick();
  } catch (e) {
    status.textContent = 'Could not start: ' + (e && e.message ? e.message : e);
    status.classList.add('error');
    throw e;
  }
}

function loadProgram(index) {
  const m = state.machine;
  const prog = PROGRAMS[index] || PROGRAMS[0];
  m.powerCycle();
  m.load(LOAD_ADDR, new Uint8Array(prog.bytes));
  m.setResetVector(LOAD_ADDR);
  m.reset();
}

function wireUp(svg) {
  const select = $('bp-program');
  PROGRAMS.forEach((p, i) => select.add(new Option(p.name, String(i))));

  // One place changes the program, whichever control was used to change it.
  const choose = (index, { fromNav = false } = {}) => {
    select.value = String(index);
    setSelectedProgram(index);
    if (!fromNav && state.nav) state.nav.set(index);
    loadProgram(index);
    refresh(svg, state.bp, state.machine);
    updateReadout();
  };
  state.choose = choose;
  select.onchange = () => choose(Number(select.value));
  state.nav = setupProgramNav({ onChange: (i) => choose(i, { fromNav: true }) });

  // The header owns run/pause, the step, the power cycle and the clock rate.
  // These buttons are a second view of the same store, painted from it.
  const paint = () => {
    refresh(svg, state.bp, state.machine);
    updateReadout();
  };
  setupChipNav({
    step: () => { state.machine.halfStep(); paint(); },
    back: () => { state.machine.stepBack(); paint(); },
    reset: () => { loadProgram(Number(select.value)); paint(); },
    halfCycle: () => state.machine.halfCycle(),
  });

  $('bp-run').onclick = () => toggleRunning();
  $('bp-step').onclick = () => stepChip();
  $('bp-cycle').onclick = () => {
    setRunning(false);
    state.machine.stepCycle();
    paint();
  };
  $('bp-reset').onclick = () => resetChip();

  const speed = $('bp-speed');
  for (const c of CLOCKS) speed.add(new Option(c.label, String(c.hz)));
  speed.onchange = () => setClock(Number(speed.value));

  subscribe(() => {
    const on = isRunning();
    $('bp-run').textContent = on ? 'Pause' : 'Run';
    $('bp-run').classList.toggle('btn-primary', !on);
    const hz = String(clockHz());
    if (speed.value !== hz) speed.value = hz;
  });

  const pick = (control) => {
    state.selected = control;
    for (const g of svg.querySelectorAll('.bp-edge')) {
      g.classList.toggle('picked', g.dataset.control === control);
    }
    $('bp-detail').innerHTML = control
      ? describe(state.bp, control)
      : '<p class="bp-detail-empty">Pick a path to see the switches behind it.</p>';
  };
  svg.addEventListener('click', (ev) => {
    const g = ev.target.closest('.bp-edge');
    pick(g ? g.dataset.control : null);
  });
  svg.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const g = ev.target.closest('.bp-edge');
    if (!g) return;
    ev.preventDefault();
    pick(g.dataset.control);
  });
  pick(null);

  // Deep links, matching the explorer's spirit: ?program=N&run=1&path=CONTROL
  const q = new URLSearchParams(location.search);
  // The URL if it names a program, otherwise the one chosen elsewhere on the
  // site -- arriving here from the Explorer should not change what is running.
  const chosen = selectedProgram(location.search);
  select.value = String(chosen);
  if (state.nav) state.nav.set(chosen);
  loadProgram(chosen);
  if (q.has('path')) pick(q.get('path'));
  if (q.get('run') === '1') $('bp-run').click();
}

function updateReadout() {
  const m = state.machine;
  $('bp-readout').textContent =
    `half-cycle ${m.halfCycle()}   PC ${'$' + hex(m.pc(), 4)}   `
    + `A ${'$' + hex(m.a(), 2)}  X ${'$' + hex(m.x(), 2)}  Y ${'$' + hex(m.y(), 2)}   `
    + `${m.flagsString()}`;
}

function tick(now) {
  state.raf = requestAnimationFrame(tick);
  const n = halfCyclesFor(now);
  if (n > 0) state.machine.runHalfCycles(n);
  const hc = state.machine.halfCycle();
  if (hc !== state.lastHalfCycle) {
    state.lastHalfCycle = hc;
    refresh($('bp-svg'), state.bp, state.machine);
    updateReadout();
  }
}

boot();
