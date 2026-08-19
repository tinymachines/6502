// The data latch, the data output register, the internal data bus and the
// read/write control, derived from the switch network.
//
// The chip meets memory through eight bidirectional pads, and the die names
// both sides of the traffic: `idl_n`/`notidl_n` (the input data latch), `dor_n`
// /`notdor_n` (the data output register), `idb_n` (the internal data bus), and
// the read/write control `rw`, `notRnWprepad`, `RnWstretched`, `#WR`.
//
//  1. The input data latch is the closure of `idl0..7` over unnamed and
//     own-named nodes (the register recipe): 32, four a bit: the pad's
//     inverter, `notidl_n` under `cclk`, `idl_n`, and a latched copy under
//     `cp1` that lives in the Address latches block and is what the three
//     `DL/*` lines open onto `idb`, `adl` and `adh`. It reads exactly the
//     `db` pads; its lines are `DL/DB`, `DL/ADL`, `DL/ADH`, each with its
//     bounded cone in the control pipeline and the static logic.
//  2. The data output register is the closure of `dor0..7`: 48, six a bit:
//     `notdor_n` loaded from the bus under `cp1`, `dor_n`, and four static
//     nodes that are the pad's push-pull driver. It reads exactly `idb0..7`
//     and `RnWstretched`, and feeds exactly the `db` pads. It has no control
//     line of its own: the clock loads it and the write control enables it.
//  3. The bus is `idb0..7` alone (its closure over unnamed nodes reaches 369
//     nodes, because a bus touches everything), with the lines that hold a
//     switch on a bus bit: `DL/DB`, `SBDB`, `ACDB`, `PCLDB`, `PCHDB`, `DBADD`
//     and `H1x1` (P onto the bus). Of those, `SBDB`, `PCLDB` and `PCHDB` get
//     their cones here; `ACDB`, `DBADD` and `H1x1` belong to the A register,
//     the ALU and the flags and are listed, not repeated.
//  4. The read/write control is the union of the bounded cones of the nodes
//     the die names for it, `rw`, `notRnWprepad`, `RnWstretched`, `#WR`,
//     inside the pads, the static logic and the control pipeline: it reads
//     the write latch `pipe#WR.phi2`, `notRdy0` and the reset, which is the
//     rule that a write needs the chip ready and not in reset.
//
// Measured on this die: idl 32, dor 48, idb 8; cones DL/DB 5, DL/ADL 5, DL/ADH
// 17 (it reaches the timing chain's T0 cell: the high byte of a fetched
// address lands at T0), SBDB 5, PCLDB 7, PCHDB 5; rw 31, made from
// `pipe#WR.phi2`, the store terms through the store-data latches, `notRdy0`
// and `C1x5Reset`. Converges by a depth of 12. One owner per node, a later
// group yielding to an earlier one.
//
// A leaf: it imports nothing and touches no DOM.

export const HOME = ['Control pipeline', 'Static logic'];
export const RW = ['rw', 'notRnWprepad', 'RnWstretched', '#WR'];
export const BUS_LINES_HERE = ['dpc25_SBDB', 'dpc37_PCLDB', 'dpc33_PCHDB'];
export const CLOCK_SWITCHES = 40;

/**
 * @param {object} sch  schematic.json
 * @param {{home?:string[], cap?:number}} [opts]
 * @returns {{groups:{id:string, kind:string, nodes:number[], reads:number[], feeds?:number[], lines?:number[], node?:number, switches?:number}[], clocks:number[]}}
 */
