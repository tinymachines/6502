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
import { PROGRAMS, LOAD_ADDR, selectedProgram, setSelectedProgram } from './programs.js';
import { setupProgramNav } from './program-nav.js';

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';
const hex = (v, n) => v.toString(16).padStart(n, '0').toUpperCase();

// --- layout constants -------------------------------------------------------
// Pure drawing, no claims about the chip.
const COL_W = 138;        // horizontal pitch between block columns
const RAIL_GAP = 60;      // vertical pitch between bus rails
const BLOCK_W = 96;
const BLOCK_H = 54;
const TOP = 74;           // room above the first rail for its label
const STALK = 54;         // gap between the lowest rail and the block row
const PAD_X = 150;        // left gutter, sized to hold the rail names
const RAIL_TAIL = 96;     // room to the right of a rail for its live value
const MIN_SEP = 68;       // closest two rail-to-rail connectors may sit
const TWIN_DX = 64;       // offset for a second path between the same two units

const state = {
  machine: null,
  bp: null,
  layout: null,
  running: false,
  // The slowest setting the control offers. Watching a switch open is the point
  // of this diagram, and it is not visible at eight half-cycles a frame.
  speed: 0.1,
  speedDebt: 0,
  raf: 0,
  selected: null,        // control name of a pinned link
  lastHalfCycle: -1,
};

// ---------------------------------------------------------------------------
// Layout: JSON -> positions
// ---------------------------------------------------------------------------

