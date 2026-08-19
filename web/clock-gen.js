// The clock generator, derived by a rule rather than by a list of node numbers.
//
// Extracted from designer.js when the tracer wanted the same circuit as a
// container. Two pages deriving "the clock generator" from two copies of the
// walk would eventually disagree about which transistors it is, and a reader
// comparing the designer page's 44 with a tracer card would have no way to
// tell which was lying. A leaf: it imports nothing.
//
// The rule: start at the `clk0` pad and walk forward through gate inputs (a
// precharge clock counts as an input), including the four clocks it ends at
// but never expanding them. That last clause is what bounds the walk: `cclk`
// alone opens 243 switches, so expanding it reaches the decode pipeline and
// from there most of the chip. `clk0` itself is the pin the generator starts
// from, not part of the circuit: its own two transistors are gated by vss and
// can never switch, which is the difference between the 46 the die reports on
// the chain and the 44 the circuit is.
//
// Measured on this die: 16 nodes, 44 transistors, 21 of them deciding anything
// and 23 the four output stages, 1.3% of the chip; and two transistors gated by
// `cp1` landing back inside the generator, one in each symmetric half, which
// is the non-overlap interlock the whole circuit is on the die for.
// `_designer-test.html` re-walks it, and re-runs it WITHOUT the boundary
// clause to prove the clause is load-bearing.

export const CLOCKS = ['cclk', 'cp1', 'clk1out', 'clk2out'];
export const PAD = 'clk0';

const cache = new WeakMap();

/**
 * @param {object} sch  schematic.json (names, gates, vss, vcc)
 * @returns {{pad:number, outs:Set<number>, nodes:Set<number>, transistors:number,
 *            drivers:number, logic:number, feedback:[number,number][]}}
 *   `nodes` is the generator: the nodes reached, the four clocks included,
 *   the pad excluded. `transistors` counts the legs of every gate in it plus
 *   a clocked precharge (a depletion pullup is a segdef flag on this die, not
 *   a transistor). `feedback` lists [clock, node] for every transistor gated
 *   by a generated clock whose channel lands back inside the generator.
 */
export function clockGen(sch) {
  if (cache.has(sch)) return cache.get(sch);
  const idx = new Map();
  sch.names.forEach((n, i) => { if (n) idx.set(n, i); });
  const gates = new Map(sch.gates.map((g) => [g[0], g]));
  const feeds = new Map();
  const add = (k, v) => { if (!feeds.has(k)) feeds.set(k, new Set()); feeds.get(k).add(v); };
  for (const [node, , pre, legs] of sch.gates) {
    for (const leg of legs) for (const i of leg) add(i, node);
    if (pre >= 0) add(pre, node);
  }
  const { vss, vcc } = sch;
  const outs = new Set(CLOCKS.map((n) => idx.get(n)));
  const pad = idx.get(PAD);
  const seen = new Set([pad]);
  const queue = [pad];
  while (queue.length) {
    const n = queue.shift();
    if (outs.has(n)) continue;            // an output is included, not expanded
    for (const t of feeds.get(n) || []) {
      if (seen.has(t) || t === vss || t === vcc) continue;
      seen.add(t);
      queue.push(t);
    }
  }
  seen.delete(pad);

  const cost = (n) => {
    const g = gates.get(n);
    if (!g) return 0;
    return g[3].reduce((a, leg) => a + leg.length, 0) + (g[2] >= 0 ? 1 : 0);
  };
  const transistors = [...seen].reduce((a, n) => a + cost(n), 0);
  const drivers = [...outs].reduce((a, n) => a + cost(n), 0);

  const feedback = [];
  for (const [node, , pre, legs] of sch.gates) {
    if (!seen.has(node)) continue;
    for (const leg of legs) for (const inp of leg) if (outs.has(inp)) feedback.push([inp, node]);
    if (pre >= 0 && outs.has(pre)) feedback.push([pre, node]);
  }
  const out = { pad, outs, nodes: seen, transistors, drivers, logic: transistors - drivers, feedback };
  cache.set(sch, out);
  return out;
}
