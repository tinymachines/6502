// The whole chip as a graph, drawn where the silicon actually put it.
//
// Every other drawing on this site chooses its own layout. The schematic lays a
// cone out in columns; the blueprint stacks buses as rails; the block diagram
// places boxes by rule. All three are honest, and all three are *arrangements*
// somebody decided on.
//
// This one decides nothing. Every node is drawn at its own centroid on the die,
// and every edge is a connection the netlist already has. There is no layout
// algorithm here at all, which is the point: a chip is a graph that was embedded
// in a plane by the people who drew it, and that embedding is a measurement we
// happen to hold. Nothing has to be inferred, learned or force-directed. It only
// has to be read out and connected up.
//
// Two views, and the default is the smaller one on purpose:
//
//   filtered  named signals and the edges between them. 1286 edges. This is the
//             chip as a person talks about it -- the wires somebody bothered to
//             name -- and it is legible.
//   full      every node and every edge, 3047 of them. Honest, and dense, and
//             the density is itself the finding: the gate network is most of
//             this chip and it does not thin out anywhere.

import { blockCss } from './block-palette.js';
import { el } from './sch-draw.js';
import { centroids } from './die-centroids.js';

const $ = (id) => document.getElementById(id);

const state = {
  sch: null,
  pos: null,          // node -> {x, y} centroid in die coordinates
  bounds: null,
  mode: 'filtered',
  view: null,         // current viewBox as [x, y, w, h]
  home: null,
  picked: null,
};

/**
 * The graph, at whichever size was asked for.
 *
 * An edge is a node-to-node connection the netlist already states: a gate's
 * input to its output, and the two channels of a pass transistor. Rails are
 * dropped from both -- vss and vcc touch most of the chip, so drawing them
 * would put a star through the middle of every picture and say nothing.
 */
