// The last three pieces of machinery, derived from the switch network: the
// program counter's own storage, the pipeline latch file, and the SYNC pin's
// generator. Three small derivations in one leaf, because each is a page of
// rule and they were asked for together.
//
// THE PROGRAM COUNTER (pcRegister): the counter is `pcl0..7` and `pch0..7`,
// sixteen pure bus bits: no gate drives them, everything arrives through a
// switch. The next value sits in the prime latches `pclp_n`/`pchp_n`, each an
// inverter of the incrementer's `#pclp_n`/`#pchp_n` (which stay with the
// incrementer container). Four byte groups, each with the lines that hold
// switches on it; the six lines that are nobody else's get their bounded
// cones here: `PCLPCL`/`PCHPCH` (write the prime back into the counter: the
// hold), `ADLPCL`/`ADHPCH` (load the counter from the buses: a jump), and
// `PCLADL`/`PCHADH` (drive the prime onto the buses: the next fetch address).
// Measured: pcl 8, pch 8, pclp 8, pchp 8; cones PCLPCL 8, ADLPCL 4, PCLADL 5,
// PCHPCH 6, ADHPCH 4, PCHADH 7 (the low pair's load and hold share a stage,
// which the one-owner rule files with PCLPCL; the high pair's cones read #862,
// the hidden T1, and the branch's nnT2BR: a taken branch reloads PCH a cycle
// later than PCL).
//
// THE PIPELINE LATCH FILE (pipeFile): every node the die names `pipe*` is a
// latch under `cclk`, all 52 of them, and that uniformity is the finding: the
// file is where the decoder's phase-1 answers are re-timed onto phase 2. 15
// carry meaningful names and belong to other containers' stories (the timing
// chain's `pipeT*`, the vectors' `pipeVector*`); 37 are `pipeUNK*`, named by
// the reverse engineers for what they could not yet name. Two groups, `named`
// and `unk`, each with reads (the gate each latches) and feeds.
//
// THE SYNC GENERATOR (syncGen): the pin that says "this cycle is an opcode
// fetch" is four nodes: the pad (a push-pull driver precharged through
// `#417`, with `#317` the other half), driven by `#445`, an inverter of
// `#862`: the hidden T1, the timing chain's own state that never reaches the
// T-state readout by name. SYNC is T1, inverted twice and sent off chip, and
// the whole generator reads exactly one wire.
//
// A leaf: it imports nothing and touches no DOM.

export const CLOCK_SWITCHES = 40;
const PC_LINES = ['dpc39_PCLPCL', 'dpc40_ADLPCL', 'dpc38_PCLADL', 'dpc31_PCHPCH', 'dpc30_ADHPCH', 'dpc32_PCHADH'];

function graphs(sch) {
  const rails = new Set([sch.vss, sch.vcc]);
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
  const clocks = new Set([...ctlCount].filter(([, c]) => c >= CLOCK_SWITCHES).map(([n]) => n));
  const byName = new Map();
  sch.names.forEach((s, n) => { if (s) byName.set(s, n); });
  const nb = (m, n) => m.get(n) || new Set();
  const readsOf = (set) => { const r = new Set(); for (const n of set) for (const m of nb(back, n)) if (!set.has(m) && !rails.has(m)) r.add(m); return [...r].sort((a, b) => a - b); };
  const feedsOf = (set) => { const r = new Set(); for (const n of set) for (const m of nb(fwd, n)) if (!set.has(m) && !rails.has(m)) r.add(m); return [...r].sort((a, b) => a - b); };
  const blk = (n) => sch.nodeBlock[n] & 0x7f;
  const cone = (root, homeBlocks, cap = 32) => {
    const inside = new Set(homeBlocks.map((s) => sch.blockNames.indexOf(s)).filter((i) => i >= 0));
    const homeOk = (n) => inside.has(blk(n)) && !clocks.has(n);
    const d = new Map([[root, 0]]);
    const q = [root];
    while (q.length) {
      const n = q.shift();
      if (d.get(n) >= cap) continue;
      const boundary = [...nb(back, n)].some((x) => !rails.has(x) && !homeOk(x));
      if (n !== root && boundary) continue;
      for (const x of nb(back, n)) {
        if (rails.has(x) || d.has(x)) continue;
        d.set(x, d.get(n) + 1);
        if (homeOk(x)) q.push(x);
      }
    }
    return [...d.keys()].filter((n) => n === root || homeOk(n)).sort((a, b) => a - b);
  };
  return { rails, back, fwd, und, clocks, byName, nb, readsOf, feedsOf, cone };
}

/** The program counter's storage: pcl, pch, pclp, pchp, and the six lines. */
export function pcRegister(sch, { cap = 32 } = {}) {
  const g = graphs(sch);
  const groups = [];
  for (const stem of ['pcl', 'pch', 'pclp', 'pchp']) {
    const set = new Set([...Array(8).keys()].map((i) => g.byName.get(`${stem}${i}`)).filter((n) => n !== undefined));
    const lines = new Set();
    for (const [c, a, b] of sch.switches) if ((set.has(a) || set.has(b)) && !g.clocks.has(c) && !set.has(c)) lines.add(c);
    groups.push({ id: stem, kind: 'byte', nodes: [...set].sort((a, b) => a - b), reads: g.readsOf(set), feeds: g.feedsOf(set), lines: [...lines].sort((a, b) => a - b) });
  }
  for (const name of PC_LINES) {
    const root = g.byName.get(name);
    if (root === undefined) continue;
    const nodes = g.cone(root, ['Control pipeline', 'Static logic'], cap);
    const set = new Set(nodes);
    groups.push({ id: name.slice(name.indexOf('_') + 1), kind: 'line', node: root, nodes, reads: g.readsOf(set), switches: sch.switches.filter(([c]) => c === root).length });
  }
  const claimed = new Set();
  for (const grp of groups) { grp.nodes = grp.nodes.filter((n) => !claimed.has(n)); grp.nodes.forEach((n) => claimed.add(n)); }
  return { groups };
}

/** The pipeline latch file: every pipe* node, named and unknown, all under cclk. */
export function pipeFile(sch) {
  const g = graphs(sch);
  const named = [], unk = [];
  sch.names.forEach((s, n) => { if (s && /^pipe/.test(s)) (/^pipeUNK/.test(s) ? unk : named).push(n); });
  let cclkLatched = 0;
  const chan = new Map();
  for (const [c, a, b] of sch.switches) { for (const [x, y] of [[a, b], [b, a]]) { if (!chan.has(x)) chan.set(x, []); chan.get(x).push(c); } }
  for (const n of [...named, ...unk]) if ((chan.get(n) || []).some((c) => sch.names[c] === 'cclk')) cclkLatched++;
  const mk = (id, ns) => { const set = new Set(ns); return { id, kind: 'pipes', nodes: [...set].sort((a, b) => a - b), reads: g.readsOf(set), feeds: g.feedsOf(set) }; };
  return { groups: [mk('named', named), mk('unk', unk)], cclkLatched, total: named.length + unk.length };
}

/** The SYNC generator: the pad, its driver, and the one wire it reads. */
export function syncGen(sch, { cap = 32 } = {}) {
  const g = graphs(sch);
  const root = g.byName.get('sync');
  const nodes = g.cone(root, ['Pads & I/O', 'Static logic'], cap);
  const set = new Set(nodes);
  return { groups: [{ id: 'sync', kind: 'sync', node: root, nodes, reads: g.readsOf(set), feeds: g.feedsOf(set) }] };
}
