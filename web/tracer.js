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
import { blockRegions, loopsToPath, inRegion, gridCells } from './block-regions.js';
import { SLUGS } from './block-notes.js';
import { hex2, hex4 } from './demos.js';
import { setupFullscreen } from './fullscreen.js';
import { createPalette } from './solo-palette.js';

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
// A block's region is everything within REGION_R die units of one of its
// member nodes, evaluated on a REGION_CELL grid (block-regions.js). 300 is
// about three times the median spacing between neighbours inside a datapath
// block, measured: the program counter then comes out as one piece, the
// registers as two, and the timing chain, whose 25 nodes are genuinely spread
// across the control side, as a dozen. Both numbers are printed in the caption.
export const REGION_R = 300;
export const REGION_CELL = 50;
// A bus or latch is every stem the die names bit by bit: letters only (so no
// `#`, `~` or ALU product like `(AxB)`), not a `not…` complement, with bit 0
// named and at least seven of bits 0..7 (seven rather than eight for exactly
// one reason: `p` has no bit 5). Its region is everything within STEM_R of one
// of its bits; bits sit about 400 die units apart down the datapath, so 220
// joins a byte into one capsule and keeps neighbouring columns apart where
// they are apart (which, for alua and alub, 28 units from each other, they
// are not, and the capsules say so).
export const STEM_R = 220;

const state = {
  m: null,
  sch: null,
  pre: null,        // dynamic gate output -> the node gating its pull-up transistor
  pos: null,
  bounds: null,
  home: null,
  view: null,
  mode: 'full',
  only: false,
  regions: true,    // draw the block regions behind the graph
  regionData: null, // block -> {loops, cells, pieces, label, members}, computed once
  regionStats: null,
  block: null,      // the selected functional block, or null
  stem: null,       // the selected bus or latch (a stem), or null
  stems: null,      // [{stem, nodes}] the buses and latches, derived from the names
  stemRegionData: null,
  stemRegions: true,
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
  solo: false,             // the study view (fullscreen) is on
  dragged: false,          // the last press became a pan, so its click picks nothing
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
  // The precharged (dynamic) gate outputs, by their kind in schematic.json:
  // a clocked transistor pulls them to vcc and the pulldown network discharges
  // them or leaves them holding charge. They are drawn with a dashed outline,
  // because a static gate output and a charge-holding node are two different
  // kinds of thing that otherwise look identical on the page.
  // `pre` maps each to the node gating the transistor that pulls it up: a
  // clock for the precharged ones (cclk, or an unnamed clock), and for the 24
  // address and data pads the data itself, because there the same shape is the
  // pull-up half of a push-pull output driver. The page reports which node it
  // was rather than deciding which reading applies.
  const pre = new Map();
  const dyn = sch.kinds.indexOf('dynamic');
  for (const [out, kind, up, legs] of sch.gates) {
    if (kind === dyn) pre.set(out, up);
    for (const i of new Set(legs.flat())) push(i, out, 'gate', -1);
  }
  for (const [control, a, b] of sch.switches) push(a, b, 'switch', control);

  const nodes = new Set();
  for (const e of edges) { nodes.add(e.a); nodes.add(e.b); }
  state.pre = pre;
  return { nodes: [...nodes], edges };
}

/**
 * The functional blocks as regions on the die, behind the graph.
 *
 * Computed once from the centroids and `nodeBlock`, because neither changes:
 * the region is a fact about the die, not about which nodes the current mode
 * draws. Twelve blocks, ids 1..12 in blocks.json order; the unclassified
 * residue (0) and the static logic (13) are the background the blocks sit in
 * and get no region. The pads come out as the ring they are.
 */
function regionData() {
  if (state.regionData) return state.regionData;
  const { sch, pos, bounds } = state;
  const blocks = [];
  for (let b = 1; b < sch.blockNames.length - 1; b++) blocks.push(b);
  const nb = sch.nodeBlock.map((v) => v & 0x7f);
  const rails = new Set([sch.vss, sch.vcc]);
  const posNoRails = new Map([...pos].filter(([n]) => !rails.has(n)));
  const data = blockRegions(posNoRails, nb, blocks, bounds, { radius: REGION_R, cell: REGION_CELL });
  // How much the regions overlap: functional-block nodes that also sit inside
  // another block's region. A fact worth printing, because it is the reason
  // these are regions and not hulls.
  let members = 0, shared = 0, pieces = 0;
  for (const [n, p] of posNoRails) {
    const b = nb[n];
    if (!data.has(b)) continue;
    members++;
    for (const [ob, r] of data) {
      if (ob !== b && inRegion(p, r.loops)) { shared++; break; }
    }
  }
  for (const r of data.values()) pieces += r.pieces;
  state.regionStats = { members, shared, pieces, blocks: data.size, grid: gridCells(bounds, { radius: REGION_R, cell: REGION_CELL }) };
  state.regionData = data;
  return data;
}

