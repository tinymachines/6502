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

const COL = 168;      // horizontal distance between a signal column and the next
const ROW = 34;       // vertical pitch within a column
// Room above the topmost row for the control-line labels, which sit 26px over
// their element. Without it they render at negative y and are clipped away by
// the viewBox -- the label is drawn, and simply not visible.
const PAD = 46;

function el(tag, attrs, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
}

function draw(c) {
  const svg = $('sch-svg');
  svg.replaceChildren();

  // Columns alternate signal / element, root on the right.
  const cols = c.levels.length;
  const width = PAD * 2 + (cols - 1) * COL * 2 + 160;
  const place = new Map();          // node -> {x, y}
  let maxY = 0;

  c.levels.forEach((nodes, li) => {
    const x = width - PAD - 80 - li * COL * 2;
    const h = (nodes.length - 1) * ROW;
    nodes.forEach((n, i) => {
      const y = PAD + Math.max(0, (maxYOf(c) - h) / 2) + i * ROW;
      place.set(n, { x, y });
      maxY = Math.max(maxY, y);
    });
  });

  const height = maxY + PAD * 2;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);

  const wires = el('g', { class: 'sch-wires' }, svg);
  const parts = el('g', { class: 'sch-parts' }, svg);
  const labels = el('g', { class: 'sch-labels' }, svg);

  // Elements sit between their inputs and their output.
  const { vss, vcc } = state.data;
  for (const e of c.elements) {
    const out = place.get(e.out);
    if (!out) continue;
    const ex = out.x - COL;

    // Inputs that are rails have no pill of their own -- they are not signals
    // and do not belong in a level. They still have to be drawn: a precharge
    // transistor to Vcc is most of what a dynamic gate *is*, and dropping it
    // left the caption claiming five switches while none appeared.
    const placed = e.inputs.map((n) => ({ node: n, pos: place.get(n) }));
    const real = placed.filter((p) => p.pos);
    const ey = real.length
      ? real.reduce((s, p) => s + p.pos.y, 0) / real.length
      : out.y;
    for (const p of placed) {
      if (!p.pos) p.pos = { x: ex - 54, y: ey, rail: true };
    }
    const ins = placed.map((p) => p.pos);

    for (const p of placed) {
      el('path', {
        d: `M ${p.pos.x - (p.pos.rail ? 0 : 4)} ${p.pos.y} H ${ex - 26} L ${ex - 18} ${ey}`,
        class: 'sch-wire',
        'data-from': p.node,
      }, wires);
      if (p.pos.rail) {
        const rail = p.node === vss ? 'Vss' : p.node === vcc ? 'Vcc' : '?';
        el('line', {
          x1: p.pos.x, y1: p.pos.y - 8, x2: p.pos.x, y2: p.pos.y + 8, class: 'sch-rail',
        }, wires);
        const t = el('text', { x: p.pos.x - 6, y: p.pos.y + 4, class: 'sch-rail-label' }, labels);
        t.textContent = rail;
      }
    }
    el('path', { d: `M ${ex + 18} ${ey} H ${out.x - 62}`, class: 'sch-wire' }, wires);

    if (e.kind === 'switch') {
      // A switch is drawn as a break in the wire with its control above it —
      // which is what a pass transistor is: a gap that a control line closes.
      const g = el('g', { class: 'sch-el sch-switch', 'data-control': e.control }, parts);
      el('line', { x1: ex - 14, y1: ey, x2: ex - 4, y2: ey, class: 'sch-sw-lead' }, g);
      el('line', { x1: ex + 4, y1: ey, x2: ex + 14, y2: ey, class: 'sch-sw-lead' }, g);
      el('line', { x1: ex - 4, y1: ey - 9, x2: ex - 4, y2: ey + 9, class: 'sch-sw-plate' }, g);
      el('line', { x1: ex + 4, y1: ey - 9, x2: ex + 4, y2: ey + 9, class: 'sch-sw-plate' }, g);
      el('line', { x1: ex, y1: ey - 22, x2: ex, y2: ey - 9, class: 'sch-sw-gate' }, g);
      const t = el('text', { x: ex, y: ey - 26, class: 'sch-ctrl' }, labels);
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
    const label = nameOf(node);
    const w = Math.max(46, label.length * 6.6 + 14);
    el('rect', { x: -w, y: -11, width: w, height: 22, rx: 3, class: 'sch-pill' }, g);
    const t = el('text', { x: -w / 2, y: 4, class: 'sch-name' }, g);
    t.textContent = label;
    g.addEventListener('click', () => setRoot(node));
  }

  svg.querySelectorAll('.sch-ctrl').forEach((t) => {
    if (!t.dataset.node) return;
    t.style.cursor = 'pointer';
    t.addEventListener('click', () => setRoot(Number(t.dataset.node)));
  });
}

function maxYOf(c) {
  return Math.max(...c.levels.map((l) => (l.length - 1) * ROW), 0);
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
