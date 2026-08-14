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
import { ExplodedRenderer, HEIGHT_NAMES, BLOCK_COLOR } from './exploded-gl.js';
import { PROGRAMS, LOAD_ADDR } from './programs.js';

const $ = (id) => document.getElementById(id);

const state = {
  machine: null,
  renderer: null,
  blocks: null,
  running: false,
  speed: 12,
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
  m.powerCycle();
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function buildLegend(blocks) {
  const el = $('ex-legend');
  el.replaceChildren();
  for (const b of blocks.blocks) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'ex-block' + (b.id === 0 ? ' ghost' : '');
    row.dataset.block = String(b.id);
    row.dataset.half = b.half;
    const named = b.nodes ? Math.round((100 * b.seeded) / b.nodes) : 0;
    const c = BLOCK_COLOR[b.id] || [0.5, 0.5, 0.5];
    const swatch = `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;
    row.style.setProperty('--block-color', swatch);
    row.innerHTML =
      `<span class="ex-b-name"><i class="ex-sw"></i>${b.name}</span>`
      + `<span class="ex-b-meta">${b.transistors} transistors`
      + (b.id === 0 ? '' : ` · ${named}% named`) + `</span>`
      + `<span class="ex-b-blurb">${b.blurb}</span>`;
    row.onclick = () => setFocus(state.focus === b.id ? -1 : b.id);
    el.append(row);
  }
}

function buildStats(blocks) {
  const c = blocks.coverage;
  $('ex-stats').textContent =
    `${blocks.blocks.length - 1} blocks · ${c.transistorsPlaced} of ${c.transistors} transistors placed `
    + `· ${c.nodesNamed} nodes named by the die · ${c.transistors - c.transistorsPlaced} unclassified`;
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

  $('ex-run').addEventListener('click', () => {
    state.running = !state.running;
    $('ex-run').textContent = state.running ? 'Pause' : 'Run';
    $('ex-run').classList.toggle('btn-primary', !state.running);
  });
  $('ex-step').addEventListener('click', () => {
    state.machine.halfStep();
  });
  $('ex-reset').addEventListener('click', () => {
    loadProgram(Number($('ex-program').value));
  });

  const sel = $('ex-program');
  sel.replaceChildren();
  PROGRAMS.forEach((p, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = p.name;
    sel.append(o);
  });
  sel.addEventListener('change', () => loadProgram(Number(sel.value)));

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

  wireOrbit($('ex-canvas'), r);
  window.addEventListener('resize', () => r.resize());
}

/** Drag to orbit, wheel to zoom. Pitch stays above the plane -- see below. */
function wireOrbit(canvas, r) {
  let last = null;
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', (ev) => {
    last = { x: ev.clientX, y: ev.clientY };
    canvas.setPointerCapture(ev.pointerId);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!last) return;
    r.yaw += (ev.clientX - last.x) * 0.006;
    // Clamped above the horizon on purpose. Metal is translucent and is drawn
    // last without depth writes, which is only correct while it is the near
    // face; letting the camera go underneath would sort it wrongly and the
    // wiring would vanish behind the silicon.
    r.pitch = Math.max(0.14, Math.min(1.53, r.pitch + (ev.clientY - last.y) * 0.006));
    last = { x: ev.clientX, y: ev.clientY };
  });
  const end = (ev) => {
    last = null;
    if (canvas.hasPointerCapture?.(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    r.zoom = Math.max(0.35, Math.min(6, r.zoom * Math.exp(-ev.deltaY * 0.0015)));
  }, { passive: false });
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
  if (q.get('run') === '1') $('ex-run').click();
}

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

function tick() {
  const { machine, renderer } = state;
  if (state.running) {
    for (let i = 0; i < state.speed; i++) machine.halfStep();
  }
  renderer.setNodeLevels(machine.nodeLevels());
  renderer.render();
  state.raf = requestAnimationFrame(tick);
}

boot();
