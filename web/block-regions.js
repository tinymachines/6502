// Where each functional block is on the die, as a region rather than a hull.
//
// The first idea was a convex hull per block, and it was measured before it
// was drawn: the control pipeline's hull is 45% of the die, and the address
// latches' hull contains every node of the ALU and the program counter,
// because the datapath blocks are interleaved bit-slices and the control
// lines run along all of them. A hull that claims the neighbour's silicon is
// the opposite of a container.
//
// So a block's region is defined by one rule and nothing else: every point
// within `radius` die units of one of its member nodes. It can be several
// pieces, it can have holes, and two blocks' regions can overlap; all three
// are facts about the die and are drawn as such. The rule is evaluated on a
// grid (`cell` die units) as a distance field and traced with marching
// squares, so the outline is the union of discs to within a cell.
//
// A leaf: it imports nothing, takes the centroids `die-centroids.js` already
// computes and the block of each node, and returns geometry. The tracer draws
// it; a harness can call it, or re-derive the rule and compare.

/**
 * @param {Map<number, {x:number,y:number}>} pos   node -> centroid (die units)
 * @param {number[]} nodeBlock   node -> block id (bit 7 stripped by the caller)
 * @param {number[]} blocks      the block ids to build regions for
 * @param {{xmin:number,ymin:number,xmax:number,ymax:number}} bounds  the die
 * @param {{radius?:number, cell?:number}} [opts]
 * @returns {Map<number, {loops: {x:number,y:number}[][], cells: number, pieces: number,
 *                        label: {x:number,y:number}|null, members: number}>}
 */
export function blockRegions(pos, nodeBlock, blocks, bounds, { radius = 300, cell = 50 } = {}) {
  const R = radius;
  // Sample points sit at cell centres, one cell of margin each side so a
  // region at the die's edge still closes.
  const x0 = bounds.xmin - R - cell * 2, y0 = bounds.ymin - R - cell * 2;
  const W = Math.ceil((bounds.xmax + R + cell * 2 - x0) / cell) + 1;
  const H = Math.ceil((bounds.ymax + R + cell * 2 - y0) / cell) + 1;
  const members = new Map();
  for (const b of blocks) members.set(b, []);
  for (const [n, p] of pos) {
    const b = nodeBlock[n];
    if (members.has(b)) members.get(b).push(p);
  }

  const out = new Map();
  for (const b of blocks) {
    const pts = members.get(b);
    // The distance field: for every sample point, the distance to the nearest
    // member. Each member only touches the samples within R + one cell of it.
    const f = new Float32Array(W * H).fill(Infinity);
    const reach = Math.ceil((R + cell) / cell);
    for (const p of pts) {
      const ci = Math.round((p.x - x0) / cell), cj = Math.round((p.y - y0) / cell);
      for (let j = Math.max(0, cj - reach); j <= Math.min(H - 1, cj + reach); j++) {
        const sy = y0 + j * cell;
        for (let i = Math.max(0, ci - reach); i <= Math.min(W - 1, ci + reach); i++) {
          const sx = x0 + i * cell;
          const d = Math.hypot(sx - p.x, sy - p.y);
          const k = j * W + i;
          if (d < f[k]) f[k] = d;
        }
      }
    }
    // A sample exactly on the iso-line would put an interpolated point on a
    // grid corner, where two edges meet, and the chaining below relies on
    // every point belonging to exactly one edge. Nudge such a sample inside;
    // a thousandth of a die unit is far below anything drawn.
    for (let k = 0; k < f.length; k++) if (Math.abs(f[k] - R) < 1e-3) f[k] = R - 1e-3;
    let cells = 0;
    for (let k = 0; k < f.length; k++) if (f[k] <= R) cells++;
    const loops = pts.length ? trace(f, W, H, x0, y0, cell, R) : [];
    // Pieces: the outer loops. A loop is outer if it runs anticlockwise in this
    // orientation, which the tracer below guarantees by construction (inside
    // is kept on the left). Holes are the other loops.
    const outer = loops.filter((l) => signedArea(l) > 0);
    // The label goes on the largest piece, at the centroid of its outline; a
    // C-shaped or ring-shaped piece has its centroid outside itself, so a
    // label that lands outside the region snaps to the nearest member.
    let label = null, best = -1;
    for (const l of outer) {
      const a = signedArea(l);
      if (a > best) { best = a; label = centroid(l); }
    }
    if (label && !inRegion(label, loops)) {
      let bd = Infinity;
      for (const p of pts) { const d = Math.hypot(p.x - label.x, p.y - label.y); if (d < bd) { bd = d; label = p; } }
    }
    out.set(b, { loops, cells, pieces: outer.length, label, members: pts.length });
  }
  return out;
}

/** Every sample grid's cells, for a caption: how many a region could cover. */
export function gridCells(bounds, { radius = 300, cell = 50 } = {}) {
  const R = radius;
  const x0 = bounds.xmin - R - cell * 2, y0 = bounds.ymin - R - cell * 2;
  const W = Math.ceil((bounds.xmax + R + cell * 2 - x0) / cell) + 1;
  const H = Math.ceil((bounds.ymax + R + cell * 2 - y0) / cell) + 1;
  return W * H;
}

