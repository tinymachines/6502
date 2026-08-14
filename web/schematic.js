// The chip as a circuit: pick a signal, see what makes it.
//
// Everything drawn here is recognised rather than authored. `schematic.rs`
// reduces the netlist to gates and switches; this page walks backwards from a
// chosen signal and lays the result out. No symbol appears that is not a real
// structure on the die, and no wire appears that is not a real transistor.
//
// The layout is bipartite by construction, because a schematic is: signals in
// one column, the elements that combine them in the next, signals again after
// that. Reading right to left is reading backwards in causality.

import init, { Machine } from './pkg/v6502_wasm.js';
import { PROGRAMS, LOAD_ADDR } from './programs.js';

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';

const state = {
  data: null,
  machine: null,
  gateOf: new Map(),      // out node -> gate
  switchesOn: new Map(),  // node -> [switch]
  root: null,
  depth: 3,
  compare: null,          // [nodeA, nodeB] when comparing two bits
  running: false,
  raf: 0,
};

const nameOf = (n) => state.data.names[n] ?? `#${n}`;
const isNamed = (n) => state.data.names[n] != null;

// ---------------------------------------------------------------------------
// Cone extraction — the same walk as `Schematic::cone`, in the page so that
// re-rooting and changing depth cost nothing.
// ---------------------------------------------------------------------------

function cone(root, depth) {
  const { vss, vcc } = state.data;
  const isRail = (n) => n === vss || n === vcc;
  const levels = [[root]];
  const seen = new Set([root]);
  const elements = [];   // {kind, out, inputs, control, level}

  for (let level = 0; level < depth; level++) {
    const next = [];
    for (const node of levels[level]) {
      const g = state.gateOf.get(node);
      if (g) {
        const inputs = [...new Set(g.terms.flat())];
        elements.push({ kind: g.kind, out: node, inputs, terms: g.terms, level, precharge: g.precharge });
        for (const i of inputs) {
          if (!isRail(i) && !seen.has(i)) { seen.add(i); next.push(i); }
        }
      }
      for (const w of state.switchesOn.get(node) || []) {
        const far = w.a === node ? w.b : w.a;
        elements.push({ kind: 'switch', out: node, inputs: [far], control: w.control, level });
        // The control rides on the element as a label and is not expanded.
        // cclk alone gates 273 transistors; following it drags the whole clock
        // tree in and buries the signal that was asked about.
        if (!isRail(far) && !seen.has(far)) { seen.add(far); next.push(far); }
      }
    }
    if (!next.length) break;
    levels.push(next);
  }
  return { root, levels, elements };
}

/**
 * A shape signature: how the cone is wired, ignoring which wires.
 *
 * This is what makes "is bit 0 the same circuit as bit 7" answerable at all.
 * The control line's *name* is part of the shape, because a switch opened by
 * ADDSB7 is a different element from one opened by ADDSB06 — that difference
 * is the shifter, and erasing it would erase the finding.
 */
function signature(c) {
  return c.elements
    .map((e) => (e.kind === 'switch'
      ? `${e.level}:switch:${nameOf(e.control)}`
      : `${e.level}:gate:${e.kind}`))
    .sort();
}

