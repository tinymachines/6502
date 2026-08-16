// The exploded die: page glue for `exploded-gl.js`.
//
// The die view shows the chip as it is and is nearly unreadable. The blueprint
// shows the same chip with the geometry thrown away. This is the step between:
// the real polygons, in their real positions, pulled apart along the two axes
// that make them legible.
//
// It runs live off the same engine as everything else, so a filament brightens
// when its transistor conducts.

import init, { Machine } from './pkg/v6502_wasm.js';
import { parseLayout } from './renderer.js';
import { ExplodedRenderer, HEIGHT_NAMES, BLOCK_COLOR, applyZoom, wireOrbit }
  from './exploded-gl.js';
import { PROGRAMS, LOAD_ADDR, selectedProgram, setSelectedProgram } from './programs.js';
import { setupProgramNav } from './program-nav.js';
import { setupChipNav } from './chip-nav.js';
import {
  isRunning, toggleRunning, step as stepChip, reset as resetChip,
  subscribe, halfCyclesFor,
} from './chip-controls.js';

const $ = (id) => document.getElementById(id);

const state = {
  machine: null,
  renderer: null,
  blocks: null,
  focus: -1,
  raf: 0,
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  const status = $('ex-status');
  try {
    status.textContent = 'Loading the engine…';
    const [, layoutBuf, blocksJson] = await Promise.all([
      init(),
      fetch('layout.bin').then((r) => {
        if (!r.ok) throw new Error(`layout.bin: HTTP ${r.status}`);
        return r.arrayBuffer();
      }),
      fetch('blocks.json').then((r) => {
        if (!r.ok) throw new Error(`blocks.json: HTTP ${r.status}`);
        return r.json();
      }),
    ]);

    const layout = parseLayout(layoutBuf);
    const blocks = {
      blocks: blocksJson.blocks,
      coverage: blocksJson.coverage,
      nodeBlock: new Uint8Array(blocksJson.nodeBlock),
      nodeDrives: new Uint8Array(blocksJson.nodeDrives),
      transistorBlock: new Uint16Array(blocksJson.transistorBlock),
      transistorGate: new Uint16Array(blocksJson.transistorGate),
    };
    state.blocks = blocks;

    const machine = new Machine();
    state.machine = machine;
    loadProgram(0);

    // The renderer is built inside a panel that is still hidden, so it measures
    // 1x1 until the reveal below. Same trap as the flat die view: frame the
    // camera only once the canvas has been laid out.
    const renderer = new ExplodedRenderer($('ex-canvas'), layout, blocks, machine.nodeCount());
    renderer.setRailNodes([machine.nodeId('vss'), machine.nodeId('vcc')].filter((n) => n >= 0));
    state.renderer = renderer;

    buildLegend(blocks);
    buildStats(blocks);
    wireControls();

    $('ex-boot').hidden = true;
    $('ex-main').hidden = false;

    // Only now does the canvas have a size.
    renderer.resize();
    applyQuery();
    tick();
  } catch (e) {
    status.textContent = 'Could not load: ' + (e && e.message ? e.message : e);
    status.classList.add('error');
    throw e;
  }
}

