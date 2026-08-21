#!/usr/bin/env node
// The chip's derived containers, as one file the API can serve.
//
// `web/chip-groups.js` composes the tracer's twenty-odd derivations into the
// disjoint partition the chip map draws, and it is a pure function of three
// published files -- so it runs here, outside a browser, and the API gets the
// same answer the page draws rather than a second implementation of it.
//
// Two layers come out, and the difference between them is the point:
//
//   groups      the PARTITION. Every node in exactly one group, because a
//               schematic needs disjoint boxes. Ownership is the tracer's own
//               click order: the first container to reach a node keeps it.
//   containers  the same derivations UNFILTERED, so they overlap. This is the
//               honest answer to "which groups is this node in": a node in the
//               decimal correction is also in an ALU slice, and three whole
//               containers (`sdp:sd1`, `sdp:sd2`, `sbus:link`) exist only
//               here, having been absorbed wholesale by a container that
//               outranks them.
//
// Hierarchy is reported, never invented. A kind is the root; a group whose id
// is `X.Y` is a child of `kind:X` when that group exists (the register load
// lines, and nothing else today); everything else hangs off its kind. Where
// there is no derived parent the field is the kind, not a guess.
//
// Bundles are the group-to-group wiring: every gate leg and switch whose ends
// are owned by different groups, counted by the chip map's own rule so the
// page's figures and the API's are one measurement.
//
//   node tools/export-groups.mjs [web/groups.json]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chipGroups, KIND_LABEL, KIND_ORDER } from '../web/chip-groups.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const OUT = process.argv[2] || path.join(WEB, 'groups.json');

const J = (p) => {
  const f = path.join(WEB, p);
  if (!fs.existsSync(f)) {
    console.error(`export-groups: ${f} is missing. Run the exporter that writes it first:\n`
      + '  cargo run -p v6502-netlist --bin export-schematic -- web/schematic.json\n'
      + '  cargo run -p v6502-netlist --bin export-blocks    -- web/blocks.json\n'
      + '  cargo run -p v6502-netlist --bin export-graph     -- web/graph.json\n'
      + '  cargo run --release -p v6502-sim --bin export-timing -- web/timing.json');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(f, 'utf8'));
};

const sch = J('schematic.json');
const blocks = J('blocks.json');
const timing = J('timing.json');
const graph = J('graph.json');

const { groups, containers, universe, stats } = chipGroups(sch, blocks, timing);

// ---------------------------------------------------------------------------
// Hierarchy: derived, and only where the ids actually carry one.
// ---------------------------------------------------------------------------
const byKey = new Map(groups.map((g) => [g.key, g]));
function parentOf(g) {
  const dot = g.id.lastIndexOf('.');
  if (dot > 0) {
    const p = `${g.kind}:${g.id.slice(0, dot)}`;
    if (byKey.has(p) && p !== g.key) return p;
  }
  return g.kind;                       // the kind is the root of every branch
}
const children = new Map();
for (const g of groups) {
  const p = parentOf(g);
  if (!children.has(p)) children.set(p, []);
  children.get(p).push(g.key);
}
const pathOf = (g) => {
  const out = [g.key];
  let p = parentOf(g);
  while (p && p.includes(':')) { out.unshift(p); p = parentOf(byKey.get(p)); }
  out.unshift(g.kind);
  return out;
};

// ---------------------------------------------------------------------------
// Ownership, membership and overlap
// ---------------------------------------------------------------------------
const owner = new Map();
for (const g of groups) for (const n of g.nodes) owner.set(n, g.key);

const memberOf = new Map();            // node -> [container keys], derivation order
for (const c of containers) for (const n of c.nodes) {
  if (!memberOf.has(n)) memberOf.set(n, []);
  memberOf.get(n).push(c.key);
}

// Which containers a container shares nodes with, and how many.
const overlapOf = new Map(containers.map((c) => [c.key, new Map()]));
for (const [, keys] of memberOf) {
  if (keys.length < 2) continue;
  for (const a of keys) for (const b of keys) {
    if (a === b) continue;
    const m = overlapOf.get(a);
    m.set(b, (m.get(b) || 0) + 1);
  }
}

