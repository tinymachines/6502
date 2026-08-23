// The whole chip as one ELK graph: every node, every edge.
//
//     node tools/chip-elk/chip2elk.js            # nested in the 132 containers
//     FLAT=1 node tools/chip-elk/chip2elk.js     # no hierarchy
//
// Reads web/graph.json (the chip as one node-and-edge file) and
// web/groups.json (the partition that covers every node exactly once), and
// writes an ELK layout to $OUT.
//
// **This is the opposite of what the die graph draws, deliberately.** That
// page puts every node at its own measured centroid and lays out nothing,
// because the embedding is a fact we hold rather than something to infer.
// This computes an arrangement instead. The two are worth having side by
// side: where the designers put a wire, against where a layout algorithm
// would. Neither is the other's approximation, and this one must never be
// labelled as a picture of the die.
//
// Rails are excluded, as everywhere else here: vss and vcc touch hundreds of
// nodes and would put a star through the middle of the drawing.

const fs = require('fs');
const ELK = require('elkjs');

const REPO = process.env.REPO || `${__dirname}/../..`;
const OUT = process.env.OUT || '/tmp/chip-elk.json';
const FLAT = !!process.env.FLAT;
// One container, with the wires that cross its edge. The whole chip at node
// level lays out in seconds and renders as texture; a container is a median
// of 8 nodes and 121 of the 132 hold 30 or fewer, which is a scale a layout
// algorithm can actually make readable. See the README.
const ONLY = process.env.GROUP || '';
const DIR = process.env.DIR || 'RIGHT';

const g = JSON.parse(fs.readFileSync(`${REPO}/web/graph.json`, 'utf8'));
const gr = JSON.parse(fs.readFileSync(`${REPO}/web/groups.json`, 'utf8'));

const owner = new Map();
for (const grp of gr.groups) for (const n of grp.nodes) owner.set(n, grp.key);

const nodes = g.nodes.filter(Boolean);
const rail = new Set(nodes.filter((n) => /^(vss|vcc)$/.test(n.name || '')).map((n) => n.id));
const byId = new Map(nodes.map((n) => [n.id, n]));

// A node is 26x12 with its name inside, or a bare 12x8 dot when it has none:
// 839 of these are gate outputs nobody needed to name, and giving each a box
// wide enough for "#1446" spends most of the drawing on anonymity.
const boxOf = (n) => (n.name ? { width: Math.max(26, n.name.length * 6.2 + 8), height: 13 }
                             : { width: 12, height: 8 });

const leaf = (n) => ({ id: `n${n.id}`, ...boxOf(n),
                       labels: n.name ? [{ text: n.name }] : [] });

let children;
if (ONLY) {
  const grp = gr.groups.find((x) => x.key === ONLY);
  if (!grp) { console.error(`no container ${ONLY}`); process.exit(1); }
  const inside = new Set(grp.nodes);
  // The boundary too: a block drawn without what crosses its edge is a block
  // with its inputs cut off, which is the mistake the block pages document.
  const edge = new Set();
  for (const e of g.edges) {
    if (rail.has(e.a) || rail.has(e.b)) continue;
    if (inside.has(e.a) && !inside.has(e.b)) edge.add(e.b);
    if (inside.has(e.b) && !inside.has(e.a)) edge.add(e.a);
  }
  children = [...inside].concat([...edge]).filter((id) => byId.has(id))
    .map((id) => ({ ...leaf(byId.get(id)), border: !inside.has(id) }));
} else if (FLAT) {
  children = nodes.filter((n) => !rail.has(n.id)).map(leaf);
} else {
  const boxes = new Map(gr.groups.map((grp) => [grp.key, {
    id: grp.key, children: [], labels: [{ text: grp.key }],
    layoutOptions: {
      'elk.padding': '[top=24,left=10,bottom=10,right=10]',
      'elk.algorithm': 'layered', 'elk.direction': DIR,
      'elk.spacing.nodeNode': '8',
      'elk.layered.spacing.nodeNodeBetweenLayers': '18',
    },
  }]));
  for (const n of nodes) {
    if (rail.has(n.id)) continue;
    const b = boxes.get(owner.get(n.id));
    if (b) b.children.push(leaf(n));
  }
  children = [...boxes.values()].filter((b) => b.children.length);
}

const inGraph = ONLY
  ? new Set(children.map((c) => +c.id.slice(1)))
  : new Set(FLAT ? nodes.filter((n) => !rail.has(n.id)).map((n) => n.id)
                 : [...owner.keys()].filter((id) => !rail.has(id)));
const seen = new Set();
const edges = [];
let dropped = 0;
for (const e of g.edges) {
  if (e.a === e.b || rail.has(e.a) || rail.has(e.b)) { dropped++; continue; }
  if (!inGraph.has(e.a) || !inGraph.has(e.b)) { dropped++; continue; }
  // 70 switches are parallel pairs on the same ends under the same control;
  // drawing both puts two identical lines on top of each other.
  const k = `${e.a}-${e.b}-${e.kind}`;
  if (seen.has(k)) { dropped++; continue; }
  seen.add(k);
  edges.push({ id: `e${edges.length}`, sources: [`n${e.a}`], targets: [`n${e.b}`],
               kind: e.kind, control: e.control ?? null });
}

const total = (ONLY || FLAT) ? children.length
                   : children.reduce((s, b) => s + b.children.length, 0);
console.log(`chip2elk: ${ONLY || 'whole chip'}: ${total} nodes`
          + `${(ONLY || FLAT) ? '' : ` in ${children.length} containers`}, `
          + `${edges.length} edges, ${dropped} dropped (rails, self, duplicates)`);

const t = Date.now();
new ELK().layout({
  id: 'root', children, edges,
  layoutOptions: {
    'elk.algorithm': 'layered', 'elk.direction': DIR,
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.spacing.nodeNode': '16',
    'elk.layered.spacing.nodeNodeBetweenLayers': '28',
    'elk.layered.nodePlacement.strategy': process.env.PLACE || 'BRANDES_KOEPF',
  },
}).then((r) => {
  // The kinds ride along so the renderer can colour an edge without reading
  // graph.json a second time.
  r.edgeKinds = Object.fromEntries(edges.map((e) => [e.id, e.kind]));
  fs.writeFileSync(OUT, JSON.stringify(r));
  console.log(`  laid out in ${((Date.now() - t) / 1000).toFixed(1)}s -> `
            + `${Math.round(r.width)} x ${Math.round(r.height)} -> ${OUT}`);
}).catch((e) => { console.error('chip2elk:', e); process.exit(1); });
