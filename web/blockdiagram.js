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
  { id: 'timing', label: 'Timing control', region: 'Timing chain',
    says: 'counts how far through the instruction the chip has got' },
  { id: 'interrupt', label: 'Interrupt logic', region: 'Interrupts & vectors',
    says: 'samples the interrupt pins and supplies the vectors' },
  { id: 'clockgen', label: 'Clock generator', region: null, figure: true,
    clocks: ['clk0', 'clk1out', 'clk2out', 'cclk', 'cp1'],
    says: 'makes the two internal phases from the one clock pin' },
  // On the die, not in the figure. The same treatment the special bus gets, and
  // for the same reason: the difference is the finding. `blocks.rs` grew this
  // out of the die's names as a region of its own, sitting between the decode
  // array and the control lines it drives.
  { id: 'pipeline', label: 'Control pipeline', region: 'Control pipeline',
    figure: false,
    says: 'latches the decoder\'s terms on the clock and drives the control lines' },
];

/**
 * Where the chip meets the outside world.
 *
 * Two of these are buses and resolve by width like any datapath claim. The rest
 * are individual pins, which have no width at all, so they carry a list of node
 * names and are answered by how many of them this die actually names.
 *
 * Deliberately NOT stated as "forty pins". The package has forty, but three are
 * unconnected and ground arrives on three of them, so a die that names 35
 * signals is not disagreeing with a datasheet that says 40 -- they are counting
 * different things. The page reports what it can see, which is the names.
 */
const PINS = [
  { id: 'ab', label: 'Address bus, A0 to A15', stem: 'ab', kind: 'bits' },
  { id: 'db', label: 'Data bus, D0 to D7', stem: 'db', kind: 'bits' },
  { id: 'ctrl', label: 'Control pins', kind: 'pinset',
    pins: ['res', 'irq', 'nmi', 'rdy', 'rw'] },
  { id: 'clk', label: 'Clock pins', kind: 'pinset',
    pins: ['clk0', 'clk1out', 'clk2out'] },
  { id: 'pwr', label: 'Power', kind: 'pinset', pins: ['vcc', 'vss'] },
  // In the figure, absent here. The figure covers the whole MCS650X family and
  // says so in its own notes; data bus enable is a 6501 pin and this die does
  // not carry it. Kept in the dataset precisely so the page can show it as
  // unresolved rather than quietly matching only what happens to be present.
  { id: 'dbe', label: 'Data bus enable', kind: 'pinset', pins: ['dbe'] },
  // On the die, not in this figure.
  { id: 'extra', label: 'Also on this die', kind: 'pinset', figure: false,
    pins: ['so', 'sync'] },
];

/**
 * The data bus buffer, which is the one box in the figure that is a *journey*
 * rather than a place. It is measured as one: how many gates drive the pins on
 * the way out, and how many steps a byte takes on the way in.
 */
const BUFFER = {
  id: 'dbb', label: 'Data bus buffer', kind: 'buffer',
  says: 'the drivers and receivers between the data pins and the internal bus',
};

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

/**
 * How a byte gets from a data pin to the internal bus, measured.
 *
 * The way OUT is gates: one driver per bit whose output is the pad itself. The
 * way IN is not, and that is the thing worth measuring rather than assuming. A
 * pad is an output driver, so nothing enters this chip through a pass
 * transistor from a pin -- the way in is a receiver, which is a gate -- and the
 * route from there to the internal bus crosses switches, so a walk that follows
 * only gates finds nothing at all and reports a chip with no way to read
 * memory. This one follows both.
 */
function buffer(d) {
  const pin = (s, i) => d.byName.get(`${s}${i}`);
  const dbn = new Set([...Array(8).keys()].map((i) => pin('db', i)));
  const idbn = new Set([...Array(8).keys()].map((i) => pin('idb', i)));
  const latch = new Set([...Array(8).keys()].map((i) => pin('idl', i)));

  const drivers = d.sch.gates.filter((g) => dbn.has(g[0]));
  const transistors = drivers.reduce((a, g) =>
    a + g[3].reduce((s, leg) => s + leg.length, 0) + (g[2] >= 0 ? 1 : 0), 0);
  const direct = d.sch.switches.filter(([, a, b]) =>
    (dbn.has(a) && idbn.has(b)) || (dbn.has(b) && idbn.has(a))).length;

  // Shortest route in, following gate inputs AND switch channels.
  const step = new Map();
  for (const [node, , pre, legs] of d.sch.gates) {
    for (const leg of legs) for (const i of leg) {
      if (!step.has(i)) step.set(i, new Set());
      step.get(i).add(node);
    }
    if (pre >= 0) { if (!step.has(pre)) step.set(pre, new Set()); step.get(pre).add(node); }
  }
  for (const [, a, b] of d.sch.switches) {
    if (!step.has(a)) step.set(a, new Set());
    if (!step.has(b)) step.set(b, new Set());
    step.get(a).add(b); step.get(b).add(a);
  }
  const start = pin('db', 0);
  const prev = new Map([[start, null]]);
  const queue = [start];
  let hit = null;
  while (queue.length && hit === null) {
    const n = queue.shift();
    if (idbn.has(n)) { hit = n; break; }
    for (const t of step.get(n) || []) {
      if (prev.has(t) || t === d.sch.vss || t === d.sch.vcc) continue;
      prev.set(t, n); queue.push(t);
    }
  }
  const route = [];
  for (let c = hit; c != null; c = prev.get(c)) route.push(c);
  route.reverse();
  return { drivers: drivers.length, transistors, direct,
           hops: route.length ? route.length - 1 : -1,
           viaLatch: route.some((n) => latch.has(n)),
           route: route.map((n) => d.sch.names[n] || `#${n}`) };
}

