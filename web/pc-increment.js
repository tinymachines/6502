// The program counter's incrementer, derived from the switch network.
//
// The counter is `pcl0..7` and `pch0..7`; its next value sits in the prime
// latches `pclp`/`pchp`, each the inverse of `#pclp_n`/`#pchp_n`. The
// incrementer is what lies between the two: the logic that computes each
// `#pclp_n` and `#pchp_n` from the counter bits and the increment enable. The
// die names the enable and the two carries, `dpc36_#IPC`, `dpc34_PCLC` (the
// low byte's carry out, a NOR over the `pcl` inverses) and `dpc35_PCHC`, and
// nothing else: bit 0's gates sit in the static logic, bits 1..7's are unnamed
// nodes filed in the Program counter block. So:
//
//  1. Roots: the sixteen outputs `#pclp0..7`, `#pchp0..7`, and the three
//     lines. Stops: the counter's storage, `pcl`, `pch`, `pclp`, `pchp`,
//     never expanded. Home: the static logic and the Program counter block
//     less the stops.
//  2. From each root walk BACKWARD through gate inputs and switch channels,
//     never entering a rail; a node outside the home is recorded but not
//     expanded, and a node inside with an input from outside is a boundary,
//     kept but not expanded.
//  3. The union is one connected piece (measured: 86 nodes). It reads exactly
//     `pcl0..7` and `pch0..7` plus the enable's inputs (`#1570`, the branch
//     logic's page-cross short circuit; `#1472` and `notRdy0` from the timing
//     chain; `pipeIPCrelated`; `ONEBYTE`), and it feeds exactly `pclp0..7`
//     and `pchp0..7`. Bit 7's cone runs nine deep: that is the ripple carry.
//  4. `parts`, for the card: `enable` is the `#IPC` cone (why the counter
//     does or does not count); `low` is the `#pclp` cones and `PCLC`'s less
//     the enable; `high` is the `#pchp` cones and `PCHC`'s less both.
//
// A leaf: it imports nothing and touches no DOM.

export const HOME = ['Static logic', 'Program counter'];
export const STOP = /^(pcl|pch|pclp|pchp)\d$/;
export const LINES = ['dpc36_#IPC', 'dpc34_PCLC', 'dpc35_PCHC'];

/**
 * @param {object} sch  schematic.json
 * @param {{home?:string[], cap?:number}} [opts]
 * @returns {{nodes:number[], roots:number[], parts:{enable:number[], low:number[], high:number[]},
 *            reads:number[], feeds:number[], components:number, depth:number}}
 */
export function pcIncrement(sch, { home = HOME, cap = 32 } = {}) {
  const rails = new Set([sch.vss, sch.vcc]);
  const blk = (n) => sch.nodeBlock[n] & 0x7f;
  const inside = new Set(home.map((s) => sch.blockNames.indexOf(s)).filter((i) => i >= 0));
  const isStop = (n) => STOP.test(sch.names[n] || '');
  const isHome = (n) => inside.has(blk(n)) && !isStop(n);
  const byName = new Map();
  sch.names.forEach((s, n) => { if (s) byName.set(s, n); });
  const back = new Map(), fwd = new Map();
  const add = (m, a, b) => { if (!m.has(a)) m.set(a, new Set()); m.get(a).add(b); };
  for (const [out, , pre, legs] of sch.gates) {
    for (const i of new Set(legs.flat())) { add(back, out, i); add(fwd, i, out); }
    if (pre >= 0) { add(back, out, pre); add(fwd, pre, out); }
  }
  for (const [, a, b] of sch.switches) { add(back, a, b); add(back, b, a); add(fwd, a, b); add(fwd, b, a); }
  const nb = (m, n) => m.get(n) || new Set();

  const bits = (stem) => [...Array(8).keys()].map((i) => byName.get(`${stem}${i}`)).filter((n) => n !== undefined);
  const lowRoots = bits('#pclp'), highRoots = bits('#pchp');
  const [ipc, pclc, pchc] = LINES.map((s) => byName.get(s));
  const roots = [...lowRoots, ...highRoots, ipc, pclc, pchc].filter((n) => n !== undefined);
  const rootSet = new Set(roots);
  let depth = 0;
  const walk = (rs) => {
    const reached = new Set();
    for (const o of rs) {
      const d = new Map([[o, 0]]);
      const q = [o];
      while (q.length) {
        const n = q.shift();
        if (d.get(n) >= cap) continue;
        const boundary = [...nb(back, n)].some((x) => !rails.has(x) && !isHome(x) && !rootSet.has(x));
        if (n !== o && boundary) continue;
        for (const x of nb(back, n)) {
          if (rails.has(x) || d.has(x)) continue;
          d.set(x, d.get(n) + 1);
          depth = Math.max(depth, d.get(x));
          if (isHome(x)) q.push(x);
        }
      }
      for (const n of d.keys()) if (isHome(n) || rootSet.has(n)) reached.add(n);
    }
    return reached;
  };
  const enableSet = walk([ipc]);
  const lowSet = walk([...lowRoots, pclc]);
  const highSet = walk([...highRoots, pchc]);
  const all = new Set([...enableSet, ...lowSet, ...highSet]);
  const nodes = [...all].sort((a, b) => a - b);
  const enable = nodes.filter((n) => enableSet.has(n));
  const low = nodes.filter((n) => !enableSet.has(n) && lowSet.has(n));
  const high = nodes.filter((n) => !enableSet.has(n) && !lowSet.has(n));
  const reads = new Set(), feeds = new Set();
  for (const n of nodes) {
    for (const m of nb(back, n)) if (!all.has(m) && !rails.has(m)) reads.add(m);
    for (const m of nb(fwd, n)) if (!all.has(m) && !rails.has(m)) feeds.add(m);
  }
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
  return { nodes, roots: roots.sort((a, b) => a - b), parts: { enable, low, high },
           reads: [...reads].sort((a, b) => a - b), feeds: [...feeds].sort((a, b) => a - b), components, depth };
}
