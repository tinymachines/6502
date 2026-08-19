// The tracer: the whole circuit on screen, lit half-cycle by half-cycle, beside
// the code that is running.
//
// Every other live page shows one part of the chip: the die view its polygons,
// the blueprint its bus fabric, the schematic one cone, the halfshot one plate.
// This one shows every node and every edge at once, at the positions the die
// graph reads off the polygons (die-centroids.js), and at each half-cycle marks
// everything that moved: the nodes whose level changed, the gates whose output
// changed, and the switches that opened or closed. It is the die graph with a
// clock, and the reason it can be is that the graph is not laid out: a node's
// place never changes, so lighting it costs a class and nothing else.
//
// Beside the drawing is the tracer: the program's source with the fetching
// instruction marked, the head line (half-cycle, phase, T-states, buses),
// the registers, a watch list of stems (the address latches and the data
// buses by default) read out bit by bit, and everything that moved, grouped by
// block. Clicking a name in the list flies the drawing to it.
//
// Nothing here is a fact about the 6502. The positions come from layout.bin,
// the edges and blocks from schematic.json, the levels from the machine.

import init, { Machine } from './pkg/v6502_wasm.js';
import { PROGRAMS, LOAD_ADDR, selectedProgram, setSelectedProgram } from './programs.js';
import { setupProgramNav } from './program-nav.js';
import { setupChipNav } from './chip-nav.js';
import {
  CLOCKS, clockHz, isRunning, setClock, setRunning, toggleRunning,
  step as stepChip, reset as resetChip, subscribe, halfCyclesFor,
} from './chip-controls.js';
import { blockCss } from './block-palette.js';
import { el } from './sch-draw.js';
import { centroids } from './die-centroids.js';
import { hex2, hex4 } from './demos.js';
import { setupFullscreen } from './fullscreen.js';

const $ = (id) => document.getElementById(id);

/** HTML element helper (sch-draw's `el` is the SVG one). */
function h(tag, attrs = {}, parent) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  if (parent) parent.append(node);
  return node;
}

/** The default watch, and the presets. Stems as the die names them. */
export const DEFAULT_WATCH = ['abh', 'abl', 'adh', 'adl', 'db', 'idb', 'sb'];
export const PRESETS = {
  address: ['abh', 'abl', 'adh', 'adl', 'pch', 'pcl'],
  data: ['db', 'idl', 'idb', 'sb', 'dor'],
  registers: ['a', 'x', 'y', 's', 'p', 'ir'],
  alu: ['alua', 'alub', 'alu', 'sb'],
};
/** Zoom (home width / view width) at which every named label is shown. */
export const LABEL_ZOOM = 3;

const state = {
  m: null,
  sch: null,
  pos: null,
  bounds: null,
  home: null,
  view: null,
  mode: 'full',
  only: false,
  watch: DEFAULT_WATCH.slice(),
  program: 0,
  // The drawing.
  nodeEl: new Map(),      // node -> circle
  labelEl: new Map(),     // node -> text
  edges: [],              // {a, b, kind, el, control}
  edgesByNode: new Map(), // node -> [edge index]
  edgesByControl: new Map(),
  watchEls: [],           // per stem: {stem, nodes, line, labels}
  // The chip, as last painted.
  levels: null,
  prevLevels: null,
  changed: [],
  prevChanged: [],
  wasSet: new Set(),
  fired: new Set(),       // edge indices marked this paint
  toggled: new Set(),
  lastPaintH: -1,
  spanned: 1,             // half-cycles between the previous paint and this one
  regs: null,
  prevRegs: null,
  fetches: new Map(),     // addr -> times fetched (observed)
  fetchLog: [],           // [{h, addr}] so a rewind can un-count
  lastFetchSeen: -1,
  rows: new Map(),        // addr -> listing row
  picked: null,
  raf: 0,
};

// ---------------------------------------------------------------------------
// The chip
// ---------------------------------------------------------------------------

function loadProgram(index) {
  const m = state.m;
  const prog = PROGRAMS[index] || PROGRAMS[0];
  state.program = PROGRAMS[index] ? index : 0;
  m.powerCycle();
  m.load(LOAD_ADDR, new Uint8Array(prog.bytes));
  m.setResetVector(LOAD_ADDR);
  m.powerCycle();
  state.prevLevels = null;
  state.levels = null;
  state.prevRegs = null;
  state.fetches = new Map();
  state.fetchLog = [];
  state.lastFetchSeen = -1;
  state.lastPaintH = -1;
  buildListing(prog);
  // The chip comes out of the power cycle on its first opcode fetch, so that
  // one is counted too, or the first instruction of every program reads as
  // never having run.
  observeFetch();
}

