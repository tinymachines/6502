// The interrupt logic as paths from the pins, plus the vector selection.
//
// The "Interrupts & vectors" block the exploded view draws is 40 names and
// their neighbours, and a third of it is branch logic the seed table filed
// there (`branch-back`, `#BRtaken`, `nnT2BR`). What IS interrupt logic has a
// structure the pins give away: three inputs, three receivers, and the place
// where two of them meet. So the rule starts at the pins.
//
//  1. From each of `irq`, `nmi` and `res` walk FORWARD: a gate input to the
//     output it helps produce (a precharge clock counts as an input), and a
//     switch's channel both ways, never entering a rail. The logic lives in
//     the interrupts block and the static logic it is built from; a node
//     outside them is recorded but not expanded, and a node inside with an
//     output outside is a boundary, kept but not expanded: that is where an
//     interrupt stops being detected and starts being acted on (INTG feeds
//     the timing chain, Reset0 the control pipeline). The depth cap is a
//     runaway guard; the walk converges well below it.
//  2. A node reached from one pin belongs to that pin's path; a node reached
//     from more than one is shared: measured, that is four nodes, the three
//     gates between the IRQ and NMI latches and `INTG`, the interrupt-go.
//     The pin itself is not part of the path.
//  3. The vector selection is not reached from any pin: it is driven by the
//     BRK sequence, which is what every interrupt runs. It is grouped by the
//     die's names, `VEC0`, `VEC1`, `#VEC`, `pipe#VEC`, `pipeVectorA0..2`: a
//     reading of names rather than a measurement, and said so. A node a pin
//     path already reached stays with the path: `pipeVectorA2` is reached from
//     `nmi`, and that is a finding, because bit 2 is the one bit by which the
//     NMI vector $FFFA differs from $FFFE.
//
// Measured on this die: irq 6, nmi 20, res 6, shared 4, vector 6, and 22 of
// the block's 40 members in none of them: `brk-done`, the branch logic, and
// the unnamed latch partners of the vector nodes. The walk converges by a
// depth of 12.
//
// A leaf: it imports nothing and touches no DOM.

export const PINS = ['irq', 'nmi', 'res'];
export const HOME = ['Interrupts & vectors', 'Static logic'];

/**
 * @param {object} sch  schematic.json (names, gates, switches, nodeBlock, blockNames, vss, vcc)
 * @param {{home?:string[], cap?:number}} [opts]
 * @returns {{paths: {id:string, pin:number, nodes:number[]}[], shared: number[], vector: number[],
 *            residue: number[], reached: number}}
 */
export function interruptPaths(sch, { home = HOME, cap = 32 } = {}) {
  const rails = new Set([sch.vss, sch.vcc]);
  const blk = (n) => sch.nodeBlock[n] & 0x7f;
  const inside = new Set(home.map((s) => sch.blockNames.indexOf(s)).filter((i) => i >= 0));
  const byName = new Map();
  sch.names.forEach((s, n) => { if (s) byName.set(s, n); });
  const fwd = new Map();
  const add = (a, b) => { if (!fwd.has(a)) fwd.set(a, new Set()); fwd.get(a).add(b); };
  for (const [out, , pre, legs] of sch.gates) {
    for (const i of new Set(legs.flat())) add(i, out);
    if (pre >= 0) add(pre, out);
  }
  for (const [, a, b] of sch.switches) { add(a, b); add(b, a); }
  const nb = (n) => fwd.get(n) || new Set();
  const boundary = (n) => [...nb(n)].some((m) => !rails.has(m) && !inside.has(blk(m)));

  const pins = PINS.map((p) => byName.get(p));
  const reach = pins.map((o) => {
    const d = new Map([[o, 0]]);
    const q = [o];
    while (q.length) {
      const n = q.shift();
      const dn = d.get(n);
      if (dn >= cap) continue;
      if (n !== o && boundary(n)) continue;
      for (const m of nb(n)) {
        if (rails.has(m) || d.has(m)) continue;
        d.set(m, dn + 1);
        if (inside.has(blk(m))) q.push(m);
      }
    }
    return d;
  });
  const count = new Map();
  for (const r of reach) for (const n of r.keys()) count.set(n, (count.get(n) || 0) + 1);
  const taken = new Set();
  const paths = pins.map((pin, i) => {
    const nodes = [...reach[i].keys()].filter((n) => n !== pin && count.get(n) === 1 && inside.has(blk(n))).sort((a, b) => a - b);
    for (const n of nodes) taken.add(n);
    return { id: PINS[i], pin, nodes };
  });
  const shared = [...count].filter(([n, c]) => c > 1 && !pins.includes(n) && inside.has(blk(n))).map(([n]) => n).sort((a, b) => a - b);
  for (const n of shared) taken.add(n);
  const vector = [];
  sch.names.forEach((s, n) => { if (s && /vec/i.test(s) && !taken.has(n)) vector.push(n); });
  vector.sort((a, b) => a - b);
  for (const n of vector) taken.add(n);
  const ib = sch.blockNames.indexOf(home[0]);
  const residue = [];
  sch.nodeBlock.forEach((b, n) => { if ((b & 0x7f) === ib && !taken.has(n)) residue.push(n); });
  return { paths, shared, vector, residue, reached: count.size };
}