function graph(mode) {
  const { sch, pos } = state;
  const rails = new Set([sch.vss, sch.vcc]);
  const named = (i) => !!sch.names[i];
  const keep = (i) => pos.has(i) && !rails.has(i) && (mode === 'full' || named(i));

  const edges = [];
  const seen = new Set();
  const push = (a, b, kind) => {
    if (a === b || !keep(a) || !keep(b)) return;
    const key = a < b ? `${a}:${b}:${kind}` : `${b}:${a}:${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ a, b, kind });
  };
  for (const [out, , , legs] of sch.gates) {
    for (const i of new Set(legs.flat())) push(i, out, 'gate');
  }
  for (const [, a, b] of sch.switches) push(a, b, 'switch');

  const nodes = new Set();
  for (const e of edges) { nodes.add(e.a); nodes.add(e.b); }
  return { nodes: [...nodes], edges };
}

function draw() {
  const svg = $('dg-svg');
  svg.replaceChildren();
  const g = graph(state.mode);
  const { pos, sch } = state;

  const cam = el('g', { class: 'dg-cam' }, svg);
  // Edges first so the nodes sit over them. Switch edges are drawn apart from
  // gate edges because they are a different relation: a pass transistor joins
  // two wires without either causing the other, which is the same distinction
  // the block pages make on their boundary panel.
  const wires = el('g', { class: 'dg-wires' }, cam);
  for (const e of g.edges) {
    const p = pos.get(e.a), q = pos.get(e.b);
    el('line', { x1: p.x, y1: p.y, x2: q.x, y2: q.y,
                 class: `dg-e dg-e-${e.kind}` }, wires);
  }
  const dots = el('g', { class: 'dg-nodes' }, cam);
  for (const nd of g.nodes) {
    const p = pos.get(nd);
    const c = el('circle', { cx: p.x, cy: p.y, r: sch.names[nd] ? 26 : 16,
                             class: 'dg-n' + (sch.names[nd] ? ' dg-named' : ''),
                             'data-node': nd }, dots);
    c.style.fill = blockCss(sch.nodeBlock[nd] & 0x7f);
  }

  $('dg-caption').textContent =
    `${g.nodes.length} nodes, ${g.edges.length} edges drawn at their own die `
    + `coordinates: ${g.edges.filter((e) => e.kind === 'switch').length} of them pass `
    + `transistors joining two wires, the rest a gate input reaching its output. `
    + (state.mode === 'filtered'
      ? 'Named signals only.'
      : 'Every node, including the gate outputs nobody needed to name.');
  paintPicked();
}

/* -- the camera ------------------------------------------------------------
 *
 * A viewBox and nothing else. The drawing is in die coordinates, so zoom is a
 * smaller rectangle over the same picture and pan is that rectangle moving.
 * There is no transform to keep in step with a projection, which is what makes
 * the pointer maths a two-liner instead of the explorer's screenToDie.
 */
function setView(v) {
  state.view = v;
  $('dg-svg').setAttribute('viewBox', v.join(' '));
  $('dg-zoom').textContent = `${(state.home[2] / v[2]).toFixed(1)}×`;
}

function zoomAt(factor, cx, cy) {
  const [x, y, w, h] = state.view;
  const nw = Math.max(200, Math.min(state.home[2] * 4, w * factor));
  const nh = nw * (h / w);
  setView([x + (cx - x) * (1 - nw / w), y + (cy - y) * (1 - nh / h), nw, nh]);
}

/** Where a client point lands in die coordinates. */
function atClient(e) {
  const r = $('dg-svg').getBoundingClientRect();
  const [x, y, w, h] = state.view;
  return { x: x + ((e.clientX - r.left) / r.width) * w,
           y: y + ((e.clientY - r.top) / r.height) * h };
}

function paintPicked() {
  const box = $('dg-picked');
  const n = state.picked;
  for (const c of $('dg-svg').querySelectorAll('.dg-n.on')) c.classList.remove('on');
  if (n == null) {
    box.textContent = 'Click a node to identify it.';
    return;
  }
  const el2 = $('dg-svg').querySelector(`.dg-n[data-node="${n}"]`);
  if (el2) el2.classList.add('on');
  const name = state.sch.names[n] || `unnamed node ${n}`;
  const block = state.sch.blockNames[state.sch.nodeBlock[n] & 0x7f];
  const p = state.pos.get(n);
  box.textContent = `${name} · ${block} · die ${Math.round(p.x)}, `
    + `${Math.round(state.bounds.ymax - p.y + state.bounds.ymin)}`;
}

function setMode(m) {
  state.mode = m;
  for (const b of document.querySelectorAll('[data-mode]')) {
    b.classList.toggle('on', b.dataset.mode === m);
  }
  state.picked = null;
  draw();
}

async function boot() {
  const status = $('dg-status');
  try {
    const [sch, buf] = await Promise.all([
      fetch('schematic.json').then((r) => {
        if (!r.ok) throw new Error(`schematic.json: HTTP ${r.status}`);
        return r.json();
      }),
      fetch('layout.bin').then((r) => {
        if (!r.ok) throw new Error(`layout.bin: HTTP ${r.status}`);
        return r.arrayBuffer();
      }),
    ]);
    state.sch = sch;
    const c = centroids(buf);
    state.pos = c.pos;
    state.bounds = c.bounds;

    const pad = 220;
    state.home = [c.bounds.xmin - pad, c.bounds.ymin - pad,
                  (c.bounds.xmax - c.bounds.xmin) + pad * 2,
                  (c.bounds.ymax - c.bounds.ymin) + pad * 2];
    setView(state.home.slice());

    const placed = [...state.pos.keys()].filter((n) => n !== sch.vss && n !== sch.vcc);
    $('dg-stats').textContent =
      `${placed.length} of ${sch.names.length} nodes have a position on the die · `
      + `${sch.counts.transistors} transistors · nothing here is laid out, it is `
      + `read off the geometry`;

    setMode('filtered');

    for (const b of document.querySelectorAll('[data-mode]')) {
      b.addEventListener('click', () => setMode(b.dataset.mode));
    }
    $('dg-home').addEventListener('click', () => {
      setView(state.home.slice());
      state.picked = null;
      paintPicked();
    });

    const svg = $('dg-svg');
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = atClient(e);
      zoomAt(e.deltaY > 0 ? 1.18 : 1 / 1.18, p.x, p.y);
    }, { passive: false });

    // Drag to pan, and a drag is not a click: without the slop a reader who
    // moves four pixels while pressing selects a node they were only sliding
    // past. Same rule and the same reason as the workbench.
    let from = null, moved = 0;
    svg.addEventListener('pointerdown', (e) => { from = atClient(e); moved = 0; });
    svg.addEventListener('pointermove', (e) => {
      if (!from) return;
      const p = atClient(e);
      moved += Math.abs(p.x - from.x) + Math.abs(p.y - from.y);
      const [, , w, h] = state.view;
      setView([state.view[0] - (p.x - from.x), state.view[1] - (p.y - from.y), w, h]);
    });
    const release = () => { from = null; };
    svg.addEventListener('pointerup', release);
    svg.addEventListener('pointerleave', release);
    svg.addEventListener('click', (e) => {
      if (moved > 60) return;
      const t = e.target.closest('.dg-n');
      state.picked = t ? Number(t.dataset.node) : null;
      paintPicked();
    });

    $('dg-boot').hidden = true;
    $('dg-main').hidden = false;
  } catch (e) {
    status.textContent = 'Could not load: ' + (e && e.message ? e.message : e);
    status.classList.add('error');
    throw e;
  }
}

boot();
