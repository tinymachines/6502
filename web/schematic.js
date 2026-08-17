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
import { PROGRAMS, LOAD_ADDR, selectedProgram, setSelectedProgram } from './programs.js';
import { setupProgramNav } from './program-nav.js';
import { blockCss } from './block-palette.js';
import { createDraw, el, SVGNS, NODE_H } from './sch-draw.js';
import { setupFullscreen } from './fullscreen.js';
import { setupChipNav } from './chip-nav.js';
import {
  CLOCKS, clockHz, isRunning, setClock, toggleRunning,
  step as stepChip, stepBack, reset as resetChip, subscribe, halfCyclesFor,
} from './chip-controls.js';

const $ = (id) => document.getElementById(id);

// The drawing engine, bound to schematic.json once it has loaded. It is shared
// verbatim with the block pages -- see sch-draw.js for why that matters.
let draw = null;

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
  // Lock the chip's own I/O to the far end of the drawing and show the chain
  // between. Off by default: it adds eight or so elements, which is a lot to
  // arrive to uninvited.
  pinIO: false,
  compare: null,          // [nodeA, nodeB] when comparing two signals
  diffControls: null,     // control names that differ, ringed in the drawing
  solo: false,            // fullscreen: one level, centred, nothing else
  // Whether it is running and how fast are in chip-controls.js, set from the
  // header and from the study view's own drawer.
  lastFrame: 0,
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
  // The walk: the signals stepped through, oldest first. The drawing is the
  // union of their circuits, merged so that each node appears exactly once.
  trail: [],
  nodeBox: new Map(),   // where each signal ended up, for flying to one
  world: null,          // the whole drawing, which is what "fit" fits
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
  quiet: false,    // raised while entering or leaving, so nothing saves mid-switch
};

const HISTORY_MAX = 200;

// How many steps of the walk stay on the bench. The walk is the point of the
// study view, so the last several steps of it are worth keeping -- but a drawing
// that grows without limit ends up too small to read at any zoom that shows all
// of it. The cap is declared on the Walk tab rather than applied quietly.
const TRAIL_MAX = 6;


// Forwarders rather than a second spelling: the drawing engine has to agree with
// the page about what an unnamed node is called, and two copies of `#${n}` is
// how they would eventually stop agreeing.
const nameOf = (n) => draw.nameOf(n);
const isNamed = (n) => draw.isNamed(n);

// ---------------------------------------------------------------------------
// Cone extraction -- the same walk as `Schematic::cone`, in the page so that
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
 * ADDSB7 is a different element from one opened by ADDSB06 -- that difference
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
// The camera -- pinch, drag and wheel over the drawing
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

