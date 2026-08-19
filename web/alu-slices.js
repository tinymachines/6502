// The ALU and its adder, derived from the switch network and read bit by bit.
//
// The die names the adder bit by bit: `#A.B_n` (the AND term), `A+B_n`, the
// XOR as `#(AxB)_n`/`AxB_n`, the sum `#(AxBxC)_n`, the carries alternating in
// polarity (`C01`, `#C12`, `C23`, `#C34`, ...), the function select
// `#aluresult_n`, and the hold register `alu_n`/`notalu_n`; its inputs
// `alua_n`/`alub_n`; its ends `alucin`, `alucout`, `aluvout`. That is what
// makes the slices derivable rather than drawn:
//
//  1. Slices: from each hold bit `alu_n` walk BACKWARD through gate inputs
//     and switch channels inside the ALU block and the static logic, never
//     a rail, never a clock, stopping at the inputs (`alua`, `alub`), the
//     decimal nodes (`DA-*`, `DC*`, which have their own container) and the
//     carry ends (`alucin`, `alucout`, `aluvout`), with the boundary rule
//     beyond. A node belongs to the bit that reaches it soonest; a tie is
//     shared. Measured: 10 or 11 nodes a bit (the hold bit, its inverse, the
//     result select, the sum, the XOR, the OR and AND terms, the carry INTO
//     the bit and its propagate term), and the seven generate terms
//     `#A.B1..7` shared, each read by its own bit's XOR and the next bit's
//     carry at the same depth. The carry into a bit files with that bit,
//     because that is what its sum reads.
//  2. Inputs: `a` and `b` as the closure of `alua0..7`/`alub0..7` over
//     unnamed and own-named nodes (the register recipe): A is its eight bits,
//     B sixteen, an inverter per bit for `nDBADD`, the inverted data bus that
//     makes SBC. Their lines are `SBADD`, `0ADD` and `DBADD`, `nDBADD`,
//     `ADLADD`.
//  3. The ends, by name with their bounded cones in the ALU, the static logic
//     and the control pipeline: `cin` (`alucin`, `notalucin` and the logic
//     that chooses the carry in), `cout` (`alucout` and its copies, with the
//     bit 7 carry `C78`), `vout` (`aluvout`, `notaluvout`).
//  4. The thirteen control lines in three groups by what they do, each the
//     union of the lines' bounded cones in the control pipeline and the
//     static logic: `in` (the five ways in), `fn` (`ANDS`, `EORS`, `ORS`,
//     `SUMS`, `SRS`), `out` (`ADDSB06`, `ADDSB7`, `ADDADL`). The block page
//     measured the same five-five-three from the switches; here each comes
//     with what makes it.
//
// Measured on this die: bits 10, 11, 11, 11, 10, 11, 11, 11; shared 7; a 8,
// b 16; cin 18, cout 7, vout 4; in 26, fn 25, out 58; converging by a depth
// of 12. One owner per node: a later group yields to an earlier one.
//
// A leaf: it imports nothing and touches no DOM.

