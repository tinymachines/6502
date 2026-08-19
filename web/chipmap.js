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
import { halfCyclesFor } from './chip-controls.js';
import { chipGroups, KIND_LABEL } from './chip-groups.js';
import { centroids } from './die-centroids.js';
import { el } from './sch-draw.js';
import { SLUGS } from './block-notes.js';

const $ = (id) => document.getElementById(id);

// Layout constants: presentation, not measurement. The columns and the order
// within them are the measured part.
const COLW = 190, BOXW = 148, VGAP = 12, PAD = 40;

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
};

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

function buildLayout(pos) {
  const dist = pinDistance();
  for (const g of state.groups) {
    g.col = median(g.nodes.map((n) => dist.get(n)).filter((d) => d !== undefined));
    g.medY = median(g.nodes.map((n) => pos.get(n)?.y).filter((y) => y !== undefined));
    g.h = Math.max(28, Math.round(16 + 3.4 * Math.sqrt(g.nodes.length)));
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

function drawAll() {
  const svg = $('cm-svg');
  svg.replaceChildren();
  const bg = el('g', { class: 'cm-bundles' }, svg);
  for (const bd of state.bundles) {
    const A = state.groups[bd.a], B = state.groups[bd.b];
    const w = Math.min(9, 0.7 + Math.log2(1 + bd.weight) * 0.9);
    const cls = bd.switches ? 'cm-bd cm-bd-sw' : 'cm-bd';
    const line = el('line', {
      x1: A.x + A.w / 2, y1: A.y + A.h / 2,
      x2: B.x + B.w / 2, y2: B.y + B.h / 2,
      class: cls, 'stroke-width': w.toFixed(2), 'data-b': bd.i,
    }, bg);
    line.style.setProperty('--bw', Math.min(0.5, 0.1 + bd.weight / 60).toFixed(2));
  }
  const fg = el('g', { class: 'cm-boxes' }, svg);
  for (const g of state.groups) {
    const box = el('g', { class: 'cm-box', 'data-key': g.key }, fg);
    el('rect', { x: g.x, y: g.y, width: g.w, height: g.h, rx: 3, class: 'cm-bg' }, box);
    el('rect', { x: g.x, y: g.y, width: g.w, height: g.h, rx: 3, class: 'cm-hi' }, box);
    el('text', { x: g.x + 6, y: g.y + 11, class: 'cm-kind' }, box)
      .textContent = trim(KIND_LABEL[g.kind] || g.kind, 24);
    el('text', { x: g.x + 6, y: g.y + Math.min(g.h - 6, 23), class: 'cm-name' }, box)
      .textContent = trim(g.label, 22);
    el('title', {}, box).textContent =
      `${g.label} · ${KIND_LABEL[g.kind]} · ${g.nodes.length} node${g.nodes.length === 1 ? '' : 's'}`;
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
  state.groups.forEach((g, gi) => {
    let hi = 0, mv = 0;
    for (const n of g.nodes) {
      if (levels[n] > 0) hi++;
      if (prev && levels[n] !== prev[n]) mv++;
    }
    g.hiNow = hi; g.mvNow = mv;
    const box = boxes[gi];
    box.style.setProperty('--hi', (0.5 * hi / g.nodes.length).toFixed(3));
    box.classList.toggle('mv', mv > 0);
  });
  for (const line of svg.querySelectorAll('.cm-bd')) {
    const bd = state.bundles[Number(line.dataset.b)];
    let open = false, fired = false;
    for (const c of bd.controls) if (levels[c] > 0) { open = true; break; }
    if (prev) for (const o of bd.outs) if (levels[o] !== prev[o]) { fired = true; break; }
    line.classList.toggle('open', open);
    line.classList.toggle('fired', fired);
  }
  state.prev = levels;
  paintCardLive();
  const head = $('cm-head');
  const text = `half-cycle ${m.halfCycle()} · ${m.clk0() ? 'φ1' : 'φ2'}`
    + `${m.sync() ? ' · sync' : ''}`;
  if (head.textContent !== text) head.textContent = text;
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
  for (const line of svg.querySelectorAll('.cm-bd')) {
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
  paintCardLive();
}

/** The card's live line, rewritten on every paint rather than rebuilt. */
function paintCardLive() {
  const live = document.getElementById('cm-card-live');
  if (!live || !state.sel || !state.prev) return;
  const g = state.groups.find((x) => x.key === state.sel);
  const byte = byteOf(g, state.prev);
  const text = `${g.hiNow ?? 0} high now · ${g.mvNow ?? 0} moved at the last half-cycle`
    + (byte ? ` · reads ${byte}` : '');
  if (live.textContent !== text) live.textContent = text;
}

// ---------------------------------------------------------------------------
// Camera: a viewBox and nothing else, the die graph's own arrangement
// ---------------------------------------------------------------------------

function setView(v) {
  state.view = v;
  $('cm-svg').setAttribute('viewBox', v.join(' '));
  $('cm-zoom').textContent = `${(state.home[2] / v[2]).toFixed(1)}×`;
}

function zoomAt(factor, cx, cy) {
  const [x, y, w, h] = state.view;
  const nw = Math.max(120, Math.min(state.home[2] * 4, w * factor));
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
  let pinch = null, moved = 0;
  const pinchOf = () => {
    const [p, q] = [...live.values()];
    return { mid: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 },
             spread: Math.hypot(p.x - q.x, p.y - q.y), view: state.view.slice() };
  };
  svg.addEventListener('pointerdown', (e) => {
    live.set(e.pointerId, atClient(e));
    moved = 0;
    if (live.size === 2) pinch = pinchOf();
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
    } else if (live.size === 1) {
      const [, , w, h] = state.view;
      setView([state.view[0] - (p.x - was.x), state.view[1] - (p.y - was.y), w, h]);
    }
  });
  const release = (e) => {
    live.delete(e.pointerId);
    if (live.size < 2) pinch = null;
  };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  svg.addEventListener('click', (e) => {
    if (moved > 8) return;
    const t = e.target.closest('.cm-box');
    select(t ? t.dataset.key : null);
  });
  $('cm-home').addEventListener('click', () => setView(state.home.slice()));
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
    const { pos } = centroids(buf);
    const dims = buildLayout(pos);
    const edge = buildBundles();
    state.home = [0, 0, dims.W, dims.H];
    drawAll();
    setView(state.home.slice());
    setupCamera();

    const switches = state.bundles.reduce((a, b) => a + b.switches, 0);
    const gates = state.bundles.reduce((a, b) => a + b.gates, 0);
    $('cm-caption').textContent =
      `${r.groups.length} groups over ${r.stats.kinds} kinds, covering all `
      + `${r.stats.universe} nodes exactly once. ${state.bundles.length} bundles `
      + `carrying ${gates} gate edges and ${switches} switches between groups; `
      + `${edge.internalGates} gate edges and ${edge.internalSwitches} switches `
      + `stay inside one. ${dims.columns} columns of pin distance`
      + (dims.unreachedCols ? ', the last for what the pins never reach.' : '.');

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
    const loadProgram = (i) => {
      state.program = i;
      m.load(LOAD_ADDR, new Uint8Array(PROGRAMS[i].bytes));
      m.setResetVector(LOAD_ADDR);
      m.powerCycle();
      state.prev = null;
    };
    loadProgram(selectedProgram(location.search));
    setupProgramNav({ onChange: (i) => { setSelectedProgram(i); loadProgram(i); paint(); } });
    setupChipNav({
      step: () => { m.halfStep(); paint(); },
      back: () => { m.stepBack(); paint(); },
      reset: () => { m.powerCycle(); state.prev = null; paint(); },
      halfCycle: () => m.halfCycle(),
    });
    paint();
    requestAnimationFrame(tick);

    const sel = new URLSearchParams(location.search).get('sel');
    select(sel && state.byKey.has(sel) ? sel : null);

    // For the harness: the partition and the bundles as data, not scraped
    // back out of the DOM.
    window.__chipmap = { groups: state.groups, bundles: state.bundles, stats: r.stats, machine: m };

    $('cm-boot').hidden = true;
    $('cm-main').hidden = false;
  } catch (e) {
    status.textContent = `Could not build the page: ${e && e.message ? e.message : e}`;
    status.classList.add('bk-error');
  }
}

boot();
