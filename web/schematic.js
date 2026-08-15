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
import { setupFullscreen } from './fullscreen.js';

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';

const state = {
  data: null,
  machine: null,
  gateOf: new Map(),      // out node -> gate
  switchesOn: new Map(),  // node -> [switch]
  gatesUsing: new Map(),  // node -> [gate] it is an input to
  switchesBy: new Map(),  // node -> [switch] it opens
  dir: 'back',            // 'back' = what makes it, 'fwd' = what it drives
  root: null,
  depth: 3,
  compare: null,          // [nodeA, nodeB] when comparing two signals
  diffControls: null,     // control names that differ, ringed in the drawing
  solo: false,            // fullscreen: one level, centred, nothing else
  // Half-cycles per second while running in the study view. The page loop does
  // eight per animation frame, which is ~480/s -- fine for watching a die light
  // up, useless for watching six wires change. The point of this mode is to see
  // an edge happen, so it is paced in time rather than in frames.
  soloRate: 4,
  soloAcc: 0,
  lastFrame: 0,
  depthBeforeSolo: 3,
  running: false,
  raf: 0,
  // Where you have been. An entry is `{root, dir, depth}` -- which is exactly
  // what the deep link carries, so a history entry *is* a URL you could have
  // typed. `suppress` is raised while a change is not a navigation (restoring
  // an entry, or fullscreen forcing depth to 1), because those must not be
  // recorded as somewhere you chose to go.
  past: [],
  future: [],
  lastKind: null,
  suppress: 0,
  camG: null,
  dragged: false,
};

const HISTORY_MAX = 200;

const nameOf = (n) => state.data.names[n] ?? `#${n}`;
const isNamed = (n) => state.data.names[n] != null;

// ---------------------------------------------------------------------------
// Cone extraction — the same walk as `Schematic::cone`, in the page so that
// re-rooting and changing depth cost nothing.
// ---------------------------------------------------------------------------

// Most signals drive one or two things -- the median forward fan-out is 1 --
// but `cclk` opens 273 switches and the IR bits feed dozens of terms. Those are
// capped and the cap is reported, because a picture that quietly showed 16 of
// 273 would be a lie about the chip rather than a limit of the page.
const MAX_FAN = 16;

/**
 * Everything behind a signal, or everything in front of it.
 *
 * Backward asks what makes this value: the gate that drives it, and the wires a
 * switch could bring to it. Forward asks what this value changes: the gates it
 * is an input to, and the switches it opens. Pass transistors appear in both,
 * because a pass transistor genuinely is bidirectional -- the direction that is
 * really directional is the gate, and the control line.
 */