function readRegs() {
  const m = state.m;
  return {
    h: m.halfCycle(), ph: m.phase(), clk0: m.clk0() ? 1 : 0, sync: m.sync() ? 1 : 0,
    t: m.timingStates() || 'none', ab: m.addressBus(), db: m.dataBus(), rw: m.isRead() ? 'R' : 'W',
    pc: m.pc(), a: m.a(), x: m.x(), y: m.y(), s: m.s(), p: m.p(), ir: m.ir(),
    flags: m.flagsString(), fetch: m.lastFetchAddr(), op: m.lastFetchOpcode(),
  };
}

/** Note an opcode fetch if this instant is one, so the listing can count it. */
function observeFetch() {
  const m = state.m;
  if (!m.sync() || m.clk0()) return;
  const key = m.halfCycle();
  if (key === state.lastFetchSeen) return;
  state.lastFetchSeen = key;
  const at = m.lastFetchAddr();
  state.fetches.set(at, (state.fetches.get(at) || 0) + 1);
  state.fetchLog.push({ h: key, addr: at });
}

/** Forget the fetches past the chip's current half-cycle, after a rewind. */
function forgetFetchesAfter(h) {
  const log = state.fetchLog;
  while (log.length && log[log.length - 1].h > h) {
    const { addr } = log.pop();
    const n = (state.fetches.get(addr) || 0) - 1;
    if (n > 0) state.fetches.set(addr, n); else state.fetches.delete(addr);
  }
  state.lastFetchSeen = log.length ? log[log.length - 1].h : -1;
}

/**
 * Advance `n` half-cycles, watching every fetch. One call per half-cycle
 * rather than runHalfCycles(n): the four readouts a fetch check costs are
 * nothing beside the settle, and a listing that counted fetches only at slow
 * clocks would go quietly wrong at fast ones.
 */
function advance(n) {
  const m = state.m;
  for (let i = 0; i < n; i++) { m.halfStep(); observeFetch(); }
}

// ---------------------------------------------------------------------------
// The drawing: every node, every edge, at the die's own coordinates
// ---------------------------------------------------------------------------

