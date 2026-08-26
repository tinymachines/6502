// The whole chip as one schematic: every derived container a box, the wiring
// between them bundled, laid out by rule, lit by the running chip.
//
// The site has said since the tracer was built that a schematic of 1160 gates
// and 873 switches would need a whole-chip layout engine, and would still be
// an arrangement somebody chose. At the GROUP level it stops being true:
// `chip-groups.js` gives 134 disjoint groups covering every node, and at that
// size a layout can be derived rather than chosen. Two axes, both measured:
//
//  - x is HOW FAR FROM THE OUTSIDE WORLD: the median, over a group's nodes, of
//    each node's BFS distance from the input and bidirectional pins, walking
//    gate inputs to their outputs and both ways through a switch channel (the
//    same neighbour rules as the workbench's pin chains). The pins land in
//    column 0 and the deepest logic sixteen hops in.
//  - y is WHERE IT SITS ON THE DIE: groups within a column are ordered by the
//    median die Y of their members, so the address machinery stays near the
//    address machinery and the picture agrees with the exploded view about
//    what is near what. Positions come from layout.bin, nothing invented.
//
// An edge here is a BUNDLE: every gate edge and every switch between two
// groups, drawn as one line weighted by how many it stands for. Switch
// bundles are brighter than gate bundles, the same structural distinction
// every drawing on this site keeps. Nothing is dropped: 540 bundles, and the
// caption counts them.
//
// Live: a box fills with the share of its members high right now, and rings
// when any member changed at the last half-cycle; a switch bundle brightens
// while any of its controls is high, and a gate bundle flashes when one of
// its outputs moved. Clicking a box is the walk: the card lists its heaviest
// partners as pills that select them, and links to the same container on the
// tracer, where it sits at its die position instead.

import init, { Machine } from './pkg/v6502_wasm.js';
import { PROGRAMS, LOAD_ADDR, selectedProgram, setSelectedProgram } from './programs.js';
import { setupProgramNav } from './program-nav.js';
import { setupChipNav } from './chip-nav.js';
import { adopt, chipDriver } from './chip-machine.js';
import {
  halfCyclesFor, CLOCKS, clockHz, setClock, toggleRunning, isRunning,
  step as stepChip, stepBack as stepBackChip, reset as resetChip, subscribe,
} from './chip-controls.js';
import { setupFullscreen } from './fullscreen.js';
import { createPalette } from './solo-palette.js';
import { chipGroups, KIND_LABEL } from './chip-groups.js';
import { centroids } from './die-centroids.js';
import { el } from './sch-draw.js';
import { SLUGS } from './block-notes.js';
import { assemble } from './asm.js';
import { TOUR, readerOf } from './chipmap-tour.js';

const $ = (id) => document.getElementById(id);

// Layout constants: presentation, not measurement. The columns and the order
// within them are the measured part.
const COLW = 190, BOXW = 148, VGAP = 12, PAD = 40;
// The node grid inside an opened box: a fixed number of cells across, sized
// so the widest group still fits the box. Presentation; the ORDER within the
// grid is the stated rule in orderMembers().
const GRID_COLS = 10, CELL = 13, GRID_PAD = 9, LABEL_H = 26;

const state = {
  sch: null, blocks: null, timing: null,
  machine: null, program: 0,
  groups: null,           // chip-groups.js, with {col, medY, x, y, w, h} added
  byKey: null,            // key -> group
  owner: null,            // Int16Array node -> group index
  bundles: null,          // [{a, b, gates, switches, outs, controls, ab, ba}]
  partners: null,         // group index -> [{i, weight}]
  view: null, home: null, // viewBox
  prev: null,             // last painted levels
  sel: null,              // selected group key, or null
  tour: null,             // {h0, lastStep} while the guided tour is running
  reader: null,           // readerOf(machine), built once
  nodesView: true,        // boxes opened into grids of their member nodes
  controls: null,         // Set of nodes that hold at least one switch
  pos: null,              // die centroids, kept for the in-grid ordering
  nodeEls: null,          // node id -> its glyph, in the nodes view
  rung: new Set(),        // the glyphs ringed at the last paint
  pickedNode: null,       // a clicked glyph, shown on the card
  offsets: new Map(),     // key -> {dx, dy}: boxes the reader has moved
  boxEls: null,           // group index -> its <g>, for the drag
  bundleEls: null,        // bundle index -> its <line>
  solo: false,            // the study view
};
let pal = null;           // the floating console (solo-palette.js)

const LAYOUT_KEY = 'v6502.chipmap.layout';
const CONSOLE_KEY = 'v6502.chipmap.console';

/** A moved box's offset, snapped to the node grid's own cell. */
function offsetOf(g) { return state.offsets.get(g.key) || { dx: 0, dy: 0 }; }
function centerOf(g) {
  const o = offsetOf(g);
  return [g.x + o.dx + g.w / 2, g.y + o.dy + g.h / 2];
}

function loadOffsets() {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}');
    state.offsets = new Map(Object.entries(raw).map(([k, v]) => [k, { dx: v[0], dy: v[1] }]));
  } catch { state.offsets = new Map(); }
}
function saveOffsets() {
  const out = {};
  for (const [k, o] of state.offsets) if (o.dx || o.dy) out[k] = [o.dx, o.dy];
  try {
    if (Object.keys(out).length) localStorage.setItem(LAYOUT_KEY, JSON.stringify(out));
    else localStorage.removeItem(LAYOUT_KEY);
  } catch { /* storage denied: the arrangement lives for the session */ }
}

// ---------------------------------------------------------------------------
// Derivation: distance from the pins, the bundles, the layout
// ---------------------------------------------------------------------------

/** BFS distance of every node from the input and bidirectional pins. */
function pinDistance() {
  const { sch } = state;
  const fwd = new Map();
  const add = (x, y) => { if (!fwd.has(x)) fwd.set(x, []); fwd.get(x).push(y); };
  for (const [out, , pre, legs] of sch.gates) {
    for (const i of new Set(legs.flat())) add(i, out);
    if (pre >= 0) add(pre, out);
  }
  for (const [, a, b] of sch.switches) { add(a, b); add(b, a); }
  const start = [];
  for (const g of state.groups) {
    if (g.kind === 'pins' && (g.id === 'input' || g.id === 'bidirectional')) start.push(...g.nodes);
  }
  const dist = new Map(start.map((n) => [n, 0]));
  const q = [...start];
  while (q.length) {
    const n = q.shift();
    for (const m of fwd.get(n) || []) {
      if (m === sch.vss || m === sch.vcc || dist.has(m)) continue;
      dist.set(m, dist.get(n) + 1);
      q.push(m);
    }
  }
  return dist;
}

const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : Infinity;
};

/**
 * The order of a group's members on its grid, stated: a name carrying a bit
 * index sorts by stem then bit, so a byte reads left to right from bit 0; any
 * other name sorts after them alphabetically; the unnamed come last in die
 * order, top of the die first. Nothing is placed by hand.
 */
function orderMembers(g) {
  const key = (n) => {
    const nm = state.sch.names[n];
    if (nm) {
      const m = /^(.*?)(\d+)$/.exec(nm);
      if (m) return [0, m[1], Number(m[2]), 0];
      return [1, nm, 0, 0];
    }
    const p = state.pos.get(n);
    return [2, '', p ? p.y : 1e9, p ? p.x : 1e9];
  };
  return g.nodes.slice().sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < 4; i++) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return a - b;
  });
}