/** The buses and latches, by the rule above. Computed once from the names. */
function stemList() {
  if (state.stems) return state.stems;
  const { sch, byName } = state;
  const found = new Map();
  for (const nm of sch.names) {
    if (!nm) continue;
    const m = /^([A-Za-z]+)(\d{1,2})$/.exec(nm);
    if (!m || /^not/i.test(m[1])) continue;
    if (!found.has(m[1])) found.set(m[1], new Set());
    found.get(m[1]).add(Number(m[2]));
  }
  const out = [];
  for (const [stem, bits] of found) {
    if (!bits.has(0)) continue;
    let low = 0;
    for (let b = 0; b < 8; b++) if (bits.has(b)) low++;
    if (low < 7) continue;
    const nodes = [];
    for (let b = 0; b < 16; b++) { const n = byName.get(`${stem}${b}`); nodes.push(n === undefined ? null : n); }
    while (nodes.length && nodes[nodes.length - 1] === null) nodes.pop();
    out.push({ stem, nodes });
  }
  out.sort((a, b) => a.stem.localeCompare(b.stem));
  state.stems = out;
  return out;
}

function stemRegionData() {
  if (state.stemRegionData) return state.stemRegionData;
  const list = stemList();
  const { pos, bounds } = state;
  const idx = new Array(2048).fill(-1);
  list.forEach((s, i) => { for (const n of s.nodes) if (n !== null) idx[n] = i; });
  const data = blockRegions(pos, idx, list.map((_, i) => i), bounds, { radius: STEM_R, cell: REGION_CELL });
  const out = new Map();
  list.forEach((s, i) => out.set(s.stem, data.get(i)));
  state.stemRegionData = out;
  return out;
}

function drawStemRegions(g) {
  const data = stemRegionData();
  for (const [stem, r] of data) {
    const path = el('path', { d: loopsToPath(r.loops), class: 'tc-sg' + (state.stem === stem ? ' sel' : ''), 'fill-rule': 'evenodd',
                              'data-stem': stem }, g);
    path.setAttribute('aria-label', `${stem} region`);
    if (r.label) {
      // The name sits above the capsule's top, where it does not cover a bit.
      let top = Infinity, tx = r.label.x;
      for (const l of r.loops) for (const p of l) if (p.y < top) { top = p.y; tx = p.x; }
      const t = el('text', { x: tx, y: top - 30, class: 'tc-sg-lb' + (state.stem === stem ? ' sel' : ''), 'data-stem': stem }, g);
      t.textContent = stem;
    }
  }
  g.classList.toggle('off', !state.stemRegions);
}

/** Which bus or latch a die point is in: nearest bit among the capsules holding it. */
function stemAt(pt) {
  const data = stemRegionData();
  const { pos } = state;
  let best = null, bd = Infinity;
  for (const [stem, r] of data) {
    if (!inRegion(pt, r.loops)) continue;
    const s = stemList().find((x) => x.stem === stem);
    for (const n of s.nodes) {
      if (n === null || !pos.has(n)) continue;
      const p = pos.get(n);
      const d = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (d < bd) { bd = d; best = stem; }
    }
  }
  return best;
}

function drawRegions(g) {
  const data = regionData();
  const { sch } = state;
  for (const [b, r] of data) {
    const css = blockCss(b);
    const path = el('path', { d: loopsToPath(r.loops), class: 'tc-rg' + (state.block === b ? ' sel' : ''), 'fill-rule': 'evenodd',
                 'data-block': b, style: `--bc: ${css}` }, g);
    path.setAttribute('tabindex', '-1');
    path.setAttribute('aria-label', `${sch.blockNames[b]} region`);
    if (r.label) {
      const t = el('text', { x: r.label.x, y: r.label.y, class: 'tc-rg-lb', 'data-block': b, style: `--bc: ${css}` }, g);
      t.textContent = sch.blockNames[b];
    }
  }
  g.classList.toggle('off', !state.regions);
}

