// The published block diagram, as a dataset, checked against the silicon.
//
// Every 6502 datasheet opens with the same figure: a column of registers, a
// couple of buses, an adder, and the decode logic off to one side. It is how
// nearly everyone first meets this chip. This page encodes what that figure
// CLAIMS as data, draws it from that data in this site's own language, and then
// asks the die whether each claim is true.
//
// Two things it is deliberately NOT.
//
// It is not a facsimile. The original plate is a copyrighted figure from a 1976
// publication and tracing it coordinate for coordinate would be a derivative of
// it. What is encoded here is the factual content -- which blocks a 6502 is
// said to contain, and which buses join them -- laid out by this file's own
// rules. Facts about how a chip is organised are not anyone's to own; a
// particular drawing of them is.
//
// And it is not a second source of truth. Every number beside a block is read
// out of the published measurements -- schematic.json, blocks.json,
// blueprint.json -- exactly as the rest of the site does it. The dataset below
// carries only the *claim*: a label, and the stem the claim is about. Whether
// that stem exists, how wide it is, how many transistors are in it and which
// functional block owns it are all answered by the chip.

import { renderClaims } from './claim-table.js';
import { blockCss } from './block-palette.js';
import { el } from './sch-draw.js';

const $ = (id) => document.getElementById(id);

const FILES = ['schematic.json', 'blocks.json', 'blueprint.json'];

/* -- the dataset -----------------------------------------------------------
 *
 * The published architecture, as claims. `stem` is what this die calls the
 * thing, and it is the ONLY bridge between the figure and the measurements: if
 * a stem does not resolve, the page says so against that block rather than
 * quietly dropping it. `rail` is which bus the figure hangs the block off.
 *
 * The order is the reading order of the original: address side at the top,
 * down through the registers and the adder, to the data side at the bottom.
 * That much is genuinely functional rather than decorative -- a 6502 block
 * diagram is arranged by what touches what.
 */
const BUSES = [
  { id: 'adh', label: 'address bus high', stem: 'adh', side: 'left' },
  { id: 'adl', label: 'address bus low', stem: 'adl', side: 'left' },
  { id: 'sb', label: 'special bus', stem: 'sb', side: 'right', figure: false },
  { id: 'idb', label: 'internal data bus', stem: 'idb', side: 'right' },
];

const BLOCKS = [
  { id: 'abh', label: 'Address bus buffer, high', stem: 'abh', rail: 'adh',
    says: 'drives the top half of the address pins' },
  { id: 'abl', label: 'Address bus buffer, low', stem: 'abl', rail: 'adl',
    says: 'drives the bottom half of the address pins' },
  { id: 'pch', label: 'Program counter, high', stem: 'pch', rail: 'adh',
    says: 'the high byte of the address the chip will fetch next' },
  { id: 'pcl', label: 'Program counter, low', stem: 'pcl', rail: 'adl',
    says: 'the low byte, incremented as bytes are consumed' },
  { id: 'y', label: 'Index register Y', stem: 'y', rail: 'sb',
    says: 'an index added to an address before the access' },
  { id: 'x', label: 'Index register X', stem: 'x', rail: 'sb',
    says: 'the other index register' },
  { id: 's', label: 'Stack pointer', stem: 's', rail: 'sb',
    says: 'the low byte of the stack address; the page is fixed' },
  { id: 'alu', label: 'Arithmetic logic unit', stem: 'alu', rail: 'sb',
    says: 'every arithmetic and logical result the chip produces' },
  { id: 'a', label: 'Accumulator', stem: 'a', rail: 'sb',
    says: 'where a result is put when it is meant to be kept' },
  { id: 'p', label: 'Processor status register', stem: 'p', rail: 'sb',
    says: 'the flags, set as a side effect of the adder' },
  { id: 'idl', label: 'Input data latch', stem: 'idl', rail: 'idb',
    says: 'holds the byte arriving from memory' },
  { id: 'ir', label: 'Instruction register', stem: 'ir', rail: 'idb',
    says: 'holds the opcode being executed' },
];

/** Which functional block in `blocks.rs` a stem's signals are filed under. */
function ownerOf(d, stem) {
  const ids = d.bits.get(stem) || [];
  if (!ids.length) return null;
  const tally = new Map();
  for (const n of ids) {
    const b = d.sch.nodeBlock[n] & 0x7f;
    tally.set(b, (tally.get(b) || 0) + 1);
  }
  const [best] = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  return { id: best[0], name: d.sch.blockNames[best[0]], share: best[1] / ids.length };
}

