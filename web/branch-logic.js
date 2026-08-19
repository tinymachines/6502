// The branch logic, derived from the switch network and split where the
// wiring splits it.
//
// The "Interrupts & vectors" block is where the seed table filed the branch
// nodes, because the names (`branch-back`, `#BRtaken`, `nnT2BR`,
// `short-circuit-branch-add`) were read as control-flow like the vectors. The
// interrupt paths leave them over (interrupt-paths.js), and asked for them on
// their own the honest container is what the wires say they are:
//
//  1. Seeds: every node whose name the die gave a branch word (`branch`,
//     `BRtaken`, `T2BR`) that lives in the interrupts block or the static
//     logic. The decode terms `op-T2-branch`, `op-T3-branch`, `op-branch-done`
//     are PLA rows and belong to the stage clusters; the `#op-branch-*`
//     inverters beside them are the PLA's and are reached as boundaries.
//  2. From each seed walk BACKWARD: a gate's inputs, and a switch's channel
//     both ways, never entering a rail; a node outside the two home blocks is
//     recorded but not expanded, and a node inside with an input from outside
//     is a boundary, kept but not expanded. That is where the branch logic
//     stops being itself and starts reading the instruction register, the
//     flags, the data bus and the adder.
//  3. The union of those cones, restricted to the home, falls into connected
//     components, and that split is the measurement: THREE. One holds
//     `#BRtaken`: an AOI that is `ir5` XNOR the flag `#620` selects, `#620`
//     being a NOR of four gates each pairing one flag (`p0`, `p1`, `p6`, `p7`)
//     with the decode of opcode bits 6 and 7: the flag multiplexer, written
//     in switches. One holds `nnT2BR`, `branch-back` (an AOI reading the
//     offset's sign, `DBNeg`, at T2 of a branch) and its `.phi1` latches: the
//     direction. And `short-circuit-branch-add` with its cp1 latch is a piece
//     of its own, because it hangs off the direction latches only through
//     switch CONTROLS, which ride on edges and are never expanded; it reads
//     the adder's carry, or its complement when the branch is backward, and
//     is the page-cross decision proper. Which component is which is read off
//     the seed it contains and labelled `taken`, `direction` and `cross`; the
//     labels are a reading, the split is not.
//  4. Each component's `reads` are the nodes outside it that its members read
//     (gate inputs and switch partners) and its `feeds` the nodes outside it
//     that its members drive as gate inputs: measured both ways, and on the
//     card. Taken reads `notir5`, the `#op-branch-bit6/7` decodes and the
//     flags' pipeline copies, and feeds `#586`, the gate behind
//     `pipeIPCrelated`; cross reads `#alucout` and feeds `dpc36_#IPC`, the
//     control line that stops the program counter incrementing, and `#959`,
//     which is the timing chain's reset: a branch that crosses no page ends
//     early, and that is the wire it ends on.
//
// Measured on this die: taken 9, direction 8, cross 2, converging by depth 4.
//
// A leaf: it imports nothing and touches no DOM.

export const HOME = ['Interrupts & vectors', 'Static logic'];
export const SEED = /branch|BRtaken|T2BR/i;
export const LABELS = [['#BRtaken', 'taken'], ['branch-back', 'direction'], ['short-circuit-branch-add', 'cross']];

/**
 * @param {object} sch  schematic.json
 * @param {{home?:string[], cap?:number}} [opts]
 * @returns {{groups: {id:string, seeds:number[], nodes:number[], reads:number[], feeds:number[]}[], seeds:number[], reached:number}}
 */
export function branchLogic(sch, { home = HOME, cap = 32 } = {}) {
  const rails = new Set([sch.vss, sch.vcc]);
  const blk = (n) => sch.nodeBlock[n] & 0x7f;
  const inside = new Set(home.map((s) => sch.blockNames.indexOf(s)).filter((i) => i >= 0));
  const back = new Map();
  const fwd = new Map();
  const add = (m, a, b) => { if (!m.has(a)) m.set(a, new Set()); m.get(a).add(b); };
  for (const [out, , , legs] of sch.gates) for (const i of new Set(legs.flat())) { add(back, out, i); add(fwd, i, out); }
  for (const [, a, b] of sch.switches) { add(back, a, b); add(back, b, a); }
  const nb = (n) => back.get(n) || new Set();
  const boundary = (n) => [...nb(n)].some((m) => !rails.has(m) && !inside.has(blk(m)));

  const seeds = [];
  sch.names.forEach((s, n) => { if (s && SEED.test(s) && inside.has(blk(n))) seeds.push(n); });
  const reached = new Set();
  for (const o of seeds) {
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
    for (const n of d.keys()) if (inside.has(blk(n))) reached.add(n);
  }
  // Connected components of the reached set, by the undirected union of the
  // same adjacency, restricted to reached nodes.
  const und = new Map();
  for (const n of reached) for (const m of nb(n)) if (reached.has(m)) { add(und, n, m); add(und, m, n); }
  const comp = new Map();
  const groups = [];
  for (const s of seeds) {
    if (comp.has(s)) continue;
    const c = new Set([s]);
    const q = [s];
    while (q.length) {
      const n = q.shift();
      for (const m of und.get(n) || []) if (!c.has(m)) { c.add(m); q.push(m); }
    }
    const id = groups.length;
    for (const n of c) comp.set(n, id);
    groups.push({ nodes: [...c].sort((a, b) => a - b), seeds: seeds.filter((x) => c.has(x)) });
  }
  const byName = new Map();
  sch.names.forEach((s, n) => { if (s) byName.set(s, n); });
  for (const g of groups) {
    const lab = LABELS.find(([name]) => g.seeds.includes(byName.get(name)));
    g.id = lab ? lab[1] : `group${groups.indexOf(g)}`;
    const mem = new Set(g.nodes);
    const feeds = new Set(), reads = new Set();
    for (const n of g.nodes) {
      for (const m of fwd.get(n) || []) if (!mem.has(m)) feeds.add(m);
      for (const m of nb(n)) if (!mem.has(m) && !rails.has(m)) reads.add(m);
    }
    g.feeds = [...feeds].sort((a, b) => a - b);
    g.reads = [...reads].sort((a, b) => a - b);
  }
  return { groups, seeds: seeds.sort((a, b) => a - b), reached: reached.size };
}