/**
 * Which block a die point belongs to, for a click on the regions.
 *
 * The regions overlap, so the path under the pointer is only the one drawn
 * last there. The rule that made the regions settles it instead: of the
 * blocks whose region contains the point, the one with the nearest member
 * node. Null when no region contains it.
 */
function blockAt(pt) {
  const data = regionData();
  const { sch, pos } = state;
  const nb = sch.nodeBlock;
  let best = null, bd = Infinity;
  for (const [b, r] of data) {
    if (!inRegion(pt, r.loops)) continue;
    for (const [n, p] of pos) {
      if ((nb[n] & 0x7f) !== b) continue;
      const d = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (d < bd) { bd = d; best = b; }
    }
  }
  return best;
}

/**
 * Select a functional block: its region brightens, the rest of the drawing
 * steps back, and the block card reports it. Null clears. Membership is
 * `nodeBlock`, so a node of the block is lit wherever it sits, and an edge
 * with either end in the block stays, because that edge is the block's
 * boundary.
 */
function selectBlock(b, { fly = false } = {}) {
  state.block = b;
  if (b !== null) state.stem = null;
  const { sch } = state;
  applySelection(b === null ? null : (n) => (sch.nodeBlock[n] & 0x7f) === b, fly);
}

/** Select a bus or latch: the same treatment, with the stem's bits as members. */
function selectStem(stem, { fly = false } = {}) {
  const s = stem === null ? null : stemList().find((x) => x.stem === stem);
  state.stem = s ? s.stem : null;
  if (s) state.block = null;
  const members = s ? new Set(s.nodes.filter((n) => n !== null)) : null;
  applySelection(members ? (n) => members.has(n) : null, fly);
}

/**
 * One selection, of either kind: the chosen region brightens, every node
 * outside it steps back, an edge with either end in it stays (it is the
 * boundary), the moved list marks it, and the card reports it.
 */
function applySelection(isMember, fly) {
  const on = isMember !== null;
  const cam = $('tc-cam');
  if (cam) cam.classList.toggle('has-sel', on);
  for (const p of document.querySelectorAll('#tc-regions .tc-rg, #tc-regions .tc-rg-lb')) {
    p.classList.toggle('sel', state.block !== null && Number(p.dataset.block) === state.block);
  }
  for (const p of document.querySelectorAll('#tc-stem-regions .tc-sg, #tc-stem-regions .tc-sg-lb')) {
    p.classList.toggle('sel', state.stem !== null && p.dataset.stem === state.stem);
  }
  for (const [n, c] of state.nodeEl) {
    const out = on && !isMember(n);
    c.classList.toggle('sel-out', out);
    state.labelEl.get(n)?.classList.toggle('sel-out', out);
  }
  for (const e of state.edges) e.el.classList.toggle('sel-out', on && !isMember(e.a) && !isMember(e.b));
  paintBlock();
  paintMoved();
  if (fly && on) {
    const members = [];
    for (const n of state.nodeEl.keys()) if (isMember(n)) members.push(n);
    frameNodes(members);
  }
}

function selectBlockBySlug(slug) {
  const { sch } = state;
  for (let b = 0; b < sch.blockNames.length; b++) {
    if (SLUGS[sch.blockNames[b]] === slug && regionData().has(b)) return selectBlock(b, { fly: true });
  }
}

/** The block card: what is selected, how much of it is drawn and moving. */
function paintBlock() {
  const box = $('tc-block');
  const b = state.block;
  if (b === null && state.stem !== null) { paintStemCard(box); return; }
  if (b === null) {
    const t = 'Click a region in the drawing to select a block, or a capsule to select a bus or latch; click it again to clear.';
    if (box.textContent !== t) box.textContent = t;
    return;
  }
  const { sch } = state;
  const r = regionData().get(b);
  let drawn = 0, moved = 0;
  for (const n of state.nodeEl.keys()) if ((sch.nodeBlock[n] & 0x7f) === b) drawn++;
  for (const n of state.changed) if ((sch.nodeBlock[n] & 0x7f) === b) moved++;
  const st = state.regionStats;
  const pct = st ? Math.round(100 * r.cells / st.grid) : 0;
  const slug = SLUGS[sch.blockNames[b]];
  const html = `<span class="tc-bk-name">${sch.blockNames[b]}</span> · ${r.members} nodes, ${drawn} drawn · `
    + `<span class="tc-bk-moved">${moved}</span> moved at this half-cycle · ${r.pieces} piece${r.pieces === 1 ? '' : 's'}, `
    + `${pct}% of the die`
    + (slug ? ` · <a href="block?b=${slug}">its page</a>` : '');
  if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
}