/** Every claim in the dataset, answered by the chip. */
function resolve(d) {
  const out = [];
  for (const b of [...BLOCKS]) {
    const ids = d.bits.get(b.stem) || [];
    const unit = d.bp.units.find((u) => u.name === b.stem) || null;
    out.push({ ...b, ids, width: ids.length, owner: ownerOf(d, b.stem), unit });
  }
  return out;
}

/* -- the drawing -----------------------------------------------------------
 *
 * Laid out from the dataset by rule: buses become vertical rails, blocks sit in
 * a column between them, and a block connects to the rail it hangs off. No
 * coordinate in here came from the original plate -- the arrangement is
 * computed from the order and the rail assignment above, which is why adding a
 * block to the dataset just works.
 */
const GEO = { w: 980, top: 70, rowH: 58, boxW: 300, boxH: 40, railW: 22, gap: 26 };

function draw(rows, d) {
  const svg = $('bd-svg');
  svg.replaceChildren();
  const h = GEO.top + rows.length * GEO.rowH + 60;
  svg.setAttribute('viewBox', `0 0 ${GEO.w} ${h}`);

  const boxX = (GEO.w - GEO.boxW) / 2;
  const leftX = boxX - GEO.gap - GEO.railW;
  const rightX = boxX + GEO.boxW + GEO.gap;
  const railX = { adh: leftX - 34, adl: leftX, sb: rightX, idb: rightX + 34 };

  // Rails first, so the boxes sit over them.
  for (const bus of BUSES) {
    const x = railX[bus.id];
    const g = el('g', { class: 'bd-rail' + (bus.figure === false ? ' bd-rail-extra' : '') }, svg);
    el('rect', { x, y: GEO.top - 30, width: GEO.railW, height: h - GEO.top - 10, rx: 3 }, g);
    const t = el('text', { x: x + GEO.railW / 2, y: GEO.top - 38,
                           class: 'bd-raillabel' }, g);
    t.textContent = bus.stem;
    t.setAttribute('text-anchor', 'middle');
  }

  rows.forEach((r, i) => {
    const y = GEO.top + i * GEO.rowH;
    const g = el('g', { class: 'bd-block' + (r.width ? '' : ' bd-missing'),
                        'data-id': r.id }, svg);
    // The connector to the rail the figure hangs this block off.
    const rx = railX[r.rail];
    const from = rx > boxX ? boxX + GEO.boxW : rx + GEO.railW;
    const to = rx > boxX ? rx : boxX;
    el('line', { x1: from, y1: y + GEO.boxH / 2, x2: to, y2: y + GEO.boxH / 2,
                 class: 'bd-wire' }, g);

    const box = el('rect', { x: boxX, y, width: GEO.boxW, height: GEO.boxH, rx: 4,
                             class: 'bd-box' }, g);
    if (r.owner) box.style.setProperty('--bd-hue', blockCss(r.owner.id));

    const label = el('text', { x: boxX + 12, y: y + GEO.boxH / 2 + 4, class: 'bd-label' }, g);
    label.textContent = r.label;
    // The measurement, beside the claim rather than under it: this is the whole
    // point of the page and burying it in a caption would undo that.
    const meas = el('text', { x: boxX + GEO.boxW - 12, y: y + GEO.boxH / 2 + 4,
                              class: 'bd-meas' }, g);
    meas.setAttribute('text-anchor', 'end');
    meas.textContent = r.width ? `${r.stem} ×${r.width}` : 'no such signal';
  });
  return { h };
}

/** The per-block table under the drawing. */
function table(rows) {
  const host = $('bd-rows');
  host.replaceChildren();
  for (const r of rows) {
    const tr = document.createElement('tr');
    const cell = (s, cls) => {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      td.textContent = s;
      tr.append(td);
    };
    cell(r.label);
    cell(r.width ? r.stem : '(not on this die)', 'mono');
    cell(r.width ? String(r.width) : '0', 'mono');
    cell(r.owner ? r.owner.name : 'unclaimed');
    cell(r.unit ? 'yes' : 'no', 'mono');
    host.append(tr);
  }
}

