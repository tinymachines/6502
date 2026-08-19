// The instruction register and the predecode, derived from the switch network.
//
// An opcode arrives on the data pads, is latched as the predecode byte, passes
// under `fetch` into the instruction register, and on the way the predecoder
// reads it for two things the timing chain wants to know early: is this a
// two-cycle instruction, is it one byte. The die names all of it: `pd_n` and
// `pd_n.clearIR` (the predecode byte, forced to $00, BRK, when `clearIR`
// fires for an interrupt), `ir_n`/`notir_n`, the five `PD-*` terms and
// `ONEBYTE`, `irline3` (a derived line the decoder reads on 63 terms), and
// `clearIR` itself.
//
//  1. Two closures over the Instruction register block's unnamed nodes and
//     their own names: from `pd0..7` (own: `pd_n`, `pd_n.clearIR`) and from
//     `ir0..7` (own: `ir_n`, `notir_n`). What only the first reaches is the
//     predecode latch: 24, three a bit (the pad's inverter, `pd_n`,
//     `pd_n.clearIR`), reading exactly the `db` pads and `clearIR`. What only
//     the second reaches is the register: 16, `ir_n` and `notir_n`. What BOTH
//     reach is the load path between them: 24, three a bit (the inverter of
//     `pd_n.clearIR`, the node under `fetch`, the register bit's input node
//     that `notir_n` recirculates into under `cclk`). The closures are kept
//     to the block because over the static logic the register's leaks through
//     `#1133` into the flag logic and reaches 348 nodes.
//  2. The predecoder is the bounded backward cones of `PD-*` and `ONEBYTE`
//     inside the block and the static logic, stopping at the predecode byte:
//     7 nodes once the load path has had its inverters (the first group to
//     claim a node keeps it), reading `pd_n.clearIR` and feeding `#TWOCYCLE` (the timing
//     chain's T0 cell) and `#1275` (the PC increment enable): that is where a
//     one-byte instruction stops the counter and a two-cycle one shortens
//     the chain, read off the wires.
//  3. `irline3` and its gate (`#1133`, reading `ir0` and `ir1`: both low, the
//     line the decoder uses instead of the two bits on 63 of its terms),
//     `clearIR` (a NAND of `fetch` and `D1x1`), and `fetch` with its cone
//     (the load line, reading `notRdy0` and a pipeline latch), each a group.
//
// Measured on this die: pd 24, load 24, ir 16, predecoder 7, irline3 2,
// clear 1, fetch 2. One owner per node. The register feeds all 122 product
// terms of the decode PLA directly, and `irline3` 63 of them again.
//
// A leaf: it imports nothing and touches no DOM.

export const CLOCK_SWITCHES = 40;

/**
 * @param {object} sch  schematic.json
 * @param {{cap?:number}} [opts]
 * @returns {{groups:{id:string, kind:string, nodes:number[], reads:number[], feeds:number[], node?:number, roots?:number[]}[], clocks:number[]}}
 */