/** The card for a selected bus or latch: its byte now, the bits that moved. */
function paintStemCard(box) {
  const s = stemList().find((x) => x.stem === state.stem);
  const { sch } = state;
  const L = state.levels, P = state.prevLevels;
  let v = 0, moved = 0, present = 0;
  s.nodes.forEach((n, b) => {
    if (n === null) return;
    present++;
    if (L && L[n] > 0) v |= 1 << b;
    if (L && P && P[n] !== L[n]) moved++;
  });
  const width = s.nodes.length > 8 ? 4 : 2;
  const blocks = [...new Set(s.nodes.filter((n) => n !== null).map((n) => sch.blockNames[sch.nodeBlock[n] & 0x7f]))];
  const r = stemRegionData().get(s.stem);
  const watched = state.watch.includes(s.stem);
  const html = `<span class="tc-bk-name">${s.stem}</span> · ${present} bit${present === 1 ? '' : 's'}`
    + (s.nodes.length !== present ? ` of ${s.nodes.length}` : '')
    + ` · <span class="tc-bk-val">$${(L ? v : 0).toString(16).padStart(width, '0').toUpperCase()}</span>`
    + ` · <span class="tc-bk-moved">${moved}</span> bit${moved === 1 ? '' : 's'} moved at this half-cycle`
    + ` · ${r.pieces} piece${r.pieces === 1 ? '' : 's'} · filed under ${blocks.join(', ')}`
    + ` · <button type="button" class="tc-bk-watch" data-stem="${s.stem}">${watched ? 'unwatch' : 'watch'}</button>`;
  if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
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
  drawRegions(el('g', { class: 'tc-regions', id: 'tc-regions' }, cam));
  drawStemRegions(el('g', { class: 'tc-stem-regions', id: 'tc-stem-regions' }, cam));
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
                             class: 'tc-n' + (sch.names[nd] ? ' tc-named' : '') + (state.pre.has(nd) ? ' tc-pre' : ''),
                             'data-node': nd, 'data-block': sch.nodeBlock[nd] & 0x7f }, dots);
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
  if (state.block !== null) selectBlock(state.block);
  else if (state.stem !== null) selectStem(state.stem);

  const sw = g.edges.filter((e) => e.kind === 'switch').length;
  $('tc-caption').textContent =
    `${g.nodes.length} nodes and ${g.edges.length} edges at their own die coordinates, `
    + `${sw} of them pass transistors and the rest a gate input reaching its output. `
    + (state.mode === 'full' ? 'Every node, including the gate outputs nobody named. '
                             : 'Named signals only. ')
    + 'A ring is a node that changed level at this half-cycle, a fainter ring one that '
    + 'changed at the previous one; a bright line is a switch conducting, a flashed line '
    + 'a gate whose output moved. '
    + regionCaption();
}

function regionCaption() {
  const st = state.regionStats;
  if (!st) return '';
  const pct = Math.round(100 * st.shared / st.members);
  return `The tinted regions are the ${st.blocks} functional blocks, each drawn as everything `
    + `within ${REGION_R} die units of one of its nodes: ${st.pieces} pieces in all, and they `
    + `overlap, because ${st.shared} of the ${st.members} block nodes (${pct}%) sit inside `
    + 'another block\'s region too. A convex hull per block was measured first and rejected: '
    + 'the datapath blocks are interleaved bit-slices, and a hull claims the neighbour\'s silicon. '
    + stemCaption();
}