/** The drawing, fitted to the portal on arrival. */
function focusCurrent() {
  if (state.world) frameOn(state.world, MAX_FIT);
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
//
// The layered layout and the symbols themselves live in sch-draw.js, shared
// verbatim with the block pages. What stays here is what belongs to this page:
// which cone to draw, and what a click on it means.

/**
 * The block key, for the blocks that are on screen and no others.
 *
 * Which block a signal belongs to is `blocks.rs`'s answer, measured and
 * published in `schematic.json` -- the same one the signal panel reports as its
 * region. The colour is only a second way of saying it, so the key is labelled
 * `measured` for the membership and not for the hue.
 *
 * Static logic and the unaccounted residue are named plainly rather than
 * dressed up: they are where the gates that no functional block claimed live,
 * and that is worth seeing on a walk rather than hiding.
 */
function paintBlockKey(blocks) {
  const host = $('sch-blockkey');
  if (!host) return;
  const names = state.data.blockNames;
  const shown = [...blocks].filter((b) => names[b]).sort((a, b) => a - b);
  host.hidden = shown.length === 0;
  if (host.hidden) { host.replaceChildren(); return; }

  // Nothing changed? Then do not touch the DOM -- this runs on every redraw.
  const signature = shown.join(',');
  if (host.dataset.signature === signature) return;
  host.dataset.signature = signature;

  host.replaceChildren();
  const label = el('span', { class: 'sch-blockkey-label' }, host);
  label.textContent = 'Region';
  for (const b of shown) {
    const item = el('span', { class: 'sch-blockkey-item' }, host);
    const dot = el('i', {}, item);
    dot.style.background = blockCss(b);
    const t = el('span', {}, item);
    t.textContent = names[b];
  }
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
 * The walk, as one drawing.
 *
 * Every step is a cone, and the cones overlap: walk from `sb0` to `alua0` and
 * both of them appear in both. Laying each one out separately put a second copy
 * of every shared signal on the bench, which is exactly the thing this page is
 * for undoing -- a reader tracing a value found two `#844`s and no way to tell
 * which was which. So the cones are merged into a single graph first and every
 * node is drawn once.
 *
 * A node's column is where it *first* appeared, measured from the signal the
 * walk started on. That is what makes the arrangement stable as it grows: the
 * columns are "how far back from where I began", they are assigned once, and a
 * later step that reaches an already-placed signal joins to it where it already
 * is rather than moving it. It also copes with feedback, which a strict
 * topological layering would not -- this chip is full of it.
 */
// The pad ring, split by which way a signal crosses it.
//
// Written out rather than taken from the `Pads & I/O` block, because that block
// is a *region of the die* -- it holds the drivers and receivers as well as the
// pads -- and what is wanted here is the twenty-eight places the chip meets the
// outside world. The data bus is in both lists because it genuinely is both.
const IO_IN = ['clk0', 'rdy', 'irq', 'nmi', 'res', 'so'];
const IO_OUT = ['rw', 'sync', 'clk1out', 'clk2out'];
const IO_BUS = Array.from({ length: 8 }, (_, i) => `db${i}`);
const IO_ADDR = Array.from({ length: 16 }, (_, i) => `ab${i}`);

/** Pin node ids, resolved once against the die's own name table. */
function ioNodes(dir) {
  const names = dir === 'back' ? [...IO_IN, ...IO_BUS] : [...IO_OUT, ...IO_ADDR, ...IO_BUS];
  const out = new Map();
  for (const n of names) {
    const id = state.byName.get(n);
    if (id != null) out.set(id, n);
  }
  return out;
}

/**
 * The shortest chain of real circuit elements between `root` and a pin.
 *
 * Why a search rather than a deeper cone: measured against `schematic.json`, the
 * median named signal is **eight** hops from the nearest pin and the depth
 * control stops at six. Pins drawn by growing the cone would therefore sit
 * disconnected on almost every walk, which is decoration rather than a feature.
 *
 * The neighbour rules are exactly `cone()`'s, and have to be: a control line
 * rides on a switch as a label and is never expanded, or `cclk` -- which gates
 * 273 transistors -- turns every chain into a trip through the clock tree.
 *
 * Two measured facts the caller has to respect. Every named signal reaches an
 * input pin backward, all 705 of them. But **97 of 705 never reach an output
 * pin forward**, `dpc3_SBX` among them, and that is correct rather than a
 * failure: a control line's forward reach ends at the switches it opens,
 * because opening a switch is not the same as driving a value through it. So
 * `null` here is an answer, and the page says so instead of drawing nothing.
 */
function pinChain(root, dir) {
  const { vss, vcc } = state.data;
  const isRail = (n) => n === vss || n === vcc;
  const targets = ioNodes(dir);
  if (targets.has(root)) return null;          // already a pin: nothing between

  // The root's entry is a real object, not null. Seeding it with `null` reads
  // fine and then throws in the reconstruction below, on `from.get(at).element`,
  // one iteration *after* the last useful one -- so it threw only when a chain
  // was actually found, the exception escaped render(), and the page went on
  // showing the previous drawing. Which looks exactly like a feature that does
  // nothing rather than one that crashed.
  const from = new Map([[root, { prev: null, element: null }]]);
  let frontier = [root];

  for (let hop = 0; hop < 24 && frontier.length; hop++) {
    const next = [];
    for (const node of frontier) {
      const step = (n, element) => {
        if (isRail(n) || from.has(n)) return false;
        from.set(n, { prev: node, element });
        next.push(n);
        return true;
      };

      if (dir === 'back') {
        const g = state.gateOf.get(node);
        if (g) {
          const inputs = [...new Set(g.terms.flat())];
          for (const i of inputs) {
            step(i, { kind: g.kind, out: node, inputs, terms: g.terms,
                      precharge: g.precharge });
          }
        }
      } else {
        for (const g of state.gatesUsing.get(node) || []) {
          step(g.out, { kind: g.kind, out: g.out, inputs: [node], terms: g.terms,
                        precharge: g.precharge, forward: true });
        }
      }
      // A pass transistor conducts both ways and so belongs to either reading.
      for (const w of state.switchesOn.get(node) || []) {
        const far = w.a === node ? w.b : w.a;
        step(far, { kind: 'switch', out: node, inputs: [far], control: w.control });
      }

      for (const n of next) {
        if (!targets.has(n)) continue;
        // Walk the parent pointers back and hand the chain over root-first.
        const nodes = [];
        const elements = [];
        for (let at = n; at != null; at = from.get(at).prev) {
          nodes.push(at);
          const e = from.get(at).element;
          if (e) elements.push(e);
          if (at === root) break;
        }
        nodes.reverse();
        return { pin: n, pinName: targets.get(n), nodes, elements, hops: nodes.length - 1 };
      }
    }
    frontier = next;
  }
  return null;
}

function merge() {
  const col = new Map();          // node -> column
  const seen = [];                // insertion order, for a stable tie-break
  const elements = new Map();     // key -> element, first sighting wins
  let truncated = 0;
  let last = null;

  state.trail.forEach((t, i) => {
    if (!col.has(t.node)) {
      // A step onto something not already drawn -- following a control line
      // does this, since a control is never a signal on the drawing. It goes
      // one column further back than where the reader was.
      const prev = i > 0 ? col.get(state.trail[i - 1].node) : 0;
      col.set(t.node, i === 0 ? 0 : (prev ?? 0) + 1);
      seen.push(t.node);
    }
    const base = col.get(t.node);
    const c = cone(t.node, state.depth, state.dir);
    truncated += c.truncated;
    last = c;
    c.levels.forEach((nodes, k) => {
      for (const n of nodes) {
        if (col.has(n)) continue;
        col.set(n, base + k);
        seen.push(n);
      }
    });
    for (const e of c.elements) {
      // A switch reached from its far side is the same transistor, so it is
      // keyed by the pair it joins rather than by which end was expanded first.
      const key = e.kind === 'switch'
        ? `s:${e.control}:${Math.min(e.out, e.inputs[0])}:${Math.max(e.out, e.inputs[0])}`
        : `g:${e.out}`;
      if (!elements.has(key)) elements.set(key, e);
    }
  });

  // The chip's own I/O, locked to the far end of the drawing.
  //
  // The chain is placed from wherever its first node already sits, so the pin
  // ends up at a column the walk cannot reach on its own -- and stays there.
  // Anything the walk later discovers between the two lands in the columns
  // between them, which is the whole point: the ends are fixed and the middle
  // fills in.
  let pinned = null;
  if (state.pinIO && state.trail.length) {
    const subject = state.trail[state.trail.length - 1].node;
    const chain = pinChain(subject, state.dir);
    if (chain) {
      const base = col.get(chain.nodes[0]) ?? 0;
      chain.nodes.forEach((n, k) => {
        // First appearance still wins, exactly as it does for the walk: a
        // signal already on the bench joins where it is rather than moving.
        if (col.has(n)) return;
        col.set(n, base + k);
        seen.push(n);
      });
      for (const e of chain.elements) {
        const key = e.kind === 'switch'
          ? `s:${e.control}:${Math.min(e.out, e.inputs[0])}:${Math.max(e.out, e.inputs[0])}`
          : `g:${e.out}`;
        if (!elements.has(key)) elements.set(key, e);
      }
      pinned = chain;
    } else {
      // Not a gap in the drawing -- an answer about the chip. 97 of 705 signals
      // never reach an output pin, because a control line's forward reach ends
      // at the switches it opens.
      pinned = { pin: null, pinName: null, nodes: [], elements: [], hops: -1 };
    }
  }

  const depth = Math.max(0, ...col.values());
  const levels = Array.from({ length: depth + 1 }, () => []);
  for (const n of seen) levels[col.get(n)].push(n);

  const els = [...elements.values()].map((e) => ({ ...e, level: col.get(e.out) ?? 0 }));

  // Order each column by the average row of what it connects to in the column
  // before it. Without this the rows follow insertion order and the wires cross
  // for no reason -- one merged drawing has far more of them to cross than a
  // single cone ever did.
  for (let c = 1; c < levels.length; c++) {
    const above = new Map(levels[c - 1].map((n, i) => [n, i]));
    const near = new Map();
    const note = (n, i) => {
      if (!near.has(n)) near.set(n, []);
      near.get(n).push(i);
    };
    for (const e of els) {
      for (const input of e.inputs) {
        if (col.get(input) === c && above.has(e.out)) note(input, above.get(e.out));
        if (col.get(e.out) === c && above.has(input)) note(e.out, above.get(input));
      }
    }
    const mean = (n) => {
      const list = near.get(n);
      return list && list.length ? list.reduce((a, b) => a + b, 0) / list.length : Infinity;
    };
    levels[c] = levels[c]
      .map((n, i) => ({ n, i }))
      .sort((a, b) => (mean(a.n) - mean(b.n)) || (a.i - b.i))
      .map((x) => x.n);
  }

  return {
    root: state.trail.length ? state.trail[state.trail.length - 1].node : state.root,
    levels, elements: els, dir: state.dir, truncated, current: last, pinned,
  };
}

/**
 * Draw the walk.
 *
 * One layout, one pass, one copy of everything. The viewBox stays a fixed
 * workbench in the study view so that redrawing does not move the world under
 * the camera -- the drawing itself reflows as it grows, which is the point, but
 * the space it grows in does not.
 */
function drawWalk(c) {
  const svg = $('sch-svg');
  svg.replaceChildren();

  const L = draw.layout(c);
  const vb = state.solo ? WORKBENCH : { w: L.width, h: L.height };
  state.viewBox = vb;
  svg.setAttribute('viewBox', `0 0 ${vb.w} ${vb.h}`);
  svg.setAttribute('width', vb.w);
  svg.setAttribute('height', vb.h);

  const camG = el('g', { class: 'sch-cam' }, svg);
  state.camG = camG;
  if (state.solo) drawGrid(svg, camG);

  // The card marks where the reader is. There are no islands to shade any more
  // -- that was the price of the duplicates -- so it goes round the subject
  // itself, which is the thing the rest of the drawing is arranged around.
  const card = state.solo ? el('rect', { class: 'sch-bench-card', rx: 8 }, camG) : null;

  const g = el('g', { class: 'sch-graph' }, camG);
  draw.drawGraph(g, c, L, {
    pick: setRoot,
    dragging: () => state.dragged,
    diffControls: state.diffControls,
    onBlocks: paintBlockKey,
  });

  // Where every signal ended up, so the Walk drawer can fly to one and the
  // camera can be told to keep the subject in view.
  state.nodeBox = new Map();
  for (const [node, p] of L.place) {
    state.nodeBox.set(node, {
      x: p.boxL, y: p.y - NODE_H / 2, w: p.boxR - p.boxL, h: NODE_H,
    });
  }

  const here = state.nodeBox.get(c.root);
  if (card && here) {
    const bleed = 9;
    for (const [k, v] of Object.entries({
      x: here.x - bleed, y: here.y - bleed,
      width: here.w + bleed * 2, height: here.h + bleed * 2,
    })) card.setAttribute(k, v);
  } else if (card) {
    card.setAttribute('width', 0);
  }

  state.world = { x: 0, y: 0, w: L.width, h: L.height };

  if (state.solo) saveConfig();

  // The camera is not reset as the drawing grows: a bench keeps what is put on
  // it. It is only nudged, and only when the signal just walked to would
  // otherwise be off screen.
  if (state.solo && state.framed) {
    applyCam();
    if (here) ensureVisible(here, 60);
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
    add('Name', `bit <b>${bit[1]}</b> of <span class="mono">${bit[0]}</span>: ${STEMS[bit[0]]}`);
  } else if (STEMS[name]) {
    add('Name', STEMS[name]);
  } else if (/^op-/.test(name)) {
    add('Name', 'a decode PLA product term. '
      + `<span class="muted">The die names these after the T-state and the instructions they serve.</span>`);
  } else if (!named) {
    add('Name', 'unnamed. <span class="muted">An internal node the die trace did not label; '
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
        '<span class="muted">no gate: it is fed through switches only</span>');
  }

  const fan = d.nodeFanout[node];
  add('Gates <span class="tagm">measured</span>',
      `${fan} transistor${fan === 1 ? '' : 's'}`
      + (fan === 0 ? ' <span class="muted">(it drives nothing)</span>' : ''));

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
  item('NOR ≥1', 'low if <em>any</em> input is high: transistors in parallel', gate('≥1', 'sch-nor'));
  item('NAND &', 'low only if <em>all</em> inputs are high: in series', gate('&', 'sch-nand'));
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
  item('Power rail', 'Vcc above, Vss below: where a gate pulls to', (svg) => {
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
  // `quiet` is raised while the mode is being switched. Everything that runs in
  // there is the switch's own doing rather than the reader's, and one of those
  // things resets the walk.
  if (state.quiet || state.root == null) return;
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify({
      pos: state.palPos,
      drawer: state.drawer,
      tab: state.tab,
      // The walk is stored with the direction it was drawn in, because the
      // layout mirrors: restoring a backward ribbon into a forward view would
      // put every thread on the wrong side.
      dir: state.dir,
      pinIO: state.pinIO,
      root: state.root,
      trail: state.trail.map((t) => ({ node: t.node })),
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
  state.trail = clean.map((t) => ({ node: t.node }));
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
  ['res', 'RES', 'setRes', 'reset, active low'],
  ['irq', 'IRQ', 'setIrq', 'interrupt request, active low, masked by the I flag'],
  ['nmi', 'NMI', 'setNmi', 'non-maskable interrupt, active low'],
  ['rdy', 'RDY', 'setRdy', 'ready: low stalls the chip on a read cycle'],
  ['so', 'SO', 'setSo', 'set overflow, held low out of reset'],
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

  /** Where you have walked, how far back each step reaches, and back to any of it. */
  walk(host) {
    host.innerHTML = `<label class="sp-field sp-depth">
        <span>Depth <b class="mono" id="solo-depth-val">${state.depth}</b></span>
        <input id="solo-depth" type="range" min="1" max="6" value="${state.depth}">
      </label>
      <div class="sp-dirpair" role="group" aria-label="Direction">
        <button class="sp-dirbtn" id="solo-dir-back" type="button">what makes it</button>
        <button class="sp-dirbtn" id="solo-dir" type="button">what it drives</button>
      </div>
      <label class="sp-check">
        <input type="checkbox" id="solo-pinio"${state.pinIO ? ' checked' : ''}>
        <span>pin the chip's I/O</span>
      </label>
      <div class="sp-walk" id="sp-walk"></div>
      <div class="sp-actions">
        <button class="solo-btn sp-wide" id="sp-clear" type="button">start again from here</button>
      </div>
      <p class="sp-note">The last ${TRAIL_MAX} steps stay on the bench and older
        ones are dropped, because a drawing that grows without limit is too small
        to read at any zoom that shows all of it. Click a step to fly to it;
        <b>⌾</b> fits the whole walk.</p>
      <p class="sp-note">The steps are merged into one drawing, so a signal two
        of them share is drawn once and joined to both. That is the whole point:
        a second copy of a wire is the fastest way to lose track of which one you
        were following.</p>`;
    host.querySelector('#sp-clear').addEventListener('click', () => {
      resetTrail();
      render();
    });
    // Direction lives here rather than on the strip because it is a labelled
    // choice, not an icon: "what makes it" and "what it drives" are the two
    // readings, and an arrow glyph for either would be a guess.
    host.querySelector('#solo-dir-back').addEventListener('click', () => setDir('back'));
    host.querySelector('#solo-dir').addEventListener('click', () => setDir('fwd'));
    // Changing how far each step reaches resizes every column, so the walk
    // starts again from here -- the same rule the page's own slider follows.
    host.querySelector('#solo-depth').addEventListener('input', (e) =>
      setDepth(Number(e.target.value)));
    // Unlike depth, this does not reset the walk: the pin is an anchor added to
    // what is already on the bench, not a change to how big each step is.
    host.querySelector('#solo-pinio').addEventListener('change', (e) =>
      setPinIO(e.currentTarget.checked));
    paintDir();
    paintPinIO();
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
          const box = state.nodeBox.get(state.trail[Number(b.dataset.i)].node);
          if (box) ensureVisible(box, 120);
        });
      }
    };
  },

  /** The chip's edge: what is on the pads, and the five pins that drive it. */
  io(host) {
    host.innerHTML = `<dl class="sp-kv" id="sp-io"></dl>
      <p class="sp-sub">Input pins: the level on each. Click to flip it.</p>
      <div class="sp-pins" id="sp-pins"></div>
      <p class="sp-note">Everything above is read off the pads: the address and
        data buses are the levels on <span class="mono">ab0…15</span> and
        <span class="mono">db0…7</span>, not a number kept beside them. Four of
        the pins are active low, so 0 means asserted. <b>SO</b> is the
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
        <dt>Phase</dt><dd class="mono">${m.clk0() ? 'φ1' : 'φ2'} · ${m.timingStates() || 'none'}${m.sync() ? ' · SYNC' : ''}</dd>`;
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
      <p class="sp-note">The bus the chip is talking to, not a copy of it, so
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
   * `$FF - S`, which assumes the stack began empty at the top -- and the 6502
   * does not clear S at reset. It decrements it by three and nothing else, so
   * out of a power-on it holds whatever its storage nodes came up as, exactly as
   * this simulator reproduces. How much is on the stack is not something the
   * chip knows, and a panel that reported a number for it would be reporting an
   * assumption in the same typeface as a measurement.
   */
  stack(host) {
    host.innerHTML = `<div id="sp-stack"></div>
      <p class="sp-note">S is read out of its storage nodes like every other
        register, and it points at the <em>next free byte</em>, so a push writes
        to $0100+S and then decrements, and the stack grows downward. The bytes
        below the list are whatever was pushed and pulled earlier: still in
        memory, still on the Memory tab, and no longer the chip's business.</p>
      <p class="sp-note">There is no count here on purpose. The 6502 does not
        reset its stack pointer (reset only decrements it by three) so how deep
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
  if (dir > 0) stepChip();
  else stepBack();
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
    state.depth = Math.max(1, Math.min(6, v.depth));
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

/**
 * The one place the I/O pinning changes, and `paintPinIO` the one place it is
 * shown -- the same arrangement depth has, and for the same reason: there are
 * two checkboxes for it and they must not be able to disagree.
 *
 * The walk is not reset. The pin is an anchor added to whatever is already on
 * the bench, so turning it on mid-walk should extend the drawing rather than
 * throw away where you have been.
 */
function setPinIO(on) {
  const next = !!on;
  if (next === state.pinIO) return;
  state.pinIO = next;
  paintPinIO();
  saveConfig();
  render();
}

function paintPinIO() {
  for (const id of ['sch-pinio', 'solo-pinio']) {
    const box = $(id);
    if (box) box.checked = state.pinIO;
  }
}

function paintDepth() {
  // Both sliders: the page's, and the study view's own -- which exists only
  // while the Walk drawer is built.
  for (const [slider, out] of [['sch-depth', 'sch-depth-val'], ['solo-depth', 'solo-depth-val']]) {
    const el = $(slider);
    if (!el) continue;
    el.value = String(state.depth);
    const label = $(out);
    if (label) label.textContent = String(state.depth);
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

/**
 * Paint the transports from the store.
 *
 * Three of them now: this page's, the study view's, and the header's. None of
 * them holds run state, so none of them can disagree about it.
 */
function paintTransport() {
  const on = isRunning();
  const a = $('sch-run');
  if (a) a.textContent = on ? 'Pause' : 'Run';
  const b = $('solo-run');
  if (b) {
    b.textContent = on ? '❙❙' : '▶';
    b.setAttribute('aria-label', on ? 'Pause' : 'Run');
    b.classList.toggle('on', on);
  }
  const c = $('solo-clock-select');
  if (c && c.value !== String(clockHz())) c.value = String(clockHz());
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
 * In the study view this *extends* the drawing rather than replacing it: the
 * signals already on the bench stay where they are and the new step's circuit is
 * merged in beside them, joining to anything it has in common. On the page
 * proper the drawing is replaced, because that view sits in a scrolling stage
 * with no camera to find the rest of a walk with.
 */
function setRoot(node) {
  if (node !== state.root) remember('root');
  state.root = node;
  if (state.solo) walkTo(node);
  renderSignal(node);
  clearCompare();
  paintPicker();
  render();
  syncUrl();
}

/** Append to the walk, dropping the oldest step once it is full. */
function walkTo(node) {
  const last = state.trail[state.trail.length - 1];
  if (last && last.node === node) return;
  state.trail.push({ node });
  while (state.trail.length > TRAIL_MAX) state.trail.shift();
}

/** Start the walk again from where you are. */
function resetTrail() {
  state.trail = state.root == null ? [] : [{ node: state.root }];
}

function render() {
  if (!state.solo || !state.trail.length) resetTrail();
  const c = merge();
  drawWalk(c);
  const gates = c.elements.filter((e) => e.kind !== 'switch').length;
  const sw = c.elements.length - gates;
  const way = c.dir === 'fwd' ? 'levels forward' : 'levels back';
  const capped = c.truncated
    ? ` · ${c.truncated} more not shown (fan-out capped at ${MAX_FAN})`
    : '';
  // The pin, and the honest answer when there is not one. A count that quietly
  // omitted the unreachable case would read as "no pins are ever involved".
  let io = '';
  if (c.pinned) {
    io = c.pinned.pin != null
      ? ` · pinned to ${nameOf(c.pinned.pin)}, ${c.pinned.hops} elements away`
      : ` · no path to a ${c.dir === 'back' ? 'chip input' : 'chip output'} from here`;
  }
  $('sch-caption').textContent =
    `${nameOf(state.root)}: ${c.levels.reduce((a, l) => a + l.length, 0)} signals, `
    + `${gates} gates, ${sw} switches, ${c.levels.length} ${way}${capped}${io}`;
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
    : '<p class="muted">nothing: every element here has a partner</p>';

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
      it. Two bits of one bus use different wires by definition; the question is
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
    draw = createDraw(data);

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
    // Whatever was chosen on the Programs page or in the header, so that the
    // gates on this page belong to the same run the die view was showing.
    state.program = selectedProgram(location.search);
    m.load(LOAD_ADDR, new Uint8Array(PROGRAMS[state.program].bytes));
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
      `${c.gates} gates: ${c.inverter} inverters, ${c.nor} NOR, ${c.nand} NAND, ${c.aoi} AOI, `
      + `${c.dynamic} precharged · ${c.switches} switches · `
      + `${c.absorbed} of ${c.transistors} transistors inside a symbol · ${c.unresolved} unresolved`;

    const q = new URLSearchParams(location.search);
    state.depth = Math.max(1, Math.min(6, Number(q.get('depth')) || 3));
    state.dir = q.get('dir') === 'fwd' ? 'fwd' : 'back';
    $('sch-depth').value = String(state.depth);
    $('sch-depth-val').textContent = String(state.depth);

    const want = q.get('signal');
    const byName = new Map(data.names.map((n, i) => [n, i]).filter(([n]) => n));
    // Shared, because the pin chains resolve the pad ring through it too.
    state.byName = byName;
    state.root = byName.get(want) ?? byName.get('dpc3_SBX') ?? byName.get('a0') ?? 0;

    // Changing the program here restarts the chip on the new one and leaves the
    // walk where it is: the circuit is a property of the silicon, not of what
    // happens to be running through it.
    state.nav = setupProgramNav({
      onChange: (i) => {
        state.program = i;
        setSelectedProgram(i);
        m.load(LOAD_ADDR, new Uint8Array(PROGRAMS[i].bytes));
        m.setResetVector(LOAD_ADDR);
        m.powerCycle();
        render();
      },
    });

    // The saved I/O choice, read up front with the rest of the configuration.
    // Reading it later would find whatever the first render just wrote -- the
    // same trap the console's tab fell into.
    const saved = loadConfig();
    if (saved && typeof saved.pinIO === 'boolean') state.pinIO = saved.pinIO;
    $('sch-pinio').checked = state.pinIO;
    $('sch-pinio').addEventListener('change', (e) => setPinIO(e.currentTarget.checked));

    buildPicker();
    $('sch-filter').addEventListener('input', buildPicker);
    $('sch-signal').addEventListener('change', (e) => setRoot(Number(e.target.value)));
    $('sch-depth').addEventListener('input', (e) => setDepth(Number(e.target.value)));
    // The header owns the transport; this page's own buttons and the study
    // view's are two more views of it. The study view is fullscreen, with no
    // header to reach, so it carries the clock select as well.
    setupChipNav({
      step: () => { state.machine.halfStep(); refresh(); },
      back: () => { state.machine.stepBack(); refresh(); },
      reset: () => { state.machine.powerCycle(); refresh(); },
      halfCycle: () => state.machine.halfCycle(),
    });
    const soloClock = $('solo-clock-select');
    for (const c of CLOCKS) soloClock.add(new Option(c.label, String(c.hz)));
    soloClock.addEventListener('change', () => setClock(Number(soloClock.value)));
    subscribe(paintTransport);

    $('sch-run').addEventListener('click', () => toggleRunning());
    $('sch-reset').addEventListener('click', () => resetChip());
    $('solo-run').addEventListener('click', () => toggleRunning());
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
      else if (ev.key === ' ') { toggleRunning(); ev.preventDefault(); }
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
      // Read the saved configuration *once*, up front, and write nothing until
      // the switch is over.
      //
      // Both halves of that are load-bearing and the second was learnt the hard
      // way. Leaving restores the reader's depth, `setDepth` starts the walk
      // again because every column would change size, and it does all that while
      // `state.solo` is still true -- so the render it triggers *saved a
      // one-step walk over the saved one*, a moment before leaving. The walk was
      // gone by the time anybody came back for it. Reading late is the other
      // half: a render writes the current state, so a read after the first one
      // finds the defaults it just wrote rather than what was saved.
      const cfg = on ? loadConfig() : null;
      state.quiet = true;
      try {
        // Fullscreen used to drop to a single level on the way in and put the
        // reader's depth back on the way out. That made sense when it showed one
        // cone with everything else hidden -- but it is a workbench now, and
        // arriving to *less* than the page was already showing is a jolt with
        // nothing to recommend it. It carries the view in: same signal, same
        // depth, same direction. The depth control comes along too, in the Walk
        // drawer, since the page's own slider is out of sight in this mode.
        state.solo = on;
        state.framed = false;      // aim the camera once, on arrival
        console_.classList.toggle('solo', on);
        // A walk belongs to the study view: the page proper draws one cone in a
        // scrolling stage, with no camera to find the rest of a walk with.
        resetTrail();
        if (cfg) {
          restoreTrail(cfg);                  // the same walk, if it is the same bench
          if (PANELS[cfg.tab]) state.tab = cfg.tab;
          state.drawer = cfg.drawer !== false;
        }
        if (state.root != null) render();
      } finally {
        state.quiet = false;
      }
      // The console only exists in this mode, so entering has to open and
      // populate it rather than waiting for the next animation frame. Opening it
      // is also the first write after the switch, which puts the restored walk
      // back on disk under its own name.
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
    const parts = [`½cyc ${m.halfCycle()}`, m.clk0() ? 'φ1' : 'φ2', m.timingStates() || 'none'];
    if (m.sync()) parts.push('sync');
    const text = parts.join(' · ');
    if (out.textContent !== text) out.textContent = text;
  }
  refreshPalette();
  paint(m.nodeLevels());
}

function tick(now = 0) {
  const m = state.machine;
  // The page and the study view ran at different rates: eight half-cycles a
  // frame here, four a second there. That difference existed because the page
  // had no rate control, and it does now -- one clock, paced in wall-clock time
  // so the reader chooses how fast an edge arrives.
  const n = halfCyclesFor(now);
  for (let i = 0; i < n; i++) m.halfStep();
  state.lastFrame = now;
  refresh();
  state.raf = requestAnimationFrame(tick);
}

boot();
