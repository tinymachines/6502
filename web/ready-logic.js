// The ready logic, derived from the switch network: how the RDY pin becomes
// `notRdy0`, the wire half the chip consults, and the copies that re-time it.
//
// Ready has turned up as a read at the boundary of nearly every container
// built before it: the timing chain holds when it is low, the flags' load
// gates read it, the PC increment enable reads it, the store pipeline reads
// it, the write control reads it. This is the wire itself, three groups:
//
//  1. `in`, the receiver: the bounded backward cone of `notRdy0` (home: the
//     static logic, the control pipeline and the timing chain, clocks never
//     expanded; the pads are OUTSIDE the home, so the pin and the write
//     control's `#759` land in `reads` rather than pulling the whole write
//     control in, which the first draft did). `rdy` feeds `#958`, latched to
//     `#1449`, and `#944` NORs that with `#759` FROM THE WRITE CONTROL,
//     latching under `cclk` into `pipeUNK37` and through `#198` into the
//     master: a low RDY does not stall a write cycle, and that rule is one
//     NOR, read off the wires. `#424` precharges the master.
//  2. `notRdy0`, the master: one dynamic node, active low as its name says.
//  3. `copies`, the re-timers: the five nodes joined to the master under
//     `cp1` (`notRdy0.phi1` and four unnamed), and the delay chain
//     `notRdy0.phi1 -> #608 -> #notRdy0.delay -> notRdy0.delay` under `cclk`:
//     ready moved onto the other phase and delayed a cycle, which is what
//     lets a consumer ask "was the chip ready last cycle".
//
// What the master and the copies feed is listed, never absorbed: it is the
// timing chain's hold, the branch logic, the flags, the write control, the
// store pipeline, the PC increment.
//
// Measured on this die: in 4 (#198, pipeUNK37, #944 and the precharge #424;
// #1449 and #759 are its reads), master 1, copies 8, converging by a depth
// of 8.
// One owner per node.
//
// A leaf: it imports nothing and touches no DOM.

export const HOME = ['Static logic', 'Control pipeline', 'Timing chain'];
export const MASTER = 'notRdy0';
export const CLOCK_SWITCHES = 40;

/**
 * @param {object} sch  schematic.json
 * @param {{home?:string[], cap?:number}} [opts]
 * @returns {{groups:{id:string, node?:number, nodes:number[], reads:number[], feeds:number[]}[], clocks:number[]}}
 */
export function readyLogic(sch, { home = HOME, cap = 32 } = {}) {
  const rails = new Set([sch.vss, sch.vcc]);
  const blk = (n) => sch.nodeBlock[n] & 0x7f;
  const inside = new Set(home.map((s) => sch.blockNames.indexOf(s)).filter((i) => i >= 0));
  const byName = new Map();
  sch.names.forEach((s, n) => { if (s) byName.set(s, n); });
  const back = new Map(), fwd = new Map();
  const add = (m, a, b) => { if (!m.has(a)) m.set(a, new Set()); m.get(a).add(b); };
  for (const [out, , pre, legs] of sch.gates) {
    for (const i of new Set(legs.flat())) { add(back, out, i); add(fwd, i, out); }
    if (pre >= 0) { add(back, out, pre); add(fwd, pre, out); }
  }
  const ctlCount = new Map();
  const chan = new Map();
  for (const [c, a, b] of sch.switches) {
    add(back, a, b); add(back, b, a); add(fwd, a, b); add(fwd, b, a);
    add(chan, a, b); add(chan, b, a);
    ctlCount.set(c, (ctlCount.get(c) || 0) + 1);
  }
  const nb = (m, n) => m.get(n) || new Set();
  const clocks = [...ctlCount].filter(([, c]) => c >= CLOCK_SWITCHES).map(([n]) => n).sort((a, b) => a - b);
  const clockSet = new Set(clocks);
  const readsOf = (set) => { const r = new Set(); for (const n of set) for (const m of nb(back, n)) if (!set.has(m) && !rails.has(m)) r.add(m); return [...r].sort((a, b) => a - b); };
  const feedsOf = (set) => { const r = new Set(); for (const n of set) for (const m of nb(fwd, n)) if (!set.has(m) && !rails.has(m)) r.add(m); return [...r].sort((a, b) => a - b); };
  const master = byName.get(MASTER);
  const homeOk = (n) => inside.has(blk(n)) && !clockSet.has(n);
  // The copies first: the master's channel partners (its cp1 re-timers; the
  // precharge #424 arrives the same way and belongs to the receiver), and the
  // delay chain. Built before the receiver so the receiver's cone, which sees
  // them as back-channel neighbours of the master, never claims them.
  const pre424 = sch.gates.find((g) => g[0] === master)?.[2] ?? -1;
  const copies = new Set([...nb(chan, master)].filter((n) => !rails.has(n) && n !== pre424));
  // #608 sits between notRdy0.phi1 and #notRdy0.delay and is named only by number.
  const phi1 = byName.get('notRdy0.phi1');
  if (phi1 !== undefined) for (const x of nb(fwd, phi1)) if (!rails.has(x) && blk(x) === sch.blockNames.indexOf('Timing chain')) copies.add(x);
  for (const dn of ['#notRdy0.delay', 'notRdy0.delay']) { const n = byName.get(dn); if (n !== undefined) copies.add(n); }
  copies.delete(master);
  // The receiver: the backward cone of the master, the master and its copies excluded.
  const d = new Map([[master, 0]]);
  const q = [master];
  while (q.length) {
    const n = q.shift();
    if (d.get(n) >= cap) continue;
    const boundary = [...nb(back, n)].some((x) => !rails.has(x) && !homeOk(x));
    if (n !== master && boundary) continue;
    for (const x of nb(back, n)) {
      if (rails.has(x) || d.has(x) || copies.has(x)) continue;
      d.set(x, d.get(n) + 1);
      if (homeOk(x)) q.push(x);
    }
  }
  const inSet = new Set([...d.keys()].filter((n) => n !== master && homeOk(n)));
  const groups = [
    { id: 'in', nodes: [...inSet].sort((a, b) => a - b), reads: readsOf(inSet), feeds: feedsOf(inSet) },
    { id: 'master', node: master, nodes: [master], reads: readsOf(new Set([master])), feeds: feedsOf(new Set([master])) },
    { id: 'copies', nodes: [...copies].sort((a, b) => a - b), reads: readsOf(copies), feeds: feedsOf(copies) },
  ];
  const claimed = new Set();
  for (const g of groups) { g.nodes = g.nodes.filter((n) => !claimed.has(n)); g.nodes.forEach((n) => claimed.add(n)); }
  for (const g of groups) { const set = new Set(g.nodes); g.reads = readsOf(set); g.feeds = feedsOf(set); }
  return { groups, clocks };
}