function buildLayout(pos) {
  const dist = pinDistance();
  for (const g of state.groups) {
    g.col = median(g.nodes.map((n) => dist.get(n)).filter((d) => d !== undefined));
    g.medY = median(g.nodes.map((n) => pos.get(n)?.y).filter((y) => y !== undefined));
    g.order = orderMembers(g);
    g.h = state.nodesView
      ? LABEL_H + Math.ceil(g.nodes.length / GRID_COLS) * CELL + GRID_PAD
      : Math.max(28, Math.round(16 + 3.4 * Math.sqrt(g.nodes.length)));
    g.w = BOXW;
  }
  // Compress the distances to consecutive columns; a group none of whose
  // members the pins reach (the two inert structures) goes last, and the
  // caption says so rather than dropping it.
  const cols = [...new Set(state.groups.map((g) => g.col))]
    .sort((a, b) => (a === Infinity) - (b === Infinity) || a - b);
  const colIx = new Map(cols.map((c, i) => [c, i]));
  const perCol = new Map();
  for (const g of state.groups) {
    const c = colIx.get(g.col);
    g.colIx = c;
    if (!perCol.has(c)) perCol.set(c, []);
    perCol.get(c).push(g);
  }
  let maxH = 0;
  for (const list of perCol.values()) {
    maxH = Math.max(maxH, list.reduce((a, g) => a + g.h + VGAP, -VGAP));
  }
  const H = maxH + PAD * 2;
  for (const [c, list] of perCol) {
    list.sort((p, q) => p.medY - q.medY || p.key.localeCompare(q.key));
    const colH = list.reduce((a, g) => a + g.h + VGAP, -VGAP);
    let y = PAD + (maxH - colH) / 2;
    for (const g of list) {
      g.x = PAD + c * COLW;
      g.y = y;
      y += g.h + VGAP;
    }
  }
  const W = PAD * 2 + (cols.length - 1) * COLW + BOXW;
  return { W, H, columns: cols.length, unreachedCols: cols.includes(Infinity) ? 1 : 0 };
}

function buildBundles() {
  const { sch } = state;
  const owner = new Int16Array(sch.names.length).fill(-1);
  state.groups.forEach((g, i) => { for (const n of g.nodes) owner[n] = i; });
  state.owner = owner;
  const map = new Map();
  const at = (a, b) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const k = lo * 1024 + hi;
    if (!map.has(k)) map.set(k, { a: lo, b: hi, gates: 0, switches: 0, outs: [], controls: [], ab: 0, ba: 0 });
    return map.get(k);
  };
  let internalGates = 0, internalSwitches = 0;
  for (const [out, , pre, legs] of sch.gates) {
    const ins = new Set(legs.flat());
    if (pre >= 0) ins.add(pre);
    for (const i of ins) {
      if (i === sch.vss || i === sch.vcc) continue;
      const a = owner[i], b = owner[out];
      if (a < 0 || b < 0) continue;
      if (a === b) { internalGates++; continue; }
      const bd = at(a, b);
      bd.gates++;
      bd.outs.push(out);
      if (a === bd.a) bd.ab++; else bd.ba++;
    }
  }
  for (const [c, a, b] of sch.switches) {
    if (a === sch.vss || a === sch.vcc || b === sch.vss || b === sch.vcc) continue;
    const p = owner[a], q = owner[b];
    if (p < 0 || q < 0) continue;
    if (p === q) { internalSwitches++; continue; }
    const bd = at(p, q);
    bd.switches++;
    bd.controls.push(c);
  }
  state.bundles = [...map.values()];
  state.partners = state.groups.map(() => []);
  state.bundles.forEach((bd, i) => {
    bd.i = i;
    bd.weight = bd.gates + bd.switches;
    state.partners[bd.a].push({ i: bd.b, weight: bd.weight, bundle: i });
    state.partners[bd.b].push({ i: bd.a, weight: bd.weight, bundle: i });
  });
  for (const list of state.partners) list.sort((p, q) => q.weight - p.weight);
  return { internalGates, internalSwitches };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const trim = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Lay out for the current view, draw, and re-home the camera. */
function rebuild() {
  const dims = buildLayout(state.pos);
  state.nodeEls = state.nodesView ? new Array(state.sch.names.length).fill(null) : null;
  state.rung = new Set();
  state.home = [0, 0, dims.W, dims.H];
  drawAll();
  setView(state.home.slice());
  return dims;
}

