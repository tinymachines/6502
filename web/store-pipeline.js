// The store-data pipeline, derived from the switch network: the two latches
// that remember a store is in its data cycles, and the gate that sets them.
//
// The die does not name these; the simulator's own timing readout does (the
// bracket in its fixed-width trace: SD1 is node 440, SD2 node 1258, active
// high), and their cones have turned up at the boundary of half the other
// containers: the address latches' load line reads them (the address holds
// during a store's data cycles), the write control reads them (#WR), the
// carry-in choice reads them, the RMW shift gating reads them. This is the
// machinery that turns "this instruction stores" into those holds, and it is
// three groups:
//
//  1. `detect`, the bounded backward cone of `#191` inside the control
//     pipeline and the static logic: a NOR of `#347` (itself a NOR of the
//     five data-cycle terms, `op-T2-mem-zp`, `op-T3-mem-abs`,
//     `op-T3-mem-zp-idx`, `op-T4-mem-abs-idx`, `op-T5-mem-ind-idx`: one per
//     addressing mode), `notRdy0` and `#790` (a NOR of the read-modify-write
//     classes, `op-asl/rol` and `op-lsr/ror/dec/inc`); it also feeds
//     `op-rmw`. The memory data cycle of a store or an RMW, read off the
//     wires.
//  2. `sd1`, the first latch: `pipeUNK40` (the detect, latched under `cclk`),
//     `#1039` (an AOI that holds through `pipeUNK39` when the chip is not
//     ready), `#24` under `cp1`, and `#440` itself.
//  3. `sd2`, the second: `#504` (a NAND of SD1 and ready), `pipeUNK41` under
//     `cclk`, `#1497`, `#653` under `cp1`, `#390`, and `#1258`: SD1 delayed
//     one cycle when the chip is ready.
//
// What they feed is the finding, listed on the cards and never absorbed: the
// write control `#WR` (both), the `ADL/ABL` hold `#104` (SD1: the address
// latch stops reloading), the RMW shift gating (`#905`, `#366` into `op-SRS`),
// the carry-in choice (`#1107`), and the C flag's shift path (`#op-set-C`
// reads SD2).
//
// Measured on this die: detect 4, sd1 4, sd2 7, converging by a depth of 6.
// One owner per node.
//
// A leaf: it imports nothing and touches no DOM.

export const HOME = ['Control pipeline', 'Static logic'];
export const SD1 = 440;
export const SD2 = 1258;
export const DETECT = 191;
export const CLOCK_SWITCHES = 40;

/**
 * @param {object} sch  schematic.json
 * @param {{home?:string[], cap?:number}} [opts]
 * @returns {{groups:{id:string, node:number, nodes:number[], reads:number[], feeds:number[]}[], clocks:number[]}}
 */
export function storePipeline(sch, { home = HOME, cap = 32 } = {}) {
  const rails = new Set([sch.vss, sch.vcc]);
  const blk = (n) => sch.nodeBlock[n] & 0x7f;
  const inside = new Set(home.map((s) => sch.blockNames.indexOf(s)).filter((i) => i >= 0));
  const back = new Map(), fwd = new Map();
  const add = (m, a, b) => { if (!m.has(a)) m.set(a, new Set()); m.get(a).add(b); };
  for (const [out, , pre, legs] of sch.gates) {
    for (const i of new Set(legs.flat())) { add(back, out, i); add(fwd, i, out); }
    if (pre >= 0) { add(back, out, pre); add(fwd, pre, out); }
  }
  const ctlCount = new Map();
  for (const [c, a, b] of sch.switches) { add(back, a, b); add(back, b, a); add(fwd, a, b); add(fwd, b, a); ctlCount.set(c, (ctlCount.get(c) || 0) + 1); }
  const nb = (m, n) => m.get(n) || new Set();
  const clocks = [...ctlCount].filter(([, c]) => c >= CLOCK_SWITCHES).map(([n]) => n).sort((a, b) => a - b);
  const clockSet = new Set(clocks);
  const cone = (root) => {
    const d = new Map([[root, 0]]);
    const q = [root];
    while (q.length) {
      const n = q.shift();
      if (d.get(n) >= cap) continue;
      const boundary = [...nb(back, n)].some((x) => !rails.has(x) && !(inside.has(blk(x)) && !clockSet.has(x)));
      if (n !== root && boundary) continue;
      for (const x of nb(back, n)) {
        if (rails.has(x) || d.has(x)) continue;
        d.set(x, d.get(n) + 1);
        if (inside.has(blk(x)) && !clockSet.has(x)) q.push(x);
      }
    }
    return [...d.keys()].filter((n) => n === root || (inside.has(blk(n)) && !clockSet.has(n))).sort((a, b) => a - b);
  };
  const readsOf = (set) => { const r = new Set(); for (const n of set) for (const m of nb(back, n)) if (!set.has(m) && !rails.has(m)) r.add(m); return [...r].sort((a, b) => a - b); };
  const feedsOf = (set) => { const r = new Set(); for (const n of set) for (const m of nb(fwd, n)) if (!set.has(m) && !rails.has(m)) r.add(m); return [...r].sort((a, b) => a - b); };
  const groups = [];
  // sd1 and sd2 first (the latches keep their own nodes), then the detect.
  for (const [id, root] of [['sd1', SD1], ['sd2', SD2], ['detect', DETECT]]) {
    const nodes = cone(root);
    const set = new Set(nodes);
    groups.push({ id, node: root, nodes, reads: readsOf(set), feeds: feedsOf(set) });
  }
  // One owner per node (sd2's cone crosses into sd1 through #504 reading
  // #440), and reads/feeds recomputed on the final sets so a card never
  // reports the neighbour's wiring as its own.
  const claimed = new Set();
  for (const g of groups) { g.nodes = g.nodes.filter((n) => !claimed.has(n)); g.nodes.forEach((n) => claimed.add(n)); }
  for (const g of groups) { const set = new Set(g.nodes); g.reads = readsOf(set); g.feeds = feedsOf(set); }
  return { groups, clocks };
}