export function dataBus(sch, { home = HOME, cap = 32 } = {}) {
  const rails = new Set([sch.vss, sch.vcc]);
  const blk = (n) => sch.nodeBlock[n] & 0x7f;
  const inside = new Set(home.map((s) => sch.blockNames.indexOf(s)).filter((i) => i >= 0));
  const PADS = sch.blockNames.indexOf('Pads & I/O');
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
  const readsOf = (set) => { const r = new Set(); for (const n of set) for (const m of nb(back, n)) if (!set.has(m) && !rails.has(m)) r.add(m); return [...r].sort((a, b) => a - b); };
  const feedsOf = (set) => { const r = new Set(); for (const n of set) for (const m of nb(fwd, n)) if (!set.has(m) && !rails.has(m)) r.add(m); return [...r].sort((a, b) => a - b); };
  const linesOn = (set) => { const l = new Set(); for (const [c, a, b] of sch.switches) if ((set.has(a) || set.has(b)) && !clockSet.has(c) && !set.has(c)) l.add(c); return [...l].sort((a, b) => a - b); };
  const cone = (root, homeFn) => {
    const d = new Map([[root, 0]]);
    const q = [root];
    while (q.length) {
      const n = q.shift();
      if (d.get(n) >= cap) continue;
      const boundary = [...nb(back, n)].some((x) => !rails.has(x) && !homeFn(x));
      if (n !== root && (boundary || clockSet.has(n))) continue;
      for (const x of nb(back, n)) {
        if (rails.has(x) || d.has(x)) continue;
        d.set(x, d.get(n) + 1);
        if (homeFn(x) && !clockSet.has(x)) q.push(x);
      }
    }
    return [...d.keys()].filter((n) => n === root || (homeFn(n) && !clockSet.has(n))).sort((a, b) => a - b);
  };
  const homeCS = (n) => inside.has(blk(n));
  const closure = (stem) => {
    const own = new RegExp(`^(not|#)?${stem}\\d$`);
    const bits = [...Array(8).keys()].map((i) => byName.get(`${stem}${i}`)).filter((n) => n !== undefined);
    const set = new Set(bits);
    const q = [...bits];
    while (q.length) {
      const n = q.shift();
      for (const m of nb(und, n)) if (!set.has(m) && !rails.has(m) && (!sch.names[m] || own.test(sch.names[m]))) { set.add(m); q.push(m); }
    }
    return set;
  };
  const groups = [];
  const idl = closure('idl');
  groups.push({ id: 'idl', kind: 'latch', nodes: [...idl].sort((a, b) => a - b), reads: readsOf(idl), feeds: feedsOf(idl), lines: linesOn(idl) });
  const dor = closure('dor');
  groups.push({ id: 'dor', kind: 'latch', nodes: [...dor].sort((a, b) => a - b), reads: readsOf(dor), feeds: feedsOf(dor), lines: linesOn(dor) });
  const idb = new Set([...Array(8).keys()].map((i) => byName.get(`idb${i}`)).filter((n) => n !== undefined));
  groups.push({ id: 'idb', kind: 'bus', nodes: [...idb].sort((a, b) => a - b), reads: readsOf(idb), feeds: feedsOf(idb), lines: linesOn(idb) });
  // Lines with cones: the latch's three, and the bus lines that are nobody else's.
  const lineRoots = [...groups[0].lines, ...BUS_LINES_HERE.map((s) => byName.get(s)).filter((n) => n !== undefined)];
  for (const l of [...new Set(lineRoots)]) {
    const nodes = cone(l, homeCS);
    const set = new Set(nodes);
    const name = sch.names[l] || `#${l}`;
    groups.push({ id: name.includes('_') ? name.slice(name.indexOf('_') + 1) : name, kind: 'line', node: l, nodes, reads: readsOf(set), switches: ctlCount.get(l) || 0 });
  }
  // The read/write control.
  const homeRW = (n) => inside.has(blk(n)) || blk(n) === PADS;
  const rwSet = new Set();
  const rwRoots = RW.map((s) => byName.get(s)).filter((n) => n !== undefined);
  for (const r of rwRoots) for (const n of cone(r, homeRW)) rwSet.add(n);
  groups.push({ id: 'rw', kind: 'rw', roots: rwRoots, nodes: [...rwSet].sort((a, b) => a - b), reads: readsOf(rwSet), feeds: feedsOf(rwSet) });
  // One owner per node, a later group yielding to an earlier one.
  const claimed = new Set();
  for (const g of groups) { g.nodes = g.nodes.filter((n) => !claimed.has(n)); g.nodes.forEach((n) => claimed.add(n)); }
  return { groups, clocks };
}
