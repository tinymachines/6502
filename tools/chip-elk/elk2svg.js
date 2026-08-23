// An ELK result to SVG. Same coordinate walk as the atlas package's renderer:
// ELK nests child positions inside their parent, and an edge's sections are
// relative to the container the edge is declared on, so both have to be
// resolved on the way down rather than read off the leaves.
//
//     OUT=/tmp/chip-elk.json SVG=chip.svg node tools/chip-elk/elk2svg.js

const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.env.OUT || '/tmp/chip-elk.json', 'utf8'));
const SVG = process.env.SVG || 'chip.svg';
const LABELS = process.env.LABELS !== '0';

// The die's own four colours, plus a hue per container kind so a reader can
// tell the ALU from the address latches without reading every label.
const KIND = {
  alu: '#fbbf24', regs: '#7dd3fc', flags: '#fca5a5', alat: '#67e8f9',
  dbus: '#fda4af', irp: '#c4b5fd', pcr: '#86efac', incr: '#f87171',
  stage: '#f0abfc', pins: '#94a3b8', chain: '#a5b4fc', clock: '#fde68a',
  intr: '#f9a8d4', branch: '#93c5fd', decimal: '#fdba74', sbus: '#5eead4',
  sdp: '#d8b4fe', rdy: '#bef264', pipe: '#cbd5e1', sync: '#fca5a5',
};
const hue = (id) => KIND[String(id).split(':')[0]] || '#8ea3c0';

const boxes = [], labels = [];
(function walk(n, ox, oy, depth) {
  for (const c of n.children || []) {
    const x = ox + (c.x || 0), y = oy + (c.y || 0);
    const kids = (c.children || []).length;
    boxes.push({ x, y, w: c.width || 0, h: c.height || 0, id: c.id,
                 container: kids > 0, hue: hue(c.id) });
    if (LABELS && c.labels?.[0]) {
      labels.push({ x: x + (kids ? 8 : (c.width || 0) / 2), y: y + (kids ? 16 : 9.5),
                    t: c.labels[0].text, container: kids > 0, hue: hue(c.id) });
    }
    walk(c, x, y, depth + 1);
  }
})(r, 0, 0, 0);

const paths = [];
(function collect(n, ox, oy) {
  for (const e of n.edges || []) {
    for (const s of e.sections || []) {
      const pts = [[s.startPoint.x, s.startPoint.y],
                   ...(s.bendPoints || []).map((p) => [p.x, p.y]),
                   [s.endPoint.x, s.endPoint.y]];
      paths.push({ pts: pts.map(([px, py]) => [px + ox, py + oy]),
                   kind: (r.edgeKinds || {})[e.id] ?? 0 });
    }
  }
  for (const c of n.children || []) collect(c, ox + (c.x || 0), oy + (c.y || 0));
})(r, 0, 0);

const W = Math.ceil(r.width), H = Math.ceil(r.height);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const out = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
  `<rect width="${W}" height="${H}" fill="#0b1120"/>`,
];

// Containers first, then edges, then leaves: a wire should cross a box and
// pass behind a node rather than over its name.
for (const b of boxes.filter((b) => b.container)) {
  out.push(`<rect x="${b.x.toFixed(1)}" y="${b.y.toFixed(1)}" width="${b.w.toFixed(1)}" `
         + `height="${b.h.toFixed(1)}" rx="9" fill="#101a2e" stroke="${b.hue}" stroke-opacity=".45"/>`);
}
for (const p of paths) {
  // A switch joins two wires without either causing the other, and a gate
  // input reaches the output it helps produce. Drawing them alike loses the
  // only structural distinction in the picture.
  const sw = p.kind === 1;
  out.push(`<polyline points="${p.pts.map((q) => q[0].toFixed(1) + ',' + q[1].toFixed(1)).join(' ')}" `
         + `fill="none" stroke="${sw ? '#4fbfd4' : '#3e93a6'}" stroke-opacity="${sw ? .55 : .28}" `
         + `stroke-width="${sw ? 1.4 : 0.7}"/>`);
}
for (const b of boxes.filter((b) => !b.container)) {
  const named = b.w > 12;
  out.push(`<rect x="${b.x.toFixed(1)}" y="${b.y.toFixed(1)}" width="${b.w.toFixed(1)}" `
         + `height="${b.h.toFixed(1)}" rx="${named ? 2.5 : 4}" fill="${named ? '#16233d' : '#1d2b45'}" `
         + `stroke="${b.hue}" stroke-opacity="${named ? .8 : .4}" stroke-width="0.6"/>`);
}
for (const l of labels) {
  out.push(`<text x="${l.x.toFixed(1)}" y="${l.y.toFixed(1)}" font-size="${l.container ? 15 : 8}" `
         + `font-family="ui-monospace,monospace" fill="${l.container ? l.hue : '#d6e2f5'}" `
         + `${l.container ? 'letter-spacing="1.2"' : 'text-anchor="middle"'}>${esc(l.t)}</text>`);
}
out.push('</svg>');
fs.writeFileSync(SVG, out.join('\n'));
const kb = (fs.statSync(SVG).size / 1024).toFixed(0);
console.log(`elk2svg: ${boxes.length} boxes, ${paths.length} edge paths, ${labels.length} labels`);
console.log(`  ${W} x ${H} -> ${SVG} (${kb} KB)`);
