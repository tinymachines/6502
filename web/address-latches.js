// The address latches, derived from the switch network: the two latches that
// hold the address on the pins, the lines that load them, and the constant
// generators that force address bits.
//
// The register recipe (register-logic.js) misreads this block, and the way it
// misreads is the structure: the latch nodes are themselves switch CONTROLS
// (`abl_n` gates the pull-up of its pad driver), so every node came out as a
// "line", and the closure ran into the pad drivers. Read on its own terms, one
// bit is a chain of seven nodes: the bus bit's inverter, a node joined to it
// under `cp1`, the latch input `#ABL_n` joined to that under `ADL/ABL`, its
// inverse `abl_n`, an output latch joined back under `cclk`, and two static
// nodes that are the push-pull driver of the `ab_n` pad (the pad is the pin,
// outside).
//
//  1. Each half is the closure of its eight bits (`abl0..7`, `abh0..7`) over
//     gates and switch channels BOTH ways, entering only unnamed nodes and
//     nodes named with the stem (`#ABL3`), never a rail and never another
//     named wire: the closure stops at the `adl`/`adh` buses on one side and
//     the `ab` pads on the other. Measured: 56 nodes each, seven a bit;
//     `reads` is exactly `adl0..7` (or `adh0..7`), `feeds` exactly `ab0..7`
//     (or `ab8..15`).
//  2. The load lines are the controls of the half's switches less the clocks
//     (forty or more switches): `ADL/ABL` and `ADH/ABH`, each holding eight
//     switches on its half, each with its bounded backward cone inside the
//     control pipeline and the static logic, clocks never expanded, the
//     boundary rule as everywhere.
//  3. The constant generators are the nodes the die names for forcing an
//     address bit: `0/ADL0..2` (inverters of the vector address bits
//     `pipeVectorA0..2`, which is how $FFFA..$FFFF is put on the bus) and
//     `dpc28_0ADH0`, `dpc29_0ADH17` (the high byte forced to $00 for the zero
//     page and to $01 for the stack), each with the same bounded cone; two
//     groups, low and high, by which bus they drive.
//
// Measured on this die: abl 56, abh 56; the ADL/ABL cone 18 (it reaches the
// store-data pipeline latches, `#440` and `#1258`: the low latch does not
// reload during a store's data cycles), the ADH/ABH cone 5; constants low 4
// (reading `pipeVectorA0..2`) and high 8 (reading `op-T2-stack-access`,
// `op-T2-zp/zp-idx` and `op-T2-ind`, the modes that force the high byte);
// converging by a depth of 12.
//
// A leaf: it imports nothing and touches no DOM.

export const HALVES = [['abl', 'adl', 'ab', 0], ['abh', 'adh', 'ab', 8]];
export const HOME = ['Control pipeline', 'Static logic'];
export const CONST = { low: /^0\/ADL\d$/, high: /_0ADH\d+$/ };
export const CLOCK_SWITCHES = 40;

/**
 * @param {object} sch  schematic.json
 * @param {{home?:string[], cap?:number}} [opts]
 * @returns {{halves:{id:string, stem:string, nodes:number[], reads:number[], feeds:number[]}[],
 *            lines:{id:string, half:string, node:number, nodes:number[], reads:number[], switches:number, onHalf:number}[],
 *            consts:{id:string, roots:number[], nodes:number[], reads:number[]}[], clocks:number[], depth:number}}
 */