export function irPredecode(sch, { cap = 32 } = {}) {
  const rails = new Set([sch.vss, sch.vcc]);
  const blk = (n) => sch.nodeBlock[n] & 0x7f;
  const IRB = sch.blockNames.indexOf('Instruction register'), ST = sch.blockNames.indexOf('Static logic');
  const byName = new Map();
  sch.names.forEach((s, n) => { if (s) byName.set(s, n); });
  const back = new Map(), fwd = new Map(), und = new Map();
  const add = (m, a, b) => { if (!m.has(a)) m.set(a, new Set()); m.get(a).add(b); };
  for (const [out, , pre, legs] of sch.gates) {
    for (const i of new Set(legs.flat())) { add(back, out, i); add(fwd, i, out); add(und, out, i); add(und, i, out); }
    if (pre >= 0) { add(back, out, pre); add(fwd, pre, out); add(und, out, pre); add(und, pre, out); }
  }
  const ctlCount = new Map();
  for (const [c, a, b] of sch.switches) {
    add(back, a, b); add(back, b, a); add(fwd, a, b); add(fwd, b, a); add(und, a, b); add(und, b, a);
    ctlCount.set(c, (ctlCount.get(c) || 0) + 1);
  }
  const nb = (m, n) => m.get(n) || new Set();
  const clocks = [...ctlCount].filter(([, c]) => c >= CLOCK_SWITCHES).map(([n]) => n).sort((a, b) => a - b);
  const clockSet = new Set(clocks);
  const nm = (n) => sch.names[n] || '';
  const readsOf = (set) => { const r = new Set(); for (const n of set) for (const m of nb(back, n)) if (!set.has(m) && !rails.has(m)) r.add(m); return [...r].sort((a, b) => a - b); };
  const feedsOf = (set) => { const r = new Set(); for (const n of set) for (const m of nb(fwd, n)) if (!set.has(m) && !rails.has(m)) r.add(m); return [...r].sort((a, b) => a - b); };
  const closure = (stem, own) => {
    const bits = [...Array(8).keys()].map((i) => byName.get(`${stem}${i}`)).filter((n) => n !== undefined);
    const set = new Set(bits);
    const q = [...bits];
    while (q.length) {
      const n = q.shift();
      for (const m of nb(und, n)) if (!set.has(m) && !rails.has(m) && ((!sch.names[m] && blk(m) === IRB) || (sch.names[m] && own.test(sch.names[m])))) { set.add(m); q.push(m); }
    }
    return set;
  };
  const pdAll = closure('pd', /^pd\d(\.clearIR)?$/);
  const irAll = closure('ir', /^(not)?ir\d$/);
  const load = new Set([...pdAll].filter((n) => irAll.has(n)));
  const pd = new Set([...pdAll].filter((n) => !irAll.has(n)));
  const ir = new Set([...irAll].filter((n) => !pdAll.has(n)));
  const groups = [
    { id: 'pd', kind: 'latch', nodes: [...pd].sort((a, b) => a - b), reads: readsOf(pd), feeds: feedsOf(pd) },
    { id: 'load', kind: 'load', nodes: [...load].sort((a, b) => a - b), reads: readsOf(load), feeds: feedsOf(load) },
    { id: 'ir', kind: 'reg', nodes: [...ir].sort((a, b) => a - b), reads: readsOf(ir), feeds: feedsOf(ir) },
  ];
  // Bounded cones inside the block and the static logic, stopping at the bytes.
  const home = (n) => (blk(n) === IRB || blk(n) === ST) && !clockSet.has(n) && !/^pd\d|^(not)?ir\d$/.test(nm(n));
  const cone = (root) => {
    const d = new Map([[root, 0]]);
    const q = [root];
    while (q.length) {
      const n = q.shift();
      if (d.get(n) >= cap) continue;
      const boundary = [...nb(back, n)].some((x) => !rails.has(x) && !home(x));
      if (n !== root && boundary) continue;
      for (const x of nb(back, n)) {
        if (rails.has(x) || d.has(x)) continue;
        d.set(x, d.get(n) + 1);
        if (home(x)) q.push(x);
      }
    }
    return [...d.keys()].filter((n) => n === root || home(n));
  };
  const preRoots = [];
  sch.names.forEach((s, n) => { if (s && /^PD-|^ONEBYTE$/.test(s)) preRoots.push(n); });
  const pre = new Set();
  for (const r of preRoots) for (const n of cone(r)) pre.add(n);
  groups.push({ id: 'pre', kind: 'predecoder', roots: preRoots.sort((a, b) => a - b), nodes: [...pre].sort((a, b) => a - b), reads: readsOf(pre), feeds: feedsOf(pre) });
  for (const [id, name] of [['irline3', 'irline3'], ['clear', 'clearIR'], ['fetch', 'fetch']]) {
    const root = byName.get(name);
    if (root === undefined) continue;
    const set = new Set(cone(root));
    groups.push({ id, kind: 'named', node: root, nodes: [...set].sort((a, b) => a - b), reads: readsOf(set), feeds: feedsOf(set) });
  }
  const claimed = new Set();
  for (const g of groups) { g.nodes = g.nodes.filter((n) => !claimed.has(n)); g.nodes.forEach((n) => claimed.add(n)); }
  return { groups, clocks };
}