function drawAll() {
  const svg = $('cm-svg');
  svg.replaceChildren();
  const bg = el('g', { class: 'cm-bundles' }, svg);
  state.bundleEls = [];
  for (const bd of state.bundles) {
    const [ax, ay] = centerOf(state.groups[bd.a]);
    const [bx, by] = centerOf(state.groups[bd.b]);
    const w = Math.min(9, 0.7 + Math.log2(1 + bd.weight) * 0.9);
    const cls = bd.switches ? 'cm-bd cm-bd-sw' : 'cm-bd';
    const line = el('line', {
      x1: ax, y1: ay, x2: bx, y2: by,
      class: cls, 'stroke-width': w.toFixed(2), 'data-b': bd.i,
    }, bg);
    line.style.setProperty('--bw', Math.min(0.5, 0.1 + bd.weight / 60).toFixed(2));
    state.bundleEls[bd.i] = line;
  }
  const fg = el('g', { class: 'cm-boxes' }, svg);
  state.boxEls = [];
  for (const g of state.groups) {
    const box = el('g', { class: 'cm-box', 'data-key': g.key }, fg);
    state.boxEls.push(box);
    const o = offsetOf(g);
    if (o.dx || o.dy) box.setAttribute('transform', `translate(${o.dx} ${o.dy})`);
    el('rect', { x: g.x, y: g.y, width: g.w, height: g.h, rx: 3, class: 'cm-bg' }, box);
    el('rect', { x: g.x, y: g.y, width: g.w, height: g.h, rx: 3, class: 'cm-hi' }, box);
    el('text', { x: g.x + 6, y: g.y + 11, class: 'cm-kind' }, box)
      .textContent = trim(KIND_LABEL[g.kind] || g.kind, 24);
    el('text', { x: g.x + 6, y: g.y + Math.min(g.h - 6, 23), class: 'cm-name' }, box)
      .textContent = trim(g.label, 22);
    el('title', {}, box).textContent =
      `${g.label} · ${KIND_LABEL[g.kind]} · ${g.nodes.length} node${g.nodes.length === 1 ? '' : 's'}`;
    if (state.nodesView) {
      g.order.forEach((n, i) => {
        const cx = g.x + GRID_PAD + (i % GRID_COLS) * CELL + CELL / 2;
        const cy = g.y + LABEL_H + Math.floor(i / GRID_COLS) * CELL + CELL / 2 - 3;
        // A square is a node that holds switches: filled while they conduct,
        // empty while they are open circuit. Everything else is a dot.
        const glyph = state.controls.has(n)
          ? el('rect', { x: cx - 3.5, y: cy - 3.5, width: 7, height: 7, class: 'cm-sw', 'data-n': n }, box)
          : el('circle', { cx, cy, r: 2.8, class: 'cm-nd', 'data-n': n }, box);
        el('title', {}, glyph).textContent =
          `${state.sch.names[n] || `unnamed ${n}`}`
          + (state.controls.has(n) ? ` · holds ${state.sch.switches.filter(([c]) => c === n).length} switch(es)` : '');
        state.nodeEls[n] = glyph;
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Live state
// ---------------------------------------------------------------------------

/**
 * Push the machine into the drawing. Called from the frame loop while running
 * and directly after any discrete step, never left to the next frame.
 */
function paint() {
  const m = state.machine;
  if (!m) return;
  const levels = m.nodeLevels();
  const prev = state.prev;
  const svg = $('cm-svg');
  const boxes = svg.querySelectorAll('.cm-box');
  const els = state.nodeEls;
  const rungNow = new Set();
  state.groups.forEach((g, gi) => {
    let hi = 0, mv = 0;
    for (const n of g.nodes) {
      const on = levels[n] > 0;
      const changed = prev ? levels[n] !== prev[n] : false;
      if (on) hi++;
      if (changed) mv++;
      if (els) {
        const e = els[n];
        if (e && (!prev || changed)) e.classList.toggle('on', on);
        if (e && changed) { e.classList.add('mv'); rungNow.add(e); }
      }
    }
    g.hiNow = hi; g.mvNow = mv;
    const box = boxes[gi];
    box.style.setProperty('--hi', (0.5 * hi / g.nodes.length).toFixed(3));
    box.classList.toggle('mv', mv > 0);
  });
  if (els) {
    for (const e of state.rung) if (!rungNow.has(e)) e.classList.remove('mv');
    state.rung = rungNow;
  }
  for (const line of state.bundleEls || []) {
    const bd = state.bundles[Number(line.dataset.b)];
    let open = false, fired = false;
    for (const c of bd.controls) if (levels[c] > 0) { open = true; break; }
    if (prev) for (const o of bd.outs) if (levels[o] !== prev[o]) { fired = true; break; }
    line.classList.toggle('open', open);
    line.classList.toggle('fired', fired);
  }
  state.prev = levels;
  paintCardLive();
  paintTour();
  const text = `half-cycle ${m.halfCycle()} · ${m.clk0() ? 'φ1' : 'φ2'}`
    + `${m.sync() ? ' · sync' : ''}`;
  for (const id of ['cm-head', 'cm-solo-clock']) {
    const out = $(id);
    if (out && out.textContent !== text) out.textContent = text;
  }
}

function tick(now = 0) {
  const n = halfCyclesFor(now);
  for (let i = 0; i < n; i++) state.machine.halfStep();
  if (n) paint();
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// Selection and the card
// ---------------------------------------------------------------------------

/** The same container on the tracer, where it sits at its die position. */
function tracerLink(g) {
  const { sch } = state;
  const blockSlug = (b) => SLUGS[sch.blockNames[b]] || null;
  const enc = encodeURIComponent;
  switch (g.kind) {
    case 'regs': return `tracer?reg=${enc(g.id)}`;
    case 'flags': return `tracer?flag=${enc(g.id)}`;
    case 'alat': return `tracer?alat=${enc(g.id)}`;
    case 'dbus': return `tracer?dbus=${enc(g.id)}`;
    case 'irp': return `tracer?ir=${enc(g.id)}`;
    case 'sbus': return `tracer?sb=${enc(g.id)}`;
    case 'sdp': return `tracer?sd=${enc(g.id.toLowerCase())}`;
    case 'rdy': return `tracer?rdy=${enc(g.id)}`;
    case 'pcr': return `tracer?pc=${enc(g.id)}`;
    case 'pipe': return `tracer?pipes=${enc(g.id)}`;
    case 'sync': return 'tracer?syncgen=1';
    case 'clock': return 'tracer?clock=1';
    case 'intr': return `tracer?intr=${enc(g.id)}`;
    case 'branch': return `tracer?branch=${enc(g.id)}`;
    case 'decimal': return 'tracer?bcd=1';
    case 'alu': return `tracer?alu=${enc(g.id)}`;
    case 'incr': return 'tracer?incr=1';
    case 'chain': return `tracer?chain=${enc(g.id)}`;
    case 'bus': return `tracer?bus=${enc(g.id)}`;
    case 'stage': return `tracer?stage=${enc(g.id)}`;
    case 'pins': return g.id === 'neither' ? null : `tracer?pin=${enc(g.id)}`;
    case 'control': case 'rest': case 'logic': {
      const slug = blockSlug(Number(g.id));
      return slug ? `tracer?block=${slug}` : null;
    }
    default: return null;
  }
}

/** A group whose id is a stem with eight named bits reads as a byte. */
function byteOf(g, levels) {
  if (!/^[a-z]+$/.test(g.id)) return null;
  const bits = [];
  for (let i = 0; i < 8; i++) {
    const n = state.byName.get(`${g.id}${i}`);
    bits.push(n === undefined ? null : n);
  }
  if (bits.filter((b) => b !== null).length < 7) return null;
  let v = 0;
  for (let i = 0; i < 8; i++) if (bits[i] !== null && levels[bits[i]] > 0) v |= 1 << i;
  return `$${v.toString(16).padStart(2, '0').toUpperCase()}`;
}

function select(key) {
  if (state.pickedNode != null) {
    const g = key ? state.byKey.get(key) : null;
    if (!g || !g.nodes.includes(state.pickedNode)) state.pickedNode = null;
  }
  state.sel = key;
  const svg = $('cm-svg');
  const gi = key ? state.groups.findIndex((g) => g.key === key) : -1;
  svg.classList.toggle('has-sel', gi >= 0);
  const adj = new Set();
  if (gi >= 0) for (const p of state.partners[gi]) adj.add(p.i);
  const boxes = svg.querySelectorAll('.cm-box');
  state.groups.forEach((g, i) => {
    boxes[i].classList.toggle('sel', i === gi);
    boxes[i].classList.toggle('adj', adj.has(i));
  });
  for (const line of state.bundleEls || []) {
    const bd = state.bundles[Number(line.dataset.b)];
    line.classList.toggle('sel', gi >= 0 && (bd.a === gi || bd.b === gi));
  }
  paintCard();
}

function paintCard() {
  const card = $('cm-card');
  card.replaceChildren();
  const gi = state.sel ? state.groups.findIndex((g) => g.key === state.sel) : -1;
  if (gi < 0) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Click a box: what it is, what moves it, and where it sits on the tracer.';
    card.append(p);
    return;
  }
  const g = state.groups[gi];
  const head = document.createElement('p');
  head.className = 'cm-card-head';
  const b = document.createElement('b');
  b.textContent = g.label;
  head.append(b, ` · ${KIND_LABEL[g.kind]} · ${g.nodes.length} node${g.nodes.length === 1 ? '' : 's'}`
    + ` · column ${g.colIx + 1} of the pin distance`);
  card.append(head);
  const live = document.createElement('p');
  live.className = 'mono muted';
  live.id = 'cm-card-live';
  card.append(live);
  if (state.pickedNode != null && g.nodes.includes(state.pickedNode)) {
    const n = state.pickedNode;
    const nd = document.createElement('p');
    nd.className = 'mono muted';
    nd.id = 'cm-card-node';
    nd.dataset.n = n;
    card.append(nd);
  }
  const parts = state.partners[gi].slice(0, 10);
  if (parts.length) {
    const row = document.createElement('p');
    row.className = 'cm-card-partners';
    row.append('wired to: ');
    for (const p of parts) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cm-pill';
      const bd = state.bundles[p.bundle];
      btn.textContent = `${state.groups[p.i].label} ×${p.weight}`;
      btn.title = `${bd.gates} gate edge${bd.gates === 1 ? '' : 's'}, `
        + `${bd.switches} switch${bd.switches === 1 ? '' : 'es'}`;
      btn.addEventListener('click', () => select(state.groups[p.i].key));
      row.append(btn, ' ');
    }
    card.append(row);
  }
  const link = tracerLink(g);
  if (link) {
    const p = document.createElement('p');
    const a = document.createElement('a');
    a.className = 'btn';
    a.href = link;
    a.textContent = 'This container on the tracer';
    p.append(a);
    card.append(p);
  }
  addDiagram(card, g);
  paintCardLive();
}

/** A group key as a filename: five keys carry a slash (`alat:ADL/ABL`), which
 *  is a directory separator to every filesystem, so `run.sh` flattens `/` and
 *  `:` the same way. */
const elkFile = (key) => key.replace(/[/:]/g, '-');

/**
 * This container as a schematic, if one has been drawn.
 *
 * **A computed layout, not a picture of the die.** The tracer draws these same
 * nodes at their measured centroids; this is where a layout algorithm puts
 * them instead, which is a different claim and is labelled as one. The two are
 * worth having side by side and neither approximates the other.
 *
 * Drawn by `tools/chip-elk/run.sh` into `web/chip-elk/`, which is generated
 * and may simply not be there. So the element is added hidden and revealed on
 * load: a missing file leaves no caption, no broken image and no error,
 * exactly as the version footer does nothing without its stamp.
 */
function addDiagram(card, g) {
  const wrap = document.createElement('figure');
  wrap.className = 'cm-elk';
  wrap.hidden = true;
  const a = document.createElement('a');
  const href = `chip-elk/${elkFile(g.key)}.svg`;
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  const img = document.createElement('img');
  img.alt = `${g.label}, laid out as a schematic`;
  // The listener goes on BEFORE the src, or a cached image fires `load`
  // before anything is listening and the figure stays hidden forever.
  img.addEventListener('load', () => { wrap.hidden = false; });
  // NOT loading="lazy". A lazy image inside a hidden element is never
  // fetched, so `load` never fires, so it is never revealed: the
  // reveal-on-load pattern and lazy loading deadlock each other. One image
  // per selection, a median of 8 KB, is not worth the trap.
  img.src = href;
  a.append(img);
  const cap = document.createElement('figcaption');
  cap.textContent = 'Laid out by algorithm, not at die positions. Opens full size.';
  wrap.append(a, cap);
  card.append(wrap);
}

/** The card's live lines, rewritten on every paint rather than rebuilt. */
function paintCardLive() {
  const live = document.getElementById('cm-card-live');
  if (!live || !state.sel || !state.prev) return;
  const g = state.groups.find((x) => x.key === state.sel);
  const byte = byteOf(g, state.prev);
  const text = `${g.hiNow ?? 0} high now · ${g.mvNow ?? 0} moved at the last half-cycle`
    + (byte ? ` · reads ${byte}` : '');
  if (live.textContent !== text) live.textContent = text;
  const nd = document.getElementById('cm-card-node');
  if (nd) {
    const n = Number(nd.dataset.n);
    const held = state.controls.has(n)
      ? (state.prev[n] > 0 ? 'its switches conduct' : 'its switches are open circuit')
      : (state.prev[n] > 0 ? 'high' : 'low');
    const sw = state.controls.has(n) ? state.sch.switches.filter(([c]) => c === n).length : 0;
    const t = `node ${state.sch.names[n] || `unnamed ${n}`}: ${held}`
      + (sw ? ` (${sw} switch${sw === 1 ? '' : 'es'})` : '');
    if (nd.textContent !== t) nd.textContent = t;
  }
}

// ---------------------------------------------------------------------------
// The guided tour: one instruction, container by container
// ---------------------------------------------------------------------------
//
// The authored half is chipmap-tour.js and is labelled as such; everything
// this panel shows beside it is measured on this machine: every check is a
// function evaluated live, and the moved list is the change set grouped by
// the partition. The tour takes over the chip the way the Lab does: it
// replaces the loaded program and power-cycles, so it never starts on its
// own; it waits for the button, or ?tour=.

/** Frame the subject and its partners, padded, at the home aspect. */
function frameGroups(gis) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of gis) {
    const g = state.groups[i];
    const o = offsetOf(g);
    x0 = Math.min(x0, g.x + o.dx); y0 = Math.min(y0, g.y + o.dy);
    x1 = Math.max(x1, g.x + o.dx + g.w); y1 = Math.max(y1, g.y + o.dy + g.h);
  }
  const pad = 60;
  let w = Math.max(700, x1 - x0 + pad * 2);
  let h = (state.home[3] / state.home[2]) * w;
  if (h < y1 - y0 + pad * 2) { h = y1 - y0 + pad * 2; w = (state.home[2] / state.home[3]) * h; }
  w = Math.min(w, state.home[2]); h = Math.min(h, state.home[3]);
  setView([(x0 + x1) / 2 - w / 2, (y0 + y1) / 2 - h / 2, w, h]);
}

function loadTheProgram(i) {
  const m = state.machine;
  state.program = i;
  m.load(LOAD_ADDR, new Uint8Array(PROGRAMS[i].bytes));
  m.setResetVector(LOAD_ADDR);
  m.powerCycle();
  state.prev = null;
}

function startTour(stepIx = 0) {
  const m = state.machine;
  const img = assemble(TOUR.source);
  const at = img.labels.get(TOUR.target);
  if (at == null) throw new Error(`tour: no label "${TOUR.target}"`);
  m.load(img.org, new Uint8Array(img.bytes));
  m.setResetVector(img.org);
  m.powerCycle();
  // Offsets are from the instruction's own opcode fetch, found by running
  // until sync with its address on the bus, never a remembered half-cycle.
  let guard = 0;
  while (!(m.sync() && m.lastFetchAddr() === at)) {
    if (guard++ > 20000) throw new Error('tour: never fetched the instruction');
    m.halfStep();
  }
  state.tour = { h0: m.halfCycle(), lastStep: -1 };
  state.prev = null;
  $('cmt-start').hidden = true;
  $('cmt-panel').hidden = false;
  $('cmt-src').textContent = TOUR.source;
  tourGoTo(TOUR.steps[Math.max(0, Math.min(TOUR.steps.length - 1, stepIx))].at);
}

function exitTour() {
  state.tour = null;
  $('cmt-panel').hidden = true;
  $('cmt-start').hidden = false;
  loadTheProgram(state.program);
  select(null);
  setView(state.home.slice());
  paint();
}

/**
 * Land on offset `at` showing what the LAST half-cycle changed: run to at-1,
 * snapshot, step, paint. The tracer's ?step= learnt this rule the hard way.
 * Backward is the rewind, bounded by its keyframes like everywhere else.
 */
function tourGoTo(at) {
  const m = state.machine;
  while (m.halfCycle() - state.tour.h0 > at - 1) {
    const before = m.halfCycle();
    m.stepBack();
    if (m.halfCycle() === before) break;
  }
  while (m.halfCycle() - state.tour.h0 < at - 1) m.halfStep();
  state.prev = m.nodeLevels();
  if (m.halfCycle() - state.tour.h0 === at - 1) m.halfStep();
  paint();
}

function tourStep(dir) {
  const k = state.machine.halfCycle() - state.tour.h0;
  const st = dir > 0
    ? TOUR.steps.find((x) => x.at > k)
    : [...TOUR.steps].reverse().find((x) => x.at < k);
  if (st) tourGoTo(st.at);
}

/** The tour panel, painted from the machine on every paint. */
function paintTour() {
  if (!state.tour) return;
  const m = state.machine;
  const k = m.halfCycle() - state.tour.h0;
  const ix = TOUR.steps.findIndex((st) => st.at === k);
  const head = $('cmt-head');
  if (ix < 0) {
    const text = `off the path at ${k >= 0 ? '+' : ''}${k} half-cycles: `
      + 'Back and Next rejoin the walkthrough';
    if (head.textContent !== text) head.textContent = text;
    if (state.tour.lastStep !== -1) {
      state.tour.lastStep = -1;
      $('cmt-title').textContent = '';
      $('cmt-note').textContent = '';
      $('cmt-checks').replaceChildren();
    }
  } else {
    const st = TOUR.steps[ix];
    const text = `step ${ix + 1} of ${TOUR.steps.length} · ${st.at ? `+${st.at}` : 'the fetch'}`
      + ` half-cycle${st.at === 1 ? '' : 's'} from the opcode fetch`;
    if (head.textContent !== text) head.textContent = text;
    // Selection, framing and the prose move only when the step does.
    if (state.tour.lastStep !== ix) {
      state.tour.lastStep = ix;
      $('cmt-title').textContent = st.title;
      $('cmt-note').textContent = st.note;
      select(st.subject);
      const gi = state.groups.findIndex((g) => g.key === st.subject);
      frameGroups([gi, ...state.partners[gi].slice(0, 6).map((p) => p.i)]);
    }
    // The checks are re-evaluated on every paint: a claim the chip has
    // stopped satisfying goes red on its own.
    const host = $('cmt-checks');
    host.replaceChildren();
    const r = state.reader;
    for (const c of st.checks) {
      const held = c.fn(r) === true;
      const p = document.createElement('p');
      p.className = `cmt-check ${held ? 'held' : 'broke'}`;
      const mark = document.createElement('span');
      mark.className = 'cmt-mark';
      mark.textContent = held ? '\u2713' : '\u2717';
      p.append(mark, ` ${c.claim}`);
      host.append(p);
    }
  }
  const movers = state.groups.filter((g) => g.mvNow > 0)
    .sort((a, b) => b.mvNow - a.mvNow).slice(0, 6);
  const mv = movers.length
    ? `moved at this edge: ${movers.map((g) => `${g.label} ${g.mvNow}`).join(' \u00b7 ')}`
    : 'nothing moved at this edge';
  if ($('cmt-moved').textContent !== mv) $('cmt-moved').textContent = mv;
}

// ---------------------------------------------------------------------------
// The study view: fullscreen, with the floating console
// ---------------------------------------------------------------------------
//
// The tracer's arrangement, from the same two shared modules: fullscreen.js
// decides how the viewport is claimed (and falls back where the API would
// fight the browser), solo-palette.js owns the strip, the drawer, the drag
// and the clamp. The drawers BORROW the page's own elements (the card, the
// tour, the view controls) rather than drawing copies, so the console cannot
// disagree with the page about a byte: there is only one copy of it to paint.

const HOMES = [];
function borrow(host, ...ids) {
  for (const id of ids) {
    const e = $(id);
    if (!e) continue;
    HOMES.push({ e, parent: e.parentNode, next: e.nextSibling });
    host.append(e);
  }
}
function returnAll() {
  while (HOMES.length) {
    const { e, parent, next } = HOMES.pop();
    parent.insertBefore(e, next && next.parentNode === parent ? next : null);
  }
}

const noop = () => {};
const PANELS = {
  card: (host) => { returnAll(); borrow(host, 'cm-card'); return noop; },
  tour: (host) => { returnAll(); borrow(host, 'cmt-start', 'cmt-panel'); return noop; },
  view: (host) => { returnAll(); borrow(host, 'cm-nodes', 'cm-tidy', 'cm-scramble', 'cm-opt', 'cm-save', 'cm-load-btn', 'cm-home', 'cm-zoom', 'cm-io-note'); return noop; },
};
const TAB_NAMES = { card: 'The selection', tour: 'The tour', view: 'View' };

function loadConfig() {
  try { return JSON.parse(localStorage.getItem(CONSOLE_KEY) || 'null'); } catch { return null; }
}
function saveConfig() {
  if (!pal) return;
  try { localStorage.setItem(CONSOLE_KEY, JSON.stringify(pal.config())); } catch { /* session only */ }
}

function setupConsole() {
  pal = createPalette({
    palette: $('cm-palette'),
    strip: $('cm-strip'),
    host: $('cm-sp-panel'),
    title: $('cm-drawer-title'),
    collapse: $('cm-collapse'),
    stage: () => document.querySelector('.cm-stage'),
    panels: PANELS,
    names: TAB_NAMES,
    tab: 'card',
    active: () => state.solo,
    onChange: saveConfig,
  });
  pal.restore(loadConfig());

  $('cm-solo-run').addEventListener('click', () => toggleRunning());
  $('cm-solo-step').addEventListener('click', () => stepChip());
  $('cm-solo-back').addEventListener('click', () => stepBackChip());
  $('cm-solo-reset').addEventListener('click', () => resetChip());
  $('cm-solo-exit').addEventListener('click', () => $('cm-fullscreen').click());
  const speed = $('cm-solo-speed');
  for (const c of CLOCKS) speed.add(new Option(c.label, String(c.hz)));
  speed.addEventListener('change', () => setClock(Number(speed.value)));
  // Every control here is a view of the one store, painted on its changes.
  subscribe(() => {
    const on = isRunning();
    const run = $('cm-solo-run');
    run.textContent = on ? '\u275a\u275a' : '\u25b6';
    run.title = on ? 'Pause' : 'Run';
    run.classList.toggle('on', on);
    if (speed.value !== String(clockHz())) speed.value = String(clockHz());
  });

  const console_ = document.querySelector('#view .console');
  setupFullscreen(console_, $('cm-fullscreen'), () => {
    const on = console_.classList.contains('immersive');
    state.solo = on;
    console_.classList.toggle('solo', on);
    if (on) pal.open(loadConfig());
    else returnAll();
  });
}

// ---------------------------------------------------------------------------
// Camera: a viewBox and nothing else, the die graph's own arrangement
// ---------------------------------------------------------------------------

/** The boxes' own bounding rectangle, offsets included. */
function contentBox() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const g of state.groups) {
    const o = offsetOf(g);
    x0 = Math.min(x0, g.x + o.dx); y0 = Math.min(y0, g.y + o.dy);
    x1 = Math.max(x1, g.x + o.dx + g.w); y1 = Math.max(y1, g.y + o.dy + g.h);
  }
  return [x0, y0, x1, y1];
}