export const LINES = {
  in: ['dpc11_SBADD', 'dpc9_DBADD', 'dpc8_nDBADD', 'dpc10_ADLADD', 'dpc12_0ADD'],
  fn: ['dpc15_ANDS', 'dpc16_EORS', 'dpc13_ORS', 'dpc17_SUMS', 'dpc14_SRS'],
  out: ['dpc20_ADDSB06', 'dpc19_ADDSB7', 'dpc21_ADDADL'],
};
export const ENDS = { cin: /^(not)?alucin$/, cout: /alucout$|^#?C78(\.phi2)?$/, vout: /aluvout$/ };
export const STOP = /^alua\d$|^alub\d$|^#?DA-|^DC\d|alucin|alucout|aluvout/;
export const CLOCK_SWITCHES = 40;

/**
 * @param {object} sch  schematic.json
 * @param {{cap?:number}} [opts]
 * @returns {{groups:{id:string, kind:string, bit?:number, nodes:number[], reads:number[], feeds?:number[], lines?:number[]}[], clocks:number[]}}
 */
export function aluSlices(sch, { cap = 32 } = {}) {
  const rails = new Set([sch.vss, sch.vcc]);
  const blk = (n) => sch.nodeBlock[n] & 0x7f;
  const ALU = sch.blockNames.indexOf('ALU'), ST = sch.blockNames.indexOf('Static logic'), CP = sch.blockNames.indexOf('Control pipeline');
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
  const groups = [];
  const readsOf = (set) => { const r = new Set(); for (const n of set) for (const m of nb(back, n)) if (!set.has(m) && !rails.has(m)) r.add(m); return [...r].sort((a, b) => a - b); };
  const feedsOf = (set) => { const r = new Set(); for (const n of set) for (const m of nb(fwd, n)) if (!set.has(m) && !rails.has(m)) r.add(m); return [...r].sort((a, b) => a - b); };

  // 1. Slices.
  const home = (n) => (blk(n) === ALU || blk(n) === ST) && !clockSet.has(n) && !STOP.test(nm(n));
  const bits = [...Array(8).keys()].map((i) => byName.get(`alu${i}`));
  const reach = bits.map((o) => {
    const d = new Map([[o, 0]]);
    const q = [o];
    while (q.length) {
      const n = q.shift();
      if (d.get(n) >= cap) continue;
      const boundary = [...nb(back, n)].some((x) => !rails.has(x) && !home(x));
      if (n !== o && boundary) continue;
      for (const x of nb(back, n)) {
        if (rails.has(x) || d.has(x)) continue;
        d.set(x, d.get(n) + 1);
        if (home(x)) q.push(x);
      }
    }
    return d;
  });
  const all = new Set();
  reach.forEach((r, i) => { for (const n of r.keys()) if (home(n) || n === bits[i]) all.add(n); });
  const owner = new Map();
  for (const n of all) {
    const hits = reach.map((r, i) => [i, r.get(n)]).filter(([, v]) => v !== undefined);
    const md = Math.min(...hits.map((h) => h[1]));
    const best = hits.filter((h) => h[1] === md);
    owner.set(n, best.length > 1 ? -1 : best[0][0]);
  }
  for (let i = 0; i < 8; i++) {
    const own = new Set([...all].filter((n) => owner.get(n) === i));
    groups.push({ id: `bit${i}`, kind: 'bit', bit: i, nodes: [...own].sort((a, b) => a - b), reads: readsOf(own) });
  }
  const sharedSet = new Set([...all].filter((n) => owner.get(n) === -1));
  groups.push({ id: 'shared', kind: 'shared', nodes: [...sharedSet].sort((a, b) => a - b), reads: readsOf(sharedSet) });

  // 2. Inputs.
  const lineNodes = {};
  for (const [g, names] of Object.entries(LINES)) lineNodes[g] = names.map((s) => byName.get(s)).filter((n) => n !== undefined);
  for (const stem of ['alua', 'alub']) {
    const own = new RegExp(`^#?${stem}\\d$`);
    const bb = [...Array(8).keys()].map((i) => byName.get(`${stem}${i}`)).filter((n) => n !== undefined);
    const set = new Set(bb);
    const q = [...bb];
    while (q.length) {
      const n = q.shift();
      for (const m of nb(und, n)) if (!set.has(m) && !rails.has(m) && (!sch.names[m] || own.test(sch.names[m]))) { set.add(m); q.push(m); }
    }
    const lines = new Set();
    for (const [c, a, b] of sch.switches) if ((set.has(a) || set.has(b)) && !clockSet.has(c)) lines.add(c);
    groups.push({ id: stem === 'alua' ? 'a' : 'b', kind: 'input', nodes: [...set].sort((a, b) => a - b), reads: readsOf(set), feeds: feedsOf(set), lines: [...lines].sort((a, b) => a - b) });
  }

  // 3. Ends, with bounded cones in the ALU, the static logic and the control pipeline.
  const home2 = (n) => (blk(n) === ALU || blk(n) === ST || blk(n) === CP) && !clockSet.has(n);
  const innerStop = /^alu\d$|^alua|^alub|^#?\(A|^A\+B|^AxB|^#A\.B|^#?C\d\d$|^#aluresult|^notalu\d|^#?DA-|^DC\d/;
  const cone = (root, homeFn, stopRe) => {
    const d = new Map([[root, 0]]);
    const q = [root];
    while (q.length) {
      const n = q.shift();
      if (d.get(n) >= cap) continue;
      const boundary = [...nb(back, n)].some((x) => !rails.has(x) && (!homeFn(x) || stopRe.test(nm(x))));
      if (n !== root && boundary) continue;
      for (const x of nb(back, n)) {
        if (rails.has(x) || d.has(x)) continue;
        d.set(x, d.get(n) + 1);
        if (homeFn(x) && !stopRe.test(nm(x))) q.push(x);
      }
    }
    return [...d.keys()].filter((n) => n === root || (homeFn(n) && !stopRe.test(nm(n))));
  };
  // A node a slice already holds stays with the slice (#748, the inverter
  // behind C78, is bit 7's by depth and would otherwise be the carry-out's too).
  const inSlice = new Set(all);
  for (const [id, re] of Object.entries(ENDS)) {
    const roots = [];
    sch.names.forEach((s, n) => { if (s && re.test(s)) roots.push(n); });
    const set = new Set();
    for (const r of roots) for (const n of cone(r, home2, innerStop)) if (!inSlice.has(n)) set.add(n);
    groups.push({ id, kind: 'end', nodes: [...set].sort((a, b) => a - b), reads: readsOf(set), feeds: feedsOf(set), roots: roots.sort((a, b) => a - b) });
  }

  // 4. The control lines in three groups, cones in the control pipeline and the static logic.
  const home3 = (n) => (blk(n) === ST || blk(n) === CP) && !clockSet.has(n);
  for (const [g, ns] of Object.entries(lineNodes)) {
    const set = new Set();
    for (const l of ns) for (const n of cone(l, home3, /(?!)/)) set.add(n);
    groups.push({ id: g, kind: 'lines', nodes: [...set].sort((a, b) => a - b), reads: readsOf(set), lines: ns });
  }
  // One owner per node: a later group yields to an earlier one (#604 sits in
  // both the carry-in cone and the ways-in cone; it stays with the carry in).
  const claimed = new Set();
  for (const g of groups) { g.nodes = g.nodes.filter((n) => !claimed.has(n)); g.nodes.forEach((n) => claimed.add(n)); }
  return { groups, clocks };
}
