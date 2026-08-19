// The stack pointer logic: the S register as the die builds it, the control
// lines that move it, and how those lines are made.
//
// The register is eight dynamic latches. Each bit is four nodes: `s`, its
// inverse `nots`, and two latch nodes joined to them by switches, one under
// `dpc7_SS` (hold: the bit recirculates, and the line is asserted by the
// ABSENCE of any term, so S keeps its value unless told otherwise) and one
// under `cclk`. Three more lines move it: `dpc6_SBS` loads it from the
// special bus, `dpc4_SSB` drives it onto the special bus, `dpc5_SADL` drives
// it onto the address-low bus, which is how the stack page is addressed. None
// of that is authored here; it is read off the switches:
//
//  1. The register is everything reachable from `s0..s7` through gates and
//     switch channels without leaving the Registers block: 32 nodes.
//  2. The lines are the controls of every switch touching a register node,
//     less the clocks: a node that controls forty or more switches is a
//     clock (`cclk` 243, `cp1` 96, nothing else comes close) and is never a
//     line of its own.
//  3. Each line's group is the line plus its backward cone inside the control
//     pipeline and the static logic, with the boundary rule (a node reading
//     anything from outside is kept, not expanded) and the clocks never
//     expanded, because `dpc7_SS` reads `cclk` as a gate input and a walk
//     through it reaches the clock generator. That cone is how the line is
//     made; its `reads` are the decode terms and pipeline latches it is made
//     from, and its `switches` are the ones it holds, counted.
//
//  4. A node in the cones of two lines is shared and is its own group: SS
//     and SBS, hold and load, share three (a TXS term latched once and read
//     by both, which is how one decode clears the hold and asserts the load).
//
// Measured on this die: register 32; SS 5, SBS 4, shared by SS and SBS 3,
// SADL 5, SSB 5, each line holding eight switches on the register; SADL is
// made from `op-T0-jsr` and `op-T2-stack`, SSB from `op-T0-tsx`, SS and SBS
// from `op-T0-txs`, which is the instruction set written in the wires; and the
// register's switches reach exactly `sb0..7` and `adl0..7` outside it, the
// two buses S can meet. Converges by a depth of 6.
//
// A leaf: it imports nothing and touches no DOM.

export const STEM = 's';
export const HOME = ['Control pipeline', 'Static logic'];
export const CLOCK_SWITCHES = 40;

/**
 * @param {object} sch  schematic.json
 * @param {{home?:string[], cap?:number}} [opts]
 * @returns {{register:{nodes:number[], outside:number[]},
 *            lines:{id:string, node:number, nodes:number[], cone:number[], reads:number[], switches:number, onRegister:number}[],
 *            shared:{id:string, nodes:number[], of:string[]}[], clocks:number[]}}
 *   `cone` is a line's whole backward cone; `nodes` is the cone less what it
 *   shares with another line, which is then in `shared`.
 */
export function stackPointer(sch, { home = HOME, cap = 32 } = {}) {
  const rails = new Set([sch.vss, sch.vcc]);
  const blk = (n) => sch.nodeBlock[n] & 0x7f;
  const REG = sch.blockNames.indexOf('Registers');
  const inside = new Set(home.map((s) => sch.blockNames.indexOf(s)).filter((i) => i >= 0));
  const byName = new Map();
  sch.names.forEach((s, n) => { if (s) byName.set(s, n); });
  const back = new Map(), und = new Map();
  const add = (m, a, b) => { if (!m.has(a)) m.set(a, new Set()); m.get(a).add(b); };
  for (const [out, , pre, legs] of sch.gates) {
    for (const i of new Set(legs.flat())) { add(back, out, i); add(und, out, i); add(und, i, out); }
    if (pre >= 0) { add(back, out, pre); add(und, out, pre); add(und, pre, out); }
  }
  const ctlOf = new Map(), ctlCount = new Map();
  for (const [c, a, b] of sch.switches) {
    add(back, a, b); add(back, b, a); add(und, a, b); add(und, b, a);
    for (const x of [a, b]) add(ctlOf, x, c);
    ctlCount.set(c, (ctlCount.get(c) || 0) + 1);
  }
  const nb = (m, n) => m.get(n) || new Set();
  const clocks = [...ctlCount].filter(([, c]) => c >= CLOCK_SWITCHES).map(([n]) => n).sort((a, b) => a - b);
  const clockSet = new Set(clocks);

  // The register: closure of the bits inside the Registers block.
  const bits = [];
  for (let i = 0; i < 8; i++) { const n = byName.get(`${STEM}${i}`); if (n !== undefined) bits.push(n); }
  const reg = new Set(bits);
  const q = [...bits];
  while (q.length) {
    const n = q.shift();
    for (const m of nb(und, n)) if (!reg.has(m) && !rails.has(m) && blk(m) === REG) { reg.add(m); q.push(m); }
  }
  const outside = new Set();
  for (const n of reg) for (const m of nb(und, n)) if (!reg.has(m) && !rails.has(m)) outside.add(m);

  // The lines: controls of the register's switches, less the clocks.
  const lineSet = new Set();
  for (const n of reg) for (const c of nb(ctlOf, n)) if (!clockSet.has(c)) lineSet.add(c);
  const lines = [...lineSet].sort((a, b) => a - b).map((l) => {
    const d = new Map([[l, 0]]);
    const qq = [l];
    while (qq.length) {
      const n = qq.shift();
      if (d.get(n) >= cap) continue;
      const boundary = [...nb(back, n)].some((x) => !rails.has(x) && !inside.has(blk(x)));
      if (n !== l && (boundary || clockSet.has(n))) continue;
      for (const x of nb(back, n)) {
        if (rails.has(x) || d.has(x)) continue;
        d.set(x, d.get(n) + 1);
        if (inside.has(blk(x)) && !clockSet.has(x)) qq.push(x);
      }
    }
    const nodes = [...d.keys()].filter((n) => (inside.has(blk(n)) && !clockSet.has(n)) || n === l).sort((a, b) => a - b);
    const mem = new Set(nodes);
    const reads = new Set();
    for (const n of nodes) for (const m of nb(back, n)) if (!mem.has(m) && !rails.has(m)) reads.add(m);
    let onRegister = 0;
    for (const [c, a, b] of sch.switches) if (c === l && (reg.has(a) || reg.has(b))) onRegister++;
    const name = sch.names[l] || `#${l}`;
    const id = name.includes('_') ? name.slice(name.indexOf('_') + 1) : name;
    return { id, node: l, cone: nodes, nodes, reads: [...reads].sort((a, b) => a - b), switches: ctlCount.get(l) || 0, onRegister };
  });
  // Shared: a node in two or more cones, grouped by the set of lines sharing it.
  const owners = new Map();
  for (const L of lines) for (const n of L.cone) { if (!owners.has(n)) owners.set(n, []); owners.get(n).push(L.id); }
  const sharedMap = new Map();
  for (const [n, ids] of owners) if (ids.length > 1) { const k = ids.join('-'); if (!sharedMap.has(k)) sharedMap.set(k, { id: k, of: ids, nodes: [] }); sharedMap.get(k).nodes.push(n); }
  for (const L of lines) L.nodes = L.cone.filter((n) => owners.get(n).length === 1);
  const shared = [...sharedMap.values()].map((g) => ({ ...g, nodes: g.nodes.sort((a, b) => a - b) }));
  return { register: { nodes: [...reg].sort((a, b) => a - b), outside: [...outside].sort((a, b) => a - b) }, lines, shared, clocks };
}