/** Frame whatever is actually there: the optimizer runs unwalled, so the
 * cloud can be any size, and a Fit that framed the original rectangle would
 * frame the place the boxes used to be. */
function fitContent(pad = 60) {
  const [x0, y0, x1, y1] = contentBox();
  setView([x0 - pad, y0 - pad, (x1 - x0) + pad * 2, (y1 - y0) + pad * 2]);
}

function setView(v) {
  state.view = v;
  $('cm-svg').setAttribute('viewBox', v.join(' '));
  $('cm-zoom').textContent = `${(state.home[2] / v[2]).toFixed(1)}×`;
}

function zoomAt(factor, cx, cy) {
  const [x, y, w, h] = state.view;
  const [bx0, , bx1] = contentBox();
  const nw = Math.max(120, Math.min(Math.max(state.home[2], bx1 - bx0) * 4, w * factor));
  const nh = nw * (h / w);
  setView([x + (cx - x) * (1 - nw / w), y + (cy - y) * (1 - nh / h), nw, nh]);
}

function atClient(e) {
  const r = $('cm-svg').getBoundingClientRect();
  const [x, y, w, h] = state.view;
  return { x: x + ((e.clientX - r.left) / r.width) * w,
           y: y + ((e.clientY - r.top) / r.height) * h };
}