function cone(root, depth, dir = 'back') {
  const { vss, vcc } = state.data;
  const isRail = (n) => n === vss || n === vcc;
  const levels = [[root]];
  const seen = new Set([root]);
  const elements = [];
  let truncated = 0;

  for (let level = 0; level < depth; level++) {
    const next = [];
    for (const node of levels[level]) {
      const push = (n) => {
        if (!isRail(n) && !seen.has(n)) { seen.add(n); next.push(n); }
      };
      const cap = (list) => {
        if (list.length <= MAX_FAN) return list;
        truncated += list.length - MAX_FAN;
        return list.slice(0, MAX_FAN);
      };

      if (dir === 'back') {
        const g = state.gateOf.get(node);
        if (g) {
          const inputs = [...new Set(g.terms.flat())];
          elements.push({ kind: g.kind, out: node, inputs, terms: g.terms, level,
                          precharge: g.precharge });
          inputs.forEach(push);
        }
      } else {
        // The gates this signal is an input to: it helps decide their output.
        for (const g of cap(state.gatesUsing.get(node) || [])) {
          elements.push({ kind: g.kind, out: g.out, inputs: [node], terms: g.terms,
                          level, precharge: g.precharge, forward: true });
          push(g.out);
        }
        // ...and the switches it opens, which is what a control line is for.
        for (const w of cap(state.switchesBy.get(node) || [])) {
          for (const side of [w.a, w.b]) {
            if (isRail(side)) continue;
            elements.push({ kind: 'switch', out: side, inputs: [node],
                            control: node, level, forward: true, opens: true });
            push(side);
          }
        }
      }

      // A pass transistor conducts both ways, so its far side belongs to either
      // reading. The control rides on the element as a label and is never
      // expanded: cclk alone gates 273 transistors.
      for (const w of cap(state.switchesOn.get(node) || [])) {
        const far = w.a === node ? w.b : w.a;
        elements.push({ kind: 'switch', out: node, inputs: [far], control: w.control, level });
        push(far);
      }
    }
    if (!next.length) break;
    levels.push(next);
  }
  return { root, levels, elements, dir, truncated };
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
// The camera — pinch, drag and wheel over the drawing
// ---------------------------------------------------------------------------
//
// Live in the study view only. On the page proper the drawing sits in a
// scrolling stage, and claiming the touch stream there would stop a phone
// scrolling the page -- so `touch-action: none` is scoped to `.solo` in the
// stylesheet and every handler below asks `state.solo` before acting.
//
// Zoom is applied as a transform on one wrapper group rather than by rewriting
// the viewBox, so `getScreenCTM()` still maps the screen into the drawing's own
// coordinates and nothing here has to reimplement what `preserveAspectRatio`
// already does.

const cam = { k: 1, tx: 0, ty: 0 };
const MIN_K = 0.4;
const MAX_K = 16;

function applyCam() {
  if (!state.camG) return;
  state.camG.setAttribute('transform', `translate(${cam.tx},${cam.ty}) scale(${cam.k})`);
}

/** Back to the framing the browser chose. */
function fitCam() {
  cam.k = 1; cam.tx = 0; cam.ty = 0;
  applyCam();
}

/**
 * Put content point `c` under user-space point `u`, at scale `k`.
 *
 * Every camera change goes through here, so this is the one place that can
 * refuse a non-finite result -- and it does. A NaN reaching the transform would
 * stick, because NaN survives every comparison, and the drawing would vanish
 * permanently. One dropped frame is the better failure.
 */
function place(k, c, u) {
  const kk = Math.min(MAX_K, Math.max(MIN_K, k));
  const tx = u.x - kk * c.x;
  const ty = u.y - kk * c.y;
  if (!Number.isFinite(kk) || !Number.isFinite(tx) || !Number.isFinite(ty)) return;
  cam.k = kk; cam.tx = tx; cam.ty = ty;
  applyCam();
}

function setupCamera(svg) {
  const live = new Map();
  let gesture = null;   // { c, k0, d0 } -- the content point being held, and the
                        // pinch it started from. One shape for both cases.
  let travel = 0;

  const toUser = (x, y) => {
    const m = svg.getScreenCTM();
    if (!m) return null;
    const p = new DOMPoint(x, y).matrixTransform(m.inverse());
    return Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
  };

  // One constructor for the geometry of a two-finger gesture, and only one.
  // The explorer had two, spelled differently -- one wrote `{x, y}` and the
  // other read `.cx`/`.cy` -- so the first move after a second finger landed
  // computed `undefined` and put NaN into the camera. Anything that needs a
  // midpoint or a spread asks this.
  const pinchOf = (a, b) => ({
    d: Math.hypot(a.x - b.x, a.y - b.y),
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2,
  });

  const contentAt = (u) => ({ x: (u.x - cam.tx) / cam.k, y: (u.y - cam.ty) / cam.k });

  // Seed from whatever is down now. The ratio is always read against this
  // seed rather than accumulated per event, which drifts.
  const seed = () => {
    const pts = [...live.values()];
    if (!pts.length) { gesture = null; return; }
    const anchor = pts.length >= 2 ? pinchOf(pts[0], pts[1]) : { cx: pts[0].x, cy: pts[0].y, d: 0 };
    const u = toUser(anchor.cx, anchor.cy);
    gesture = u ? { c: contentAt(u), k0: cam.k, d0: anchor.d } : null;
  };

  svg.addEventListener('pointerdown', (e) => {
    if (!state.solo) return;
    state.dragged = false;
    travel = 0;
    live.set(e.pointerId, { x: e.clientX, y: e.clientY });
    seed();
    svg.classList.add('dragging');
  });

  // Move and release are watched on the window rather than captured on the SVG:
  // `setPointerCapture` retargets the click that follows, which would break
  // clicking a signal to re-root -- the one interaction this page is for.
  const onMove = (e) => {
    if (!live.has(e.pointerId) || !gesture) return;
    const from = live.get(e.pointerId);
    travel = Math.max(travel, Math.hypot(e.clientX - from.x, e.clientY - from.y));
    live.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const pts = [...live.values()];
    if (pts.length >= 2) {
      const now = pinchOf(pts[0], pts[1]);
      const u = toUser(now.cx, now.cy);
      if (u && gesture.d0 > 0) place(gesture.k0 * (now.d / gesture.d0), gesture.c, u);
    } else {
      const u = toUser(pts[0].x, pts[0].y);
      if (u) place(cam.k, gesture.c, u);
    }
  };

  const onUp = (e) => {
    if (!live.delete(e.pointerId)) return;
    // A finger always moves a little, so the slop that separates a tap from a
    // drag is larger for touch than for a mouse. Without it, every tap on a
    // signal would register as a drag and select nothing.
    const slop = e.pointerType === 'mouse' ? 4 : 12;
    if (travel > slop) state.dragged = true;
    if (live.size) seed(); else { gesture = null; svg.classList.remove('dragging'); }
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);

  svg.addEventListener('wheel', (e) => {
    if (!state.solo) return;
    e.preventDefault();
    const u = toUser(e.clientX, e.clientY);
    if (!u) return;
    place(cam.k * Math.exp(-e.deltaY * 0.0015), contentAt(u), u);
  }, { passive: false });

  svg.addEventListener('dblclick', () => { if (state.solo) fitCam(); });
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
  // A forward cone is the same layout mirrored. Causality has to read the same
  // way in both: the thing being explained sits at the anchored end and what
  // relates to it grows away from it. Backwards that means inputs to the left;
  // forwards it means consumers to the right, so every x is negated and the
  // pills anchor from their other edge.
  const flip = c.dir === 'fwd';
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
  const sx = flip ? -1 : 1;
  c.levels.forEach((nodes, li) => {
    const top = (tallest - (nodes.length - 1) * ROW) / 2;
    nodes.forEach((n, i) => {
      const w = boxWidth(n);
      const x = nodeRight[li] * sx;
      place.set(n, {
        x, y: top + i * ROW, w, flip,
        // Where the box sits, and where a wire meets it. Stored rather than
        // recomputed at every use, so the two cannot disagree about which edge
        // is which.
        boxL: flip ? x : x - w,
        boxR: flip ? x + w : x,
        wireIn: flip ? x + 4 : x - 4,     // just inside, on the element side
        wireOut: flip ? x + w : x - w,    // the far edge, where the output meets it
      });
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
    items.push({ e, out, x: elX[e.level] * sx, y });
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
  for (const p of place.values()) see(p.boxL, p.y - NODE_H / 2, p.boxR, p.y + NODE_H / 2);
  for (const it of items) {
    const railward = it.e.inputs.some((n) => !place.has(n)) ? RAIL_LEAD + 4 : 0;
    see(it.x - EL_W / 2 - railward, it.y - EL_H / 2 - EL_LABEL - 6,
        it.x + EL_W / 2, it.y + EL_H / 2);
  }
  if (!Number.isFinite(minX)) { minX = 0; maxX = 0; minY = 0; maxY = 0; }

  const dx = PAD - minX;
  const dy = PAD - minY;
  for (const p of place.values()) {
    p.x += dx; p.y += dy; p.boxL += dx; p.boxR += dx; p.wireIn += dx; p.wireOut += dx;
  }
  for (const it of items) { it.x += dx; it.y += dy; }
  return { place, items, flip, width: maxX - minX + PAD * 2, height: maxY - minY + PAD * 2 };
}

function draw(c) {
  const svg = $('sch-svg');
  svg.replaceChildren();
  const { place, items, flip, width, height } = layout(c);

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);

  // Everything drawn lives under one group, which is what the camera moves.
  // A new subject gets a fresh framing: staying zoomed into a corner of the
  // last drawing would leave the new one off screen with no sign of why.
  const camG = el('g', { class: 'sch-cam' }, svg);
  state.camG = camG;
  fitCam();

  const wires = el('g', { class: 'sch-wires' }, camG);
  const parts = el('g', { class: 'sch-parts' }, camG);
  const labels = el('g', { class: 'sch-labels' }, camG);
  const { vss, vcc } = state.data;

  for (const { e, out, x: ex, y: ey } of items) {
    // Inputs that are rails have no pill of their own -- they are not signals
    // and do not belong in a level. They still have to be drawn: a precharge
    // transistor to Vcc is most of what a dynamic gate *is*, and dropping it
    // left the caption claiming five switches while none appeared.
    for (const n of e.inputs) {
      const p = place.get(n);
      const sgn = flip ? -1 : 1;
      if (p) {
        el('path', {
          d: `M ${p.wireIn} ${p.y} H ${ex - sgn * (EL_W / 2 + 10)} `
             + `L ${ex - sgn * (EL_W / 2 - 4)} ${ey}`,
          class: 'sch-wire', 'data-from': n,
        }, wires);
      } else {
        const rx = ex - sgn * (EL_W / 2 + RAIL_LEAD);
        el('path', { d: `M ${rx} ${ey} H ${ex - sgn * (EL_W / 2 - 4)}`, class: 'sch-wire' }, wires);
        el('line', { x1: rx, y1: ey - 8, x2: rx, y2: ey + 8, class: 'sch-rail' }, wires);
        // Below the stub rather than beside it: the space under a rail tap is
        // always free, whereas the space to its left is the next column.
        const t = el('text', { x: rx, y: ey + 16, class: 'sch-rail-label' }, labels);
        t.textContent = n === vss ? 'Vss' : n === vcc ? 'Vcc' : '?';
      }
    }
    const sgnOut = flip ? -1 : 1;
    const meet = out.wireOut + sgnOut * 2;
    el('path', { d: `M ${ex + sgnOut * (EL_W / 2 - 4)} ${ey} H ${meet} `
      + `M ${meet} ${ey} V ${out.y} H ${out.wireOut}`, class: 'sch-wire' }, wires);

    if (e.kind === 'switch') {
      // A pass transistor is a gap that a control line closes, so it is drawn
      // as a break in the wire with its control above it.
      const differs = state.diffControls && state.diffControls.has(nameOf(e.control));
      const g = el('g', {
        class: 'sch-el sch-switch' + (differs ? ' cmp-differs' : ''),
        'data-control': e.control,
      }, parts);
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
    el('rect', { x: p.flip ? 0 : -p.w, y: -NODE_H / 2, width: p.w, height: NODE_H,
                 rx: 3, class: 'sch-pill' }, g);
    const t = el('text', { x: (p.flip ? 1 : -1) * p.w / 2, y: 4, class: 'sch-name' }, g);
    t.textContent = nameOf(node);
    // A drag that ends on a signal is panning, not choosing. `state.dragged` is
    // set by the camera on release and cleared on the next press, and click
    // fires straight after release, so this reads the gesture that just ended.
    g.addEventListener('click', () => { if (!state.dragged) setRoot(node); });
  }

  svg.querySelectorAll('.sch-ctrl').forEach((t) => {
    if (!t.dataset.node) return;
    t.style.cursor = 'pointer';
    t.addEventListener('click', () => {
      if (!state.dragged) setRoot(Number(t.dataset.node));
    });
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
// What a signal is
// ---------------------------------------------------------------------------

/**
 * What the name stems stand for.
 *
 * This is the one authored table on the page, and it is only a *reading of the
 * names*: the die calls a wire `sb`, and "special bus" is what that abbreviation
 * has always been taken to mean. Everything else in the panel below -- which
 * block a signal sits in, what it gates, which two units a control line joins
 * and on how many bits -- is measured, and is labelled as such.
 */
const STEMS = {
  sb: 'special bus', dasb: 'special bus (its other name)',
  idb: 'internal data bus', idl: 'input data latch',
  db: 'data pins', ab: 'address pins',
  adl: 'address low, internal', adh: 'address high, internal',
  abl: 'address low, latched to the pins', abh: 'address high, latched to the pins',
  a: 'accumulator', x: 'X index register', y: 'Y index register',
  s: 'stack pointer', p: 'status flags', Pout: 'status flags, read side',
  pcl: 'program counter, low byte', pch: 'program counter, high byte',
  pclp: 'program counter low, precharge', pchp: 'program counter high, precharge',
  alua: 'ALU input A', alub: 'ALU input B', alu: 'ALU result',
  ir: 'instruction register', notir: 'instruction register, complemented',
  pd: 'predecode', dor: 'data output register',
  cclk: 'the clock that latches the decode pipeline',
  cp1: 'clock phase 1', cp2: 'clock phase 2',
  clock1: 'timing chain, stage 1', clock2: 'timing chain, stage 2',
  t2: 'timing state T2', t3: 'timing state T3', t4: 'timing state T4', t5: 'timing state T5',
  sync: 'high during an opcode fetch', rw: 'read/write to the pins',
};

/** Split `sb3` into ("sb", 3), the same rule the Rust side uses. */
function splitBit(name) {
  const m = /^([A-Za-z_]+)(\d+)$/.exec(name);
  return m ? [m[1], Number(m[2])] : null;
}

const ROLE = ['', 'a product term of the decode PLA', 'a decode control line'];

function renderSignal(node) {
  const box = $('sch-signal-info');
  const d = state.data;
  const name = nameOf(node);
  const named = isNamed(node);
  const rows = [];

  const add = (k, v) => rows.push(`<dt>${k}</dt><dd>${v}</dd>`);

  // --- what the name says --------------------------------------------------
  const dpc = /^dpc(-?\d+)_(.+)$/.exec(name);
  const bit = splitBit(name);
  if (dpc) {
    add('Name', `control line <b>${dpc[1]}</b> of the decode pipeline. `
      + `<span class="muted">The suffix <span class="mono">${dpc[2]}</span> is the die's own `
      + `shorthand for what it opens.</span>`);
  } else if (bit && STEMS[bit[0]]) {
    add('Name', `bit <b>${bit[1]}</b> of <span class="mono">${bit[0]}</span> — ${STEMS[bit[0]]}`);
  } else if (STEMS[name]) {
    add('Name', STEMS[name]);
  } else if (/^op-/.test(name)) {
    add('Name', 'a decode PLA product term. '
      + `<span class="muted">The die names these after the T-state and the instructions they serve.</span>`);
  } else if (!named) {
    add('Name', 'unnamed. <span class="muted">An internal node the die trace did not label — '
      + 'most gate outputs are unnamed, because nobody needed to refer to them.</span>');
  }

  // --- what was measured ---------------------------------------------------
  const role = d.nodeRole[node];
  if (role) add('Role <span class="tagm">measured</span>', ROLE[role]);
  add('Region <span class="tagm">measured</span>', d.blockNames[d.nodeBlock[node]]);

  const g = state.gateOf.get(node);
  if (g) {
    const kind = { inverter: 'an inverter', nor: 'a NOR', nand: 'a NAND',
                   aoi: 'an and-or-invert', dynamic: 'a precharged (dynamic) gate' }[g.kind];
    const inputs = new Set(g.terms.flat()).size;
    add('Driven by <span class="tagm">measured</span>',
        `${kind} of ${inputs} input${inputs === 1 ? '' : 's'}`
        + (g.precharge >= 0 ? `, precharged by <span class="mono">${nameOf(g.precharge)}</span>` : ''));
  } else {
    add('Driven by <span class="tagm">measured</span>',
        '<span class="muted">no gate — it is fed through switches only</span>');
  }

  const fan = d.nodeFanout[node];
  add('Gates <span class="tagm">measured</span>',
      `${fan} transistor${fan === 1 ? '' : 's'}`
      + (fan === 0 ? ' <span class="muted">— it drives nothing</span>' : ''));

  // The blueprint measured which two units a control line joins. This is the
  // part that turns a name like SBX into a fact rather than an expansion.
  const path = (d.controlPaths || []).find((p) => p[0] === node);
  if (path) {
    const [, a, b, bits] = path;
    const n = (bits.toString(2).match(/1/g) || []).length;
    add('Opens <span class="tagm">measured</span>',
        `<span class="mono">${a}</span> ${STEMS[a] ? `(${STEMS[a]})` : ''} `
        + `→ <span class="mono">${b}</span> ${STEMS[b] ? `(${STEMS[b]})` : ''}`
        + `, on ${n === 8 ? 'all 8 bits' : `${n} bit${n === 1 ? '' : 's'}`}`);
  }

  box.innerHTML = `<h3 class="sch-sig-name">${name}<span class="sch-sig-id">node ${node}</span></h3>`
    + `<dl class="ends">${rows.join('')}</dl>`;
}

/** The key. Draws the same symbols the diagram does, at the same size. */
function buildLegend() {
  const host = $('sch-key');
  host.replaceChildren();
  const item = (title, note, paint) => {
    const fig = document.createElement('figure');
    fig.className = 'sch-key-item';
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 70 44');
    svg.setAttribute('class', 'sch-key-svg');
    paint(svg);
    const cap = document.createElement('figcaption');
    cap.innerHTML = `<b>${title}</b><span>${note}</span>`;
    fig.append(svg, cap);
    host.append(fig);
  };

  const gate = (glyph, cls) => (svg) => {
    const g = el('g', { class: `sch-el sch-gate ${cls}` }, svg);
    el('path', { d: 'M 18 6 L 18 38 L 44 22 Z', class: 'sch-body' }, g);
    el('circle', { cx: 49, cy: 22, r: 5, class: 'sch-bubble' }, g);
    el('path', { d: 'M 4 22 H 18 M 54 22 H 66', class: 'sch-wire' }, svg);
    const t = el('text', { x: 27, y: 26, class: 'sch-kind' }, g);
    t.textContent = glyph;
  };

  item('Inverter', 'out is low when its one input is high', gate('1', 'sch-inverter'));
  item('NOR ≥1', 'low if <em>any</em> input is high — transistors in parallel', gate('≥1', 'sch-nor'));
  item('NAND &', 'low only if <em>all</em> inputs are high — in series', gate('&', 'sch-nand'));
  item('And-or-invert', 'a mix of both, in one gate', gate('&≥', 'sch-aoi'));
  item('Precharged φ', 'no pullup: a clock charges it, the network drains it',
       gate('φ', 'sch-dynamic'));
  item('Switch', 'a pass transistor. The name above it is what opens it', (svg) => {
    const g = el('g', { class: 'sch-el sch-switch' }, svg);
    el('path', { d: 'M 4 26 H 27 M 43 26 H 66', class: 'sch-wire' }, svg);
    el('line', { x1: 31, y1: 17, x2: 31, y2: 35, class: 'sch-sw-plate' }, g);
    el('line', { x1: 39, y1: 17, x2: 39, y2: 35, class: 'sch-sw-plate' }, g);
    el('line', { x1: 35, y1: 6, x2: 35, y2: 17, class: 'sch-sw-gate' }, g);
  });
  item('Power rail', 'Vcc above, Vss below — where a gate pulls to', (svg) => {
    el('path', { d: 'M 20 22 H 60', class: 'sch-wire' }, svg);
    el('line', { x1: 20, y1: 12, x2: 20, y2: 32, class: 'sch-rail' }, svg);
    const t = el('text', { x: 20, y: 42, class: 'sch-rail-label' }, svg);
    t.textContent = 'Vcc';
  });
  item('Signal', 'a wire. Click it to make it the subject', (svg) => {
    const g = el('g', { class: 'sch-node', transform: 'translate(62,22)' }, svg);
    el('rect', { x: -56, y: -11, width: 56, height: 22, rx: 3, class: 'sch-pill' }, g);
    const t = el('text', { x: -28, y: 4, class: 'sch-name' }, g);
    t.textContent = 'sb3';
  });
  item('Lit', 'a signal that is high right now, with the chip running', (svg) => {
    const g = el('g', { class: 'sch-node hot', transform: 'translate(62,22)' }, svg);
    el('rect', { x: -56, y: -11, width: 56, height: 22, rx: 3, class: 'sch-pill' }, g);
    const t = el('text', { x: -28, y: 4, class: 'sch-name' }, g);
    t.textContent = 'sb3';
  });
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

/**
 * One half-cycle forward or back, applied at once.
 *
 * Rewind is keyframed and bounded, so the earliest reachable half-cycle is not
 * necessarily zero; a refusal at the start of history is normal, not an error.
 */
function step(dir) {
  setRunning(false);
  if (dir > 0) state.machine.halfStep();
  else state.machine.stepBack();
  refresh();
}

// ---------------------------------------------------------------------------
// Where you have been
// ---------------------------------------------------------------------------
//
// `{root, dir, depth}` is the whole of the view state and the whole of the deep
// link, so an entry in this stack is a URL. Re-rooting, flipping direction and
// changing depth all move you, and until now none of them left a way back --
// which mattered more once there were two directions to get lost in.

const viewOf = () => ({ root: state.root, dir: state.dir, depth: state.depth });

/** Raise `suppress` for a change that is not a navigation. */
function withoutHistory(fn) {
  state.suppress++;
  try { fn(); } finally { state.suppress--; }
}

/**
 * Record where you are, before going somewhere else.
 *
 * `kind` exists for one case: the depth slider fires an event per integer, so
 * dragging from 3 to 6 is three events and one navigation. Consecutive depth
 * changes on the same signal coalesce, and what you come back to is the depth
 * you set out from rather than the last value the slider passed through.
 */
function remember(kind) {
  if (state.suppress || state.root == null) return;
  const top = state.past[state.past.length - 1];
  if (kind === 'depth' && state.lastKind === 'depth'
      && top && top.root === state.root && top.dir === state.dir) return;
  state.past.push(viewOf());
  if (state.past.length > HISTORY_MAX) state.past.shift();
  state.future.length = 0;
  state.lastKind = kind;
  paintHistory();
}

function paintHistory() {
  const set = (id, on) => { const b = $(id); if (b) b.disabled = !on; };
  set('sch-back', state.past.length > 0);
  set('sch-fwd', state.future.length > 0);
  set('solo-back-nav', state.past.length > 0);
  set('solo-fwd-nav', state.future.length > 0);
}

function restore(v) {
  withoutHistory(() => {
    state.root = v.root;
    state.dir = v.dir;
    // The study view is one level by definition, so returning restores *where*
    // you were and not how deep -- otherwise stepping back past the moment you
    // went fullscreen would quietly break the one thing that mode promises.
    if (!state.solo) state.depth = Math.max(1, Math.min(6, v.depth));
    paintDir();
    paintDepth();
    clearCompare();
    renderSignal(state.root);
    paintPicker();
    render();
    syncUrl();
  });
  state.lastKind = null;
  paintHistory();
}

function goBack() {
  const prev = state.past.pop();
  if (!prev) return;
  state.future.push(viewOf());
  restore(prev);
}

function goForward() {
  const next = state.future.pop();
  if (!next) return;
  state.past.push(viewOf());
  restore(next);
}

// ---------------------------------------------------------------------------

function syncUrl() {
  const q = new URLSearchParams(location.search);
  q.set('signal', nameOf(state.root));
  q.set('dir', state.dir);
  q.set('depth', String(state.depth));
  history.replaceState(null, '', '?' + q.toString());
}

function clearCompare() {
  state.compare = null;
  state.diffControls = null;
  const box = $('sch-compare-out');
  if (box) box.hidden = true;
}

/** Keep the picker on the signal being shown, when it holds it at all. */
function paintPicker() {
  const sel = $('sch-signal');
  if (sel && sel.querySelector(`option[value="${state.root}"]`)) {
    sel.value = String(state.root);
  }
}

function paintDir() {
  const back = $('dir-back');
  const fwd = $('dir-fwd');
  if (back) back.classList.toggle('on', state.dir === 'back');
  if (fwd) fwd.classList.toggle('on', state.dir === 'fwd');
  const solo = $('solo-dir');
  if (solo) {
    solo.classList.toggle('on', state.dir === 'fwd');
    solo.title = state.dir === 'fwd' ? 'Showing what it drives (d)' : 'Showing what makes it (d)';
  }
}

function paintDepth() {
  const el = $('sch-depth');
  if (el) {
    el.value = String(state.depth);
    const out = $('sch-depth-val');
    if (out) out.textContent = String(state.depth);
  }
}

/** The only place direction changes, so the two toggles cannot disagree. */
function setDir(dir) {
  const next = dir === 'fwd' ? 'fwd' : 'back';
  if (next !== state.dir) remember('dir');
  state.dir = next;
  paintDir();
  render();
  syncUrl();
}

/** The only place run state changes, so the two transports cannot disagree. */
function setRunning(on) {
  state.running = on;
  state.soloAcc = 0;
  const a = $('sch-run');
  if (a) a.textContent = on ? 'Pause' : 'Run';
  const b = $('solo-run');
  if (b) {
    b.textContent = on ? '❙❙' : '▶';
    b.setAttribute('aria-label', on ? 'Pause' : 'Run');
    b.classList.toggle('on', on);
  }
}

/** The only place depth changes, so the slider and solo mode cannot disagree. */
function setDepth(n) {
  const next = Math.max(1, Math.min(6, n));
  if (next !== state.depth) remember('depth');
  state.depth = next;
  paintDepth();
  render();
}

function setRoot(node) {
  if (node !== state.root) remember('root');
  state.root = node;
  renderSignal(node);
  clearCompare();
  paintPicker();
  render();
  syncUrl();
}

function render() {
  const c = cone(state.root, state.depth, state.dir);
  draw(c);
  const gates = c.elements.filter((e) => e.kind !== 'switch').length;
  const sw = c.elements.length - gates;
  const way = c.dir === 'fwd' ? 'levels forward' : 'levels back';
  const capped = c.truncated
    ? ` · ${c.truncated} more not shown (fan-out capped at ${MAX_FAN})`
    : '';
  $('sch-caption').textContent =
    `${nameOf(state.root)} — ${c.levels.reduce((a, l) => a + l.length, 0)} signals, `
    + `${gates} gates, ${sw} switches, ${c.levels.length} ${way}${capped}`;
}

/** Turn a signature entry into something a reader can act on. */
function describe(sig) {
  const [level, kind, rest] = sig.split(':');
  const at = `<span class="cmp-lvl">${level} back</span>`;
  if (kind === 'switch') {
    const short = (rest || '').replace(/^dpc-?\d*_?/, '');
    return `${at} a switch opened by <span class="mono">${short}</span>`;
  }
  const g = { inverter: 'an inverter', nor: 'a NOR', nand: 'a NAND',
              aoi: 'an and-or-invert', dynamic: 'a precharged gate' }[rest] || rest;
  return `${at} ${g}`;
}

/**
 * Compare two signals as circuits.
 *
 * The counts alone say "these differ", which is the least useful form of the
 * answer. What matters is *which* elements differ, so both sides are listed and
 * the differing controls are highlighted in the drawing as well.
 */
function runCompare(a, b) {
  const ca = cone(a, state.depth, state.dir);
  const cb = cone(b, state.depth, state.dir);
  const d = diff(ca, cb);
  state.compare = [a, b];

  // The control lines that appear on one side only -- the concrete difference.
  const controlsOf = (list) => [...new Set(list
    .filter((x) => x.includes(':switch:'))
    .map((x) => x.split(':').slice(2).join(':')))];
  state.diffControls = new Set([...controlsOf(d.onlyA), ...controlsOf(d.onlyB)]);

  const list = (items) => items.length
    ? `<ul class="cmp-list">${items.map((x) => `<li>${describe(x)}</li>`).join('')}</ul>`
    : '<p class="muted">nothing — every element here has a partner</p>';

  const same = !d.onlyA.length && !d.onlyB.length;
  const total = d.shared.length + d.onlyA.length + d.onlyB.length;
  const box = $('sch-compare-out');
  box.hidden = false;
  box.innerHTML = `
    <h3 class="cmp-head">
      <span class="mono">${nameOf(a)}</span> vs <span class="mono">${nameOf(b)}</span>
    </h3>
    <p class="${same ? 'sch-same' : 'sch-differ'}">
      ${same
        ? `<strong>Identical circuits.</strong> All ${d.shared.length} elements match.`
        : `<strong>Different circuits.</strong> ${d.shared.length} of ${total} elements match; `
          + `${d.onlyA.length + d.onlyB.length} do not.`}
    </p>
    <div class="cmp-cols">
      <div><h4>Only <span class="mono">${nameOf(a)}</span></h4>${list(d.onlyA)}</div>
      <div><h4>Only <span class="mono">${nameOf(b)}</span></h4>${list(d.onlyB)}</div>
    </div>
    <p class="cmp-note">
      Compared as <em>shape</em>: how many elements of each kind sit at each level
      behind the signal, with a switch identified by the control line that opens
      it. Two bits of one bus use different wires by definition — the question is
      whether they are wired the <em>same way</em>, and mostly they are not.
      ${state.diffControls.size
        ? 'The differing controls are ringed in the drawing below.'
        : ''}
    </p>`;

  // Draw the first of the pair, with the differences marked. This moves the
  // subject, so it is somewhere you can come back from -- but the comparison
  // itself is not part of the view state and does not survive going back.
  if (a !== state.root) remember('root');
  state.root = a;
  renderSignal(a);
  paintPicker();
  render();
  syncUrl();
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
      // ...and the other direction: what this control line opens.
      if (!state.switchesBy.has(control)) state.switchesBy.set(control, []);
      state.switchesBy.get(control).push({ control, a, b });
    }
    for (const g of state.gateOf.values()) {
      for (const lit of new Set(g.terms.flat())) {
        if (!state.gatesUsing.has(lit)) state.gatesUsing.set(lit, []);
        state.gatesUsing.get(lit).push(g);
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
    state.dir = q.get('dir') === 'fwd' ? 'fwd' : 'back';
    $('sch-depth').value = String(state.depth);
    $('sch-depth-val').textContent = String(state.depth);

    const want = q.get('signal');
    const byName = new Map(data.names.map((n, i) => [n, i]).filter(([n]) => n));
    state.root = byName.get(want) ?? byName.get('dpc3_SBX') ?? byName.get('a0') ?? 0;

    buildPicker();
    $('sch-filter').addEventListener('input', buildPicker);
    $('sch-signal').addEventListener('change', (e) => setRoot(Number(e.target.value)));
    $('sch-depth').addEventListener('input', (e) => setDepth(Number(e.target.value)));
    $('sch-run').addEventListener('click', () => setRunning(!state.running));
    $('solo-run').addEventListener('click', () => setRunning(!state.running));
    $('solo-step').addEventListener('click', () => step(+1));
    $('solo-back').addEventListener('click', () => step(-1));

    $('sch-back').addEventListener('click', goBack);
    $('sch-fwd').addEventListener('click', goForward);
    $('solo-back-nav').addEventListener('click', goBack);
    $('solo-fwd-nav').addEventListener('click', goForward);
    $('solo-fit').addEventListener('click', fitCam);
    setupCamera($('sch-svg'));

    // Keyboard, because the study view is meant to be looked at rather than
    // aimed at. Ignored while typing in the filter box.
    document.addEventListener('keydown', (ev) => {
      if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement) return;
      // History works wherever the drawing does. The clock and the camera below
      // only exist in the study view. `←`/`→` belong to the clock, which is why
      // going back is on the brackets.
      if (ev.key === '[' || ev.key === 'Backspace') { goBack(); ev.preventDefault(); return; }
      if (ev.key === ']') { goForward(); ev.preventDefault(); return; }
      if (!state.solo) return;
      if (ev.key === '0') { fitCam(); ev.preventDefault(); }
      else if (ev.key === ' ') { setRunning(!state.running); ev.preventDefault(); }
      else if (ev.key === 'ArrowRight') { step(+1); ev.preventDefault(); }
      else if (ev.key === 'ArrowLeft') { step(-1); ev.preventDefault(); }
      else if (ev.key === 'd' || ev.key === 'D') {
        setDir(state.dir === 'back' ? 'fwd' : 'back');
        ev.preventDefault();
      }
    });
    $('sch-step').addEventListener('click', () => step(+1));
    $('sch-solo-exit').addEventListener('click', () => $('sch-fullscreen').click());
    $('dir-back').addEventListener('click', () => setDir('back'));
    $('dir-fwd').addEventListener('click', () => setDir('fwd'));
    $('solo-dir').addEventListener('click', () =>
      setDir(state.dir === 'back' ? 'fwd' : 'back'));

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

    // ...and the same comparison between any two signals, since the interesting
    // pairs are not always two bits of one bus: a control line against its
    // complement, or the same bit of two different buses.
    const named = data.names.map((n, i) => [n, i]).filter(([n]) => n)
      .sort((x, y) => x[0].localeCompare(y[0]));
    for (const id of ['sch-any-a', 'sch-any-b']) {
      const sel = $(id);
      for (const [name, node] of named) {
        const o = document.createElement('option');
        o.value = String(node);
        o.textContent = name;
        sel.append(o);
      }
    }
    $('sch-any-a').value = String(byName.get('sb0') ?? named[0][1]);
    $('sch-any-b').value = String(byName.get('sb7') ?? named[1][1]);
    $('sch-compare-any').addEventListener('click', () =>
      runCompare(Number($('sch-any-a').value), Number($('sch-any-b').value)));

    // Fullscreen is not "the page without its chrome". It is a different way of
    // looking: one level behind the selected signal, centred on an empty
    // screen, with everything else out of the way. Clicking a signal re-roots
    // and stays there, which is how a reader walks the islands.
    const console_ = document.querySelector('.console');
    setupFullscreen(console_, $('sch-fullscreen'), () => {
      const on = console_.classList.contains('immersive');
      // Entering and leaving is not a navigation: the depth swap below is the
      // mode's doing, not the reader's, and recording it would put a step in
      // the history that nothing on screen corresponds to.
      withoutHistory(() => {
        if (on && !state.solo) {
          state.depthBeforeSolo = state.depth;
          setDepth(1);
        } else if (!on && state.solo) {
          setDepth(state.depthBeforeSolo);
        }
      });
      state.solo = on;
      console_.classList.toggle('solo', on);
      if (state.root != null) render();
      // The clock readout only exists in this mode, so entering has to populate
      // it rather than waiting for the next animation frame.
      refresh();
    });

    if (q.get('compare')) {
      const [x, y] = q.get('compare').split(',');
      const a = byName.get(x), b = byName.get(y);
      if (a != null && b != null) runCompare(a, b);
    }

    buildLegend();
    paintHistory();
    renderSignal(state.root);
    setDir(state.dir);
    $('sch-boot').hidden = true;
    $('sch-main').hidden = false;
    tick();
  } catch (e) {
    status.textContent = 'Could not load: ' + (e && e.message ? e.message : e);
    status.classList.add('error');
    throw e;
  }
}

/**
 * Push the machine's current state into the drawing.
 *
 * Called from the frame loop while running, and directly after any discrete
 * step. A step used to wait for the next animation frame, which is a real
 * responsiveness bug -- and is invisible until the page is driven somewhere
 * animation frames are throttled, such as inside an iframe.
 */
function refresh() {
  const m = state.machine;
  const out = $('solo-clock');
  if (state.solo && out) {
    const parts = [`½cyc ${m.halfCycle()}`, m.clk0() ? 'φ1' : 'φ2', m.timingStates() || '—'];
    if (m.sync()) parts.push('sync');
    const text = parts.join(' · ');
    if (out.textContent !== text) out.textContent = text;
  }
  paint(m.nodeLevels());
}

function tick(now = 0) {
  const m = state.machine;
  if (state.running) {
    if (state.solo) {
      // Paced in wall-clock time so an edge is watchable.
      const dt = state.lastFrame ? Math.min(now - state.lastFrame, 250) : 0;
      state.soloAcc += (dt / 1000) * state.soloRate;
      while (state.soloAcc >= 1) { m.halfStep(); state.soloAcc -= 1; }
    } else {
      for (let i = 0; i < 8; i++) m.halfStep();
    }
  }
  state.lastFrame = now;
  refresh();
  state.raf = requestAnimationFrame(tick);
}

boot();