function diff(a, b) {
  const counts = new Map();
  for (const s of signature(a)) counts.set(s, (counts.get(s) || 0) + 1);
  for (const s of signature(b)) counts.set(s, (counts.get(s) || 0) - 1);
  const shared = [], onlyA = [], onlyB = [];
  for (const [s, n] of counts) {
    if (n === 0) shared.push(s);
    else if (n > 0) onlyA.push(s);
    else onlyB.push(s);
  }
  return { shared: shared.sort(), onlyA: onlyA.sort(), onlyB: onlyB.sort() };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

// Geometry. Every drawn thing has a box, and nothing is placed without asking
// whether that box is free -- the first version spaced columns by a constant and
// stacked elements at the mean of their inputs, which piles a dozen switches on
// one another whenever their inputs happen to share a row.
const NODE_H = 22;          // pill height
const ROW = NODE_H + 12;    // vertical pitch of signals within a column
const EL_W = 44;            // element symbol box
const EL_H = 32;
const EL_LABEL = 14;        // the control name sits above its element
const EL_V = EL_H + EL_LABEL + 6;   // minimum vertical pitch between elements
const GAP_X = 30;           // horizontal breathing room either side of a column
// Stub length for an input that is a power rail. Kept shorter than GAP_X so the
// stub and its label stay inside the gap between columns instead of reaching
// into the node pills beside them.
const RAIL_LEAD = 22;
const PAD = 20;

function el(tag, attrs, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
}

/** Width of a signal's pill, from its label. */
function boxWidth(node) {
  return Math.max(46, nameOf(node).length * 6.6 + 14);
}

/**
 * Work out where everything goes, before anything is drawn.
 *
 * Columns are as wide as their widest label rather than a fixed constant, so a
 * long name like `op-T0-cpx/cpy/inx/iny` pushes its neighbours over instead of
 * running through them. Elements are then pushed apart vertically until their
 * boxes stop touching.
 */
function layout(c) {
  const place = new Map();
  const colW = c.levels.map((nodes) => Math.max(...nodes.map(boxWidth), 46));

  // Right to left: level 0 holds the root. Coordinates start at 0 and go
  // negative; the whole thing is shifted into view once its extent is known.
  const nodeRight = [0];
  const elX = [];
  for (let li = 0; li < c.levels.length; li++) {
    elX.push(nodeRight[li] - colW[li] - GAP_X - EL_W / 2);
    nodeRight.push(elX[li] - EL_W / 2 - GAP_X);
  }

  const tallest = Math.max(...c.levels.map((l) => (l.length - 1) * ROW), 0);
  c.levels.forEach((nodes, li) => {
    const top = (tallest - (nodes.length - 1) * ROW) / 2;
    nodes.forEach((n, i) => {
      place.set(n, { x: nodeRight[li], y: top + i * ROW, w: boxWidth(n) });
    });
  });

  // Elements: start at the mean of the inputs that have a position, then
  // separate. An element whose inputs are all rails has nothing to average, so
  // it takes its output's row -- and several of those on one output would land
  // on exactly the same spot without the pass below.
  const items = [];
  for (const e of c.elements) {
    const out = place.get(e.out);
    if (!out) continue;
    const ins = e.inputs.map((n) => place.get(n)).filter(Boolean);
    const y = ins.length ? ins.reduce((s, p) => s + p.y, 0) / ins.length : out.y;
    items.push({ e, out, x: elX[e.level], y });
  }

  // Separate within each column. Sorting first makes one sweep enough, and
  // re-centring afterwards stops the whole column drifting downward.
  const byCol = new Map();
  for (const it of items) {
    if (!byCol.has(it.x)) byCol.set(it.x, []);
    byCol.get(it.x).push(it);
  }
  for (const group of byCol.values()) {
    group.sort((a, b) => a.y - b.y);
    const before = group.reduce((s, g) => s + g.y, 0) / group.length;
    for (let i = 1; i < group.length; i++) {
      if (group[i].y - group[i - 1].y < EL_V) group[i].y = group[i - 1].y + EL_V;
    }
    const after = group.reduce((s, g) => s + g.y, 0) / group.length;
    for (const g of group) g.y -= after - before;
  }

  // Everything's extent, so the drawing can be shifted into positive space with
  // the offset baked into the coordinates rather than applied as a transform --
  // a wrapper transform would leave the raw values negative, and the harness
  // checks those to catch labels drawn outside the viewBox.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const see = (x0, y0, x1, y1) => {
    minX = Math.min(minX, x0); maxX = Math.max(maxX, x1);
    minY = Math.min(minY, y0); maxY = Math.max(maxY, y1);
  };
  for (const p of place.values()) see(p.x - p.w, p.y - NODE_H / 2, p.x, p.y + NODE_H / 2);
  for (const it of items) {
    const railward = it.e.inputs.some((n) => !place.has(n)) ? RAIL_LEAD + 4 : 0;
    see(it.x - EL_W / 2 - railward, it.y - EL_H / 2 - EL_LABEL - 6,
        it.x + EL_W / 2, it.y + EL_H / 2);
  }
  if (!Number.isFinite(minX)) { minX = 0; maxX = 0; minY = 0; maxY = 0; }

  const dx = PAD - minX;
  const dy = PAD - minY;
  for (const p of place.values()) { p.x += dx; p.y += dy; }
  for (const it of items) { it.x += dx; it.y += dy; }
  return { place, items, width: maxX - minX + PAD * 2, height: maxY - minY + PAD * 2 };
}