function setupCamera() {
  const svg = $('cm-svg');
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = atClient(e);
    zoomAt(e.deltaY > 0 ? 1.18 : 1 / 1.18, p.x, p.y);
  }, { passive: false });
  // One pointer pans; two pinch about their midpoint, the ratio always read
  // against the gesture's own start. One constructor for the pinch state:
  // the explorer's NaN came from having two, spelled differently.
  const live = new Map();
  let pinch = null, moved = 0, boxDrag = null;

  /** Move one box: its transform, and the ends of every bundle it anchors. */
  function placeBox(gi) {
    const g = state.groups[gi];
    const o = offsetOf(g);
    state.boxEls[gi].setAttribute('transform', `translate(${o.dx} ${o.dy})`);
    for (const p of state.partners[gi]) {
      const bd = state.bundles[p.bundle];
      const line = state.bundleEls[bd.i];
      const [ax, ay] = centerOf(state.groups[bd.a]);
      const [bx, by] = centerOf(state.groups[bd.b]);
      line.setAttribute('x1', ax); line.setAttribute('y1', ay);
      line.setAttribute('x2', bx); line.setAttribute('y2', by);
    }
  }
  const pinchOf = () => {
    const [p, q] = [...live.values()];
    return { mid: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 },
             spread: Math.hypot(p.x - q.x, p.y - q.y), view: state.view.slice() };
  };
  svg.addEventListener('pointerdown', (e) => {
    live.set(e.pointerId, atClient(e));
    moved = 0;
    // A drag that starts on a box moves the box: the reader's own
    // arrangement, snapped to the node grid's cell on release, persisted,
    // and given back by Tidy. Empty ground still pans.
    const t = e.target.closest('.cm-box');
    boxDrag = live.size === 1 && t
      ? state.groups.findIndex((g) => g.key === t.dataset.key) : null;
    if (boxDrag !== null && boxDrag >= 0) stopOptimize(true);
    if (live.size === 2) { boxDrag = null; pinch = pinchOf(); }
  });
  window.addEventListener('pointermove', (e) => {
    if (!live.has(e.pointerId)) return;
    const p = atClient(e);
    const was = live.get(e.pointerId);
    moved += Math.abs(p.x - was.x) + Math.abs(p.y - was.y);
    live.set(e.pointerId, p);
    if (live.size === 2 && pinch) {
      const now = pinchOf();
      const k = pinch.spread / Math.max(1e-6, now.spread);
      if (!Number.isFinite(k)) return;
      const [vx, vy, vw, vh] = pinch.view;
      const nw = Math.max(120, Math.min(state.home[2] * 4, vw * k));
      const nh = nw * (vh / vw);
      setView([now.mid.x - (now.mid.x - vx) * (nw / vw),
               now.mid.y - (now.mid.y - vy) * (nh / vh), nw, nh]);
    } else if (live.size === 1 && boxDrag !== null && boxDrag >= 0) {
      const g = state.groups[boxDrag];
      const o = { ...offsetOf(g) };
      o.dx += p.x - was.x;
      o.dy += p.y - was.y;
      state.offsets.set(g.key, o);
      placeBox(boxDrag);
    } else if (live.size === 1) {
      const [, , w, h] = state.view;
      setView([state.view[0] - (p.x - was.x), state.view[1] - (p.y - was.y), w, h]);
    }
  });
  const release = (e) => {
    live.delete(e.pointerId);
    if (live.size < 2) pinch = null;
    if (boxDrag !== null && boxDrag >= 0 && live.size === 0) {
      if (moved > 8) {
        // Snap to the grid the nodes already sit on, and keep it.
        const g = state.groups[boxDrag];
        const o = offsetOf(g);
        state.offsets.set(g.key, {
          dx: Math.round(o.dx / CELL) * CELL,
          dy: Math.round(o.dy / CELL) * CELL,
        });
        placeBox(boxDrag);
        saveOffsets();
      }
      boxDrag = null;
    }
  };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  svg.addEventListener('click', (e) => {
    if (moved > 8) return;
    const n = e.target.dataset && e.target.dataset.n;
    state.pickedNode = n !== undefined && n !== '' && n != null ? Number(n) : null;
    const t = e.target.closest('.cm-box');
    select(t ? t.dataset.key : null);
  });
  $('cm-home').addEventListener('click', () => fitContent());
  $('cm-tidy').addEventListener('click', () => {
    stopOptimize(false);
    state.offsets.clear();
    saveOffsets();
    placeAll();
    fitContent();
    ioNote('the derived layout');
  });
}