const CHECKS = [
  {
    says: 'The figure names a set of registers and an adder as the whole of the '
      + 'datapath, and every one of them is a real, named structure on the die',
    got: (d) => {
      const rows = resolve(d);
      const hit = rows.filter((r) => r.width > 0);
      return `${hit.length} of ${rows.length} resolve to named signals, `
        + `${hit.filter((r) => r.width === 8).length} of them eight bits wide`;
    },
    holds: (d) => resolve(d).every((r) => r.width > 0),
    note: (d) => {
      const rows = resolve(d);
      const odd = rows.filter((r) => r.width !== 8);
      return 'The one that needs a translation is the input data latch: the figure '
        + 'calls it DL and this die calls it '
        + `${rows.find((r) => r.id === 'idl').stem}. `
        + (odd.length
          ? `Not everything is eight bits: ${odd.map((r) => `${r.stem} is ${r.width}`).join(', ')}.`
          : 'All of them are eight bits wide.');
    },
    where: { href: 'blueprint', label: 'Blueprint' },
  },
  {
    says: 'The datapath hangs off a single internal data bus',
    got: (d) => {
      const buses = d.bp.units.filter((u) => u.kind === 'bus').map((u) => u.name);
      return `${buses.length} buses derived from switch topology: ${buses.join(', ')}`;
    },
    holds: (d) => d.bp.units.filter((u) => u.kind === 'bus'
      && ['sb', 'idb'].includes(u.name)).length < 2,
    note: () => 'There are two, and the second one is not a detail. The special bus '
      + 'carries the register-to-register traffic and the internal data bus carries '
      + 'what came from memory, and an instruction that moves a byte between them has '
      + 'to open a switch to do it. A figure with one bus cannot show that switch, '
      + 'which is why this is the row that differs rather than a quibble about naming.',
    where: { href: 'blueprint', label: 'Blueprint' },
  },
  {
    says: 'Each block in the figure is one part of the chip, in one place',
    got: (d) => {
      const rows = resolve(d).filter((r) => r.owner);
      const clean = rows.filter((r) => r.owner.share === 1);
      return `${clean.length} of ${rows.length} have every bit filed to one functional block`;
    },
    holds: (d) => {
      const rows = resolve(d).filter((r) => r.owner);
      return rows.every((r) => r.owner.share >= 0.75);
    },
    note: (d) => {
      const rows = resolve(d).filter((r) => r.owner);
      const split = rows.filter((r) => r.owner.share < 1);
      return split.length
        ? `Split across blocks: ${split.map((r) => `${r.stem} is `
          + `${Math.round(r.owner.share * 100)}% ${r.owner.name}`).join(', ')}. `
          + 'That is `blocks.rs` measuring where the wiring actually goes, not a '
          + 'disagreement with the figure.'
        : 'Every one of them is filed whole, which is a stronger agreement than the '
          + 'figure claims: it draws boxes, and the wiring turns out to respect them.';
    },
    where: { href: 'exploded', label: 'Exploded' },
  },
];

/** Index every `stem0..stemN` once, so a claim can be resolved by name. */
function indexBits(sch) {
  const bits = new Map();
  sch.names.forEach((n, i) => {
    if (!n) return;
    const m = /^(.*?)(\d+)$/.exec(n);
    if (!m || !m[1]) return;
    if (!bits.has(m[1])) bits.set(m[1], []);
    bits.get(m[1]).push(i);
  });
  return bits;
}

// Only what the page actually has a slot for. An entry here with no `data-fact`
// to fill is dead weight that reads as a fact the page states and does not.
const FACTS = {
  claimed: () => BLOCKS.length,
};

async function boot() {
  const status = $('bd-status');
  try {
    const [sch, blk, bp] = await Promise.all(FILES.map((f) =>
      fetch(f).then((r) => {
        if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
        return r.json();
      })));
    const d = { sch, blk, bp, bits: indexBits(sch) };

    const missing = [];
    for (const e of document.querySelectorAll('[data-fact]')) {
      const fn = FACTS[e.dataset.fact];
      if (!fn) { missing.push(e.dataset.fact); continue; }
      const v = fn(d);
      if (v === undefined || v === null || v === '') { missing.push(e.dataset.fact); continue; }
      e.textContent = String(v);
    }

    const rows = resolve(d);
    draw(rows, d);
    table(rows);
    renderClaims($('bd-checks'), $('bd-tally'), CHECKS, d);

    $('bd-stats').textContent =
      `${rows.length} blocks in the figure · ${rows.filter((r) => r.width).length} resolve `
      + `on this die · ${d.bp.units.filter((u) => u.kind === 'bus').length} buses derived `
      + `from switch topology`;

    if (missing.length) throw new Error('facts not derived: ' + missing.join(', '));
    $('bd-boot').hidden = true;
    $('bd-main').hidden = false;
  } catch (e) {
    status.textContent = 'Could not load: ' + (e && e.message ? e.message : e);
    status.classList.add('error');
    throw e;
  }
}

boot();