function draw(c) {
  const svg = $('sch-svg');
  svg.replaceChildren();
  const { place, items, width, height } = layout(c);

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);

  const wires = el('g', { class: 'sch-wires' }, svg);
  const parts = el('g', { class: 'sch-parts' }, svg);
  const labels = el('g', { class: 'sch-labels' }, svg);
  const { vss, vcc } = state.data;

  for (const { e, out, x: ex, y: ey } of items) {
    // Inputs that are rails have no pill of their own -- they are not signals
    // and do not belong in a level. They still have to be drawn: a precharge
    // transistor to Vcc is most of what a dynamic gate *is*, and dropping it
    // left the caption claiming five switches while none appeared.
    for (const n of e.inputs) {
      const p = place.get(n);
      if (p) {
        el('path', {
          d: `M ${p.x - 4} ${p.y} H ${ex - EL_W / 2 - 10} L ${ex - EL_W / 2 + 4} ${ey}`,
          class: 'sch-wire', 'data-from': n,
        }, wires);
      } else {
        const rx = ex - EL_W / 2 - RAIL_LEAD;
        el('path', { d: `M ${rx} ${ey} H ${ex - EL_W / 2 + 4}`, class: 'sch-wire' }, wires);
        el('line', { x1: rx, y1: ey - 8, x2: rx, y2: ey + 8, class: 'sch-rail' }, wires);
        // Below the stub rather than beside it: the space under a rail tap is
        // always free, whereas the space to its left is the next column.
        const t = el('text', { x: rx, y: ey + 16, class: 'sch-rail-label' }, labels);
        t.textContent = n === vss ? 'Vss' : n === vcc ? 'Vcc' : '?';
      }
    }
    el('path', { d: `M ${ex + EL_W / 2 - 4} ${ey} H ${out.x - out.w - 2} `
      + `M ${out.x - out.w - 2} ${ey} V ${out.y} H ${out.x - out.w}`, class: 'sch-wire' }, wires);

    if (e.kind === 'switch') {
      // A pass transistor is a gap that a control line closes, so it is drawn
      // as a break in the wire with its control above it.
      const g = el('g', { class: 'sch-el sch-switch', 'data-control': e.control }, parts);
      el('line', { x1: ex - 14, y1: ey, x2: ex - 4, y2: ey, class: 'sch-sw-lead' }, g);
      el('line', { x1: ex + 4, y1: ey, x2: ex + 14, y2: ey, class: 'sch-sw-lead' }, g);
      el('line', { x1: ex - 4, y1: ey - 9, x2: ex - 4, y2: ey + 9, class: 'sch-sw-plate' }, g);
      el('line', { x1: ex + 4, y1: ey - 9, x2: ex + 4, y2: ey + 9, class: 'sch-sw-plate' }, g);
      el('line', { x1: ex, y1: ey - 20, x2: ex, y2: ey - 9, class: 'sch-sw-gate' }, g);
      const t = el('text', { x: ex, y: ey - 24, class: 'sch-ctrl' }, labels);
      t.textContent = nameOf(e.control).replace(/^dpc-?\d*_?/, '');
      t.dataset.node = e.control;
    } else {
      const g = el('g', { class: `sch-el sch-gate sch-${e.kind}` }, parts);
      // Every gate here inverts: NMOS pulls down against a pullup, so the
      // bubble is not decoration, it is the only thing the technology does.
      el('path', {
        d: `M ${ex - 18} ${ey - 16} L ${ex - 18} ${ey + 16} L ${ex + 8} ${ey} Z`,
        class: 'sch-body',
      }, g);
      el('circle', { cx: ex + 13, cy: ey, r: 5, class: 'sch-bubble' }, g);
      const t = el('text', { x: ex - 9, y: ey + 4, class: 'sch-kind' }, g);
      t.textContent = { inverter: '1', nor: '≥1', nand: '&', aoi: '&≥', dynamic: 'φ' }[e.kind] || '?';
      if (e.kind === 'dynamic' && e.precharge >= 0) {
        const p = el('text', { x: ex, y: ey - 24, class: 'sch-ctrl' }, labels);
        p.textContent = 'pre ' + nameOf(e.precharge);
      }
    }
  }

  // Signals last, so they sit above the wiring.
  for (const [node, p] of place) {
    const g = el('g', {
      class: 'sch-node' + (node === c.root ? ' root' : '') + (isNamed(node) ? '' : ' anon'),
      'data-node': node,
      transform: `translate(${p.x},${p.y})`,
    }, parts);
    el('rect', { x: -p.w, y: -NODE_H / 2, width: p.w, height: NODE_H, rx: 3, class: 'sch-pill' }, g);
    const t = el('text', { x: -p.w / 2, y: 4, class: 'sch-name' }, g);
    t.textContent = nameOf(node);
    g.addEventListener('click', () => setRoot(node));
  }

  svg.querySelectorAll('.sch-ctrl').forEach((t) => {
    if (!t.dataset.node) return;
    t.style.cursor = 'pointer';
    t.addEventListener('click', () => setRoot(Number(t.dataset.node)));
  });
}