/** Re-place every box and every bundle from the current offsets. */
function placeAll() {
  state.groups.forEach((g, gi) => {
    const o = offsetOf(g);
    if (o.dx || o.dy) state.boxEls[gi].setAttribute('transform', `translate(${o.dx} ${o.dy})`);
    else state.boxEls[gi].removeAttribute('transform');
  });
  for (const bd of state.bundles) {
    const line = state.bundleEls[bd.i];
    const [ax, ay] = centerOf(state.groups[bd.a]);
    const [bx, by] = centerOf(state.groups[bd.b]);
    line.setAttribute('x1', ax); line.setAttribute('y1', ay);
    line.setAttribute('x2', bx); line.setAttribute('y2', by);
  }
}

// ---------------------------------------------------------------------------
// Scramble and optimize: the arrangement as physics
// ---------------------------------------------------------------------------
//
// Fruchterman-Reingold over the boxes: every pair repels, every bundle pulls
// its two ends together with a strength scaled by the edges it carries, the
// step size cools, and the whole thing runs in small timed chunks so the
// untangling is watchable (and so it still runs where animation frames are
// throttled, which is what an iframe does to a harness). The measured claim
// is the STRETCH: the sum over bundles of weight times centre distance, and
// the note reports it before and after rather than calling anything
// "better". This is the reader's tool, like the drag: the derived layout
// stays the page's claim, and Tidy still gives it back in one press.
//
// The scramble is a seeded PRNG (mulberry32), not Math.random, so a fresh
// page's first scramble is the same scramble: an arrangement a person is
// about to hand-tune should at least start reproducibly.