/** Every claim in the dataset, answered by the chip. */
function resolve(d) {
  const out = [];
  for (const p of PINS) {
    if (p.kind === 'bits') {
      const ids = d.bits.get(p.stem) || [];
      out.push({ ...p, section: 'pins', ids, width: ids.length,
                 owner: ownerOf(d, p.stem), unit: null });
    } else {
      const found = p.pins.filter((n) => d.byName.has(n));
      out.push({ ...p, section: 'pins', found, owner: null, unit: null });
    }
  }
  out.push({ ...BUFFER, section: 'pins', buf: buffer(d), owner: null, unit: null });
  for (const b of BLOCKS) {
    const ids = d.bits.get(b.stem) || [];
    const unit = d.bp.units.find((u) => u.name === b.stem) || null;
    out.push({ ...b, kind: 'bits', section: 'datapath',
               ids, width: ids.length, owner: ownerOf(d, b.stem), unit });
  }
  for (const b of CONTROL) {
    if (b.clocks) {
      // The clock generator is in the figure and is NOT a region here: its
      // signals are spread across the blocks that use them rather than filed
      // together. Reporting it as a missing region would say the die has no
      // clock generator, which is false -- it has one, drawn in full on the
      // designer page. What is measured is where its named signals ended up.
      const found = b.clocks.filter((n) => d.byName.has(n));
      const where = [...new Set(found.map((n) =>
        d.sch.blockNames[d.sch.nodeBlock[d.byName.get(n)] & 0x7f]))];
      out.push({ ...b, kind: 'clocks', section: 'control', found, where,
                 owner: null, unit: null });
      continue;
    }
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
  if (r.kind === 'pinset') {
    return r.found.length ? `${r.found.length} named` : 'none named';
  }
  if (r.kind === 'buffer') {
    return r.buf.hops > 0 ? `${r.buf.drivers} out, ${r.buf.hops} steps in` : 'no route';
  }
  if (r.kind === 'clocks') {
    return r.found.length ? `${r.found.length} signals, no region` : 'not on this die';
  }
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
  w: 1290, top: 78, rowH: 58, boxH: 40, railW: 22, gap: 26,
  pinX: 16, pinW: 250,
  boxX: 400, boxW: 300,
  ctrlX: 930, ctrlW: 330,
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
  const pins = rows.filter((r) => r.section === 'pins');
  const h = GEO.top + Math.max(path.length, ctrl.length + 1, pins.length) * GEO.rowH + 60;
  svg.setAttribute('viewBox', `0 0 ${GEO.w} ${h}`);

  const boxX = GEO.boxX;
  const leftX = boxX - GEO.gap - GEO.railW;
  const rightX = boxX + GEO.boxW + GEO.gap;
  const railX = { adh: leftX - 34, adl: leftX, sb: rightX, idb: rightX + 34 };

  const heading = (x, wArg, text) => {
    const t = el('text', { x: x + wArg / 2, y: GEO.top - 40, class: 'bd-section' }, svg);
    t.setAttribute('text-anchor', 'middle');
    t.textContent = text;
  };
  heading(GEO.pinX, GEO.pinW, 'pins');
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
    const ok = r.kind === 'clocks' ? r.found.length > 0 : !!r.meta;
    const g = box(r, GEO.ctrlX, GEO.ctrlW, y, ok ? '' : 'bd-missing');
    if (r.figure === false) g.classList.add('bd-extra');
  });
  // The pins, on the outside where they belong. The buffer among them is the
  // one box in the figure that is a journey rather than a place, and it is
  // marked so, because "8 out, 5 steps in" is not the same kind of fact as a
  // width and should not look like one.
  pins.forEach((r, i) => {
    const y = GEO.top + i * GEO.rowH;
    const ok = r.kind === 'bits' ? r.width > 0
      : r.kind === 'pinset' ? r.found.length > 0 : r.buf.hops > 0;
    const g = box(r, GEO.pinX, GEO.pinW, y, ok ? '' : 'bd-missing');
    if (r.kind === 'buffer') g.classList.add('bd-journey');
    // On the die, not in the figure: the same mark the special bus carries.
    if (r.figure === false) g.classList.add('bd-extra');
    el('line', { x1: GEO.pinX + GEO.pinW, y1: y + GEO.boxH / 2,
                 x2: railX.adh, y2: y + GEO.boxH / 2, class: 'bd-wire' }, g);
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
    // Kind and section are not the same thing and a row has to carry both: the
    // address and data buses are bus-shaped claims like the datapath's, but
    // they are pins. Grouping by kind alone counts them as datapath.
    tr.dataset.section = r.section;
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
    } else if (r.kind === 'pinset') {
      cell(r.found.join(' ') || '(none named)', 'mono');
      cell(`${r.found.length} of ${r.pins.length} named`, 'mono');
    } else if (r.kind === 'buffer') {
      cell('db to idb', 'mono');
      cell(`${r.buf.drivers} driver gates out, ${r.buf.hops} steps in`, 'mono');
    } else if (r.kind === 'clocks') {
      cell(r.found.join(' ') || '(none named)', 'mono');
      cell(r.found.length
        ? `${r.found.length} signals, spread across ${r.where.length} blocks`
        : 'none', 'mono');
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
  {
    says: 'A data bus buffer sits between the data pins and the internal data bus',
    got: (d) => {
      const b = buffer(d);
      return `${b.drivers} driver gates out (${b.transistors} transistors), `
        + `${b.direct} direct connections in, and ${b.hops} steps from a pin to the bus`;
    },
    // It is there, and it is a buffer. What the measurement adds is that the
    // way in and the way out are not the same circuit run backwards.
    holds: (d) => buffer(d).drivers === 8 && buffer(d).hops > 0,
    note: (d) => {
      const b = buffer(d);
      return 'The two directions are not each other reversed. Out is eight gates, one '
        + 'per bit, whose output is the pad itself. In is not a gate at all at the far '
        + `end: there are ${b.direct} pass transistors joining a data pin to the internal `
        + 'bus, so nothing arriving from memory reaches it directly. The route is '
        + `${b.route.join(' then ')}, which means a byte read from memory sits in the `
        + 'input data latch first and only reaches the bus when the decoder opens the '
        + 'switch that puts it there.';
    },
    where: { href: 'block?b=data-bus', label: 'Blocks' },
  },
  {
    says: 'The figure describes a family rather than one part, and says so in its '
      + 'own notes: the clock generator is absent on one member, and the control '
      + 'options vary across them',
    got: (d) => {
      const rows = resolve(d);
      const absent = rows.filter((r) => r.kind === 'pinset' && r.figure !== false
        && r.found.length < r.pins.length);
      const extra = rows.filter((r) => r.figure === false);
      return `${absent.length} pin group in the figure is missing here `
        + `(${absent.map((r) => r.pins.join(' ')).join(', ') || 'none'}), and `
        + `${extra.length} things this die has are not drawn in it`;
    },
    // This is the figure being right about itself. It warns that the family
    // varies, and the die bears that out in both directions at once.
    holds: (d) => {
      const rows = resolve(d);
      return rows.some((r) => r.kind === 'pinset' && r.figure !== false
        && r.found.length < r.pins.length)
        && rows.some((r) => r.figure === false);
    },
    note: () => 'Data bus enable is drawn and is not on this die: it belongs to the '
      + '6501. Set overflow and sync are on this die and are not drawn. So is the '
      + 'control pipeline, which sits between the decode array and the lines it drives '
      + 'and which the figure folds into one box. None of that is the figure being '
      + 'wrong. It is a family portrait, and no single member looks exactly like it.',
    where: { href: 'designer', label: 'Designer' },
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
  claimed: () => BLOCKS.length + CONTROL.length + PINS.length + 1,
};

async function boot() {
  const status = $('bd-status');
  try {
    const [sch, blk, bp] = await Promise.all(FILES.map((f) =>
      fetch(f).then((r) => {
        if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
        return r.json();
      })));
    const d = { sch, blk, bp, bits: indexBits(sch),
                byName: new Map(sch.names.map((n, i) => [n, i]).filter(([n]) => n)) };

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

    const solved = rows.filter((r) => {
      if (r.kind === 'bits') return r.width > 0;
      if (r.kind === 'pinset') return r.found.length === r.pins.length;
      if (r.kind === 'buffer') return r.buf.hops > 0;
      if (r.kind === 'clocks') return r.found.length > 0;
      return !!r.meta;
    });
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
