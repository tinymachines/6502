// The special bus, derived from the switch network: the eight bits, the
// decimal-adjusted copies, and the thirteen lines that put values on it and
// take them off, each line's direction read off the far side of its switches.
//
// `sb0..7` are pure bus bits: no gate drives them, `cclk` precharges them to
// vcc, and everything else reaches them through a switch. Thirteen lines hold
// a switch on every bit (`ADDSB7` on bit 7 alone, `ADDSB06` on the other
// seven: the shifter). `dasb1..3` and `dasb5..7` are gates, each combining its
// bit (through an inverter) with the decimal adjust, and `SBAC` opens THOSE
// onto the accumulator for bits 1..3 and 5..7 and `sb0`/`sb4` directly: the
// adjusted bus has no bits 0 and 4 because +6 never changes them.
//
//  1. `sb` is the eight bits. Its lines are the controls of every switch on a
//     bit, less the clocks; each line's DIRECTION is read off the far side of
//     its switches: a far node driven by a static gate is a source, so the
//     line brings a value ONTO the bus (`YSB XSB SSB ACSB ADDSB06 ADDSB7`); a
//     far node that is switch-only or precharged (a latch, a bus) is a sink,
//     so the line takes the value OFF (`SBADD SBY SBS SBX SBAC SBADH`); a far
//     node that is itself a named bus joins the two (`SBDB`). Nothing here
//     reads a name for its meaning.
//  2. `dasb` is the six adjusted bits plus the six inverters they read whose
//     only input is an `sb` bit: twelve. The adjust gates that feed them are
//     the decimal correction's and stay there.
//  3. `onto`, `off` and `link` are the lines as sets; the cones of all but one
//     live with the registers, the ALU and the data bus. `SBADH` (the bus onto
//     the high address byte, for the indexed modes' page fix) is nobody else's
//     and gets its cone here.
//
// Measured on this die: sb 8 (precharged by 8 switches), dasb 12, SBADH with
// its cone 7 (reading `#op-branch-done` and `#op-T3-branch`: the page fix of
// a taken branch), onto 6, off 5 more, link 1. One owner per node, the cone
// group taking its line before the sets do.
//
// A leaf: it imports nothing and touches no DOM.

export const HOME = ['Control pipeline', 'Static logic'];
export const CLOCK_SWITCHES = 40;

/**
 * @param {object} sch  schematic.json
 * @param {{home?:string[], cap?:number}} [opts]
 * @returns {{groups:{id:string, kind:string, nodes:number[], reads:number[], feeds?:number[], lines?:{node:number, dir:string, switches:number}[], node?:number}[],
 *            precharge:number, clocks:number[]}}
 */
export function specialBus(sch, { home = HOME, cap = 32 } = {}) {
  const rails = new Set([sch.vss, sch.vcc]);
  const blk = (n) => sch.nodeBlock[n] & 0x7f;
  const inside = new Set(home.map((s) => sch.blockNames.indexOf(s)).filter((i) => i >= 0));
  const byName = new Map();
  sch.names.forEach((s, n) => { if (s) byName.set(s, n); });
  const gates = new Map(sch.gates.map((g) => [g[0], g]));
  const dyn = sch.kinds.indexOf('dynamic');
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
  const readsOf = (set) => { const r = new Set(); for (const n of set) for (const m of nb(back, n)) if (!set.has(m) && !rails.has(m)) r.add(m); return [...r].sort((a, b) => a - b); };
  const feedsOf = (set) => { const r = new Set(); for (const n of set) for (const m of nb(fwd, n)) if (!set.has(m) && !rails.has(m)) r.add(m); return [...r].sort((a, b) => a - b); };

  const sb = [...Array(8).keys()].map((i) => byName.get(`sb${i}`)).filter((n) => n !== undefined);
  const sbSet = new Set(sb);
  // Lines, with the far side of their switches.
  const far = new Map();
  let precharge = 0;
  for (const [c, a, b] of sch.switches) {
    for (const [x, y] of [[a, b], [b, a]]) {
      if (!sbSet.has(x)) continue;
      if (clockSet.has(c)) { if (rails.has(y)) precharge++; continue; }
      if (!far.has(c)) far.set(c, []);
      far.get(c).push(y);
    }
  }
  const isBusName = (n) => /^[a-z]+\d$/.test(sch.names[n] || '') && !gates.has(n);
  const lines = [...far].map(([c, fars]) => {
    const driven = fars.filter((f) => { const g = gates.get(f); return g && g[1] !== dyn; }).length;
    const busy = fars.filter((f) => isBusName(f) && !/^(a|x|y|s|alua|alub)\d$/.test(sch.names[f])).length;
    const dir = driven === fars.length ? 'onto' : busy === fars.length ? 'link' : 'off';
    return { node: c, dir, switches: fars.length };
  }).sort((p, q) => p.node - q.node);
  const groups = [];
  groups.push({ id: 'sb', kind: 'bus', nodes: sb.slice().sort((a, b) => a - b), reads: readsOf(sbSet), feeds: feedsOf(sbSet), lines });
  // dasb: the six adjusted bits and the sb inverters they read.
  const dasb = [];
  sch.names.forEach((s, n) => { if (s && /^dasb\d$/.test(s)) dasb.push(n); });
  const dset = new Set(dasb);
  for (const dn of dasb) {
    for (const x of nb(back, dn)) {
      if (sch.names[x] || rails.has(x)) continue;
      const ins = [...nb(back, x)].filter((i) => !rails.has(i));
      if (ins.length && ins.every((i) => sbSet.has(i))) dset.add(x);
    }
  }
  groups.push({ id: 'dasb', kind: 'adjusted', nodes: [...dset].sort((a, b) => a - b), reads: readsOf(dset), feeds: feedsOf(dset) });
  // SBADH's cone: the one line nobody else cones.
  const sbadh = byName.get('dpc27_SBADH');
  if (sbadh !== undefined) {
    const d = new Map([[sbadh, 0]]);
    const q = [sbadh];
    while (q.length) {
      const n = q.shift();
      if (d.get(n) >= cap) continue;
      const boundary = [...nb(back, n)].some((x) => !rails.has(x) && !inside.has(blk(x)));
      if (n !== sbadh && (boundary || clockSet.has(n))) continue;
      for (const x of nb(back, n)) {
        if (rails.has(x) || d.has(x)) continue;
        d.set(x, d.get(n) + 1);
        if (inside.has(blk(x)) && !clockSet.has(x)) q.push(x);
      }
    }
    const set = new Set([...d.keys()].filter((n) => n === sbadh || (inside.has(blk(n)) && !clockSet.has(n))));
    groups.push({ id: 'SBADH', kind: 'line', node: sbadh, nodes: [...set].sort((a, b) => a - b), reads: readsOf(set), switches: ctlCount.get(sbadh) || 0 });
  }
  for (const dir of ['onto', 'off', 'link']) {
    const ns = lines.filter((l) => l.dir === dir).map((l) => l.node);
    const set = new Set(ns);
    groups.push({ id: dir, kind: 'lines', nodes: ns, reads: readsOf(set), lines: lines.filter((l) => l.dir === dir) });
  }
  const claimed = new Set();
  for (const g of groups) { g.nodes = g.nodes.filter((n) => !claimed.has(n)); g.nodes.forEach((n) => claimed.add(n)); }
  return { groups, precharge, clocks };
}