let annealTimer = null;
let annealSeed = 0x6502;
function rng() {
  annealSeed = (annealSeed + 0x6D2B79F5) | 0;
  let t = Math.imul(annealSeed ^ (annealSeed >>> 15), 1 | annealSeed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** The sum over bundles of weight times centre distance. */
function stretchNow() {
  let sum = 0;
  for (const bd of state.bundles) {
    const [ax, ay] = centerOf(state.groups[bd.a]);
    const [bx, by] = centerOf(state.groups[bd.b]);
    sum += bd.weight * Math.hypot(ax - bx, ay - by);
  }
  return sum;
}
const fmtStretch = (v) => `${Math.round(v / 1000)}k`;

/** Write a full set of centres back as offsets; snap only when settling. */
function setCenters(pts, snap) {
  state.groups.forEach((g, i) => {
    let dx = pts[i][0] - g.x - g.w / 2;
    let dy = pts[i][1] - g.y - g.h / 2;
    if (snap) { dx = Math.round(dx / CELL) * CELL; dy = Math.round(dy / CELL) * CELL; }
    state.offsets.set(g.key, { dx, dy });
  });
  placeAll();
}

function scramble() {
  stopOptimize(false);
  const [, , W, H] = state.home;
  const pts = state.groups.map((g) => [
    PAD + g.w / 2 + rng() * Math.max(1, W - 2 * PAD - g.w),
    PAD + g.h / 2 + rng() * Math.max(1, H - 2 * PAD - g.h),
  ]);
  setCenters(pts, true);
  saveOffsets();
  ioNote(`scrambled: stretch ${fmtStretch(stretchNow())}`);
}

/**
 * Push intersecting boxes apart along the smaller penetration axis, half the
 * overlap each, relaxed over passes until clean or the budget runs out.
 * `gap` is the clearance to enforce; the settle uses one bigger than the
 * snap can steal back (two boxes snap at most half a cell each toward each
 * other), so a settled arrangement can touch but never overlap.
 */
function separate(pts, passes, gap) {
  const groups = state.groups;
  const n = groups.length;
  let any = true;
  for (let p = 0; p < passes && any; p++) {
    any = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const ax = pts[i][0] - groups[i].w / 2, ay = pts[i][1] - groups[i].h / 2;
        const bx = pts[j][0] - groups[j].w / 2, by = pts[j][1] - groups[j].h / 2;
        const ox = Math.min(ax + groups[i].w, bx + groups[j].w) - Math.max(ax, bx) + gap;
        const oy = Math.min(ay + groups[i].h, by + groups[j].h) - Math.max(ay, by) + gap;
        if (ox <= 0 || oy <= 0) continue;
        any = true;
        if (ox < oy) {
          const dir = pts[i][0] < pts[j][0] ? -1 : 1;
          pts[i][0] += (dir * ox) / 2; pts[j][0] -= (dir * ox) / 2;
        } else {
          const dir = pts[i][1] < pts[j][1] ? -1 : 1;
          pts[i][1] += (dir * oy) / 2; pts[j][1] -= (dir * oy) / 2;
        }
      }
    }
  }
  return !any;
}

function stopOptimize(settle) {
  const wasRunning = annealTimer !== null;
  if (wasRunning) { clearTimeout(annealTimer); annealTimer = null; }
  const btn = $('cm-opt');
  if (btn) { btn.textContent = 'Optimize'; btn.classList.remove('on'); }
  if (settle) {
    const pts = state.groups.map((g) => centerOf(g));
    if (wasRunning) separate(pts, 300, CELL + 1);
    setCenters(pts, true);
    saveOffsets();
  }
}

function optimize() {
  if (annealTimer !== null) {
    stopOptimize(true);
    ioNote(`stopped: stretch ${fmtStretch(stretchNow())}`);
    return;
  }
  const groups = state.groups;
  const n = groups.length;
  const k = Math.sqrt((state.home[2] * state.home[3]) / n) * 0.85;
  const radius = groups.map((g) => Math.hypot(g.w, g.h) / 2);
  const maxW = Math.max(...state.bundles.map((b) => b.weight));
  const pts = groups.map((g) => centerOf(g));
  // A container with no bundles has only gravity to answer to, so it gets
  // all of it: without this the inert structures launch off the hot phase
  // and spend the whole cooling walking home.
  const wired = groups.map((_, i) => state.partners[i].length > 0);
  const was = stretchNow();
  let temp = k * 1.8;
  let step = 0;
  const STEPS = 400, PER_CHUNK = 4;
  $('cm-opt').textContent = 'Stop';
  $('cm-opt').classList.add('on');

  const chunk = () => {
    for (let it = 0; it < PER_CHUNK && step < STEPS; it++, step++) {
      const disp = pts.map(() => [0, 0]);
      // Every pair repels, harder when the boxes themselves would touch.
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let vx = pts[i][0] - pts[j][0], vy = pts[i][1] - pts[j][1];
          let d = Math.hypot(vx, vy);
          if (d < 0.01) { vx = rng() - 0.5; vy = rng() - 0.5; d = Math.hypot(vx, vy); }
          const gap = Math.max(1, d - (radius[i] + radius[j]) * 0.7);
          const f = (k * k) / gap / d;
          disp[i][0] += vx * f; disp[i][1] += vy * f;
          disp[j][0] -= vx * f; disp[j][1] -= vy * f;
        }
      }
      // Every bundle pulls, scaled by the weight of what it carries.
      for (const bd of state.bundles) {
        const vx = pts[bd.a][0] - pts[bd.b][0], vy = pts[bd.a][1] - pts[bd.b][1];
        const d = Math.max(0.01, Math.hypot(vx, vy));
        const wgt = (0.35 + 0.65 * Math.sqrt(bd.weight / maxW)) * 2.5;
        const f = ((d * d) / k) * wgt / d;
        disp[bd.a][0] -= vx * f; disp[bd.a][1] -= vy * f;
        disp[bd.b][0] += vx * f; disp[bd.b][1] += vy * f;
      }
      // A weak gravity toward the cloud's own centroid. Without it the run is
      // not free, it is leaky: a group with no bundles at all (the inert
      // structures) feels pure repulsion and accelerates away for as long as
      // the temperature lets it; measured, one reached 31,000 units out. The
      // pull is proportional to distance, so it barely touches the wired
      // structure and firmly herds the disconnected.
      let cx0 = 0, cy0 = 0;
      for (const [px, py] of pts) { cx0 += px; cy0 += py; }
      cx0 /= n; cy0 /= n;
      for (let i = 0; i < n; i++) {
        const grav = wired[i] ? 0.08 : 0.6;
        disp[i][0] += (cx0 - pts[i][0]) * grav;
        disp[i][1] += (cy0 - pts[i][1]) * grav;
        const d = Math.hypot(disp[i][0], disp[i][1]);
        if (d > 0) {
          const move = Math.min(d, temp);
          pts[i][0] += (disp[i][0] / d) * move;
          pts[i][1] += (disp[i][1] / d) * move;
        }
      }
      separate(pts, 1, 2);
      temp *= 0.985;
    }
    setCenters(pts, false);
    fitContent();
    ioNote(`optimizing ${step} of ${STEPS}: stretch ${fmtStretch(stretchNow())}, was ${fmtStretch(was)}`);
    if (step >= STEPS || temp < 0.5) {
      stopOptimize(true);
      ioNote(`settled after ${step} steps: stretch ${fmtStretch(stretchNow())}, was ${fmtStretch(was)}`);
      return;
    }
    annealTimer = setTimeout(chunk, 16);
  };
  annealTimer = setTimeout(chunk, 0);
}

