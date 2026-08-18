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

/**
 * The control side of the figure, and why it resolves differently.
 *
 * A datapath box is a claim about a *bus*: so many wires, carrying a value, and
 * it is answered by resolving a stem and counting bits. A decode or timing box
 * is not that. It is a claim about a *region* of the chip -- a place where work
 * happens -- and the only honest answer is how much silicon is filed there.
 *
 * So these carry `region` instead of `stem` and are measured against
 * `blocks.rs`. Forcing them through the bit-width path would have meant
 * inventing a width for something that does not have one, which is exactly the
 * sort of tidy-looking wrong answer this site exists to avoid.
 */
const CONTROL = [
  { id: 'decode', label: 'Instruction decode', region: 'Decode PLA',
    says: 'turns the opcode and the cycle into the terms everything else obeys' },
  { id: 'pipeline', label: 'Control pipeline', region: 'Control pipeline',
    says: 'latches those terms on the clock and drives the control lines' },
  { id: 'timing', label: 'Timing control', region: 'Timing chain',
    says: 'counts how far through the instruction the chip has got' },
  { id: 'interrupt', label: 'Interrupt logic', region: 'Interrupts & vectors',
    says: 'samples the interrupt pins and supplies the vectors' },
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
  for (const b of BLOCKS) {
    const ids = d.bits.get(b.stem) || [];
    const unit = d.bp.units.find((u) => u.name === b.stem) || null;
    out.push({ ...b, kind: 'bits', section: 'datapath',
               ids, width: ids.length, owner: ownerOf(d, b.stem), unit });
  }
  for (const b of CONTROL) {
    // Measured as a region: how much of the chip is filed here. `blocks.rs`
    // grew these out of the die's own names, so a box the figure draws either
    // corresponds to one of them or it does not, and the page says which.
    const meta = d.blk.blocks.find((x) => x.name === b.region) || null;
    out.push({ ...b, kind: 'region', section: 'control', meta,
               owner: meta ? { id: meta.id, name: meta.name, share: 1 } : null,
               unit: null });
  }
  return out;
}

/** What was measured about one block, as the short string beside its box. */
const measured = (r) => {
  if (r.kind === 'bits') return r.width ? `${r.stem} ×${r.width}` : 'no such signal';
  return r.meta ? `${r.meta.transistors} transistors` : 'no such region';
};

/* -- the drawing -----------------------------------------------------------
 *
 * Laid out from the dataset by rule: buses become vertical rails, blocks sit in
 * a column between them, and a block connects to the rail it hangs off. No
 * coordinate in here came from the original plate -- the arrangement is
 * computed from the order and the rail assignment above, which is why adding a
 * block to the dataset just works.
 */
const GEO = {
  w: 1160, top: 78, rowH: 58, boxW: 300, boxH: 40, railW: 22, gap: 26,
  ctrlX: 800, ctrlW: 330,
};

/**
 * Two sections, laid out by rule.
 *
 * The datapath is a column of boxes between its bus rails, because that is what
 * a datapath is: things hung off wires. The control side is a separate column
 * with no rails at all, because nothing there is a bus -- decode does not carry
 * a value to the registers, it tells them what to do. Drawing a rail through it
 * to make the picture symmetrical would be inventing a bus.
 *
 * No coordinate here came from the original plate. The arrangement falls out of
 * the order and the `rail` / `section` fields, which is why adding a block to
 * the dataset just works.
 */