// ---------------------------------------------------------------------------
// Bundles: the wiring between groups, counted the way chipmap.js counts it --
// out of schematic.json's own gate legs and switches, rails skipped, a
// precharge counted as an input. NOT out of graph.json's deduplicated edge
// list, which is a different question (2435 distinct input-to-output pairs)
// and would put a different number on the same drawing. The page's figures
// and the API's have to be one measurement.
// ---------------------------------------------------------------------------
const bundles = new Map();
const inside = { gate: 0, switch: 0 };
const at = (a, b) => {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const k = `${lo}\u0000${hi}`;
  if (!bundles.has(k)) bundles.set(k, { a: lo, b: hi, gate: 0, switch: 0, ab: 0, ba: 0, controls: [] });
  return bundles.get(k);
};
for (const [out, , pre, legs] of sch.gates) {
  const ins = new Set(legs.flat());
  if (pre >= 0) ins.add(pre);
  for (const i of ins) {
    if (i === sch.vss || i === sch.vcc) continue;
    const a = owner.get(i);
    const b = owner.get(out);
    if (a === undefined || b === undefined) continue;
    if (a === b) { inside.gate++; continue; }
    const bd = at(a, b);
    bd.gate++;
    if (a === bd.a) bd.ab++; else bd.ba++;   // which end drives which
  }
}
for (const [c, a, b] of sch.switches) {
  if (a === sch.vss || a === sch.vcc || b === sch.vss || b === sch.vcc) continue;
  const p = owner.get(a);
  const q = owner.get(b);
  if (p === undefined || q === undefined) continue;
  if (p === q) { inside.switch++; continue; }
  const bd = at(p, q);
  bd.switch++;
  const nm = sch.names[c] || `#${c}`;
  if (!bd.controls.includes(nm)) bd.controls.push(nm);
}
const bundleList = [...bundles.values()].sort((p, q) => (q.gate + q.switch) - (p.gate + p.switch)
  || p.a.localeCompare(q.a) || p.b.localeCompare(q.b));