// ---------------------------------------------------------------------------
// Save and load: the arrangement as a file
// ---------------------------------------------------------------------------
//
// The format is exactly what the page already keeps: one object, a container
// key to its [dx, dy] offset in drawing units, nothing else. A loaded file is
// validated rather than trusted: an unknown key is skipped and counted, an
// offset is snapped to the node grid's cell, and the note says what happened
// rather than leaving a silently half-applied file looking like a bug.

/** The arrangement as the file's own text: {"kind:id": [dx, dy], ...}. */
function layoutJSON() {
  const out = {};
  for (const [k, o] of state.offsets) if (o.dx || o.dy) out[k] = [o.dx, o.dy];
  return JSON.stringify(out, null, 1);
}

function ioNote(text) {
  const n = $('cm-io-note');
  if (n) n.textContent = text;
}

function applyLayout(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { ioNote('not JSON: nothing applied'); return; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    ioNote('not a layout object: nothing applied');
    return;
  }
  const next = new Map();
  let applied = 0, skipped = 0;
  for (const [k, v] of Object.entries(data)) {
    const okShape = Array.isArray(v) && v.length === 2 && v.every(Number.isFinite);
    if (!state.byKey.has(k) || !okShape) { skipped++; continue; }
    next.set(k, {
      dx: Math.round(v[0] / CELL) * CELL,
      dy: Math.round(v[1] / CELL) * CELL,
    });
    applied++;
  }
  state.offsets = next;
  saveOffsets();
  placeAll();
  ioNote(`${applied} box${applied === 1 ? '' : 'es'} placed`
    + (skipped ? `, ${skipped} unknown entr${skipped === 1 ? 'y' : 'ies'} skipped` : ''));
}

function setupLayoutIO() {
  $('cm-scramble').addEventListener('click', scramble);
  $('cm-opt').addEventListener('click', optimize);
  $('cm-save').addEventListener('click', () => {
    const blob = new Blob([layoutJSON()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'chipmap-layout.json';
    a.click();
    URL.revokeObjectURL(a.href);
    ioNote(`saved ${state.offsets.size} offset${state.offsets.size === 1 ? '' : 's'}`);
  });
  $('cm-load-btn').addEventListener('click', () => $('cm-load').click());
  $('cm-load').addEventListener('change', async () => {
    const file = $('cm-load').files[0];
    if (!file) return;
    applyLayout(await file.text());
    $('cm-load').value = '';
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  const status = $('cm-status');
  try {
    const [, sch, blocks, timing, buf] = await Promise.all([
      init(),
      fetch('schematic.json').then((r) => { if (!r.ok) throw new Error(`schematic.json: HTTP ${r.status}`); return r.json(); }),
      fetch('blocks.json').then((r) => { if (!r.ok) throw new Error(`blocks.json: HTTP ${r.status}`); return r.json(); }),
      fetch('timing.json').then((r) => { if (!r.ok) throw new Error(`timing.json: HTTP ${r.status}`); return r.json(); }),
      fetch('layout.bin').then((r) => { if (!r.ok) throw new Error(`layout.bin: HTTP ${r.status}`); return r.arrayBuffer(); }),
    ]);
    state.sch = sch; state.blocks = blocks; state.timing = timing;
    state.byName = new Map(sch.names.map((n, i) => [n, i]).filter(([n]) => n));

    const r = chipGroups(sch, blocks, timing);
    state.groups = r.groups;
    state.byKey = new Map(r.groups.map((g) => [g.key, g]));
    state.controls = new Set(sch.switches.map(([c]) => c));
    state.controls.delete(sch.vss); state.controls.delete(sch.vcc);
    const { pos } = centroids(buf);
    state.pos = pos;
    state.nodesView = new URLSearchParams(location.search).get('nodes') !== '0';
    loadOffsets();
    const edge = buildBundles();
    rebuild();
    setupCamera();
    setupConsole();
    setupLayoutIO();
    $('cm-nodes').setAttribute('aria-pressed', String(state.nodesView));
    $('cm-nodes').addEventListener('click', () => {
      state.nodesView = !state.nodesView;
      $('cm-nodes').setAttribute('aria-pressed', String(state.nodesView));
      rebuild();
      paint();
      select(state.sel);
    });

    const switches = state.bundles.reduce((a, b) => a + b.switches, 0);
    const gates = state.bundles.reduce((a, b) => a + b.gates, 0);
    const cols = new Set(state.groups.map((g) => g.colIx)).size;
    $('cm-caption').textContent =
      `${r.groups.length} groups over ${r.stats.kinds} kinds, covering all `
      + `${r.stats.universe} nodes exactly once. ${state.bundles.length} bundles `
      + `carrying ${gates} gate edges and ${switches} switches between groups; `
      + `${edge.internalGates} gate edges and ${edge.internalSwitches} switches `
      + `stay inside one. ${cols} columns of pin distance, the last for what `
      + `the pins never reach. In the node view a square holds switches, `
      + `filled while they conduct; a byte reads left to right from bit 0, `
      + `the unnamed follow in die order.`;

    // .statbar is a flex row written for plain strings; b/span pairs run
    // together there, which is already documented against it.
    $('cm-stats').textContent =
      `${r.groups.length} groups · ${r.stats.kinds} kinds · `
      + `${state.bundles.length} bundles · ${r.stats.universe} nodes, each in `
      + `exactly one group · both axes measured`;

    // The chip: the chosen program, the reset vector set, the header driving
    // it, exactly the block pages' arrangement.
    const m = new Machine();
    state.machine = m;
    state.reader = readerOf(m);
    loadTheProgram(selectedProgram(location.search));
    adopt(m, selectedProgram(location.search));
    // Choosing a program leaves the tour: the tour's program is its own.
    setupProgramNav({ onChange: (i) => {
      setSelectedProgram(i);
      if (state.tour) { state.tour = null; $('cmt-panel').hidden = true; $('cmt-start').hidden = false; }
      loadTheProgram(i);
      paint();
    } });
    setupChipNav(chipDriver(m, {
      reset: () => { m.powerCycle(); state.prev = null; },
      after: paint,
    }));
    paint();
    requestAnimationFrame(tick);

    $('cmt-start').addEventListener('click', () => startTour());
    $('cmt-next').addEventListener('click', () => tourStep(+1));
    $('cmt-back').addEventListener('click', () => tourStep(-1));
    $('cmt-exit').addEventListener('click', exitTour);

    const q = new URLSearchParams(location.search);
    const sel = q.get('sel');
    select(sel && state.byKey.has(sel) ? sel : null);
    if (q.get('tour') === TOUR.id) startTour(Number(q.get('tstep')) || 0);
    // ?full=1 goes through the button rather than the API: a page load
    // carries no user activation, so a real request would be refused, and the
    // button's own fallback covers the viewport anyway.
    if (q.get('full') === '1') $('cm-fullscreen').click();

    // For the harness: the partition and the bundles as data, not scraped
    // back out of the DOM.
    window.__chipmap = { groups: state.groups, bundles: state.bundles, stats: r.stats, machine: m, layoutJSON };

    $('cm-boot').hidden = true;
    $('cm-main').hidden = false;
  } catch (e) {
    status.textContent = `Could not build the page: ${e && e.message ? e.message : e}`;
    status.classList.add('bk-error');
  }
}

boot();