function draw(rows) {
  const svg = $('bd-svg');
  svg.replaceChildren();
  const path = rows.filter((r) => r.section === 'datapath');
  const ctrl = rows.filter((r) => r.section === 'control');
  const h = GEO.top + Math.max(path.length, ctrl.length + 1) * GEO.rowH + 60;
  svg.setAttribute('viewBox', `0 0 ${GEO.w} ${h}`);

  const boxX = 300;
  const leftX = boxX - GEO.gap - GEO.railW;
  const rightX = boxX + GEO.boxW + GEO.gap;
  const railX = { adh: leftX - 34, adl: leftX, sb: rightX, idb: rightX + 34 };

  const heading = (x, wArg, text) => {
    const t = el('text', { x: x + wArg / 2, y: GEO.top - 40, class: 'bd-section' }, svg);
    t.setAttribute('text-anchor', 'middle');
    t.textContent = text;
  };
  heading(boxX, GEO.boxW, 'datapath');
  heading(GEO.ctrlX, GEO.ctrlW, 'control');

  // Rails first, so the boxes sit over them.
  for (const bus of BUSES) {
    const x = railX[bus.id];
    const g = el('g', { class: 'bd-rail' + (bus.figure === false ? ' bd-rail-extra' : '') }, svg);
    el('rect', { x, y: GEO.top - 24, width: GEO.railW,
                 height: GEO.top + path.length * GEO.rowH - GEO.top + 14, rx: 3 }, g);
    const t = el('text', { x: x + GEO.railW / 2, y: GEO.top - 30, class: 'bd-raillabel' }, g);
    t.setAttribute('text-anchor', 'middle');
    t.textContent = bus.stem;
  }

  const box = (r, x, wArg, y, cls) => {
    const g = el('g', { class: `bd-block ${cls}`, 'data-id': r.id }, svg);
    const rect = el('rect', { x, y, width: wArg, height: GEO.boxH, rx: 4, class: 'bd-box' }, g);
    if (r.owner) rect.style.setProperty('--bd-hue', blockCss(r.owner.id));
    const label = el('text', { x: x + 12, y: y + GEO.boxH / 2 + 4, class: 'bd-label' }, g);
    label.textContent = r.label;
    // The measurement beside the claim rather than under it: the comparison is
    // the whole page and burying it in a caption would undo that.
    const meas = el('text', { x: x + wArg - 12, y: y + GEO.boxH / 2 + 4, class: 'bd-meas' }, g);
    meas.setAttribute('text-anchor', 'end');
    meas.textContent = measured(r);
    return g;
  };

  path.forEach((r, i) => {
    const y = GEO.top + i * GEO.rowH;
    const g = box(r, boxX, GEO.boxW, y, r.width ? '' : 'bd-missing');
    // The connector to the rail the figure hangs this block off.
    const rx = railX[r.rail];
    const right = rx > boxX;
    el('line', { x1: right ? boxX + GEO.boxW : rx + GEO.railW, y1: y + GEO.boxH / 2,
                 x2: right ? rx : boxX, y2: y + GEO.boxH / 2, class: 'bd-wire' }, g);
  });

  // The control column, and one bracket standing for every control line that
  // reaches into the datapath. It is deliberately ONE mark rather than a line
  // per block: 46 control lines fanning across the drawing would be a picture
  // of a mess, and the count is on the page in words instead.
  ctrl.forEach((r, i) => {
    const y = GEO.top + i * GEO.rowH;
    box(r, GEO.ctrlX, GEO.ctrlW, y, r.meta ? '' : 'bd-missing');
  });
  const bx = GEO.ctrlX - 26;
  const by0 = GEO.top + GEO.boxH / 2;
  const by1 = GEO.top + (ctrl.length - 1) * GEO.rowH + GEO.boxH / 2;
  const midY = GEO.top + Math.min(path.length - 1, 4) * GEO.rowH + GEO.boxH / 2;
  el('path', {
    d: `M ${GEO.ctrlX} ${by0} H ${bx} V ${by1} H ${GEO.ctrlX}`
       + ` M ${bx} ${(by0 + by1) / 2} H ${railX.idb + GEO.railW + 12}`
       + ` M ${railX.idb + GEO.railW + 12} ${(by0 + by1) / 2} V ${midY}`,
    class: 'bd-control-wire',
  }, svg);
  const ct = el('text', { x: bx - 8, y: (by0 + by1) / 2 - 8, class: 'bd-raillabel' }, svg);
  ct.setAttribute('text-anchor', 'end');
  ct.textContent = 'control lines';
  return { h };
}

