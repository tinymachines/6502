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
  // The walk, as islands still on screen. An entry is `{node, from}` -- the
  // signal, and the index of the island whose pill was clicked to reach it, so
  // the thread joining them starts where the reader actually pressed. `from` is
  // -1 when there is no such island: the first entry, or one whose anchor has
  // since been dropped off the end.
  trail: [],
  islands: [],     // laid-out geometry, one per trail entry
  world: null,     // the union of them, which is what "fit" fits
  // The study view's console: which tab is showing, the object that paints it,
  // and where the reader dragged the panel to.
  tab: 'signal',
  drawer: true,
  panel: null,
  palPos: null,
  // Whether the camera has been aimed at this bench yet. Raised on the first
  // draw after entering the study view and lowered on leaving, so a re-render
  // caused by walking somewhere leaves the view exactly as the reader left it.
  framed: false,
  viewBox: null,
};

const HISTORY_MAX = 200;

// How many islands stay on screen. The walk is the point of the study view, so
// the last few steps of it are worth keeping -- but a ribbon that grows without
// limit ends up too small to read at any zoom that shows all of it. The cap is
// declared on the Walk tab rather than applied quietly.
const TRAIL_MAX = 6;

// Space between one island and the next, in drawing units.
const TRAIL_GAP = 90;

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
// The lower bound has to reach a whole walk: six islands side by side are
// roughly a tenth the width of one, and 0.4 would refuse to show the reader
// their own walk.
const MIN_K = 0.05;
const MAX_K = 16;

// The study view's coordinate space, and it is *fixed*.
//
// This is what makes the workbench a workbench. The page proper sizes the
// viewBox to its one drawing, which is right there -- but in the study view the
// drawing grows as you walk, and a viewBox that tracked it would move the world
// under the camera on every step. Islands would drift, the zoom would change
// meaning, and putting something somewhere would not keep it there. So the
// space is constant and only the camera moves in it.
const WORKBENCH = { w: 1200, h: 800 };

// How far the initial framing is allowed to magnify. A cone of four signals
// would otherwise be scaled to fill a 1400px screen, which draws one inverter
// the size of a hand and leaves no room for the island you walk to next.
const MAX_FIT = 2;

function applyCam() {
  if (!state.camG) return;
  state.camG.setAttribute('transform', `translate(${cam.tx},${cam.ty}) scale(${cam.k})`);
}

/**
 * Frame a rectangle of the drawing.
 *
 * The viewBox is the size of the *current* island, and the browser is already
 * scaling that to the element with `preserveAspectRatio`. So fitting something
 * to the viewBox fits it to the screen, and nothing here has to measure the
 * canvas -- which is the same reason the single-island version never did.
 */
function frameOn(box, maxScale = Infinity) {
  const vb = state.viewBox;
  if (!vb || !box || box.w <= 0 || box.h <= 0) return;
  const k = Math.min(vb.w / box.w, vb.h / box.h, maxScale);
  place(k, { x: box.x + box.w / 2, y: box.y + box.h / 2 }, { x: vb.w / 2, y: vb.h / 2 });
}

/** The signal being studied, fitted to the portal. */
function focusCurrent() {
  const cur = state.islands[state.islands.length - 1];
  if (cur) frameOn(cur.box, MAX_FIT);
}

/** Everything you have walked through, however small that makes it. */
function fitAll() {
  if (state.world) frameOn(state.world);
}

/**
 * Nudge a box into view, without changing the zoom.
 *
 * The bench keeps what is put on it, so walking somewhere must not re-frame the
 * view -- but the island you just clicked into being has to be somewhere you can
 * see. This pans by the least it can and never scales, so the reader's zoom and
 * everything else's position survive; a box already in view moves nothing at
 * all.
 */