// ---------------------------------------------------------------------------
// Which functional blocks a group's nodes are filed in. A group is derived
// machinery and a block is a region of the die, so the two cross freely:
// saying which blocks a group lands in is a fact worth reporting, not a
// contradiction to resolve.
// ---------------------------------------------------------------------------
const blockOf = (n) => sch.nodeBlock[n] & 0x7f;
function blocksOf(nodes) {
  const c = new Map();
  for (const n of nodes) c.set(blockOf(n), (c.get(blockOf(n)) || 0) + 1);
  return [...c].sort((p, q) => q[1] - p[1] || p[0] - q[0])
    .map(([id, count]) => ({ id, name: sch.blockNames[id], nodes: count }));
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------
const kindStats = new Map();
for (const g of groups) {
  const e = kindStats.get(g.kind) || { groups: 0, nodes: 0 };
  e.groups++; e.nodes += g.nodes.length;
  kindStats.set(g.kind, e);
}

const out = {
  format: 'chip-groups/1',
  note: 'Derived containers over the 6502 die. groups is a partition (every '
      + 'node once); containers is the same derivations unfiltered, so they '
      + 'overlap. Both come from web/chip-groups.js, the module the chip map '
      + 'and the tracer draw from.',
  counts: {
    nodes: universe.size,
    groups: groups.length,
    containers: containers.length,
    kinds: kindStats.size,
    bundles: bundleList.length,
    bundledGate: bundleList.reduce((s, b) => s + b.gate, 0),
    bundledSwitch: bundleList.reduce((s, b) => s + b.switch, 0),
    insideGate: inside.gate,
    insideSwitch: inside.switch,
    multiGroupNodes: [...memberOf.values()].filter((v) => v.length > 1).length,
  },
  blockNames: sch.blockNames,
  roles: ['signal', 'decode term', 'control line'],
  kinds: KIND_ORDER.filter((k) => kindStats.has(k)).map((k) => ({
    key: k,
    label: KIND_LABEL[k] || k,
    groups: kindStats.get(k).groups,
    nodes: kindStats.get(k).nodes,
  })),
  groups: groups.map((g) => ({
    key: g.key,
    kind: g.kind,
    id: g.id,
    label: g.label,
    parent: parentOf(g),
    path: pathOf(g),
    depth: pathOf(g).length - 1,
    children: children.get(g.key) || [],
    count: g.nodes.length,
    blocks: blocksOf(g.nodes),
    overlaps: [...(overlapOf.get(g.key) || new Map())]
      .sort((p, q) => q[1] - p[1] || p[0].localeCompare(q[0]))
      .map(([key, shared]) => ({ key, shared })),
    nodes: g.nodes,
  })),
  // The containers the partition drops entirely, kept whole: a reader asking
  // for `sdp:sd1` is asking about the store-data latch, not about whichever
  // container outranked it.
  containers: containers.map((c) => ({
    key: c.key,
    kind: c.kind,
    id: c.id,
    label: c.label,
    count: c.nodes.length,
    partitioned: byKey.has(c.key),
    nodes: c.nodes,
  })),
  nodes: [...universe].sort((a, b) => a - b).map((n) => {
    const gn = graph.nodes[n] || {};
    return {
      id: n,
      name: gn.name ?? null,
      block: blockOf(n),
      drives: gn.drives ?? null,
      role: sch.nodeRole[n] || 0,
      pullup: !!gn.pullup,
      x: gn.x ?? null,
      y: gn.y ?? null,
      owner: owner.get(n),
      groups: memberOf.get(n) || [],
    };
  }),
  bundles: bundleList,
};

// ---------------------------------------------------------------------------
// Refuse to write a file that is not what it claims to be. A broken run here
// produces a well-formed JSON full of plausible nonsense, which is the exact
// failure every other exporter in this tree guards against.
// ---------------------------------------------------------------------------
const fail = (m) => { console.error('export-groups: ' + m); process.exit(1); };
const c0 = out.counts;
if (out.counts.groups !== 132) fail(`expected 132 groups, got ${out.counts.groups}`);
if (out.counts.nodes !== stats.universe) fail('universe disagrees with itself');
{
  const seen = new Set();
  for (const g of out.groups) {
    for (const n of g.nodes) {
      if (seen.has(n)) fail(`node ${n} is in two groups; the partition is not disjoint`);
      seen.add(n);
    }
  }
  if (seen.size !== out.counts.nodes) fail(`partition covers ${seen.size} of ${out.counts.nodes} nodes`);
}
for (const g of out.groups) {
  if (g.parent !== g.kind && !byKey.has(g.parent)) fail(`${g.key} names a parent that is not a group`);
  for (const c of g.children) if (!byKey.has(c)) fail(`${g.key} names a child that is not a group`);
}
for (const n of out.nodes) {
  if (!n.groups.includes(n.owner)) fail(`node ${n.id} is owned by a container it is not in`);
}
if (out.counts.multiGroupNodes < 1) fail('no node is in more than one container: the overlap layer is dead');
if (!out.containers.some((c) => !c.partitioned)) fail('no container was absorbed; the two layers are the same file twice');
for (const b of out.bundles) {
  if (!byKey.has(b.a) || !byKey.has(b.b)) fail(`bundle ${b.a} - ${b.b} names a group that does not exist`);
  if (b.gate + b.switch < 1) fail(`bundle ${b.a} - ${b.b} carries nothing`);
  if (b.ab + b.ba !== b.gate) fail(`bundle ${b.a} - ${b.b} loses direction: ${b.ab}+${b.ba} of ${b.gate}`);
}
{
  // Every gate leg and every switch is either inside one group or across two.
  // Counted independently of the loops above, so a bug in either shows up as
  // a disagreement rather than as a plausible total.
  let legs = 0;
  for (const [out2, , pre, legsOf] of sch.gates) {
    const ins = new Set(legsOf.flat());
    if (pre >= 0) ins.add(pre);
    for (const i of ins) {
      if (i === sch.vss || i === sch.vcc) continue;
      if (owner.has(i) && owner.has(out2)) legs++;
    }
  }
  if (legs !== c0.bundledGate + c0.insideGate) {
    fail(`gate legs do not add up: ${legs} against ${c0.bundledGate} across + ${c0.insideGate} inside`);
  }
  let sw = 0;
  for (const [, a, b] of sch.switches) {
    if (a === sch.vss || a === sch.vcc || b === sch.vss || b === sch.vcc) continue;
    if (owner.has(a) && owner.has(b)) sw++;
  }
  if (sw !== c0.bundledSwitch + c0.insideSwitch) {
    fail(`switches do not add up: ${sw} against ${c0.bundledSwitch} across + ${c0.insideSwitch} inside`);
  }
}

fs.writeFileSync(OUT, JSON.stringify(out));
const c = c0;
console.log(`groups.json: ${c.nodes} nodes, ${c.groups} groups over ${c.kinds} kinds, `
  + `${c.containers} containers (${out.containers.filter((x) => !x.partitioned).length} absorbed), `
  + `${c.multiGroupNodes} nodes in more than one, ${c.bundles} bundles `
  + `(${c.bundledGate} gate + ${c.bundledSwitch} switch across, ${c.insideGate}+${c.insideSwitch} inside) `
  + `-> ${OUT} (${fs.statSync(OUT).size} bytes)`);
