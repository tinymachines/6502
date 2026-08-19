// The status register and the flag logic, derived from the switch network.
//
// P is seven dynamic bits, `p0 p1 p2 p3 p4 p6 p7` (there is no bit 5), each
// loaded under `cp1` from one unnamed node in the Status register block: an
// AOI whose legs are (source AND enable) | (`idb_n` AND load) | (set or clear
// AND enable) | (own pipeline copy AND hold). The enables arrive through
// `pipeUNK` latches in the control pipeline from the decode terms; the
// sources are the ALU's carry and overflow, the `DBZ` and `DBNeg` detectors
// in the block, the data bus for PLP and RTI, `ir5` for the polarity of
// SEC/CLC, SEI/CLI, SED/CLD. `Pout_n` inverts each bit's pipeline copy back
// onto `idb_n` under `H1x1` for PHP and the interrupt push.
//
//  1. Roots: the bits `p0..p7`. Home: the Status register block, the static
//     logic and the control pipeline; the clocks (a node controlling forty or
//     more switches) and the `p`/`Pout` bits themselves are never entered.
//  2. From each bit walk BACKWARD through gate inputs and switch channels,
//     with the boundary rule (a node reading anything from outside is kept
//     but not expanded) applied to every node EXCEPT the bit's own gate, the
//     node its `cp1` switch joins it to, which is always expanded. That AOI is
//     exactly where the outside arrives (the carry, the bus, the instruction
//     register), so under the plain cut C came out as a single node; and
//     without any cut the walk ran eighteen deep into the control pipeline's
//     own sequencing (`#440`, the store-data latch). The decoder, the ALU,
//     the buses and the timing chain are outside the home.
//  3. A node reached from one bit is that flag's; a node reached from two or
//     more is shared, and shared as a group: the enables the flags have in
//     common (the "sets N and Z" latch that LDA, TAX and the ALU's terms
//     drive; the PLP/RTI load). `out` is `Pout0..7` and what they read.
//
// Measured on this die: C 14, Z 11, I 9, D 9, B 2, V 24, N 7, shared 3
// (`#270`, `#503`: the `ir5` polarity for the set/clear pairs; `#781`: the
// PLP/RTI load), out 6, converging by a depth of 8. What each reads is the
// mechanism: C reads `#alucout`, `idb0`, `#op-set-C`, `op-SRS` and
// `op-T0-clc/sec`; Z reads all eight `idb` bits through DBZ and the BIT term;
// V reads `aluvout`, the `so` pin, `op-clv`, BIT and the ADC/SBC term; I reads
// `brk-done` and `op-T0-cli/sei`; D reads `op-T0-cld/sed`; N reads `idb7`
// through DBNeg; and **B is not a stored bit at all**: `p4` is an inverter of
// `D1x1`, the timing chain's BRK-against-interrupt distinction, read fresh
// every time P is pushed.
//
// A leaf: it imports nothing and touches no DOM.

export const HOME = ['Status register', 'Static logic', 'Control pipeline'];
export const FLAGS = [['C', 0], ['Z', 1], ['I', 2], ['D', 3], ['B', 4], ['V', 6], ['N', 7]];
export const CLOCK_SWITCHES = 40;

/**
 * @param {object} sch  schematic.json
 * @param {{home?:string[], cap?:number}} [opts]
 * @returns {{groups:{id:string, kind:'flag'|'shared'|'out', bit?:number, node?:number, nodes:number[], reads:number[], of?:string[]}[],
 *            clocks:number[], depth:number}}
 */
export function flagLogic(sch, { home = HOME, cap = 32 } = {}) {
  const rails = new Set([sch.vss, sch.vcc]);
  const blk = (n) => sch.nodeBlock[n] & 0x7f;
  const inside = new Set(home.map((s) => sch.blockNames.indexOf(s)).filter((i) => i >= 0));
  const byName = new Map();
  sch.names.forEach((s, n) => { if (s) byName.set(s, n); });
  const back = new Map();
  const add = (m, a, b) => { if (!m.has(a)) m.set(a, new Set()); m.get(a).add(b); };
  for (const [out, , pre, legs] of sch.gates) {
    for (const i of new Set(legs.flat())) add(back, out, i);
    if (pre >= 0) add(back, out, pre);
  }
  const ctlCount = new Map();
  for (const [c, a, b] of sch.switches) { add(back, a, b); add(back, b, a); ctlCount.set(c, (ctlCount.get(c) || 0) + 1); }
  const nb = (n) => back.get(n) || new Set();
  const clocks = [...ctlCount].filter(([, c]) => c >= CLOCK_SWITCHES).map(([n]) => n).sort((a, b) => a - b);
  const clockSet = new Set(clocks);
  const isBit = (n) => /^(p|Pout)\d$/.test(sch.names[n] || '');
  const isHome = (n) => inside.has(blk(n)) && !clockSet.has(n) && !isBit(n);

  let depth = 0;
  const flags = FLAGS.map(([id, bit]) => ({ id, bit, node: byName.get(`p${bit}`) })).filter((f) => f.node !== undefined);
  const cones = flags.map((f) => {
    const d = new Map([[f.node, 0]]);
    const q = [f.node];
    while (q.length) {
      const n = q.shift();
      if (d.get(n) >= cap) continue;
      const isGate = d.get(n) === 1;   // the bit's own gate, joined to it by the cp1 switch
      const boundary = [...nb(n)].some((x) => !rails.has(x) && !isHome(x) && x !== f.node);
      if (n !== f.node && !isGate && boundary) continue;
      for (const x of nb(n)) {
        if (rails.has(x) || d.has(x)) continue;
        d.set(x, d.get(n) + 1);
        if (isHome(x)) { depth = Math.max(depth, d.get(x)); q.push(x); }
      }
    }
    return d;
  });
  const count = new Map();
  cones.forEach((d) => { for (const n of d.keys()) if (isHome(n)) count.set(n, (count.get(n) || 0) + 1); });
  const groups = flags.map((f, i) => {
    const own = [f.node, ...[...cones[i].keys()].filter((n) => isHome(n) && count.get(n) === 1)].sort((a, b) => a - b);
    const mem = new Set(own);
    const reads = new Set();
    for (const n of own) for (const m of nb(n)) if (!mem.has(m) && !rails.has(m) && !(isHome(m) && count.get(m) > 1)) reads.add(m);
    return { id: f.id, kind: 'flag', bit: f.bit, node: f.node, nodes: own, reads: [...reads].sort((a, b) => a - b) };
  });
  const shared = [...count].filter(([, c]) => c > 1).map(([n]) => n).sort((a, b) => a - b);
  const sharedSet = new Set(shared);
  const sharedReads = new Set();
  for (const n of shared) for (const m of nb(n)) if (!sharedSet.has(m) && !rails.has(m) && !(isHome(m) && count.get(m) === 1)) sharedReads.add(m);
  const of = flags.filter((f, i) => shared.some((n) => cones[i].has(n))).map((f) => f.id);
  groups.push({ id: 'shared', kind: 'shared', nodes: shared, reads: [...sharedReads].sort((a, b) => a - b), of });
  const outs = [];
  for (let i = 0; i < 8; i++) { const n = byName.get(`Pout${i}`); if (n !== undefined) outs.push(n); }
  const outReads = new Set();
  for (const n of outs) for (const m of nb(n)) if (!rails.has(m)) outReads.add(m);
  groups.push({ id: 'out', kind: 'out', nodes: outs.sort((a, b) => a - b), reads: [...outReads].sort((a, b) => a - b) });
  return { groups, clocks, depth };
}