/** The per-block table under the drawing. */
function table(rows) {
  const host = $('bd-rows');
  host.replaceChildren();
  for (const r of rows) {
    const tr = document.createElement('tr');
    // The harness branches on this: a bus claim and a region claim are checked
    // against different things, and a row has to say which it is.
    tr.dataset.kind = r.kind;
    const cell = (s, cls) => {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      td.textContent = s;
      tr.append(td);
    };
    cell(r.label);
    if (r.kind === 'bits') {
      cell(r.width ? r.stem : '(not on this die)', 'mono');
      cell(r.width ? `${r.width} wires` : 'none', 'mono');
    } else {
      cell(r.meta ? r.region : '(no such region)', 'mono');
      cell(r.meta ? `${r.meta.nodes} signals, ${r.meta.transistors} transistors` : 'none',
           'mono');
    }
    cell(r.owner ? r.owner.name : 'unclaimed');
    // Only a datapath claim can have a derived unit: the blueprint derives the
    // *datapath*, so asking whether it found the decode PLA would be asking a
    // question with one possible answer.
    cell(r.kind === 'bits' ? (r.unit ? 'yes' : 'no') : 'not applicable', 'mono');
    host.append(tr);
  }
}

const CHECKS = [
  {
    says: 'The figure names a set of registers and an adder as the whole of the '
      + 'datapath, and every one of them is a real, named structure on the die',
    got: (d) => {
      const rows = resolve(d).filter((r) => r.kind === 'bits');
      const hit = rows.filter((r) => r.width > 0);
      return `${hit.length} of ${rows.length} resolve to named signals, `
        + `${hit.filter((r) => r.width === 8).length} of them eight bits wide`;
    },
    holds: (d) => resolve(d).filter((r) => r.kind === 'bits').every((r) => r.width > 0),
    note: (d) => {
      const rows = resolve(d).filter((r) => r.kind === 'bits');
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
    says: 'Each datapath block in the figure is one part of the chip, in one place',
    got: (d) => {
      const rows = resolve(d).filter((r) => r.kind === 'bits' && r.owner);
      const clean = rows.filter((r) => r.owner.share === 1);
      return `${clean.length} of ${rows.length} have every bit filed to one functional block`;
    },
    holds: (d) => {
      const rows = resolve(d).filter((r) => r.kind === 'bits' && r.owner);
      return rows.every((r) => r.owner.share >= 0.75);
    },
    note: (d) => {
      const rows = resolve(d).filter((r) => r.kind === 'bits' && r.owner);
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
  {
    says: 'The control side is a handful of boxes off to one side: decode, the '
      + 'pipeline that follows it, the timing chain and the interrupt logic',
    got: (d) => {
      const rows = resolve(d).filter((r) => r.kind === 'region');
      const hit = rows.filter((r) => r.meta);
      const t = hit.reduce((a, r) => a + r.meta.transistors, 0);
      return `${hit.length} of ${rows.length} are regions blocks.rs grew on its own, `
        + `${t} transistors between them`;
    },
    holds: (d) => resolve(d).filter((r) => r.kind === 'region').every((r) => r.meta),
    note: (d) => {
      const rows = resolve(d).filter((r) => r.kind === 'region' && r.meta);
      const biggest = rows.slice().sort((a, b) => b.meta.transistors - a.meta.transistors)[0];
      const dp = resolve(d).filter((r) => r.kind === 'bits' && r.owner)
        .reduce((s, r) => s + (d.blk.blocks.find((x) => x.id === r.owner.id)?.transistors || 0), 0);
      return 'These were not sought out: `blocks.rs` seeds from the names on the die and '
        + 'grows along the wiring, and these four fell out of it. The proportions are the '
        + `part worth noticing: ${biggest.label.toLowerCase()} alone is `
        + `${biggest.meta.transistors} transistors, and the control side is not the small `
        + 'annex off to one side that the drawing makes it look like.';
    },
    where: { href: 'decode', label: 'Decode' },
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
  claimed: () => BLOCKS.length + CONTROL.length,
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
    draw(rows);
    table(rows);
    renderClaims($('bd-checks'), $('bd-tally'), CHECKS, d);

    const solved = rows.filter((r) => (r.kind === 'bits' ? r.width > 0 : !!r.meta));
    const ctrlT = rows.filter((r) => r.kind === 'region' && r.meta)
      .reduce((a, r) => a + r.meta.transistors, 0);
    $('bd-stats').textContent =
      `${rows.length} blocks in the figure · ${solved.length} resolve on this die · `
      + `${d.bp.units.filter((u) => u.kind === 'bus').length} buses derived from switch `
      + `topology · ${ctrlT} transistors on the control side`;

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