export function addressLatches(sch, { home = HOME, cap = 32 } = {}) {
  const rails = new Set([sch.vss, sch.vcc]);
  const blk = (n) => sch.nodeBlock[n] & 0x7f;
  const inside = new Set(home.map((s) => sch.blockNames.indexOf(s)).filter((i) => i >= 0));
  const byName = new Map();
  sch.names.forEach((s, n) => { if (s) byName.set(s, n); });
  const back = new Map(), fwd = new Map(), und = new Map();
  const add = (m, a, b) => { if (!m.has(a)) m.set(a, new Set()); m.get(a).add(b); };
  for (const [out, , pre, legs] of sch.gates) {
    for (const i of new Set(legs.flat())) { add(back, out, i); add(fwd, i, out); add(und, out, i); add(und, i, out); }
    if (pre >= 0) { add(back, out, pre); add(fwd, pre, out); add(und, out, pre); add(und, pre, out); }
  }
  const ctlOf = new Map(), ctlCount = new Map();
  for (const [c, a, b] of sch.switches) {
    add(back, a, b); add(back, b, a); add(fwd, a, b); add(fwd, b, a); add(und, a, b); add(und, b, a);
    add(ctlOf, a, c); add(ctlOf, b, c);
    ctlCount.set(c, (ctlCount.get(c) || 0) + 1);
  }
  const nb = (m, n) => m.get(n) || new Set();
  const clocks = [...ctlCount].filter(([, c]) => c >= CLOCK_SWITCHES).map(([n]) => n).sort((a, b) => a - b);
  const clockSet = new Set(clocks);
  let depth = 0;
  const cone = (root) => {
    const d = new Map([[root, 0]]);
    const q = [root];
    while (q.length) {
      const n = q.shift();
      if (d.get(n) >= cap) continue;
      const boundary = [...nb(back, n)].some((x) => !rails.has(x) && !inside.has(blk(x)));
      if (n !== root && (boundary || clockSet.has(n))) continue;
      for (const x of nb(back, n)) {
        if (rails.has(x) || d.has(x)) continue;
        d.set(x, d.get(n) + 1);
        depth = Math.max(depth, d.get(x));
        if (inside.has(blk(x)) && !clockSet.has(x)) q.push(x);
      }
    }
    const nodes = [...d.keys()].filter((n) => n === root || (inside.has(blk(n)) && !clockSet.has(n))).sort((a, b) => a - b);
    const mem = new Set(nodes);
    const reads = new Set();
    for (const n of nodes) for (const m of nb(back, n)) if (!mem.has(m) && !rails.has(m)) reads.add(m);
    return { nodes, reads: [...reads].sort((a, b) => a - b) };
  };

  const halves = [], lines = [];
  for (const [stem] of HALVES) {
    const own = new RegExp(`^#?${stem.toUpperCase()}\\d$|^${stem}\\d$`, 'i');
    const enterable = (n) => !rails.has(n) && (!sch.names[n] || own.test(sch.names[n]));
    const bits = [];
    for (let i = 0; i < 8; i++) { const n = byName.get(`${stem}${i}`); if (n !== undefined) bits.push(n); }
    const set = new Set(bits);
    const q = [...bits];
    while (q.length) {
      const n = q.shift();
      for (const m of nb(und, n)) if (!set.has(m) && enterable(m)) { set.add(m); q.push(m); }
    }
    const reads = new Set(), feeds = new Set();
    for (const n of set) {
      for (const m of nb(back, n)) if (!set.has(m) && !rails.has(m)) reads.add(m);
      for (const m of nb(fwd, n)) if (!set.has(m) && !rails.has(m)) feeds.add(m);
    }
    halves.push({ id: stem, stem, nodes: [...set].sort((a, b) => a - b), reads: [...reads].sort((a, b) => a - b), feeds: [...feeds].sort((a, b) => a - b) });
    const lineSet = new Set();
    for (const n of set) for (const c of nb(ctlOf, n)) if (!clockSet.has(c) && !set.has(c)) lineSet.add(c);
    for (const l of [...lineSet].sort((a, b) => a - b)) {
      const c = cone(l);
      let onHalf = 0;
      for (const [cc, a, b] of sch.switches) if (cc === l && (set.has(a) || set.has(b))) onHalf++;
      lines.push({ id: sch.names[l] || `#${l}`, half: stem, node: l, nodes: c.nodes, reads: c.reads, switches: ctlCount.get(l) || 0, onHalf });
    }
  }
  const consts = [];
  for (const [id, re] of Object.entries(CONST)) {
    const roots = [];
    sch.names.forEach((s, n) => { if (s && re.test(s)) roots.push(n); });
    const nodes = new Set(), reads = new Set();
    for (const r of roots) { const c = cone(r); c.nodes.forEach((n) => nodes.add(n)); }
    for (const n of nodes) for (const m of nb(back, n)) if (!nodes.has(m) && !rails.has(m)) reads.add(m);
    consts.push({ id, roots: roots.sort((a, b) => a - b), nodes: [...nodes].sort((a, b) => a - b), reads: [...reads].sort((a, b) => a - b) });
  }
  return { halves, lines, consts, clocks, depth };
}