function ensureVisible(box, margin = 24) {
  const vb = state.viewBox;
  if (!vb || !box) return;
  const x0 = cam.k * box.x + cam.tx, x1 = cam.k * (box.x + box.w) + cam.tx;
  const y0 = cam.k * box.y + cam.ty, y1 = cam.k * (box.y + box.h) + cam.ty;
  const shift = (lo, hi, span) => {
    if (hi - lo > span) return (span - (lo + hi)) / 2;   // too big to fit: centre it
    if (hi > span - margin) return span - margin - hi;
    if (lo < margin) return margin - lo;
    return 0;
  };
  const dx = shift(x0, x1, vb.w);
  const dy = shift(y0, y1, vb.h);
  if (!dx && !dy) return;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  cam.tx += dx;
  cam.ty += dy;
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

/**
 * Pan, pinch and wheel over the whole workbench.
 *
 * Listened for on the *stage*, not on the drawing. An `<svg>` only hit-tests
 * where it has been painted, so with a bench that is mostly empty space a finger
 * landing between two islands would reach nothing and the gesture would not
 * start -- which is exactly what a pinch on a phone does most of the time. The
 * SVG is still what maps screen coordinates into the drawing.
 */
function setupCamera(stage, svg) {
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

  stage.addEventListener('pointerdown', (e) => {
    if (!state.solo) return;
    // The console floats over the bench and has its own drag. A press that
    // starts on it is never a pan.
    if (e.target.closest && e.target.closest('.solo-palette')) return;
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

  stage.addEventListener('wheel', (e) => {
    if (!state.solo) return;
    if (e.target.closest && e.target.closest('.solo-palette')) return;
    e.preventDefault();
    const u = toUser(e.clientX, e.clientY);
    if (!u) return;
    place(cam.k * Math.exp(-e.deltaY * 0.0015), contentAt(u), u);
  }, { passive: false });

  stage.addEventListener('dblclick', () => { if (state.solo) fitAll(); });
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

  // Where each control line's *name* was written. A control is never a pill --
  // it rides on the edge of a switch and is deliberately not expanded -- but
  // clicking one is a first-class way to change the subject, so the walk needs
  // somewhere on this island to hang the next thread from. Without it, following
  // a control line produced an island joined to nothing.
  const ctrl = new Map();
  for (const it of items) {
    if (it.e.kind !== 'switch' || it.e.control == null) continue;
    if (!ctrl.has(it.e.control)) ctrl.set(it.e.control, { x: it.x, y: it.y - EL_H / 2 - 12 });
  }

  return { place, ctrl, items, flip,
           width: maxX - minX + PAD * 2, height: maxY - minY + PAD * 2 };
}

/**
 * Draw one cone into its own group.
 *
 * The island keeps its local coordinates and is positioned by a transform on
 * the group, so every raw `x`/`y` written here stays inside the island's own
 * box -- which is what the layout harness checks, and what would stop being
 * true if the offset were baked into the numbers instead.
 */
function drawIsland(host, c, L, index) {
  const { place, items, flip } = L;
  const wires = el('g', { class: 'sch-wires' }, host);
  const parts = el('g', { class: 'sch-parts' }, host);
  const labels = el('g', { class: 'sch-labels' }, host);
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
    g.addEventListener('click', () => { if (!state.dragged) setRoot(node, index); });
  }

  host.querySelectorAll('.sch-ctrl').forEach((t) => {
    if (!t.dataset.node) return;
    t.style.cursor = 'pointer';
    t.addEventListener('click', () => {
      if (!state.dragged) setRoot(Number(t.dataset.node), index);
    });
  });
}

/**
 * Lay the islands of a walk out beside one another.
 *
 * Each island is placed so that the signal it is rooted on sits just beyond the
 * pill that was clicked to reach it, in the direction the drawing grows -- left
 * for a backward walk, right for a forward one. So the ribbon reads the same way
 * round as a single island does, and the thread between two islands is the click
 * that joined them.
 */
/**
 * Which island a step was taken from.
 *
 * The reader's own click, when that island is still on screen; the one before,
 * when it is not. Both the layout and the thread ask this, and they have to
 * agree or the thread would start somewhere the island is not.
 */
function anchorOf(i) {
  const from = state.trail[i] ? state.trail[i].from : -1;
  return from >= 0 && from < i ? from : i - 1;
}

/**
 * Where on an island the step to `node` was taken from.
 *
 * A pill if that signal is drawn there, its label if `node` is a control line
 * on one of its switches, and nothing if the island has neither -- which is a
 * real case, since an island can be dropped off the end of the walk. Both the
 * layout and the thread ask this, so they cannot disagree about where the step
 * came from.
 */
function anchorIn(L, node) {
  const pill = L.place.get(node);
  if (pill) return { x: L.flip ? pill.boxR : pill.boxL, y: pill.y, kind: 'wire' };
  const label = L.ctrl.get(node);
  if (label) return { x: label.x, y: label.y, kind: 'control' };
  return null;
}

function arrange(layouts) {
  const offs = [];
  for (let i = 0; i < layouts.length; i++) {
    if (i === 0) { offs.push({ x: 0, y: 0 }); continue; }
    const L = layouts[i];
    const sgn = L.flip ? 1 : -1;               // which way this walk grows
    const root = L.place.get(L.root);
    const anchorIsland = anchorOf(i);
    const anchor = anchorIsland >= 0 ? anchorIn(layouts[anchorIsland], L.root) : null;

    let x, y;
    if (root && anchor) {
      const a = offs[anchorIsland];
      // Whatever was clicked -- the near edge of a pill, or a control's label --
      // plus a gutter, is where the new island's own root pill goes.
      x = a.x + anchor.x + (sgn < 0 ? -TRAIL_GAP - root.boxR : TRAIL_GAP - root.boxL);
      y = a.y + anchor.y - root.y;
    } else {
      // Nothing to hang it on -- the anchor island has been dropped off the end
      // of the walk. Put it beside the one before, which is at least a walk.
      const p = offs[i - 1], P = layouts[i - 1];
      x = sgn < 0 ? p.x - TRAIL_GAP - L.width : p.x + P.width + TRAIL_GAP;
      y = p.y;
    }

    // Push it clear of anything already placed. Islands are displaced sideways
    // from their anchor, so this rarely fires -- but a walk that doubles back
    // on itself would otherwise draw one island on top of another.
    const boxOf = (j, o) => ({ x: o.x, y: o.y, w: layouts[j].width, h: layouts[j].height });
    const hits = (b) => offs.some((o, j) => {
      const q = boxOf(j, o);
      return b.x < q.x + q.w && q.x < b.x + b.w && b.y < q.y + q.h && q.y < b.y + b.h;
    });
    for (let guard = 0; guard < 24 && hits({ x, y, w: L.width, h: L.height }); guard++) {
      y += L.height + TRAIL_GAP / 2;
    }
    offs.push({ x, y });
  }
  return offs;
}

/**
 * Draw a whole walk: the current island, and the ones it came from.
 *
 * The viewBox stays the size of the *current* island, not of the walk. That is
 * what keeps a signal at reading size however far you have walked -- the world
 * grows around it and the camera moves within it, rather than the browser
 * scaling everything down to fit an ever-wider ribbon.
 */
function drawTrail(cones) {
  const svg = $('sch-svg');
  svg.replaceChildren();

  const layouts = cones.map((c) => Object.assign(layout(c), { root: c.root }));
  const offs = arrange(layouts);
  const cur = layouts.length - 1;

  // The page proper is sized to its one drawing; the study view is a fixed
  // workbench the camera moves around in. Anything else and adding an island
  // would move everything already on the bench.
  const vb = state.solo ? WORKBENCH : { w: layouts[cur].width, h: layouts[cur].height };
  state.viewBox = vb;
  svg.setAttribute('viewBox', `0 0 ${vb.w} ${vb.h}`);
  svg.setAttribute('width', vb.w);
  svg.setAttribute('height', vb.h);

  // Everything drawn lives under one group, which is what the camera moves.
  const camG = el('g', { class: 'sch-cam' }, svg);
  state.camG = camG;

  if (state.solo) drawGrid(svg, camG);

  // The bench card: a shaded patch under the island being studied.
  //
  // Marking the current one is better than dimming the others, which is what
  // this did first. Every island on the bench is live -- the state overlay
  // paints all of them -- so fading the ones you walked through was saying
  // "these are less real" when what was meant is "this is the one you are on".
  // Drawn before the islands and after the grid, so it reads as bench rather
  // than as part of any circuit.
  // Only on the bench: the page proper draws one island, and a card around the
  // only thing on screen marks nothing.
  const card = state.solo ? el('rect', { class: 'sch-bench-card', rx: 10 }, camG) : null;

  // Threads next, so they pass behind the pills they join.
  const threads = el('g', { class: 'sch-threads' }, camG);

  state.islands = [];
  layouts.forEach((L, i) => {
    const o = offs[i];
    const g = el('g', {
      class: 'sch-island' + (i === cur ? ' current' : ' past'),
      'data-island': i,
      transform: `translate(${o.x},${o.y})`,
    }, camG);
    drawIsland(g, cones[i], L, i);
    state.islands.push({ box: { x: o.x, y: o.y, w: L.width, h: L.height }, root: L.root });
  });

  // The click that joined two islands, drawn as the thread it was.
  //
  // Every island after the first is joined to the one it came from. It used to
  // give up when the new subject had no pill on the anchoring island and drew
  // nothing at all -- which happens on the most ordinary move there is, clicking
  // a control line, since a control is never a pill. The result was a ribbon in
  // two halves with no sign of why, so the join now always exists and says which
  // kind it is: a wire that was followed, or a jump.
  for (let i = 1; i < layouts.length; i++) {
    const from = anchorOf(i);
    const b = layouts[i].place.get(layouts[i].root);
    if (!b) continue;
    const flip = layouts[i].flip;
    const bx = offs[i].x + (flip ? b.boxL : b.boxR);
    const by = offs[i].y + b.y;

    const a = from >= 0 ? anchorIn(layouts[from], layouts[i].root) : null;
    let ax, ay, kind;
    if (a) {
      ax = offs[from].x + a.x;
      ay = offs[from].y + a.y;
      kind = a.kind;
    } else {
      // The island it came from is no longer on the bench. Come off the edge of
      // the one before, at the height of where you landed.
      const j = i - 1;
      const box = { x: offs[j].x, y: offs[j].y, w: layouts[j].width, h: layouts[j].height };
      ax = flip ? box.x + box.w : box.x;
      ay = Math.min(Math.max(by, box.y), box.y + box.h);
      kind = 'gone';
    }
    const mid = (ax + bx) / 2;
    el('path', {
      d: `M ${ax} ${ay} C ${mid} ${ay}, ${mid} ${by}, ${bx} ${by}`,
      class: 'sch-thread' + (kind === 'wire' ? '' : ' sch-jump'),
    }, threads);
  }

  // Sized to the island it marks, once that island has a position. The layout
  // already carries PAD inside its box, so this only adds enough for the card
  // to read as something the circuit is sitting on.
  if (card) {
    const on = state.islands[cur];
    const bleed = 12;
    for (const [k, v] of Object.entries({
      x: on.box.x - bleed, y: on.box.y - bleed,
      width: on.box.w + bleed * 2, height: on.box.h + bleed * 2,
    })) card.setAttribute(k, v);
  }

  // The world, which is what "fit everything" fits.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const isl of state.islands) {
    x0 = Math.min(x0, isl.box.x); y0 = Math.min(y0, isl.box.y);
    x1 = Math.max(x1, isl.box.x + isl.box.w); y1 = Math.max(y1, isl.box.y + isl.box.h);
  }
  state.world = Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;

  // The camera is *not* reset here. Adding an island to a bench should leave
  // everything else on the bench where it was -- and it can, because the space
  // is fixed. The new island lands next to the pill that was clicked, so it
  // arrives in view without anything having to move. Only entering the mode,
  // and asking, frame anything.
  if (state.solo) saveConfig();

  if (state.solo && state.framed) {
    applyCam();
    const cur = state.islands[state.islands.length - 1];
    if (cur) ensureVisible(cur.box);
  } else {
    focusCurrent();
    state.framed = state.solo;
  }
}

// ---------------------------------------------------------------------------

/**
 * The bench itself: dots, so zoom has something to be relative to.
 *
 * Scale is invisible on an empty background -- a circuit drawn twice as large on
 * a black field looks like a circuit, not like a closer circuit. The dots ride
 * inside the camera group, so they scale and slide with everything else, and two
 * grids an order of magnitude apart mean there is always one of them at a
 * useful density.
 */
function drawGrid(svg, camG) {
  const defs = el('defs', {}, svg);
  const dot = (id, step, r, cls) => {
    const p = el('pattern', {
      id, width: step, height: step, patternUnits: 'userSpaceOnUse',
    }, defs);
    el('circle', { cx: step / 2, cy: step / 2, r, class: cls }, p);
  };
  dot('sch-dots-fine', 40, 1, 'sch-dot');
  dot('sch-dots-coarse', 200, 2.2, 'sch-dot sch-dot-coarse');
  // Big enough that the reader cannot pan off the edge of it at any zoom the
  // camera allows, and cheap either way: a pattern fill is one paint.
  const span = 60000;
  for (const id of ['sch-dots-fine', 'sch-dots-coarse']) {
    el('rect', {
      x: -span / 2, y: -span / 2, width: span, height: span,
      fill: `url(#${id})`, class: 'sch-grid',
    }, camG);
  }
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

/**
 * What is known about a signal, as markup.
 *
 * Returned rather than written, because the study view's console shows the same
 * card in its own panel. Two copies of this would be two chances to explain the
 * same wire differently.
 */
function signalHtml(node) {
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

  return `<h3 class="sch-sig-name">${name}<span class="sch-sig-id">node ${node}</span></h3>`
    + `<dl class="ends">${rows.join('')}</dl>`;
}

function renderSignal(node) {
  $('sch-signal-info').innerHTML = signalHtml(node);
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
// The study view's console
// ---------------------------------------------------------------------------
//
// One floating panel rather than three clusters pinned to three corners. On a
// screen whose entire content is one drawing, the controls are the only thing
// that can be in the way -- and *where* they are in the way depends on the
// drawing, which changes every time a signal is followed. So it is draggable,
// and it remembers where it was put.
//
// Everything it reports is read out of the running chip. The address and data
// buses are the levels on the pads, the registers are read out of their storage
// nodes, and memory is the bus the chip is actually talking to -- so a rewind
// takes the hex dump back with it.

// Everything about the study view that is a *setting* rather than a fact about
// the chip: where the console was put, which drawer was open, and the walk that
// was on the bench. Saved on every change and restored on the next visit.
//
// This matters more than it sounds. A tablet's own gesture can drop you out of
// fullscreen without asking, and losing a five-island walk to a stray swipe is
// the difference between a tool and a toy. It cannot be prevented from here --
// the browser owns that gesture -- so the answer is to make it cost nothing.
const CFG_KEY = 'v6502.schematic.console';

function saveConfig() {
  if (state.root == null) return;
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify({
      pos: state.palPos,
      drawer: state.drawer,
      tab: state.tab,
      // The walk is stored with the direction it was drawn in, because the
      // layout mirrors: restoring a backward ribbon into a forward view would
      // put every thread on the wrong side.
      dir: state.dir,
      root: state.root,
      trail: state.trail.map((t) => ({ node: t.node, from: t.from })),
    }));
  } catch { /* private mode: the page works, it just forgets */ }
}

function loadConfig() {
  try {
    const raw = JSON.parse(localStorage.getItem(CFG_KEY));
    return raw && typeof raw === 'object' ? raw : null;
  } catch { return null; }
}

/**
 * Put back the walk that was on the bench, if it is still the same bench.
 *
 * A deep link, or any other subject, wins: restoring someone else's islands
 * around a signal they asked for would be the page overruling the URL. So the
 * saved walk is only reinstated when it ends where the reader now is.
 */
function restoreTrail(cfg) {
  if (!cfg || cfg.dir !== state.dir || !Array.isArray(cfg.trail) || !cfg.trail.length) return false;
  const n = state.data.names.length;
  const clean = cfg.trail
    .filter((t) => t && Number.isInteger(t.node) && t.node >= 0 && t.node < n)
    .slice(-TRAIL_MAX);
  if (!clean.length || clean[clean.length - 1].node !== state.root) return false;
  state.trail = clean.map((t, i) => ({
    node: t.node,
    from: Number.isInteger(t.from) && t.from < i ? t.from : i - 1,
  }));
  return true;
}

const hex2 = (v) => v.toString(16).padStart(2, '0').toUpperCase();
const hex4 = (v) => v.toString(16).padStart(4, '0').toUpperCase();

/** A byte or a word as lamps, high bit first. */
function bitStrip(v, n) {
  let out = '';
  for (let b = n - 1; b >= 0; b--) {
    const on = (v >> b) & 1;
    out += `<i class="${on ? 'on' : ''}">${on}</i>`;
  }
  return `<span class="sp-bits">${out}</span>`;
}

// The chip's input pins.
//
// The button shows the level on the pin rather than an interpretation of it.
// Four of the five are active low, so low means asserted -- but `so` comes out
// of reset *low* (the reset sequence drives it there, as the reference does),
// and a button that called that "asserted" would be reporting a polarity it had
// assumed instead of the level it measured.
const PINS = [
  ['res', 'RES', 'setRes', 'reset — active low'],
  ['irq', 'IRQ', 'setIrq', 'interrupt request, active low — masked by the I flag'],
  ['nmi', 'NMI', 'setNmi', 'non-maskable interrupt, active low'],
  ['rdy', 'RDY', 'setRdy', 'ready — low stalls the chip on a read cycle'],
  ['so', 'SO', 'setSo', 'set overflow — held low out of reset'],
];

const pinHigh = (name) => {
  const node = state.pinNodes[name];
  return node == null || node < 0 ? true : state.machine.isNodeHigh(node);
};

/**
 * Assert or release a pin.
 *
 * The level is read back out of the node afterwards rather than remembered
 * here, so the button cannot come to disagree with the chip -- the same reason
 * the drawing reads levels instead of storing them beside the prose.
 */
function togglePin(name, setter) {
  state.machine[setter](!pinHigh(name));
  refresh();
}

/**
 * The panels. Each takes its host element, builds whatever is static once, and
 * returns the function that paints the live parts.
 *
 * The split matters: this repaints on every animation frame, and rebuilding the
 * markup each time would blow away the address field the reader is typing in.
 * Each painter also compares what it is about to write against what is there,
 * so a stopped chip does no DOM work at all.
 */
const PANELS = {
  /** What this wire is. The same card the page proper shows below the drawing. */
  signal(host) {
    let shown = null;
    return () => {
      if (shown === state.root) return;
      shown = state.root;
      host.innerHTML = `<div class="sp-card">${signalHtml(state.root)}</div>`;
    };
  },

  /** Where you have walked, which way the walk reads, and back to any of it. */
  walk(host) {
    host.innerHTML = `<div class="sp-dirpair" role="group" aria-label="Direction">
        <button class="sp-dirbtn" id="solo-dir-back" type="button">what makes it</button>
        <button class="sp-dirbtn" id="solo-dir" type="button">what it drives</button>
      </div>
      <div class="sp-walk" id="sp-walk"></div>
      <div class="sp-actions">
        <button class="solo-btn sp-wide" id="sp-clear" type="button">start again from here</button>
      </div>
      <p class="sp-note">The last ${TRAIL_MAX} islands stay on screen and older
        ones are dropped, because a ribbon that grows without limit is too small
        to read at any zoom that shows all of it. Click a step to fly to it;
        <b>⌾</b> fits the whole walk.</p>
      <p class="sp-note">A <b class="sp-key-wire">solid thread</b> is a wire you
        followed. A <b class="sp-key-jump">faint one</b> is a step that was not
        along a wire — following a control line, which is never drawn as a
        signal, or coming off an island that has since dropped off the end.</p>`;
    host.querySelector('#sp-clear').addEventListener('click', () => {
      resetTrail();
      render();
    });
    // Direction lives here rather than on the strip because it is a labelled
    // choice, not an icon: "what makes it" and "what it drives" are the two
    // readings, and an arrow glyph for either would be a guess.
    host.querySelector('#solo-dir-back').addEventListener('click', () => setDir('back'));
    host.querySelector('#solo-dir').addEventListener('click', () => setDir('fwd'));
    paintDir();
    const list = host.querySelector('#sp-walk');
    let last = null;
    return () => {
      const key = state.trail.map((t) => t.node).join(',');
      if (key === last) return;
      last = key;
      list.innerHTML = state.trail.map((t, i) => `
        <button class="sp-step${i === state.trail.length - 1 ? ' on' : ''}"
                type="button" data-i="${i}">
          <span class="sp-step-n mono">${i + 1}</span>
          <span class="mono">${nameOf(t.node)}</span>
        </button>`).join('');
      for (const b of list.querySelectorAll('.sp-step')) {
        b.addEventListener('click', () => {
          const isl = state.islands[Number(b.dataset.i)];
          if (isl) frameOn(isl.box);
        });
      }
    };
  },

  /** The chip's edge: what is on the pads, and the five pins that drive it. */
  io(host) {
    host.innerHTML = `<dl class="sp-kv" id="sp-io"></dl>
      <p class="sp-sub">Input pins — the level on each. Click to flip it.</p>
      <div class="sp-pins" id="sp-pins"></div>
      <p class="sp-note">Everything above is read off the pads: the address and
        data buses are the levels on <span class="mono">ab0…15</span> and
        <span class="mono">db0…7</span>, not a number kept beside them. Four of
        the pins are active low, so 0 means asserted — <b>SO</b> is the
        exception and comes out of reset low. Holding <b>RDY</b> low stops the
        chip without stopping its clock; pulling <b>IRQ</b> low with no handler
        installed vectors through <span class="mono">$FFFE</span> to
        <span class="mono">$0000</span>, which is a <span class="mono">BRK</span>,
        and the chip climbs down the stack forever.</p>`;
    const pins = host.querySelector('#sp-pins');
    for (const [name, label, setter, why] of PINS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sp-pin';
      b.dataset.pin = name;
      b.dataset.label = label;
      b.title = why;
      b.addEventListener('click', () => togglePin(name, setter));
      pins.append(b);
    }
    const kv = host.querySelector('#sp-io');
    let last = '';
    return () => {
      const m = state.machine;
      const ab = m.addressBus();
      const db = m.dataBus();
      const rw = m.isRead();
      const html = `
        <dt>Address</dt><dd><b class="mono">$${hex4(ab)}</b>${bitStrip(ab, 16)}</dd>
        <dt>Data</dt><dd><b class="mono">$${hex2(db)}</b>${bitStrip(db, 8)}</dd>
        <dt>Cycle</dt><dd class="${rw ? '' : 'sp-write'}">
          ${rw ? `read <span class="mono">$${hex4(ab)}</span> → <span class="mono">$${hex2(db)}</span>`
               : `write <span class="mono">$${hex2(db)}</span> → <span class="mono">$${hex4(ab)}</span>`}
        </dd>
        <dt>Phase</dt><dd class="mono">${m.clk0() ? 'φ1' : 'φ2'} · ${m.timingStates() || '—'}${m.sync() ? ' · SYNC' : ''}</dd>`;
      if (html !== last) { last = html; kv.innerHTML = html; }
      for (const b of pins.children) {
        const high = pinHigh(b.dataset.pin);
        b.classList.toggle('low', !high);
        const text = `${b.dataset.label} ${high ? 1 : 0}`;
        if (b.textContent !== text) b.textContent = text;
      }
    };
  },

  /** Memory, as the chip sees it, following whatever is worth following. */
  mem(host) {
    host.innerHTML = `<div class="sp-fields">
        <label class="sp-field"><span>Follow</span>
          <select id="sp-mem-follow">
            <option value="pc">the program counter</option>
            <option value="ab">the address bus</option>
            <option value="s">the stack pointer</option>
            <option value="fixed">a fixed address</option>
          </select></label>
        <label class="sp-field sp-narrow"><span>At $</span>
          <input id="sp-mem-at" class="mono" value="0200" size="4" maxlength="4"
                 inputmode="latin" aria-label="Address"></label>
      </div>
      <div class="sp-dump mono" id="sp-dump"></div>
      <p class="sp-note">The bus the chip is talking to, not a copy of it — so
        stepping back takes the bytes back with it, writes and all. The cell the
        address bus is pointing at is ringed; the byte under the program counter
        is lit.</p>`;
    const follow = host.querySelector('#sp-mem-follow');
    const at = host.querySelector('#sp-mem-at');
    // Typing an address means you want that address, so the mode follows the
    // typing rather than making the reader set it twice.
    //
    // Both handlers repaint at once rather than waiting for the next animation
    // frame. The chip runs at four half-cycles a second here, so a frame is not
    // a long wait -- but a control that responds on somebody else's schedule is
    // the same responsiveness bug the study view's clock already had, and it is
    // invisible until the page is driven somewhere frames are throttled.
    at.addEventListener('input', () => { follow.value = 'fixed'; refreshPalette(); });
    follow.addEventListener('change', refreshPalette);
    const dump = host.querySelector('#sp-dump');
    let last = '';
    return () => {
      const m = state.machine;
      const fixed = parseInt(at.value.replace(/[^0-9a-fA-F]/g, ''), 16);
      const origin = {
        pc: () => m.pc(),
        ab: () => m.addressBus(),
        s: () => 0x100 + m.s(),
        fixed: () => (Number.isFinite(fixed) ? fixed : 0) & 0xffff,
      }[follow.value]();
      // Start a couple of rows above, on a row boundary, so the thing being
      // followed sits in the middle and does not jitter a row at a time.
      const base = (origin - 0x18) & 0xfff8 & 0xffff;
      const bytes = m.memorySlice(base, 64);
      const pc = m.pc(), ab = m.addressBus();
      let html = '';
      for (let r = 0; r < 8; r++) {
        const addr = (base + r * 8) & 0xffff;
        let cells = '';
        for (let i = 0; i < 8; i++) {
          const a = (addr + i) & 0xffff;
          const cls = (a === ab ? ' at' : '') + (a === pc ? ' pc' : '');
          cells += `<i class="${cls.trim()}">${hex2(bytes[r * 8 + i])}</i>`;
        }
        html += `<div class="sp-dump-row"><b>${hex4(addr)}</b>${cells}</div>`;
      }
      if (html !== last) { last = html; dump.innerHTML = html; }
    };
  },

  /**
   * The stack: where S points, and what a pull would return.
   *
   * Deliberately *not* "how many bytes are on the stack". That would be
   * `$FF - S`, which assumes the stack began empty at the top — and the 6502
   * does not clear S at reset. It decrements it by three and nothing else, so
   * out of a power-on it holds whatever its storage nodes came up as, exactly as
   * this simulator reproduces. How much is on the stack is not something the
   * chip knows, and a panel that reported a number for it would be reporting an
   * assumption in the same typeface as a measurement.
   */
  stack(host) {
    host.innerHTML = `<div id="sp-stack"></div>
      <p class="sp-note">S is read out of its storage nodes like every other
        register, and it points at the <em>next free byte</em> — so a push writes
        to $0100+S and then decrements, and the stack grows downward. The bytes
        below the list are whatever was pushed and pulled earlier: still in
        memory, still on the Memory tab, and no longer the chip's business.</p>
      <p class="sp-note">There is no count here on purpose. The 6502 does not
        reset its stack pointer — reset only decrements it by three — so how deep
        the stack is is not a fact the chip holds.</p>`;
    const box = host.querySelector('#sp-stack');
    const DEEP = 12;
    let last = '';
    return () => {
      const m = state.machine;
      const s = m.s();
      // Top first, which is the order pulls return them. The stack grows
      // downward, so the most recent push is at the *lowest* address -- listing
      // from $01FF down would read as a stack upside down.
      let rows = '';
      for (let i = 0; i < DEEP; i++) {
        const a = 0x100 + ((s + 1 + i) & 0xff);
        rows += `<div class="sp-stack-row${i === 0 ? ' top' : ''}">`
          + `<b>$${hex4(a)}</b><i>${hex2(m.peek(a))}</i>`
          + `<span class="sp-stack-note">${i === 0 ? 'the next pull' : ''}</span></div>`;
      }
      const html = `<dl class="sp-kv">
          <dt>S</dt><dd><b class="mono">$${hex2(s)}</b>${bitStrip(s, 8)}</dd>
          <dt>Next push</dt><dd class="mono">$${hex4(0x100 + s)}</dd>
          <dt>Next pull</dt><dd class="mono">$${hex4(0x100 + ((s + 1) & 0xff))}</dd>
        </dl>
        <div class="sp-stack mono">${rows}</div>`;
      if (html === last) return;
      last = html;
      box.innerHTML = html;
    };
  },
};

const TAB_NAMES = {
  signal: 'Signal', walk: 'Walk', io: 'I/O', mem: 'Memory', stack: 'Stack',
};

/**
 * Which drawer is open. Rebuilt on switch, painted every frame.
 *
 * The strip is the console; the drawer is one thing at a time pulled out of it.
 * Pressing the icon that is already open shuts it, which is the only way to get
 * back to a bench with nothing but a strip of icons on it.
 */
function setTab(name) {
  state.tab = PANELS[name] ? name : 'signal';
  const pal = $('solo-palette');
  pal.dataset.open = state.tab;
  for (const b of $('sp-strip').querySelectorAll('.sp-icon[data-tab]')) {
    const on = b.dataset.tab === state.tab && state.drawer;
    b.classList.toggle('on', on);
    b.setAttribute('aria-expanded', on ? 'true' : 'false');
  }
  $('sp-drawer-title').textContent = TAB_NAMES[state.tab];
  const host = $('sp-panel');
  host.replaceChildren();
  state.panel = PANELS[state.tab](host);
  state.panel();
  saveConfig();
}

/** Open or shut the drawer, leaving the strip. */
function setDrawer(on) {
  state.drawer = !!on;
  $('solo-palette').dataset.drawer = state.drawer ? 'open' : 'shut';
  $('sp-collapse').setAttribute('aria-expanded', state.drawer ? 'true' : 'false');
  setTab(state.tab);
  saveConfig();
  // Opening changes the panel's width and height, so where it is allowed to be
  // changes with it. Without this, opening a drawer near an edge puts half of
  // it outside the stage.
  if (state.palPos) placePalette(state.palPos.x, state.palPos.y);
}

const stageRect = () => document.querySelector('.sch-stage').getBoundingClientRect();

/**
 * Put the console somewhere, and refuse to put it out of reach.
 *
 * The clamp is against the stage rather than the viewport, and it runs again on
 * resize and on collapse -- a panel dragged to the bottom of a tall window and
 * then reopened on a phone would otherwise be gone, with no way to get it back
 * short of clearing storage.
 */
function placePalette(x, y) {
  const pal = $('solo-palette');
  const sr = stageRect();
  const pr = pal.getBoundingClientRect();
  if (!pr.width || !pr.height) return;
  const nx = Math.min(Math.max(0, sr.width - pr.width), Math.max(0, x));
  const ny = Math.min(Math.max(0, sr.height - pr.height), Math.max(0, y));
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
  pal.style.left = `${nx}px`;
  pal.style.top = `${ny}px`;
  state.palPos = { x: nx, y: ny };
  saveConfig();
}

/** Entering the study view: open the console where it was left. */
function openPalette(cfg) {
  if (cfg && cfg.pos && Number.isFinite(cfg.pos.x) && Number.isFinite(cfg.pos.y)) {
    state.palPos = cfg.pos;
  }
  setDrawer(state.drawer);
  const pos = state.palPos || (() => {
    const sr = stageRect();
    const pr = $('solo-palette').getBoundingClientRect();
    return { x: 14, y: Math.max(0, sr.height - pr.height - 14) };
  })();
  placePalette(pos.x, pos.y);
}

function setupPalette() {
  const pal = $('solo-palette');
  const grip = $('sp-strip');
  const cfg = loadConfig();
  state.palPos = cfg && cfg.pos
    && Number.isFinite(cfg.pos.x) && Number.isFinite(cfg.pos.y) ? cfg.pos : null;

  // The strip is the handle, buttons included.
  //
  // It used to refuse a press that landed on a button, which made a 2.5rem-wide
  // panel hard to grab and had a worse consequence: the press still reached the
  // button, so a drag that started on the exit icon *left the study view on
  // release*. That is one of the two ways a reader loses their walk to a stray
  // gesture. Now anything on the strip drags, and a press that turned into a
  // drag has its click swallowed on the way back up.
  //
  // Move and release are watched on the window for the same reason the camera
  // does it: `setPointerCapture` retargets the click, and half these buttons are
  // the ones the reader means to press.
  let drag = null;
  let dragged = false;
  grip.addEventListener('pointerdown', (e) => {
    const r = pal.getBoundingClientRect();
    drag = {
      dx: e.clientX - r.left, dy: e.clientY - r.top,
      x: e.clientX, y: e.clientY,
      // A finger always moves a little, so the slop that separates a press from
      // a drag is larger for touch -- the same figures the camera uses.
      slop: e.pointerType === 'mouse' ? 4 : 12,
    };
    dragged = false;
    // Only claim the gesture when it did not start on a control: preventing the
    // default on a button would cost it focus and the press that goes with it.
    if (!e.target.closest('button')) e.preventDefault();
  });
  const move = (e) => {
    if (!drag) return;
    if (!dragged && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) <= drag.slop) return;
    if (!dragged) { dragged = true; pal.classList.add('dragging'); }
    const sr = stageRect();
    placePalette(e.clientX - sr.left - drag.dx, e.clientY - sr.top - drag.dy);
  };
  const up = () => {
    if (!drag) return;
    drag = null;
    pal.classList.remove('dragging');
    // Let the click that follows this release be swallowed, then forget. A drag
    // that ends off a button produces no click at all, and a flag left latched
    // would eat the next real press instead of the one it was raised for.
    if (dragged) setTimeout(() => { dragged = false; }, 0);
  };
  // Capture, so it runs before the button's own handler rather than after it.
  grip.addEventListener('click', (e) => {
    if (!dragged) return;
    dragged = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  window.addEventListener('resize', () => {
    if (state.solo && state.palPos) placePalette(state.palPos.x, state.palPos.y);
  });

  $('sp-collapse').addEventListener('click', () => setDrawer(false));
  for (const b of $('sp-strip').querySelectorAll('.sp-icon[data-tab]')) {
    b.addEventListener('click', () => {
      if (state.drawer && state.tab === b.dataset.tab) setDrawer(false);
      else { state.tab = b.dataset.tab; setDrawer(true); }
    });
  }
}

/** Paint the live half of whichever panel is open. */
function refreshPalette() {
  if (!state.solo || !state.panel || !state.drawer) return;
  state.panel();
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
  const flipped = v.dir !== state.dir;
  withoutHistory(() => {
    state.root = v.root;
    state.dir = v.dir;
    // Going back to a signal that is still on screen walks back up the ribbon
    // rather than starting a new one -- the islands beyond it are the steps
    // being undone, so they go. Anything else (a different direction, a signal
    // that has scrolled off the end of the walk) starts again from here.
    if (state.solo) {
      const at = flipped ? -1 : state.trail.findIndex((t) => t.node === v.root);
      if (at >= 0) state.trail.length = at + 1;
      else resetTrail();
    }
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
  // The study view's pair, which exists only while the Walk drawer is built.
  const fwdBtn = $('solo-dir');
  const backBtn = $('solo-dir-back');
  if (fwdBtn) fwdBtn.classList.toggle('on', state.dir === 'fwd');
  if (backBtn) backBtn.classList.toggle('on', state.dir === 'back');
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
  // Both axes of the layout mirror when the direction flips, so a walk drawn
  // one way round cannot be extended the other. The islands would still be
  // correct circuits and the ribbon would read backwards.
  resetTrail();
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
  if (next !== state.depth) resetTrail();   // every island would change size
  state.depth = next;
  paintDepth();
  render();
}

/**
 * Make `node` the subject.
 *
 * `from` is the island the reader clicked in, when there was one. In the study
 * view this appends to the walk rather than replacing it: the island you came
 * from stays on screen, dimmed, with a thread from the pill you pressed. On the
 * page proper there is one drawing and it is replaced, because that view sits
 * in a scrolling stage with no camera to find a second island with.
 */
function setRoot(node, from = -1) {
  if (node !== state.root) remember('root');
  state.root = node;
  if (state.solo) walkTo(node, from);
  renderSignal(node);
  clearCompare();
  paintPicker();
  render();
  syncUrl();
}

/** Append to the walk, dropping the oldest island once it is full. */
function walkTo(node, from) {
  const last = state.trail[state.trail.length - 1];
  if (last && last.node === node) return;
  state.trail.push({ node, from });
  while (state.trail.length > TRAIL_MAX) {
    state.trail.shift();
    // Every island moved down one, and anything that pointed at the one just
    // dropped now points at nothing -- which `arrange` reads as "no anchor".
    for (const t of state.trail) t.from -= 1;
  }
}

/** Start the walk again from where you are. */
function resetTrail() {
  state.trail = state.root == null ? [] : [{ node: state.root, from: -1 }];
}

function render() {
  if (!state.solo || !state.trail.length) resetTrail();
  const cones = state.trail.map((t) => cone(t.node, state.depth, state.dir));
  drawTrail(cones);
  const c = cones[cones.length - 1];
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
    // Without this the reset vector reads $0000, where memory is $00 -- a BRK,
    // which pushes three bytes and vectors to itself. The chip then runs a BRK
    // loop forever instead of the program, and every gate on the page lights up
    // convincingly while doing it. Nothing here could show that until the
    // console grew a memory and a stack readout.
    m.setResetVector(LOAD_ADDR);
    m.powerCycle();

    // The pins, resolved once. Their level is read back out of these nodes
    // rather than remembered, so a button cannot disagree with the chip.
    state.pinNodes = Object.fromEntries(PINS.map(([name]) => [name, m.nodeId(name)]));

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
    $('solo-fit').addEventListener('click', fitAll);
    setupCamera(document.querySelector('.sch-stage'), $('sch-svg'));
    setupPalette();

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
      if (ev.key === '0') { fitAll(); ev.preventDefault(); }
      else if (ev.key === ' ') { setRunning(!state.running); ev.preventDefault(); }
      else if (ev.key === 'ArrowRight') { step(+1); ev.preventDefault(); }
      else if (ev.key === 'ArrowLeft') { step(-1); ev.preventDefault(); }
      else if (ev.key === 'p' || ev.key === 'P') {
        setDrawer(!state.drawer);
        ev.preventDefault();
      } else if (ev.key === 'd' || ev.key === 'D') {
        setDir(state.dir === 'back' ? 'fwd' : 'back');
        ev.preventDefault();
      }
    });
    $('sch-step').addEventListener('click', () => step(+1));
    $('sch-solo-exit').addEventListener('click', () => $('sch-fullscreen').click());
    $('dir-back').addEventListener('click', () => setDir('back'));
    $('dir-fwd').addEventListener('click', () => setDir('fwd'));

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
      state.framed = false;      // aim the camera once, on arrival
      console_.classList.toggle('solo', on);
      // A walk belongs to the study view: the page proper draws one island in a
      // scrolling stage, with no camera to find a second one with. So both
      // entering and leaving start it again from wherever the reader is.
      // Read the saved configuration *once*, up front. Reading it again after
      // the first render would find what that render had just written -- and
      // rendering happens before the console is opened, so the defaults would
      // have overwritten the saved tab a moment before it was wanted.
      const cfg = on ? loadConfig() : null;
      resetTrail();
      if (cfg) {
        restoreTrail(cfg);                    // the same walk, if it is the same bench
        if (PANELS[cfg.tab]) state.tab = cfg.tab;
        state.drawer = cfg.drawer !== false;
      }
      if (state.root != null) render();
      // The console only exists in this mode, so entering has to open and
      // populate it rather than waiting for the next animation frame.
      if (on) openPalette(cfg);
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
  refreshPalette();
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