/**
 * Marching squares over the field, iso-line at R, interpolated on the edges;
 * segments are oriented with the inside on the left, then chained into loops.
 */
function trace(f, W, H, x0, y0, cell, R) {
  const segs = [];
  const at = (i, j) => f[j * W + i];
  // Interpolated point on the edge between two samples.
  const lerp = (ax, ay, av, bx, by, bv) => {
    const t = (av === bv) ? 0.5 : (R - av) / (bv - av);
    return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t };
  };
  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      // Corners: a=(i,j) b=(i+1,j) c=(i+1,j+1) d=(i,j+1). Inside is f <= R.
      const av = at(i, j), bv = at(i + 1, j), cv = at(i + 1, j + 1), dv = at(i, j + 1);
      const a = av <= R, b = bv <= R, c = cv <= R, d = dv <= R;
      const code = (a ? 1 : 0) | (b ? 2 : 0) | (c ? 4 : 0) | (d ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const ax = x0 + i * cell, ay = y0 + j * cell, bx = ax + cell, cy = ay + cell;
      // Edge points: top (a-b), right (b-c), bottom (d-c), left (a-d). Each
      // carries the identity of the grid edge it sits on, and the chaining
      // below joins segments by that identity rather than by coordinates:
      // two crossings a hair apart on two different edges would otherwise
      // round to one key, and a crossing that is exactly a corner would be two.
      const T = () => [lerp(ax, ay, av, bx, ay, bv), `h${i}:${j}`];
      const Rr = () => [lerp(bx, ay, bv, bx, cy, cv), `v${i + 1}:${j}`];
      const B = () => [lerp(ax, cy, dv, bx, cy, cv), `h${i}:${j + 1}`];
      const L = () => [lerp(ax, ay, av, ax, cy, dv), `v${i}:${j}`];
      // Each case emits segments oriented so the inside is on the left of the
      // walk, left meaning (-dy, dx) in these coordinates: corner a is (0,0),
      // b (1,0), c (1,1), d (0,1). That is what makes the shoelace sign below
      // say outer or hole, and what lets the chaining assume every edge ends
      // exactly one segment and starts exactly one.
      const emit = (p, q) => segs.push({ p: p[0], pk: p[1], q: q[0], qk: q[1] });
      switch (code) {
        case 1: emit(T(), L()); break;
        case 2: emit(Rr(), T()); break;
        case 3: emit(Rr(), L()); break;
        case 4: emit(B(), Rr()); break;
        case 5: emit(T(), L()); emit(B(), Rr()); break;
        case 6: emit(B(), T()); break;
        case 7: emit(B(), L()); break;
        case 8: emit(L(), B()); break;
        case 9: emit(T(), B()); break;
        case 10: emit(Rr(), T()); emit(L(), B()); break;
        case 11: emit(Rr(), B()); break;
        case 12: emit(L(), Rr()); break;
        case 13: emit(T(), Rr()); break;
        case 14: emit(L(), T()); break;
      }
    }
  }
  const byStart = new Map();
  for (const s of segs) byStart.set(s.pk, s);
  const used = new Set();
  const loops = [];
  for (const s of segs) {
    if (used.has(s)) continue;
    const loop = [];
    let cur = s;
    while (cur && !used.has(cur)) {
      used.add(cur);
      loop.push(cur.p);
      cur = byStart.get(cur.qk);
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/**
 * Signed area. With y growing downward and the inside kept on the left of
 * each segment, an outer loop comes out with positive area here and a hole
 * negative. (Checked in `_tracer-test.html` against the member nodes: every
 * member lies inside its block's region by the SVG's own hit test.)
 */
export function signedArea(loop) {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i], q = loop[(i + 1) % loop.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function centroid(loop) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i], q = loop[(i + 1) % loop.length];
    const w = p.x * q.y - q.x * p.y;
    a += w; cx += (p.x + q.x) * w; cy += (p.y + q.y) * w;
  }
  if (Math.abs(a) < 1e-9) return loop[0];
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/** Inside the region: in an odd number of loops, which is what evenodd draws. */
export function inRegion(pt, loops) {
  let crossings = 0;
  for (const l of loops) {
    for (let i = 0; i < l.length; i++) {
      const p = l[i], q = l[(i + 1) % l.length];
      if ((p.y > pt.y) !== (q.y > pt.y)) {
        const x = p.x + (pt.y - p.y) * (q.x - p.x) / (q.y - p.y);
        if (x > pt.x) crossings++;
      }
    }
  }
  return (crossings & 1) === 1;
}

/** SVG path data for a set of loops; evenodd fill makes the holes holes. */
export function loopsToPath(loops) {
  return loops.map((l) => 'M' + l.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L') + 'Z').join('');
}
