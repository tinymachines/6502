// The timing chain as cells: the logic that computes each T-state, derived
// from the switch network, plus the logic the cells share.
//
// The "Timing chain" block the exploded view draws is a set of 25 nodes seeded
// by name, and it is a poor container: its members spread into a dozen region
// pieces, and the chain's latches are not even in it. Each T-state output
// (`t3`, say) is an inverter filed in the timing block whose input is a NOR in
// the control pipeline, whose inputs are a dynamic node and a reset in the
// static logic, and the value is held in a cclk half-latch the die calls
// `pipeT3out`. What is a chain is that structure repeated: for T2..T5 the same
// five nodes each, the AOI at the back of each reading `ready AND the previous
// stage's latch` OR `not ready AND its own`, which is a shift register that
// holds when RDY is low, written out in switches.
//
// The rule, and nothing is named but the blocks the chain lives in:
//
//  1. The stages are `timing.json`'s `stages`, in order: the six outputs the
//     simulator's T-state readout reads (`clock1`, `clock2`, `t2`..`t5`).
//  2. From each output walk BACKWARD: a gate's inputs, and a switch's channel
//     both ways (a dynamic latch's data is the far side of its clock switch;
//     the control, cp1 or cclk, rides on the edge and is never expanded, as
//     the schematic's cone has it). Rails are never entered. The chain lives
//     in three blocks, the timing chain, the control pipeline and the static
//     logic; a node outside them is recorded but not expanded, and a node
//     INSIDE them with an input from outside is a boundary, kept but not
//     expanded: that is where the chain stops being about itself and starts
//     reading the decoder, the interrupt logic or the ALU. The reach converges
//     on its own under that cut (59 nodes at any depth of 8 or more); the depth
//     cap is a runaway guard.
//  3. A reached node belongs to the stage that reaches it in the fewest
//     steps; a tie is shared. Then any node read, as a gate input, by the
//     nodes of three or more stages is shared too: that is the reset
//     (`#1357`) and ready (`notRdy0`, `#16`) the whole chain consults.
//  4. A cell is its output plus its own nodes still connected to it through
//     own nodes only; shared nodes and other stages' nodes are walls. The
//     shared group is the shared nodes a cell actually reads.
//
// Measured on this die: T0 21 nodes (it is the state the chain is reset INTO,
// so its reach is the end-of-instruction logic up to the boundary), T1 3, T2 8
// (it takes the SYNC latch it loads from), T3 5, T4 5, T5 5, shared 4. The
// cells link in order: T3's AOI reads `pipeT2out`, T4's `pipeT3out`, T5's
// `pipeT4out`; T1 reads T0's latch and T0 reads T1's. That order is what the
// tracer's card reports as "reads".
//
// A leaf: it imports nothing and touches no DOM, so a harness can call it or
// re-derive the rule and compare.

export const CHAIN_HOME = ['Timing chain', 'Control pipeline', 'Static logic'];

/**
 * @param {object} sch   schematic.json (gates, switches, names, nodeBlock, blockNames, vss, vcc)
 * @param {{name:string,node:number}[]} stages   timing.json's `stages`, in order
 * @param {{home?:string[], cap?:number}} [opts]
 * @returns {{cells: {id:string, name:string, node:number, nodes:number[], reads:{node:number, of:number, cell:number}[]}[],
 *            shared: number[], reached: number, cap: number}}
 */
export function chainCells(sch, stages, { home = CHAIN_HOME, cap = 32 } = {}) {
  const rails = new Set([sch.vss, sch.vcc]);
  const blk = (n) => sch.nodeBlock[n] & 0x7f;
  const inside = new Set(home.map((s) => sch.blockNames.indexOf(s)).filter((i) => i >= 0));
  // Backward adjacency: gate inputs, switch channels both ways.
  const back = new Map();
  const add = (a, b) => { if (!back.has(a)) back.set(a, new Set()); back.get(a).add(b); };
  for (const g of sch.gates) for (const i of new Set(g[3].flat())) add(g[0], i);
  for (const [, a, b] of sch.switches) { add(a, b); add(b, a); }
  const nb = (n) => back.get(n) || new Set();
  const boundary = (n) => [...nb(n)].some((m) => !rails.has(m) && !inside.has(blk(m)));

  const outs = stages.map((s) => s.node);
  const reach = outs.map((o) => {
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

  // Owner by fewest steps; a tie is shared (-1).
  const owner = new Map();
  const all = new Set();
  for (const r of reach) for (const n of r.keys()) all.add(n);
  for (const n of all) {
    const hits = reach.map((r, i) => [i, r.get(n)]).filter(([, d]) => d !== undefined);
    const md = Math.min(...hits.map((h) => h[1]));
    const best = hits.filter((h) => h[1] === md);
    owner.set(n, best.length > 1 ? -1 : best[0][0]);
  }
  // A node read by the gates of three or more stages is shared chain logic.
  const readBy = new Map();
  for (const g of sch.gates) {
    const o = owner.get(g[0]);
    if (o === undefined || o < 0) continue;
    for (const i of new Set(g[3].flat())) {
      if (!readBy.has(i)) readBy.set(i, new Set());
      readBy.get(i).add(o);
    }
  }
  for (const [n, ss] of readBy) if (ss.size >= 3 && owner.has(n)) owner.set(n, -1);

  // Cells: connected from the output through own, inside nodes.
  const cells = outs.map((o, i) => {
    const c = new Set([o]);
    const q = [o];
    while (q.length) {
      const n = q.shift();
      for (const m of nb(n)) {
        if (owner.get(m) === i && !c.has(m) && inside.has(blk(m))) { c.add(m); q.push(m); }
      }
    }
    return c;
  });
  const cellOf = new Map();
  cells.forEach((c, i) => c.forEach((n) => cellOf.set(n, i)));
  // Shared: the shared nodes a cell reads.
  const shared = new Set();
  for (const [n] of cellOf) for (const m of nb(n)) if (owner.get(m) === -1) shared.add(m);
  // Links: a cell node reading (gate input) a node of another cell.
  const gateIns = new Map();
  for (const g of sch.gates) gateIns.set(g[0], [...new Set(g[3].flat())]);
  const out = cells.map((c, i) => {
    const reads = [];
    for (const n of c) for (const m of gateIns.get(n) || []) {
      const j = cellOf.get(m);
      if (j !== undefined && j !== i) reads.push({ node: n, of: m, cell: j });
    }
    return { id: `T${i}`, name: stages[i].name, node: outs[i], nodes: [...c].sort((a, b) => a - b), reads };
  });
  return { cells: out, shared: [...shared].sort((a, b) => a - b), reached: all.size, cap };
}