/** Colour the drawing from the running chip. */
function paint(levels) {
  const svg = $('sch-svg');
  for (const g of svg.querySelectorAll('.sch-node')) {
    const n = Number(g.dataset.node);
    g.classList.toggle('hot', levels[n] > 0);
  }
  for (const g of svg.querySelectorAll('.sch-switch')) {
    const c = Number(g.dataset.control);
    g.classList.toggle('open', levels[c] > 0);
  }
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function setRoot(node) {
  state.root = node;
  state.compare = null;
  $('sch-compare-out').hidden = true;
  render();
  const q = new URLSearchParams(location.search);
  q.set('signal', nameOf(node));
  q.set('depth', String(state.depth));
  history.replaceState(null, '', '?' + q.toString());
}

function render() {
  const c = cone(state.root, state.depth);
  draw(c);
  const gates = c.elements.filter((e) => e.kind !== 'switch').length;
  const sw = c.elements.length - gates;
  $('sch-caption').textContent =
    `${nameOf(state.root)} — ${c.nodes ?? c.levels.reduce((a, l) => a + l.length, 0)} signals, `
    + `${gates} gates, ${sw} switches, ${c.levels.length} levels back`;
}

function runCompare(a, b) {
  const ca = cone(a, state.depth);
  const cb = cone(b, state.depth);
  const d = diff(ca, cb);
  state.compare = [a, b];
  const box = $('sch-compare-out');
  box.hidden = false;
  const fmt = (list) => list.length
    ? list.map((s) => `<code>${s.split(':').slice(1).join(' ')}</code>`).join(' ')
    : '<span class="muted">nothing</span>';
  box.innerHTML =
    `<h3>${nameOf(a)} vs ${nameOf(b)}</h3>`
    + `<p class="${d.onlyA.length || d.onlyB.length ? 'sch-differ' : 'sch-same'}">`
    + (d.onlyA.length || d.onlyB.length
      ? `<strong>Different circuits.</strong> ${d.shared.length} elements in common, `
        + `${d.onlyA.length + d.onlyB.length} not.`
      : `<strong>Identical.</strong> All ${d.shared.length} elements match.`)
    + '</p>'
    + `<dl class="ends"><dt>only ${nameOf(a)}</dt><dd>${fmt(d.onlyA)}</dd>`
    + `<dt>only ${nameOf(b)}</dt><dd>${fmt(d.onlyB)}</dd></dl>`;
  // Draw the first of the pair so there is something to look at.
  state.root = a;
  render();
}

function buildPicker() {
  const sel = $('sch-signal');
  const named = state.data.names
    .map((n, i) => [n, i])
    .filter(([n]) => n)
    .sort((x, y) => x[0].localeCompare(y[0]));
  const filter = $('sch-filter').value.toLowerCase();
  sel.replaceChildren();
  let shown = 0;
  for (const [name, id] of named) {
    if (filter && !name.toLowerCase().includes(filter)) continue;
    if (++shown > 400) break;
    const o = document.createElement('option');
    o.value = String(id);
    o.textContent = name;
    sel.append(o);
  }
  $('sch-shown').textContent = `${shown} of ${named.length}`;
  if (state.root != null) sel.value = String(state.root);
}

async function boot() {
  const status = $('sch-status');
  try {
    const [, data] = await Promise.all([
      init(),
      fetch('schematic.json').then((r) => {
        if (!r.ok) throw new Error(`schematic.json: HTTP ${r.status}`);
        return r.json();
      }),
    ]);
    state.data = data;

    for (const [out, kind, precharge, terms] of data.gates) {
      state.gateOf.set(out, { out, kind: data.kinds[kind], precharge, terms });
    }
    for (const [control, a, b] of data.switches) {
      for (const n of [a, b]) {
        if (n === data.vss || n === data.vcc) continue;
        if (!state.switchesOn.has(n)) state.switchesOn.set(n, []);
        state.switchesOn.get(n).push({ control, a, b });
      }
    }

    const m = new Machine();
    state.machine = m;
    m.load(LOAD_ADDR, new Uint8Array(PROGRAMS[0].bytes));
    m.powerCycle();

    const c = data.counts;
    $('sch-stats').textContent =
      `${c.gates} gates — ${c.inverter} inverters, ${c.nor} NOR, ${c.nand} NAND, ${c.aoi} AOI, `
      + `${c.dynamic} precharged · ${c.switches} switches · `
      + `${c.absorbed} of ${c.transistors} transistors inside a symbol · ${c.unresolved} unresolved`;

    const q = new URLSearchParams(location.search);
    state.depth = Math.max(1, Math.min(6, Number(q.get('depth')) || 3));
    $('sch-depth').value = String(state.depth);
    $('sch-depth-val').textContent = String(state.depth);

    const want = q.get('signal');
    const byName = new Map(data.names.map((n, i) => [n, i]).filter(([n]) => n));
    state.root = byName.get(want) ?? byName.get('dpc3_SBX') ?? byName.get('a0') ?? 0;

    buildPicker();
    $('sch-filter').addEventListener('input', buildPicker);
    $('sch-signal').addEventListener('change', (e) => setRoot(Number(e.target.value)));
    $('sch-depth').addEventListener('input', (e) => {
      state.depth = Number(e.target.value);
      $('sch-depth-val').textContent = String(state.depth);
      render();
    });
    $('sch-run').addEventListener('click', () => {
      state.running = !state.running;
      $('sch-run').textContent = state.running ? 'Pause' : 'Run';
    });
    $('sch-step').addEventListener('click', () => state.machine.halfStep());

    // The bit comparison. Populated from the buses the die actually names.
    const busSel = $('sch-bus');
    const stems = [...new Set(data.names.filter(Boolean)
      .map((n) => /^([a-z]+)([0-7])$/.exec(n)).filter(Boolean).map((m) => m[1]))]
      .filter((s) => byName.has(`${s}0`) && byName.has(`${s}7`)).sort();
    for (const s of stems) {
      const o = document.createElement('option');
      o.value = s;
      o.textContent = s;
      busSel.append(o);
    }
    busSel.value = stems.includes('sb') ? 'sb' : stems[0];
    const doCompare = () => {
      const s = busSel.value;
      const a = byName.get(`${s}${$('sch-bit-a').value}`);
      const b = byName.get(`${s}${$('sch-bit-b').value}`);
      if (a != null && b != null) runCompare(a, b);
    };
    $('sch-compare').addEventListener('click', doCompare);

    if (q.get('compare')) {
      const [x, y] = q.get('compare').split(',');
      const a = byName.get(x), b = byName.get(y);
      if (a != null && b != null) runCompare(a, b);
    }

    render();
    $('sch-boot').hidden = true;
    $('sch-main').hidden = false;
    tick();
  } catch (e) {
    status.textContent = 'Could not load: ' + (e && e.message ? e.message : e);
    status.classList.add('error');
    throw e;
  }
}

function tick() {
  if (state.running) for (let i = 0; i < 8; i++) state.machine.halfStep();
  paint(state.machine.nodeLevels());
  state.raf = requestAnimationFrame(tick);
}

boot();