// Both axes are order-preserving remaps of the die, which is the property that
// lets a reader carry position between this drawing and the real thing:
//   columns  <- mean die X of a unit's bits
//   rails    <- the unit's offset *within* a bit row (see `row_offset`)
// Neither is a stored picture; move a block on the die and it moves here.
function layOut(bp) {
  const rails = bp.units
    .map((u, i) => ({ ...u, i }))
    .filter((u) => u.kind === 'bus')
    .sort((a, b) => a.rowOffset - b.rowOffset);
  const blocks = bp.units
    .map((u, i) => ({ ...u, i }))
    .filter((u) => u.kind !== 'bus')
    .sort((a, b) => a.dieX - b.dieX);

  const pos = new Map();   // unit index -> {x, y, kind, ...}

  blocks.forEach((u, n) => {
    pos.set(u.i, {
      kind: 'block',
      x: PAD_X + n * COL_W + BLOCK_W / 2,
      y: TOP + rails.length * RAIL_GAP + STALK,
      unit: u,
    });
  });

  // A rail spans only the columns it actually reaches. That keeps the PC's
  // holding latches as short local rails instead of full-width buses they are
  // not -- and it falls out of the links rather than being asserted.
  rails.forEach((u, n) => {
    pos.set(u.i, { kind: 'rail', y: TOP + n * RAIL_GAP, unit: u, x0: 0, x1: 0 });
  });

  const xOf = (i) => {
    const p = pos.get(i);
    return p.kind === 'block' ? p.x : (p.x0 + p.x1) / 2;
  };

  // Rail extent, resolved in two passes: block partners give real x values
  // immediately, rail-to-rail partners need the first pass to have run.
  for (const u of rails) {
    const xs = [];
    for (const l of bp.links) {
      const other = l.a === u.i ? l.b : l.b === u.i ? l.a : null;
      if (other === null) continue;
      const p = pos.get(other);
      if (p && p.kind === 'block') xs.push(p.x);
    }
    const r = pos.get(u.i);
    if (xs.length) {
      r.x0 = Math.min(...xs) - 34;
      r.x1 = Math.max(...xs) + 34;
    } else {
      r.x0 = PAD_X;
      r.x1 = PAD_X + (blocks.length - 1) * COL_W + BLOCK_W;
    }
  }
  for (const u of rails) {
    const r = pos.get(u.i);
    for (const l of bp.links) {
      const other = l.a === u.i ? l.b : l.b === u.i ? l.a : null;
      if (other === null) continue;
      const p = pos.get(other);
      if (!p || p.kind !== 'rail') continue;
      // A rail-to-rail link is drawn at a column both rails cover; make sure
      // both actually reach it.
      const meet = Math.max(Math.min(r.x1, p.x1) - 26, Math.min(r.x0, p.x0) + 26);
      r.x0 = Math.min(r.x0, meet);
      r.x1 = Math.max(r.x1, meet);
    }
  }

  // Where each link's switch glyph goes.
  //
  // A block-to-rail switch is drawn *on the rail*, not halfway down the stalk.
  // That is what it is -- the thing that decides whether this column is on that
  // bus -- and it also spreads the switches of one column apart by a full rail
  // gap instead of stacking them where their labels collide. A stalk crossing a
  // rail with no switch on it is exactly the usual notation for "passes over,
  // not connected".
  const edges = bp.links.map((l) => {
    const pa = pos.get(l.a);
    const pb = pos.get(l.b);
    const railToRail = pa.kind === 'rail' && pb.kind === 'rail';
    let x;
    let sy;
    if (railToRail) {
      // Meet somewhere both rails actually reach.
      const lo = Math.max(pa.x0, pb.x0) + 20;
      const hi = Math.min(pa.x1, pb.x1) - 20;
      x = hi > lo ? (lo + hi) / 2 : (Math.max(pa.x0, pb.x0) + Math.min(pa.x1, pb.x1)) / 2;
      sy = (pa.y + pb.y) / 2;
    } else {
      const block = pa.kind === 'block' ? pa : pb;
      const rail = pa.kind === 'block' ? pb : pa;
      x = block.x;
      sy = rail.y;
    }
    return {
      link: l, x, sy, railToRail,
      lo: railToRail ? Math.max(pa.x0, pb.x0) + 20 : x,
      hi: railToRail ? Math.min(pa.x1, pb.x1) - 20 : x,
      y0: Math.min(pa.y, pb.y),
      y1: Math.max(pa.y, pb.y),
    };
  });

  // Rail-to-rail connectors would otherwise pile up in one column -- six of
  // them land in the program counter's corner. Sort by preferred x and push
  // each one right until it clears the last, staying inside the span where both
  // its rails exist.
  const rr = edges.filter((e) => e.railToRail).sort((a, b) => a.x - b.x);
  let prev = -Infinity;
  for (const e of rr) {
    if (e.x < prev + MIN_SEP) e.x = Math.min(prev + MIN_SEP, Math.max(e.hi, prev + MIN_SEP));
    prev = e.x;
  }

  // Two paths between the *same* pair land on the same point. That is not a
  // degenerate case to guard against, it is the shifter: `dpc20_ADDSB06` and
  // `dpc19_ADDSB7` both join the adder to SB, and drawing them on top of each
  // other hides the more interesting of the two.
  const twins = new Map();
  for (const e of edges) {
    const key = `${Math.min(e.link.a, e.link.b)}-${Math.max(e.link.a, e.link.b)}-${e.sy}`;
    const n = twins.get(key) || 0;
    twins.set(key, n + 1);
    if (n > 0) e.x += n * TWIN_DX;
  }

  // A rail's live value sits past its right end, so the rail has to actually
  // end past whatever connects to it -- otherwise the value lands on top of the
  // last connector.
  for (const u of rails) {
    const r = pos.get(u.i);
    for (const e of edges) {
      if (e.link.a !== u.i && e.link.b !== u.i) continue;
      r.x1 = Math.max(r.x1, e.x + 30);
      r.x0 = Math.min(r.x0, e.x - 30);
    }
  }

  const railRight = rails.length
    ? Math.max(...rails.map((u) => pos.get(u.i).x1))
    : 0;
  const blockRight = PAD_X + Math.max(0, blocks.length - 1) * COL_W + BLOCK_W;
  const edgeRight = edges.length ? Math.max(...edges.map((e) => e.x)) : 0;
  const width = Math.max(railRight + RAIL_TAIL, blockRight + PAD_X, edgeRight + 90);
  const height = TOP + rails.length * RAIL_GAP + STALK + BLOCK_H + 74;
  return { pos, edges, rails, blocks, width, height };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const el = (name, attrs = {}, text) => {
  const n = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
};

// `dpc11_SBADD` -> `SBADD`. The index is noise while reading the picture and is
// kept for the detail panel and the title, where it is the thing you search for.
const shortControl = (name) => {
  const us = name.indexOf('_');
  return us > 0 ? name.slice(us + 1) : name;
};

// Short on the drawing, long in the tooltip: a rail name has to fit the gutter,
// and "IDB · internal data bus" on the line collides with the first switch.
const LABELS = {
  sb: 'SB',
  idb: 'IDB',
  adl: 'ADL',
  adh: 'ADH',
  pclp: 'PCL hold',
  pchp: 'PCH hold',
  a: 'A',
  x: 'X',
  y: 'Y',
  s: 'S',
  alua: 'ALU A',
  alub: 'ALU B',
  alu: 'ADD',
  pcl: 'PCL',
  pch: 'PCH',
  p: 'P',
};
const LONG = {
  sb: 'special bus',
  idb: 'internal data bus',
  adl: 'address bus, low byte',
  adh: 'address bus, high byte',
  pclp: 'program counter low, holding latch',
  pchp: 'program counter high, holding latch',
  alua: 'ALU input A',
  alub: 'ALU input B',
  alu: 'adder output',
  a: 'accumulator',
  x: 'index register X',
  y: 'index register Y',
  s: 'stack pointer',
  pcl: 'program counter, low byte',
  pch: 'program counter, high byte',
  p: 'status register',
};
const label = (u) => LABELS[u.name] || u.name.toUpperCase();
const longLabel = (u) => LONG[u.name] || u.name;

function draw(svg, bp, layout) {
  svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
  svg.replaceChildren();

  const gEdges = el('g', { class: 'bp-edges' });
  const gRails = el('g', { class: 'bp-rails' });
  const gBlocks = el('g', { class: 'bp-blocks' });
  svg.append(gEdges, gRails, gBlocks);

  // -- rails ---------------------------------------------------------------
  for (const u of layout.rails) {
    const p = layout.pos.get(u.i);
    const g = el('g', { class: 'bp-rail', 'data-unit': u.name });
    g.append(el('title', {}, `${label(u)} — ${longLabel(u)}`));
    g.append(el('line', { x1: p.x0, y1: p.y, x2: p.x1, y2: p.y, class: 'rail-line' }));
    // In the left gutter, clear of the rail itself: above the line it collided
    // with the first switch's label on every rail that starts near a block.
    g.append(el('text', {
      x: p.x0 - 12, y: p.y + 4, class: 'rail-name', 'text-anchor': 'end',
    }, label(u)));
    g.append(el('text', { x: p.x1 + 12, y: p.y + 5, class: 'rail-value', 'data-value': u.name },
                '--'));
    gRails.append(g);
  }

  // -- blocks --------------------------------------------------------------
  for (const u of layout.blocks) {
    const p = layout.pos.get(u.i);
    const g = el('g', { class: 'bp-block', 'data-unit': u.name });
    g.append(el('title', {}, `${label(u)} — ${longLabel(u)}`));
    g.append(el('rect', {
      x: p.x - BLOCK_W / 2, y: p.y, width: BLOCK_W, height: BLOCK_H, rx: 4, class: 'block-box',
    }));
    g.append(el('text', { x: p.x, y: p.y + 21, class: 'block-name', 'text-anchor': 'middle' },
                label(u)));
    g.append(el('text', {
      x: p.x, y: p.y + 42, class: 'block-value', 'text-anchor': 'middle', 'data-value': u.name,
    }, '--'));
    gBlocks.append(g);
  }

  // -- edges ---------------------------------------------------------------
  for (const e of layout.edges) {
    const l = e.link;
    const g = el('g', {
      class: 'bp-edge',
      'data-control': l.control,
      tabindex: '0',
      role: 'button',
      'aria-label': `${l.control}: ${bp.units[l.a].name} to ${bp.units[l.b].name}`,
    });
    g.append(el('title', {}, `${l.control} — ${bp.units[l.a].name} ↔ ${bp.units[l.b].name}, `
      + `${l.switches.length} switches`));
    g.append(el('line', { x1: e.x, y1: e.y0, x2: e.x, y2: e.y1, class: 'edge-line' }));

    g.append(el('rect', {
      x: e.x - 7, y: e.sy - 7, width: 14, height: 14, rx: 2, class: 'edge-switch',
    }));
    const partial = l.bits !== 255;
    const t = el('text', {
      x: e.x + 12, y: e.sy - 10, class: 'edge-label' + (partial ? ' partial' : ''),
    }, shortControl(l.control) + (partial ? ` ·${countBits(l.bits)}` : ''));
    t.dataset.ax = e.x;
    t.dataset.ay = e.sy;
    g.append(t);
    gEdges.append(g);
  }
}

// Nudge control labels off each other.
//
// Tuning the layout constants until one particular pair stops touching only
// works until the next pair does. Each label instead gets several candidate
// spots around its switch and takes the first one that is clear, measured
// against what is already placed -- including the rail names and values, which
// do not move. `_blueprint-test.html` asserts the result, because a collision
// is obvious in a screenshot and completely silent to everything else.
//
// **Call this only once the SVG is visible.** `getBBox()` on anything inside a
// `hidden` container measures zero, every box then "clears" every other box,
// and the pass silently does nothing -- the same trap as sizing a canvas that
// is still in a hidden panel.
function placeLabels(svg) {
  const hits = (a, b) =>
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1
    && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1;

  // Fixed furniture: rail names and live values are anchored to their rails.
  const placed = [...svg.querySelectorAll('.rail-name, .rail-value, .block-name, .block-value')]
    .map((n) => n.getBBox());

  const CANDIDATES = [
    { dx: 12, dy: -10, anchor: 'start' },
    { dx: -12, dy: -10, anchor: 'end' },
    { dx: 12, dy: 20, anchor: 'start' },
    { dx: -12, dy: 20, anchor: 'end' },
    { dx: 12, dy: -26, anchor: 'start' },
    { dx: -12, dy: -26, anchor: 'end' },
  ];

  for (const t of svg.querySelectorAll('.edge-label')) {
    const ax = Number(t.dataset.ax);
    const ay = Number(t.dataset.ay);
    let chosen = null;
    for (const c of CANDIDATES) {
      t.setAttribute('x', ax + c.dx);
      t.setAttribute('y', ay + c.dy);
      t.setAttribute('text-anchor', c.anchor);
      const box = t.getBBox();
      if (!placed.some((p) => hits(box, p))) { chosen = box; break; }
    }
    if (!chosen) {
      // Nothing was clear; keep the default and let the test say so rather
      // than silently drawing a pile.
      const c = CANDIDATES[0];
      t.setAttribute('x', ax + c.dx);
      t.setAttribute('y', ay + c.dy);
      t.setAttribute('text-anchor', c.anchor);
      chosen = t.getBBox();
    }
    placed.push(chosen);
  }
}

const countBits = (m) => m.toString(2).split('').filter((c) => c === '1').length;

// ---------------------------------------------------------------------------
// Live state
// ---------------------------------------------------------------------------

// One byte per unit, read out of the node levels -- the same bytes the die view
// colours. Nothing is modelled: a register's value here is whatever its eight
// storage nodes happen to be holding.
function unitValue(levels, unit) {
  let v = 0;
  let known = 0;
  for (let b = 0; b < 8; b++) {
    const node = unit.bits[b];
    if (node === null) continue;
    known |= 1 << b;
    if (levels[node]) v |= 1 << b;
  }
  return { value: v, mask: known };
}

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

  $('bp-run').onclick = (ev) => {
    state.running = !state.running;
    ev.currentTarget.textContent = state.running ? 'Pause' : 'Run';
    ev.currentTarget.classList.toggle('btn-primary', !state.running);
  };
  $('bp-step').onclick = () => {
    state.machine.halfStep();
    refresh(svg, state.bp, state.machine);
    updateReadout();
  };
  $('bp-cycle').onclick = () => {
    state.machine.stepCycle();
    refresh(svg, state.bp, state.machine);
    updateReadout();
  };
  $('bp-reset').onclick = () => {
    loadProgram(Number(select.value));
    refresh(svg, state.bp, state.machine);
    updateReadout();
  };
  $('bp-speed').onchange = (ev) => { state.speed = Number(ev.currentTarget.value); };

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

function tick() {
  state.raf = requestAnimationFrame(tick);
  if (state.running) {
    // Sub-1x speeds carry a fractional debt between frames, so 0.25x means one
    // half-cycle every fourth frame rather than a rounding error.
    state.speedDebt += state.speed;
    const n = Math.floor(state.speedDebt);
    state.speedDebt -= n;
    if (n > 0) state.machine.runHalfCycles(n);
  }
  const hc = state.machine.halfCycle();
  if (hc !== state.lastHalfCycle) {
    state.lastHalfCycle = hc;
    refresh($('bp-svg'), state.bp, state.machine);
    updateReadout();
  }
}

boot();
