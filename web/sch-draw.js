// The schematic drawing engine: layered layout, and the symbols themselves.
//
// This was inside schematic.js and moved out the moment a second page wanted to
// draw the same circuit. That is the same reasoning as block-palette.js, and the
// stake is higher here: two pages drawing an NMOS gate from two copies of this
// code would eventually draw it two different ways, and a reader comparing a
// block page with the workbench would have no way to tell which one was lying.
//
// It knows nothing about pages, panels or state. Everything it needs about the
// chip arrives as `data` (the parsed schematic.json) and everything it needs
// about the page arrives as callbacks, so the workbench and the block pages can
// hand it different behaviour without forking the drawing.
//
// The unit it draws is a *cone*: `{ root, levels, elements, dir }`, where
// `levels[i]` is the signals i steps from the root and each element names its
// output, its inputs and the level it sits in. Nothing in here cares how those
// levels were arrived at -- schematic.js walks outward from one signal, block.js
// walks inward from a block's ports -- which is exactly why the two can share it.

import { blockCss } from './block-palette.js';

export const SVGNS = 'http://www.w3.org/2000/svg';

// Geometry. Every drawn thing has a box, and nothing is placed without asking
// whether that box is free -- the first version spaced columns by a constant and
// stacked elements at the mean of their inputs, which piles a dozen switches on
// one another whenever their inputs happen to share a row.
export const NODE_H = 22;   // pill height
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

export function el(tag, attrs, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    // A `style` key goes through the CSSOM, never the attribute. The live
    // site's CSP is `style-src 'self'` with no 'unsafe-inline', and that
    // blocks writing a style ATTRIBUTE (the tracer's region colours all
    // vanished, one console error per element) while `style.setProperty`
    // is not inline style and is allowed. Same result in development, where
    // there is no CSP, so a harness cannot see the difference: check the
    // live site's console.
    if (k === 'style') {
      for (const decl of String(v).split(';')) {
        const i = decl.indexOf(':');
        if (i < 0) continue;
        e.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
      }
    } else e.setAttribute(k, v);
  }
  if (parent) parent.append(e);
  return e;
}

/**
 * A drawer bound to one parsed schematic.json.
 *
 * `nameOf` and `isNamed` come back out because every caller needs them and a
 * second spelling of "an unnamed node is called #1234" would show up as two
 * pages labelling the same wire differently.
 */
export function createDraw(data, opts = {}) {
  const nameOf = (n) => data.names[n] ?? `#${n}`;
  // An address for a pill, when the caller can supply one. It goes in an SVG
  // <title>, which is a hover tooltip, and NEVER in the label: pill width is
  // measured from the label text and column width from the pills, so putting
  // `logic:4:nor2:#602` where `#602` was would relayout the whole drawing.
  const addressOf = opts.addressOf || null;
  const isNamed = (n) => data.names[n] != null;

  /** Width of a signal's pill, from its label. */
  const boxWidth = (node) => Math.max(46, nameOf(node).length * 6.6 + 14);

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
   * Draw the graph: signals, the elements between them, and the wires.
   *
   * It used to draw one cone per island and take an index to tell them apart.
   * There is one drawing now -- every node appears exactly once -- so there is
   * nothing to distinguish and nothing to offset.
   *
   * `opts` is everything that belongs to the page rather than to the circuit:
   *
   *   pick(node)      what a click on a signal or a control name means
   *   dragging()      whether the gesture that just ended was a pan, not a click
   *   diffControls    control names to mark as differing, for the compare view
   *   onBlocks(set)   the blocks that ended up on screen, for the key
   *   markOf(node)    `{cls, label}` to mark a signal as something other than an
   *                   ordinary member of this drawing, or null. The block pages
   *                   use it to say which pills are the edge of the block and
   *                   which are gates only affiliated with it.
   */
  function drawGraph(host, c, L, opts = {}) {
    const { place, items, flip } = L;
    const { pick, dragging, diffControls, onBlocks, markOf } = opts;
    const wires = el('g', { class: 'sch-wires' }, host);
    const parts = el('g', { class: 'sch-parts' }, host);
    const labels = el('g', { class: 'sch-labels' }, host);
    const { vss, vcc } = data;

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
        const differs = diffControls && diffControls.has(nameOf(e.control));
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
    const blocksHere = new Set();
    for (const [node, p] of place) {
      const mark = markOf ? markOf(node) : null;
      const g = el('g', {
        class: 'sch-node' + (node === c.root ? ' root' : '') + (isNamed(node) ? '' : ' anon')
          + (c.pinned && node === c.pinned.pin ? ' pin' : '')
          + (mark ? ` ${mark.cls}` : ''),
        'data-node': node,
        transform: `translate(${p.x},${p.y})`,
      }, parts);
      // The outline says which part of the chip this wire belongs to, in the same
      // colours the exploded view uses -- one palette, in block-palette.js, so
      // the two pages cannot come to disagree about what colour the ALU is.
      //
      // It is a custom property rather than a `stroke`, because an inline stroke
      // would outrank the `.root` and `:hover` rules and quietly kill both.
      const block = data.nodeBlock[node] & 0x7f;
      g.style.setProperty('--block', blockCss(block));
      g.dataset.block = String(block);
      blocksHere.add(block);
      el('rect', { x: p.flip ? 0 : -p.w, y: -NODE_H / 2, width: p.w, height: NODE_H,
                   rx: 3, class: 'sch-pill' }, g);
      if (addressOf) {
        // First child, which is where SVG looks for a tooltip.
        const a = addressOf(node);
        if (a) el('title', {}, g).textContent = a;
      }
      const t = el('text', { x: (p.flip ? 1 : -1) * p.w / 2, y: 4, class: 'sch-name' }, g);
      t.textContent = nameOf(node);
      // A marked signal says what it is, under its pill. Without it a port is
      // indistinguishable from a dead end, which is the difference between "the
      // block ends here" and "the drawing does".
      if (mark && mark.label) {
        const pt = el('text', { x: (p.flip ? 1 : -1) * p.w / 2, y: NODE_H / 2 + 11,
                                class: 'sch-port-label' }, g);
        pt.textContent = mark.label;
      }
      // A drag that ends on a signal is panning, not choosing. `dragging()` reads
      // the gesture that just ended: it is set by the camera on release and
      // cleared on the next press, and click fires straight after release.
      if (pick) g.addEventListener('click', () => { if (!dragging || !dragging()) pick(node); });
    }

    if (onBlocks) onBlocks(blocksHere);

    if (pick) {
      host.querySelectorAll('.sch-ctrl').forEach((t) => {
        if (!t.dataset.node) return;
        t.style.cursor = 'pointer';
        t.addEventListener('click', () => {
          if (!dragging || !dragging()) pick(Number(t.dataset.node));
        });
      });
    }
  }

  return { nameOf, isNamed, boxWidth, layout, drawGraph };
}