function stemCaption() {
  const data = state.stemRegionData;
  if (!data) return '';
  let pieces = 0;
  for (const r of data.values()) pieces += r.pieces;
  return `The outlined capsules are the ${data.size} buses and latches: every stem the die names `
    + `bit by bit, each drawn as everything within ${STEM_R} die units of one of its bits, `
    + `${pieces} pieces in all. Click one to select it.`;
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
/**
 * Pan and pinch. The camera is the viewBox, so a gesture holds one die point
 * under one screen point: the finger, or the midpoint of two. One pointer pans;
 * two pinch about their midpoint and pan by its movement. Same shape as the
 * schematic's camera, and the same two rules that each cost a round there:
 * pinch geometry has exactly one constructor (`pinchOf`), and the ratio is read
 * against the gesture's own start rather than accumulated per event, which
 * drifts. Move and release are watched on the window, so a finger that leaves
 * the stage mid-pan keeps panning, and because `setPointerCapture` would
 * retarget the click that picks a node. A press that became a drag leaves
 * `state.dragged` raised for that click to read.
 */
function setupCamera(stage, svg) {
  const live = new Map();     // pointerId -> {x, y} on screen
  let gesture = null;         // {c: die point held, w0: view width at start, d0: pinch spread at start}
  let travel = 0;
  const pinchOf = (a, b) => ({ d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 });
  const anchorOf = () => {
    const pts = [...live.values()];
    return pts.length >= 2 ? pinchOf(pts[0], pts[1]) : { cx: pts[0].x, cy: pts[0].y, d: 0 };
  };
  const dieAt = (cx, cy) => atClient({ clientX: cx, clientY: cy });
  // Put die point c under screen point (cx, cy) at view width nw.
  const place = (nw, c, cx, cy) => {
    const r = svg.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const w = Math.max(120, Math.min(state.home[2] * 4, nw));
    const hh = w * (state.view[3] / state.view[2]);
    const x = c.x - ((cx - r.left) / r.width) * w;
    const y = c.y - ((cy - r.top) / r.height) * hh;
    if (![x, y, w, hh].every(Number.isFinite)) return;
    setView([x, y, w, hh]);
  };
  const seed = () => {
    if (!live.size) { gesture = null; return; }
    const a = anchorOf();
    gesture = { c: dieAt(a.cx, a.cy), w0: state.view[2], d0: a.d };
  };
  stage.addEventListener('pointerdown', (e) => {
    // The console floats over the stage and has its own drag; a press on it
    // is never a pan.
    if (e.target.closest && e.target.closest('.solo-palette')) return;
    state.dragged = false;
    travel = 0;
    live.set(e.pointerId, { x: e.clientX, y: e.clientY });
    seed();
  });
  const onMove = (e) => {
    if (!live.has(e.pointerId) || !gesture) return;
    const from = live.get(e.pointerId);
    travel = Math.max(travel, Math.hypot(e.clientX - from.x, e.clientY - from.y));
    live.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const a = anchorOf();
    if (live.size >= 2 && gesture.d0 > 0 && a.d > 0) place(gesture.w0 * (gesture.d0 / a.d), gesture.c, a.cx, a.cy);
    else if (live.size === 1) place(state.view[2], gesture.c, a.cx, a.cy);
  };
  const onUp = (e) => {
    if (!live.delete(e.pointerId)) return;
    // A finger always moves a little: the slop that separates a tap from a
    // drag is larger for touch, or a tap on a node would never pick it.
    if (travel > (e.pointerType === 'mouse' ? 4 : 12)) state.dragged = true;
    // A finger lifting mid-pinch re-seeds from whatever is still down, so the
    // remaining one pans from where it is rather than jumping.
    seed();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
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
  paintBlock();
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
  // The console's own readout, in the drawer head, as the workbench has it.
  const out = $('tc-solo-clock');
  if (out) {
    const parts = [`½cyc ${r.h}`, `φ${r.ph}`, r.t || 'none'];
    if (r.sync) parts.push('sync');
    const text = parts.join(' · ');
    if (out.textContent !== text) out.textContent = text;
  }
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
    const selCls = state.block === null ? '' : (sch.blockNames[state.block] === b ? ' sel' : ' sel-out');
    parts.push(`<div class="tc-blk${selCls}"><h4>${b} <span>${g.named.length + g.unnamed}</span></h4><p>${pills}${un}</p></div>`);
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
  const up = state.pre?.get(n);
  const pre = up === undefined ? ''
    : ` · no pullup, pulled to vcc by ${up >= 0 ? (state.sch.names[up] || `unnamed node ${up}`) : 'nothing'}`;
  box.textContent = `${name} · ${block} · ${lvl}${pre} · ${fan} edge${fan === 1 ? '' : 's'} drawn`;
}

function pick(n, fly = false) {
  state.picked = n;
  paintPicked();
  if (fly && n != null) frameNodes([n]);
}

// ---------------------------------------------------------------------------
// The study view's console
// ---------------------------------------------------------------------------
//
// Fullscreen here is the workbench's: the drawing takes the whole viewport and
// the controls ride on one floating strip-and-drawer console (solo-palette.js,
// shared with the schematic). What is particular to this page is what the
// drawers show, and they show the side column's OWN elements, borrowed: a
// drawer moves the registers, the watch, the listing or the moved list out of
// the side column into itself and puts them back when another opens or the
// mode ends. The painters above then have one target each, and the console
// cannot disagree with the page about a register because there is only one
// copy of it to paint. (The first sketch rendered copies; the bug it would
// have had is the one every second copy on this site has had.)

const CFG_KEY = 'v6502.tracer.console';
let pal = null;

function saveConfig() {
  if (!pal) return;
  try { localStorage.setItem(CFG_KEY, JSON.stringify(pal.config())); } catch { /* private mode: the page works, it just forgets */ }
}
function loadConfig() {
  try {
    const raw = JSON.parse(localStorage.getItem(CFG_KEY));
    return raw && typeof raw === 'object' ? raw : null;
  } catch { return null; }
}

// Where each borrowed element lives, so it can go home. Returned in reverse
// order of borrowing: two neighbours borrowed together (the moved list's
// summary and the list) are put back later-first, so the earlier one finds its
// next sibling already in place.
const HOMES = [];
function borrow(host, ...ids) {
  for (const id of ids) {
    const el = $(id);
    if (!el) continue;
    HOMES.push({ el, parent: el.parentNode, next: el.nextSibling });
    host.append(el);
  }
}
function returnAll() {
  while (HOMES.length) {
    const { el, parent, next } = HOMES.pop();
    parent.insertBefore(el, next && next.parentNode === parent ? next : null);
  }
}

// Each drawer: put back whatever the last one borrowed, take its own. The
// painter is a no-op because every element here is painted by name on every
// paint() whether it is in the drawer or the side column.
const noop = () => {};
const PANELS = {
  regs: (host) => { returnAll(); borrow(host, 'tc-head', 'tc-regs'); return noop; },
  watch: (host) => { returnAll(); borrow(host, 'tc-watch-field', 'tc-watch'); return noop; },
  code: (host) => { returnAll(); borrow(host, 'tc-code'); return noop; },
  moved: (host) => { returnAll(); borrow(host, 'tc-moved-sum', 'tc-moved'); return noop; },
  view: (host) => { returnAll(); borrow(host, 'tc-modes', 'tc-zoomctl', 'tc-picked-field', 'tc-block-field'); return noop; },
};
const TAB_NAMES = { regs: 'Registers', watch: 'Watch', code: 'Code', moved: 'Moved', view: 'View' };

function setupPalette() {
  pal = createPalette({
    palette: $('tc-palette'),
    strip: $('tc-strip'),
    host: $('tc-sp-panel'),
    title: $('tc-drawer-title'),
    collapse: $('tc-collapse'),
    stage: () => document.querySelector('.tc-stage'),
    panels: PANELS,
    names: TAB_NAMES,
    tab: 'regs',
    active: () => state.solo,
    onChange: saveConfig,
  });
  pal.restore(loadConfig());
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

function setStemRegions(on) {
  state.stemRegions = on;
  $('tc-stems-btn').setAttribute('aria-pressed', on ? 'true' : 'false');
  $('tc-stem-regions')?.classList.toggle('off', !on);
}

function setRegions(on) {
  state.regions = on;
  $('tc-regions-btn').setAttribute('aria-pressed', on ? 'true' : 'false');
  $('tc-regions')?.classList.toggle('off', !on);
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
    const soloSpeed = $('tc-solo-speed');
    for (const ck of CLOCKS) soloSpeed.add(new Option(ck.label, String(ck.hz)));
    soloSpeed.onchange = () => setClock(Number(soloSpeed.value));
    subscribe(() => {
      const on = isRunning();
      $('tc-run').textContent = on ? 'Pause' : 'Run';
      $('tc-run').classList.toggle('btn-primary', !on);
      const b = $('tc-solo-run');
      b.textContent = on ? '❙❙' : '▶';
      b.setAttribute('aria-label', on ? 'Pause' : 'Run');
      b.classList.toggle('on', on);
      const hz = String(clockHz());
      if (speed.value !== hz) speed.value = hz;
      if (soloSpeed.value !== hz) soloSpeed.value = hz;
    });
    $('tc-solo-run').onclick = () => toggleRunning();
    $('tc-solo-step').onclick = () => stepChip();
    $('tc-solo-back').onclick = () => { setRunning(false); stepBack(); };
    $('tc-solo-cycle').onclick = () => { setRunning(false); advance(2); paint(); };
    $('tc-solo-reset').onclick = () => resetChip();
    $('tc-solo-fit').onclick = () => { setView(state.home.slice()); };
    $('tc-solo-exit').onclick = () => $('tc-fullscreen').click();

    // The drawing.
    $('tc-boot').hidden = true;
    $('tc-main').hidden = false;
    setView(state.home.slice());
    draw();
    paint();

    for (const b of document.querySelectorAll('[data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));
    $('tc-only').addEventListener('click', () => setOnly(!state.only));
    if (q.get('only') === '1') setOnly(true);
    $('tc-regions-btn').addEventListener('click', () => setRegions(!state.regions));
    if (q.get('regions') === '0') setRegions(false);
    $('tc-stems-btn').addEventListener('click', () => setStemRegions(!state.stemRegions));
    if (q.get('buses') === '0') setStemRegions(false);
    $('tc-block').addEventListener('click', (e) => {
      const b = e.target.closest('.tc-bk-watch');
      if (!b) return;
      const stem = b.dataset.stem;
      setWatch(state.watch.includes(stem) ? state.watch.filter((w) => w !== stem) : [...state.watch, stem]);
      paintBlock();
    });
    $('tc-home').addEventListener('click', () => { setView(state.home.slice()); });

    // Fullscreen, as the workbench has it: the drawing covers the viewport and
    // the controls ride on the floating console. The same helper as the
    // schematic, so a phone gets the same fallback and Escape leaves the same
    // way. The viewBox does the rest: the drawing scales into whatever box it
    // is given.
    const console_ = document.querySelector('#bench .console');
    setupPalette();
    setupFullscreen(console_, $('tc-fullscreen'), () => {
      const on = console_.classList.contains('immersive');
      state.solo = on;
      console_.classList.toggle('solo', on);
      if (on) {
        // The console only exists in this mode, so entering opens and
        // populates it rather than waiting for a frame. The saved tab, drawer
        // and position were restored at setup, before anything could be written.
        pal.open(loadConfig());
      } else {
        // Everything the drawers borrowed goes back to the side column.
        returnAll();
      }
    });
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
    setupCamera(document.querySelector('.tc-stage'), svg);
    svg.addEventListener('click', (e) => {
      if (state.dragged) return;
      const t = e.target.closest('.tc-n');
      if (t) { pick(Number(t.dataset.node)); return; }
      pick(null);
      // A click on the regions selects the block with the nearest member at
      // that point (they overlap); on the selected block it clears; off every
      // region it clears too.
      const pt = atClient(e);
      const stem = state.stemRegions ? stemAt(pt) : null;
      if (stem !== null) { selectStem(stem === state.stem ? null : stem); return; }
      const b = state.regions ? blockAt(pt) : null;
      selectBlock(b === state.block ? null : b);
    });

    document.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t && t.closest && t.closest('input, select, textarea')) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); stepChip(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setRunning(false); stepBack(); }
      else if (e.key === ' ') { e.preventDefault(); toggleRunning(); }
      else if (!state.solo) return;
      else if (e.key === '0') { e.preventDefault(); setView(state.home.slice()); }
      else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); pal.setDrawer(!pal.drawer); }
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
    // ?block=SLUG selects a block and frames it, the slug being the one the
    // block pages and the workbench use.
    if (q.has('block')) selectBlockBySlug(q.get('block'));
    // ?bus=STEM selects a bus or latch and frames it.
    if (q.has('bus')) selectStem(q.get('bus').toLowerCase(), { fly: true });
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

window.__tracer = { state, paint, stepOnce, stepBack, advance, setMode, setOnly, setRegions, setStemRegions, regionData, stemRegionData, stemList, selectBlock, selectBlockBySlug, selectStem, blockAt, stemAt, setWatch, frameNodes, setView, REGION_R, REGION_CELL, STEM_R, pick, loadProgram, palette: () => pal, CFG_KEY };
boot();