function buildGraph() {
  const { sch, pos } = state;
  const rails = new Set([sch.vss, sch.vcc]);
  const named = (i) => !!sch.names[i];
  const keep = (i) => pos.has(i) && !rails.has(i) && (state.mode === 'full' || named(i));

  const edges = [];
  const seen = new Set();
  const push = (a, b, kind, control) => {
    if (a === b || !keep(a) || !keep(b)) return;
    const key = a < b ? `${a}:${b}:${kind}` : `${b}:${a}:${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ a, b, kind, control, out: kind === 'gate' ? b : -1 });
  };
  for (const [out, , , legs] of sch.gates) {
    for (const i of new Set(legs.flat())) push(i, out, 'gate', -1);
  }
  for (const [control, a, b] of sch.switches) push(a, b, 'switch', control);

  const nodes = new Set();
  for (const e of edges) { nodes.add(e.a); nodes.add(e.b); }
  return { nodes: [...nodes], edges };
}

function draw() {
  const svg = $('tc-svg');
  svg.replaceChildren();
  state.nodeEl = new Map();
  state.labelEl = new Map();
  state.edgesByNode = new Map();
  state.edgesByControl = new Map();
  state.wasSet = new Set();
  state.fired = new Set();
  state.toggled = new Set();
  state.prevChanged = [];
  state.changed = [];

  const g = buildGraph();
  const { pos, sch } = state;
  state.edges = g.edges;

  const cam = el('g', { class: 'tc-cam' + (state.only ? ' only' : ''), id: 'tc-cam' }, svg);
  const wires = el('g', { class: 'tc-wires' }, cam);
  g.edges.forEach((e, i) => {
    const p = pos.get(e.a), q = pos.get(e.b);
    e.el = el('line', { x1: p.x, y1: p.y, x2: q.x, y2: q.y, class: `tc-e tc-e-${e.kind}` }, wires);
    for (const n of [e.a, e.b]) {
      if (!state.edgesByNode.has(n)) state.edgesByNode.set(n, []);
      state.edgesByNode.get(n).push(i);
    }
    if (e.kind === 'switch') {
      if (!state.edgesByControl.has(e.control)) state.edgesByControl.set(e.control, []);
      state.edgesByControl.get(e.control).push(i);
    }
  });
  const buses = el('g', { class: 'tc-buses' }, cam);
  const dots = el('g', { class: 'tc-nodes' }, cam);
  const labels = el('g', { class: 'tc-labels' }, cam);
  for (const nd of g.nodes) {
    const p = pos.get(nd);
    const c = el('circle', { cx: p.x, cy: p.y, r: sch.names[nd] ? 26 : 16,
                             class: 'tc-n' + (sch.names[nd] ? ' tc-named' : ''),
                             'data-node': nd }, dots);
    c.style.fill = blockCss(sch.nodeBlock[nd] & 0x7f);
    state.nodeEl.set(nd, c);
    if (sch.names[nd]) {
      const t = el('text', { x: p.x + 34, y: p.y - 30, class: 'tc-lb', 'data-node': nd }, labels);
      t.textContent = sch.names[nd];
      state.labelEl.set(nd, t);
    }
  }
  drawWatch(buses);
  paintZoomClass();

  const sw = g.edges.filter((e) => e.kind === 'switch').length;
  $('tc-caption').textContent =
    `${g.nodes.length} nodes and ${g.edges.length} edges at their own die coordinates, `
    + `${sw} of them pass transistors and the rest a gate input reaching its output. `
    + (state.mode === 'full' ? 'Every node, including the gate outputs nobody named. '
                             : 'Named signals only. ')
    + 'A ring is a node that changed level at this half-cycle, a fainter ring one that '
    + 'changed at the previous one; a bright line is a switch conducting, a flashed line '
    + 'a gate whose output moved.';
}

/** The stems being watched, as a polyline through their bits, and labels per bit. */
function drawWatch(buses) {
  const { pos, byName } = state;
  state.watchEls = [];
  buses.replaceChildren();
  for (const stem of state.watch) {
    const nodes = [];
    for (let b = 0; b < 16; b++) {
      const n = byName.get(`${stem}${b}`);
      nodes.push(n === undefined ? null : n);
    }
    while (nodes.length && nodes[nodes.length - 1] === null) nodes.pop();
    if (!nodes.some((n) => n !== null)) { state.watchEls.push({ stem, nodes: [], line: null }); continue; }
    const pts = nodes.filter((n) => n !== null && pos.has(n)).map((n) => pos.get(n));
    const line = el('polyline', { points: pts.map((p) => `${p.x},${p.y}`).join(' '),
                                  class: 'tc-bus', 'data-stem': stem }, buses);
    // Every bit of a watched stem carries its label whatever the zoom, and the
    // dot is ringed in the watch colour so the latch reads as one thing.
    nodes.forEach((n, b) => {
      if (n === null) return;
      const c = state.nodeEl.get(n);
      if (c) c.classList.add('wt');
      state.labelEl.get(n)?.classList.add('wt');
    });
    state.watchEls.push({ stem, nodes, line });
  }
}

// ---------------------------------------------------------------------------
// The camera: a viewBox and nothing else, as the die graph has it
// ---------------------------------------------------------------------------

function setView(v) {
  state.view = v;
  $('tc-svg').setAttribute('viewBox', v.join(' '));
  $('tc-zoom').textContent = `${zoom().toFixed(1)}×`;
  paintZoomClass();
}
function zoom() { return state.home[2] / state.view[2]; }
function paintZoomClass() {
  const cam = $('tc-cam');
  if (cam) cam.classList.toggle('z-labels', zoom() >= LABEL_ZOOM);
}
function zoomAt(factor, cx, cy) {
  const [x, y, w, hh] = state.view;
  const nw = Math.max(120, Math.min(state.home[2] * 4, w * factor));
  const nh = nw * (hh / w);
  setView([x + (cx - x) * (1 - nw / w), y + (cy - y) * (1 - nh / hh), nw, nh]);
}
function atClient(e) {
  const r = $('tc-svg').getBoundingClientRect();
  const [x, y, w, hh] = state.view;
  return { x: x + ((e.clientX - r.left) / r.width) * w, y: y + ((e.clientY - r.top) / r.height) * hh };
}
/** Fly to a set of nodes: the smallest view that holds them, never tighter than a floor. */
function frameNodes(nodes) {
  const pts = nodes.filter((n) => state.pos.has(n)).map((n) => state.pos.get(n));
  if (!pts.length) return;
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const p of pts) { xmin = Math.min(xmin, p.x); xmax = Math.max(xmax, p.x); ymin = Math.min(ymin, p.y); ymax = Math.max(ymax, p.y); }
  const cx = (xmin + xmax) / 2, cy = (ymin + ymax) / 2;
  const aspect = state.home[3] / state.home[2];
  let w = Math.max(900, (xmax - xmin) * 1.6, ((ymax - ymin) * 1.6) / aspect);
  w = Math.min(w, state.home[2]);
  const hh = w * aspect;
  setView([cx - w / 2, cy - hh / 2, w, hh]);
}

// ---------------------------------------------------------------------------
// Painting the chip into the drawing
// ---------------------------------------------------------------------------

/** Read the chip and repaint everything: the drawing, the tracer, the lists. */
function paint() {
  const m = state.m;
  const { sch } = state;
  const levels = m.nodeLevels();
  const prev = state.levels;
  const regs = readRegs();
  state.spanned = state.lastPaintH < 0 ? 0 : regs.h - state.lastPaintH;
  state.lastPaintH = regs.h;

  // What changed since the last paint. Rails are definitions and never move.
  const changed = [];
  if (prev) {
    for (let i = 0; i < levels.length; i++) {
      if (levels[i] !== prev[i] && i !== sch.vss && i !== sch.vcc) changed.push(i);
    }
  }
  const chgSet = new Set(changed);

  // Rings: this half-cycle's on `changed`, the previous one's on `was`.
  for (const n of state.wasSet) state.nodeEl.get(n)?.classList.remove('was');
  const was = new Set(state.changed.filter((n) => !chgSet.has(n)));
  for (const n of state.changed) {
    state.nodeEl.get(n)?.classList.remove('chg');
    state.labelEl.get(n)?.classList.remove('chg');
  }
  for (const n of was) state.nodeEl.get(n)?.classList.add('was');
  for (const n of changed) {
    const c = state.nodeEl.get(n);
    if (c) { c.classList.add('chg'); c.classList.remove('was'); }
    state.labelEl.get(n)?.classList.add('chg');
  }
  state.wasSet = was;

  // Levels: only the nodes that moved need their fill class touched. On the
  // first paint every node does.
  const touch = prev ? changed : [...state.nodeEl.keys()];
  for (const n of touch) state.nodeEl.get(n)?.classList.toggle('hi', levels[n] > 0);

  // Edges. A gate edge fires when its output moved; a switch edge is on while
  // its control is high and toggled when the control just moved.
  for (const i of state.fired) state.edges[i].el.classList.remove('fired');
  for (const i of state.toggled) state.edges[i].el.classList.remove('tog');
  const fired = new Set(), toggled = new Set();
  let opened = 0, closed = 0;
  const controlsTouched = prev ? changed : [...state.edgesByControl.keys()];
  for (const n of controlsTouched) {
    const idx = state.edgesByControl.get(n);
    if (!idx) continue;
    const on = levels[n] > 0;
    for (const i of idx) {
      state.edges[i].el.classList.toggle('on', on);
      if (prev) { toggled.add(i); state.edges[i].el.classList.add('tog'); }
    }
    if (prev) { if (on) opened++; else closed++; }
  }
  for (const n of changed) {
    for (const i of state.edgesByNode.get(n) || []) {
      const e = state.edges[i];
      if (e.kind === 'gate' && e.out === n) { fired.add(i); e.el.classList.add('fired'); }
    }
  }
  state.fired = fired;
  state.toggled = toggled;

  state.prevLevels = prev;
  state.levels = levels;
  state.prevChanged = state.changed;
  state.changed = changed;
  state.prevRegs = state.regs;
  state.regs = regs;
  state.opened = opened;
  state.closed = closed;

  paintHead();
  paintRegs();
  paintWatch();
  paintListing();
  paintMoved();
  paintPicked();
}

function paintHead() {
  const r = state.regs;
  const cyc = Math.floor(r.h / 2);
  const span = state.spanned > 1 ? ` <span class="tc-span">${state.spanned} half-cycles since the last frame</span>` : '';
  $('tc-head').innerHTML =
    `<b>half-cycle ${r.h}</b> <span class="tc-sep">·</span> cycle ${cyc} `
    + `<b>φ${r.ph}</b> <span class="tc-sep">·</span> <span class="mono">${r.t}</span> `
    + `<span class="tc-sep">·</span> SYNC <b>${r.sync}</b> `
    + `<span class="tc-sep">·</span> AB <b class="mono">$${hex4(r.ab)}</b> `
    + `DB <b class="mono">$${hex2(r.db)}</b> <b>${r.rw === 'R' ? 'read' : 'write'}</b>${span}`;
}

const REGS = [['pc', 'PC', 4], ['a', 'A', 2], ['x', 'X', 2], ['y', 'Y', 2], ['s', 'S', 2], ['p', 'P', 2], ['ir', 'IR', 2]];
function paintRegs() {
  const host = $('tc-regs');
  if (!host.childElementCount) {
    for (const [k, label] of REGS) {
      const d = h('div', { class: 'tc-reg', 'data-reg': k }, host);
      h('span', { class: 'tc-reg-k', text: label }, d);
      h('span', { class: 'tc-reg-v mono' }, d);
    }
    const d = h('div', { class: 'tc-reg tc-reg-flags', 'data-reg': 'flags' }, host);
    h('span', { class: 'tc-reg-k', text: 'flags' }, d);
    h('span', { class: 'tc-reg-v mono' }, d);
  }
  const r = state.regs, p = state.prevRegs;
  for (const [k, , w] of REGS) {
    const d = host.querySelector(`[data-reg="${k}"]`);
    const v = '$' + (w === 4 ? hex4(r[k]) : hex2(r[k]));
    const vs = d.querySelector('.tc-reg-v');
    if (vs.textContent !== v) vs.textContent = v;
    d.classList.toggle('moved', !!p && p[k] !== r[k]);
  }
  const f = host.querySelector('[data-reg="flags"]');
  const fv = f.querySelector('.tc-reg-v');
  if (fv.textContent !== r.flags) fv.textContent = r.flags;
  f.classList.toggle('moved', !!p && p.flags !== r.flags);
}

/** Each watched stem as bits, high bit first, with the bits that moved marked. */
function paintWatch() {
  const host = $('tc-watch');
  const L = state.levels, P = state.prevLevels;
  const rows = [];
  for (const w of state.watchEls) {
    if (!w.nodes.length) {
      rows.push(`<div class="tc-w tc-w-none"><span class="tc-w-k mono">${w.stem}</span><span class="tc-w-note">no such stem on the die</span></div>`);
      continue;
    }
    let v = 0, bits = '';
    for (let b = w.nodes.length - 1; b >= 0; b--) {
      const n = w.nodes[b];
      if (n === null) { bits += '<i class="none" title="no storage node">·</i>'; continue; }
      const on = L[n] > 0;
      if (on) v |= 1 << b;
      const moved = P && P[n] !== L[n];
      bits += `<i class="${on ? 'on' : ''}${moved ? ' moved' : ''}" title="${w.stem}${b}: node ${n}">${on ? 1 : 0}</i>`;
    }
    const width = w.nodes.length > 8 ? 4 : 2;
    rows.push(`<button type="button" class="tc-w" data-stem="${w.stem}" title="fly to ${w.stem}">`
      + `<span class="tc-w-k mono">${w.stem}</span><span class="tc-lamps">${bits}</span>`
      + `<span class="tc-w-v mono">$${v.toString(16).padStart(width, '0').toUpperCase()}</span></button>`);
  }
  const html = rows.join('');
  if (host.dataset.html !== html) { host.innerHTML = html; host.dataset.html = html; }
}

function buildListing(prog) {
  const host = $('tc-code');
  host.replaceChildren();
  state.rows = new Map();
  h('div', { class: 'tc-code-title', text: prog.name }, host);
  for (const ln of prog.asm.lines) {
    const blank = !ln.mnemonic && !ln.directive && !ln.label && !ln.comment;
    if (blank) continue;
    const row = h('div', { class: 'tc-row' + (ln.mnemonic ? ' has-op' : '') }, host);
    h('span', { class: 'tc-c-n mono' }, row);
    h('span', { class: 'tc-c-addr mono', text: ln.bytes && ln.bytes.length ? `$${hex4(ln.addr)}` : '' }, row);
    h('span', { class: 'tc-c-bytes mono', text: (ln.bytes || []).map(hex2).join(' ') }, row);
    h('span', { class: 'tc-c-src', text: ln.text.replace(/\s+$/, '') || ' ' }, row);
    if (ln.mnemonic) { row.dataset.addr = ln.addr; state.rows.set(ln.addr, row); }
  }
}

function paintListing() {
  const at = state.regs.fetch;
  for (const [addr, row] of state.rows) {
    const cur = addr === at;
    if (row.classList.contains('cur') !== cur) {
      row.classList.toggle('cur', cur);
      // Scroll the code box, never the document: scrollIntoView scrolls every
      // ancestor, and on load that dragged the whole page down to the listing.
      if (cur) {
        const box = row.parentElement;
        const top = row.offsetTop - box.offsetTop;
        if (top < box.scrollTop || top + row.offsetHeight > box.scrollTop + box.clientHeight) {
          box.scrollTop = Math.max(0, top - box.clientHeight / 2);
        }
      }
    }
    const n = state.fetches.get(addr) || 0;
    const c = row.firstChild;
    const txt = n ? String(n) : '';
    if (c.textContent !== txt) c.textContent = txt;
  }
}

/** Everything that moved, grouped by block. Named nodes are pills, unnamed a count. */
function paintMoved() {
  const { sch } = state;
  const L = state.levels;
  const groups = new Map();
  let named = 0;
  for (const n of state.changed) {
    const b = sch.blockNames[sch.nodeBlock[n] & 0x7f] || 'unclassified';
    if (!groups.has(b)) groups.set(b, { named: [], unnamed: 0 });
    if (sch.names[n]) { groups.get(b).named.push(n); named++; } else groups.get(b).unnamed++;
  }
  $('tc-moved-sum').textContent = state.prevLevels
    ? `${state.changed.length} nodes changed level (${named} named) · ${state.opened} switch controls went high, ${state.closed} went low`
    : 'Power-on state: nothing has moved yet. Step to see the first half-cycle.';
  const parts = [];
  for (const [b, g] of [...groups.entries()].sort((x, y) => (y[1].named.length + y[1].unnamed) - (x[1].named.length + x[1].unnamed))) {
    const pills = g.named
      .sort((x, y) => sch.names[x].localeCompare(sch.names[y], undefined, { numeric: true }))
      .map((n) => `<button type="button" class="tc-node ${L[n] ? 'up' : 'down'}" data-node="${n}">${sch.names[n]}<i>${L[n] ? '▲' : '▼'}</i></button>`)
      .join('');
    const un = g.unnamed ? `<span class="tc-node tc-unnamed">${g.unnamed} unnamed</span>` : '';
    parts.push(`<div class="tc-blk"><h4>${b} <span>${g.named.length + g.unnamed}</span></h4><p>${pills}${un}</p></div>`);
  }
  const html = parts.join('');
  const host = $('tc-moved');
  if (host.dataset.html !== html) { host.innerHTML = html; host.dataset.html = html; }
}

function paintPicked() {
  const box = $('tc-picked');
  const n = state.picked;
  for (const c of $('tc-svg').querySelectorAll('.tc-n.on-pick')) c.classList.remove('on-pick');
  if (n == null) { box.textContent = 'Click a node in the drawing, or a name in the list.'; return; }
  state.nodeEl.get(n)?.classList.add('on-pick');
  const name = state.sch.names[n] || `unnamed node ${n}`;
  const block = state.sch.blockNames[state.sch.nodeBlock[n] & 0x7f];
  const lvl = state.levels ? (state.levels[n] > 0 ? 'high' : 'low') : '';
  const fan = state.edgesByNode.get(n)?.length || 0;
  box.textContent = `${name} · ${block} · ${lvl} · ${fan} edge${fan === 1 ? '' : 's'} drawn`;
}

function pick(n, fly = false) {
  state.picked = n;
  paintPicked();
  if (fly && n != null) frameNodes([n]);
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function setMode(m) {
  state.mode = m;
  for (const b of document.querySelectorAll('[data-mode]')) b.classList.toggle('on', b.dataset.mode === m);
  draw();
  state.levels = null;
  paint();
}

function setOnly(on) {
  state.only = on;
  $('tc-only').setAttribute('aria-pressed', on ? 'true' : 'false');
  $('tc-only').textContent = on ? 'showing only what moved' : 'show only what moved';
  $('tc-cam')?.classList.toggle('only', on);
}

/** Set the watch list from words; unknown stems stay listed and say so. */
function setWatch(stems) {
  const clean = [];
  for (const s of stems) {
    const w = String(s).trim().toLowerCase();
    if (w && !clean.includes(w)) clean.push(w);
  }
  state.watch = clean;
  $('tc-watch-input').value = clean.join(' ');
  // Un-mark what was watched, then mark the new set.
  for (const c of $('tc-svg').querySelectorAll('.tc-n.wt')) c.classList.remove('wt');
  for (const t of $('tc-svg').querySelectorAll('.tc-lb.wt')) t.classList.remove('wt');
  drawWatch($('tc-svg').querySelector('.tc-buses'));
  if (state.levels) paintWatch();
}

function stepOnce() { advance(1); paint(); }
function stepBack() { state.m.stepBack(); forgetFetchesAfter(state.m.halfCycle()); paint(); }

function tick(now) {
  state.raf = requestAnimationFrame(tick);
  const n = halfCyclesFor(now);
  if (n > 0) advance(n);
  if (state.m.halfCycle() !== state.lastPaintH) paint();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  const status = $('tc-status');
  try {
    const [, sch, buf] = await Promise.all([
      init(),
      fetch('schematic.json').then((r) => { if (!r.ok) throw new Error(`schematic.json: HTTP ${r.status}`); return r.json(); }),
      fetch('layout.bin').then((r) => { if (!r.ok) throw new Error(`layout.bin: HTTP ${r.status}`); return r.arrayBuffer(); }),
    ]);
    state.sch = sch;
    state.byName = new Map(sch.names.map((n, i) => [n, i]).filter(([n]) => n));
    const c = centroids(buf);
    state.pos = c.pos;
    state.bounds = c.bounds;
    const pad = 220;
    state.home = [c.bounds.xmin - pad, c.bounds.ymin - pad,
                  (c.bounds.xmax - c.bounds.xmin) + pad * 2, (c.bounds.ymax - c.bounds.ymin) + pad * 2];
    state.view = state.home.slice();
    state.m = new Machine();

    const q = new URLSearchParams(location.search);
    if (q.get('mode') === 'named') state.mode = 'named';
    if (q.has('watch')) state.watch = q.get('watch').split(/[\s,]+/).filter(Boolean);
    $('tc-watch-input').value = state.watch.join(' ');
    for (const b of document.querySelectorAll('[data-mode]')) b.classList.toggle('on', b.dataset.mode === state.mode);

    // Program: the URL first, then the site-wide choice, as everywhere.
    const select = $('tc-program');
    PROGRAMS.forEach((p, i) => select.add(new Option(p.name, String(i))));
    const choose = (index, { fromNav = false } = {}) => {
      select.value = String(index);
      setSelectedProgram(index);
      if (!fromNav && state.nav) state.nav.set(index);
      loadProgram(index);
      paint();
    };
    state.choose = choose;
    select.onchange = () => choose(Number(select.value));
    state.nav = setupProgramNav({ onChange: (i) => choose(i, { fromNav: true }) });
    const chosen = selectedProgram(location.search);
    select.value = String(chosen);
    if (state.nav) state.nav.set(chosen);
    loadProgram(chosen);

    // The header owns run/pause, the step, the power cycle and the rate; the
    // console's buttons are a second view of the same store.
    setupChipNav({
      step: () => stepOnce(),
      back: () => stepBack(),
      reset: () => { loadProgram(Number(select.value)); paint(); },
      halfCycle: () => state.m.halfCycle(),
    });
    $('tc-run').onclick = () => toggleRunning();
    $('tc-step').onclick = () => stepChip();
    $('tc-back').onclick = () => { setRunning(false); stepBack(); };
    $('tc-cycle').onclick = () => { setRunning(false); advance(2); paint(); };
    $('tc-reset').onclick = () => resetChip();
    const speed = $('tc-speed');
    for (const ck of CLOCKS) speed.add(new Option(ck.label, String(ck.hz)));
    speed.onchange = () => setClock(Number(speed.value));
    subscribe(() => {
      const on = isRunning();
      $('tc-run').textContent = on ? 'Pause' : 'Run';
      $('tc-run').classList.toggle('btn-primary', !on);
      const hz = String(clockHz());
      if (speed.value !== hz) speed.value = hz;
    });

    // The drawing.
    $('tc-boot').hidden = true;
    $('tc-main').hidden = false;
    setView(state.home.slice());
    draw();
    paint();

    for (const b of document.querySelectorAll('[data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));
    $('tc-only').addEventListener('click', () => setOnly(!state.only));
    if (q.get('only') === '1') setOnly(true);
    $('tc-home').addEventListener('click', () => { setView(state.home.slice()); });

    // Fullscreen, as the workbench has it: the console covers the viewport and
    // the drawing takes the height, with the side panel beside it unless it is
    // put away. The same helper as the schematic, so a phone gets the same
    // fallback and Escape leaves the same way. The viewBox does the rest: the
    // drawing scales into whatever box it is given.
    const console_ = document.querySelector('#bench .console');
    setupFullscreen(console_, $('tc-fullscreen'), () => {
      state.full = console_.classList.contains('immersive');
    });
    const paintPanel = () => {
      const on = !console_.classList.contains('tc-nopanel');
      $('tc-panel').setAttribute('aria-pressed', on ? 'true' : 'false');
      $('tc-panel').title = on ? 'Hide the side panel' : 'Show the side panel';
    };
    $('tc-panel').addEventListener('click', () => { console_.classList.toggle('tc-nopanel'); paintPanel(); });
    paintPanel();
    // ?full=1 goes through the button rather than the API: a page load carries
    // no user activation, so a real request would be refused, and the button's
    // own fallback covers the viewport anyway.
    if (q.get('full') === '1') $('tc-fullscreen').click();
    $('tc-in').addEventListener('click', () => { const [x, y, w, hh] = state.view; zoomAt(1 / 1.6, x + w / 2, y + hh / 2); });
    $('tc-out').addEventListener('click', () => { const [x, y, w, hh] = state.view; zoomAt(1.6, x + w / 2, y + hh / 2); });
    $('tc-watch-input').addEventListener('change', () => setWatch($('tc-watch-input').value.split(/[\s,]+/)));
    for (const b of document.querySelectorAll('[data-preset]')) {
      b.addEventListener('click', () => setWatch(PRESETS[b.dataset.preset]));
    }
    $('tc-watch').addEventListener('click', (e) => {
      const b = e.target.closest('[data-stem]');
      if (!b) return;
      const w = state.watchEls.find((x) => x.stem === b.dataset.stem);
      if (w) frameNodes(w.nodes.filter((n) => n !== null));
    });
    $('tc-moved').addEventListener('click', (e) => {
      const b = e.target.closest('[data-node]');
      if (b) pick(Number(b.dataset.node), true);
    });

    const svg = $('tc-svg');
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = atClient(e);
      zoomAt(e.deltaY > 0 ? 1.18 : 1 / 1.18, p.x, p.y);
    }, { passive: false });
    let from = null, moved = 0;
    svg.addEventListener('pointerdown', (e) => { from = atClient(e); moved = 0; });
    svg.addEventListener('pointermove', (e) => {
      if (!from) return;
      const p = atClient(e);
      moved += Math.abs(p.x - from.x) + Math.abs(p.y - from.y);
      const [, , w, hh] = state.view;
      setView([state.view[0] - (p.x - from.x), state.view[1] - (p.y - from.y), w, hh]);
    });
    const release = () => { from = null; };
    svg.addEventListener('pointerup', release);
    svg.addEventListener('pointerleave', release);
    svg.addEventListener('click', (e) => {
      if (moved > 60) return;
      const t = e.target.closest('.tc-n');
      pick(t ? Number(t.dataset.node) : null);
    });

    document.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t && t.closest && t.closest('input, select, textarea')) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); stepChip(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setRunning(false); stepBack(); }
      else if (e.key === ' ') { e.preventDefault(); toggleRunning(); }
    });

    // Deep links: ?step=N runs to half-cycle N; ?run=1 starts the clock.
    // Land showing what the LAST half-cycle changed, not everything since
    // power-on: run to one before, take a reading, then take the step.
    const stepTo = Number(q.get('step') || 0);
    if (stepTo > 0) { advance(stepTo - 1); paint(); advance(1); paint(); }
    // ?fly=STEM frames the drawing on a watched stem, which is also the only
    // way to photograph a zoomed view headlessly.
    if (q.has('fly')) {
      const w = state.watchEls.find((x) => x.stem === q.get('fly').toLowerCase());
      if (w) frameNodes(w.nodes.filter((n) => n !== null));
    }
    if (q.get('run') === '1') setRunning(true);
    tick();
    $('tc-stats').textContent =
      `${state.nodeEl.size} nodes drawn · ${state.edges.length} edges · ${sch.counts.transistors} transistors · `
      + 'positions read off the polygons, levels read off the chip';
  } catch (e) {
    status.textContent = 'Could not start: ' + (e && e.message ? e.message : e);
    status.classList.add('error');
    throw e;
  }
}

window.__tracer = { state, paint, stepOnce, stepBack, advance, setMode, setOnly, setWatch, frameNodes, pick, loadProgram };
boot();
