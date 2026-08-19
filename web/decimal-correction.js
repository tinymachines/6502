// The decimal correction, derived from the switch network around the nodes
// the die names for it.
//
// The designer page counts "the decimal circuit" by five names (`dpc18_#DAA`,
// `dpc22_#DSA`, `DC34`, `DC78`, `DC78.phi2`) and gets 21 transistors; asked
// for it as a container, the honest answer is everything those names and
// their kin are wired into, found by a rule:
//
//  1. Seeds: every node the die gave a decimal name: the two control lines
//     `dpc18_#DAA` and `dpc22_#DSA` (decimal adjust add / subtract), the two
//     nibble detectors `DC34` and `DC78` with `DC78.phi2`, and the `DA-*`
//     family in the ALU (`DA-AB2`, `DA-AxB2`, `DA-C01`, `DA-C45`, `#DA-ADD1`,
//     `#DA-ADD2`). Eleven nodes.
//  2. From each seed walk BOTH ways through gate inputs and switch channels,
//     never entering a rail, with the static logic as the home: a node
//     outside it is recorded but not expanded, and a node inside it with a
//     neighbour outside in the walk's direction is a boundary, kept but not
//     expanded. The seeds are roots, not home: counting them as home let the
//     walk take one more step and pick up `#936` and `#647`, the adder's own
//     NOT(A.B) gates for bits 1 and 5, which the detectors read but which are
//     the adder's. Backward, that stops where the circuit reads the adder's
//     products; forward, where it writes the adjusted bus.
//  3. The union is one connected piece (measured: 51 nodes, converging by a
//     depth of 6), so it is one container. Within it, `parts` sorts the
//     nodes by which walk found them, for the card: `detect`, reached
//     backward from a detector or a DA node (the two AOIs that decide a
//     nibble exceeds nine, and what they read); `enable`, reached backward
//     from a control line (how the lines are made: the D flag's pipeline copy
//     and the adc/sbc decode); `adjust`, reached forward only (the cclk
//     latches of the lines and the gates that write the adjusted bus).
//  4. `reads` and `feeds` are the nodes outside the set its members read and
//     drive, measured: it reads the adder's products, the D flag's copy and
//     the `sbc` decode, and it feeds `#C34` and `notalucout` (the carries the
//     detectors inject) and `dasb1..3`, `dasb5..7` (the adjusted special bus,
//     which `dpc23_SBAC` then opens onto the accumulator: bits 1..3 for +6 in
//     the low nibble, 5..7 for +6 in the high). That is the whole mechanism,
//     read off the wires.
//
// A leaf: it imports nothing and touches no DOM.

export const SEED = /^#?DA-|^DC\d|_#DAA$|_#DSA$/;
export const HOME = ['Static logic'];

/**
 * @param {object} sch  schematic.json
 * @param {{home?:string[], cap?:number}} [opts]
 * @returns {{nodes:number[], seeds:number[], parts:{detect:number[], enable:number[], adjust:number[]},
 *            reads:number[], feeds:number[], components:number, transistors:number}}
 */
export function decimalCorrection(sch, { home = HOME, cap = 32 } = {}) {
  const rails = new Set([sch.vss, sch.vcc]);
  const blk = (n) => sch.nodeBlock[n] & 0x7f;
  const inside = new Set(home.map((s) => sch.blockNames.indexOf(s)).filter((i) => i >= 0));
  const isHome = (n) => inside.has(blk(n));
  const back = new Map(), fwd = new Map();
  const add = (m, a, b) => { if (!m.has(a)) m.set(a, new Set()); m.get(a).add(b); };
  for (const [out, , pre, legs] of sch.gates) {
    for (const i of new Set(legs.flat())) { add(back, out, i); add(fwd, i, out); }
    if (pre >= 0) { add(back, out, pre); add(fwd, pre, out); }
  }
  for (const [, a, b] of sch.switches) { add(back, a, b); add(back, b, a); add(fwd, a, b); add(fwd, b, a); }
  const nb = (m, n) => m.get(n) || new Set();

  const seeds = [];
  sch.names.forEach((s, n) => { if (s && SEED.test(s)) seeds.push(n); });
  const seedSet = new Set(seeds);
  const isCtl = (n) => /_#D[AS]A$/.test(sch.names[n] || '');

  const walk = (dir, roots) => {
    const reached = new Set();
    for (const o of roots) {
      const d = new Map([[o, 0]]);
      const q = [o];
      while (q.length) {
        const n = q.shift();
        if (d.get(n) >= cap) continue;
        const boundary = [...nb(dir, n)].some((x) => !rails.has(x) && !isHome(x));
        if (n !== o && boundary) continue;
        for (const x of nb(dir, n)) {
          if (rails.has(x) || d.has(x)) continue;
          d.set(x, d.get(n) + 1);
          if (isHome(x)) q.push(x);
        }
      }
      for (const n of d.keys()) if (isHome(n) || seedSet.has(n)) reached.add(n);
    }
    return reached;
  };
  const ctlSeeds = seeds.filter(isCtl), detSeeds = seeds.filter((n) => !isCtl(n));
  const backDet = walk(back, detSeeds);
  const backCtl = walk(back, ctlSeeds);
  const fwdAll = walk(fwd, seeds);
  const all = new Set([...backDet, ...backCtl, ...fwdAll]);
  const nodes = [...all].sort((a, b) => a - b);

  // Connected components of the set, by the undirected adjacency.
  const seen = new Set();
  let components = 0;
  for (const s of nodes) {
    if (seen.has(s)) continue;
    components++;
    const q = [s]; seen.add(s);
    while (q.length) {
      const n = q.shift();
      for (const m of [...nb(back, n), ...nb(fwd, n)]) if (all.has(m) && !seen.has(m)) { seen.add(m); q.push(m); }
    }
  }
  const detect = nodes.filter((n) => backDet.has(n));
  const enable = nodes.filter((n) => !backDet.has(n) && backCtl.has(n));
  const adjust = nodes.filter((n) => !backDet.has(n) && !backCtl.has(n));
  const reads = new Set(), feeds = new Set();
  for (const n of nodes) {
    for (const m of nb(back, n)) if (!all.has(m) && !rails.has(m)) reads.add(m);
    for (const m of nb(fwd, n)) if (!all.has(m) && !rails.has(m)) feeds.add(m);
  }
  // Transistors, by the legs of the gates in the set plus a clocked precharge,
  // the way the designer page counts its five.
  const gates = new Map(sch.gates.map((g) => [g[0], g]));
  let transistors = 0;
  for (const n of nodes) {
    const g = gates.get(n);
    if (g) transistors += g[3].reduce((a, leg) => a + leg.length, 0) + (g[2] >= 0 ? 1 : 0);
  }
  return { nodes, seeds: seeds.sort((a, b) => a - b), parts: { detect, enable, adjust },
           reads: [...reads].sort((a, b) => a - b), feeds: [...feeds].sort((a, b) => a - b), components, transistors };
}