function loadProgram(index) {
  const prog = PROGRAMS[index] || PROGRAMS[0];
  const m = state.machine;
  m.load(LOAD_ADDR, new Uint8Array(prog.bytes));
  // The reset vector has to point at the program or the chip resets to $0000,
  // reads $00, and runs BRK against itself forever. The die still lights up, so
  // nothing on this page would ever have said otherwise.
  m.setResetVector(LOAD_ADDR);
  m.powerCycle();
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function buildLegend(blocks) {
  const el = $('ex-legend');
  el.replaceChildren();

  // For the static logic, what its gates feed. This is the answer to "what is
  // all the rest of it", so it belongs on the card rather than buried.
  const drivenTally = new Map();
  let unattributed = 0;
  const logic = blocks.blocks.find((b) => b.half === 'logic');
  if (logic) {
    for (let n = 0; n < blocks.nodeBlock.length; n++) {
      if ((blocks.nodeBlock[n] & 0x7f) !== logic.id) continue;
      const d = blocks.nodeDrives[n];
      if (d) drivenTally.set(d, (drivenTally.get(d) || 0) + 1);
      else unattributed++;
    }
  }

  for (const b of blocks.blocks) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'ex-block'
      + (b.id === 0 ? ' ghost' : '')
      + (b.half === 'logic' ? ' logic' : '');
    row.dataset.block = String(b.id);
    row.dataset.half = b.half;
    const named = b.nodes ? Math.round((100 * b.seeded) / b.nodes) : 0;
    const c = BLOCK_COLOR[b.id] || [0.5, 0.5, 0.5];
    const swatch = `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;
    row.style.setProperty('--block-color', swatch);

    let extra = '';
    if (b.half === 'logic') {
      const top = [...drivenTally.entries()]
        .sort((x, y) => y[1] - x[1])
        .slice(0, 4)
        .map(([id, n]) => `${blocks.blocks[id].name} ${n}`)
        .join(' · ');
      extra = `<span class="ex-b-drives">Drives: ${top}`
        + `<br><span class="muted">${unattributed} feed no single block</span></span>`;
    }

    row.innerHTML =
      `<span class="ex-b-name"><i class="ex-sw"></i>${b.name}</span>`
      + `<span class="ex-b-meta">${b.transistors} transistors`
      + (b.id === 0 || b.half === 'logic' ? '' : ` · ${named}% named`) + `</span>`
      + `<span class="ex-b-blurb">${b.blurb}</span>` + extra;
    row.onclick = () => setFocus(state.focus === b.id ? -1 : b.id);
    el.append(row);
  }
}

function buildStats(blocks) {
  const c = blocks.coverage;
  const logic = blocks.blocks.find((b) => b.half === 'logic');
  const functional = c.transistorsPlaced - (logic ? logic.transistors : 0);
  $('ex-stats').textContent =
    `${functional} transistors in 12 functional blocks · `
    + `${logic ? logic.transistors : 0} in static logic · `
    + `${c.transistors - c.transistorsPlaced} unaccounted · `
    + `${c.nodesNamed} nodes named by the die`;
}

function setFocus(id) {
  state.focus = id;
  if (state.renderer) state.renderer.focus = id;
  for (const el of document.querySelectorAll('.ex-block')) {
    el.classList.toggle('picked', Number(el.dataset.block) === id);
  }
  $('ex-legend').classList.toggle('focused', id >= 0);
}

function wireControls() {
  const r = state.renderer;

  const bindSlider = (id, apply, fmt) => {
    const el = $(id);
    const out = $(id + '-val');
    const update = () => {
      const v = Number(el.value) / 100;
      apply(v);
      if (out) out.textContent = fmt ? fmt(v) : `${Math.round(v * 100)}%`;
    };
    el.addEventListener('input', update);
    update();
    return el;
  };

  bindSlider('ex-layer', (v) => { r.explodeZ = v; }, (v) =>
    v < 0.02 ? 'flat' : `${Math.round(v * 100)}%`);
  bindSlider('ex-block', (v) => { r.explodeXY = v; }, (v) =>
    v < 0.02 ? 'assembled' : `${Math.round(v * 100)}%`);
  bindSlider('ex-stalks', (v) => { r.stalkAmount = v; });

  // The header owns run/pause, the step, the power cycle and the clock rate.
  // This page had no rate control at all before, and ran at twelve half-cycles
  // a frame -- a chip flickering rather than a chip working, on the one page
  // whose filaments are per-transistor and whose whole point is watching an
  // individual gate open.
  setupChipNav({
    step: () => state.machine.halfStep(),
    back: () => state.machine.stepBack(),
    reset: () => loadProgram(Number($('ex-program').value)),
  });

  $('ex-run').addEventListener('click', () => toggleRunning());
  $('ex-step').addEventListener('click', () => stepChip());
  $('ex-reset').addEventListener('click', () => resetChip());

  subscribe(() => {
    const on = isRunning();
    $('ex-run').textContent = on ? 'Pause' : 'Run';
    $('ex-run').classList.toggle('btn-primary', !on);
  });

  const sel = $('ex-program');
  sel.replaceChildren();
  PROGRAMS.forEach((p, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = p.name;
    sel.append(o);
  });

  // One place changes the program, whichever control was used.
  const choose = (index, { fromNav = false } = {}) => {
    sel.value = String(index);
    setSelectedProgram(index);
    if (!fromNav && state.nav) state.nav.set(index);
    loadProgram(index);
  };
  sel.addEventListener('change', () => choose(Number(sel.value)));
  state.nav = setupProgramNav({ onChange: (i) => choose(i, { fromNav: true }) });

  // The URL if it names a program, otherwise the one chosen elsewhere.
  choose(selectedProgram(location.search), { fromNav: true });

  // Layer toggles, named by physical height rather than by segdef index: three
  // heights, not six, because three of the six are the same layer.
  const toggles = $('ex-layers');
  toggles.replaceChildren();
  const byHeight = [[1, 2, 3, 4], [5], [0]]; // diffusion, poly, metal
  HEIGHT_NAMES.forEach((name, h) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ex-layer-tog on';
    b.dataset.height = String(h);
    b.textContent = name;
    b.onclick = () => {
      const on = !b.classList.contains('on');
      b.classList.toggle('on', on);
      for (const l of byHeight[h]) r.layerVisible[l] = on;
    };
    toggles.append(b);
  });

  // Zoom buttons. The readout is refreshed from the renderer rather than kept
  // beside it, so wheel and pinch move the same number the buttons do -- a
  // second copy of the zoom level would drift the moment a gesture changed it.
  const zoomOut = () => applyZoom(r, 1 / 1.35);
  const zoomIn = () => applyZoom(r, 1.35);
  $('ex-zoom-in').addEventListener('click', zoomIn);
  $('ex-zoom-out').addEventListener('click', zoomOut);
  $('ex-zoom-reset').addEventListener('click', () => {
    r.zoom = 1;
    r.yaw = -0.42;
    r.pitch = 0.62;
  });

  wireOrbit($('ex-canvas'), r);
  window.addEventListener('resize', () => r.resize());
}

function applyQuery() {
  const q = new URLSearchParams(location.search);
  const set = (id, v) => {
    if (v === null) return;
    const el = $(id);
    el.value = String(Math.max(0, Math.min(100, Number(v))));
    el.dispatchEvent(new Event('input'));
  };
  set('ex-layer', q.get('layers'));
  set('ex-block', q.get('blocks'));
  if (q.has('focus')) {
    const want = q.get('focus').toLowerCase();
    const b = state.blocks.blocks.find((x) => x.name.toLowerCase() === want);
    if (b) setFocus(b.id);
  }
  if (q.get('run') === '1') toggleRunning();
}

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

function tick(now) {
  const { machine, renderer } = state;
  const n = halfCyclesFor(now);
  for (let i = 0; i < n; i++) machine.halfStep();
  renderer.setNodeLevels(machine.nodeLevels());
  renderer.render();

  // Read the zoom back out of the renderer rather than tracking it separately,
  // so wheel, pinch, keyboard and the buttons all report the same number.
  const z = renderer.zoom.toFixed(1) + '\u00d7';
  const out = $('ex-zoom-val');
  if (out.textContent !== z) out.textContent = z;

  state.raf = requestAnimationFrame(tick);
}

boot();
