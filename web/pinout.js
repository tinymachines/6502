// The forty pins, and what the die says about each one.
//
// The package is a fact: pin 9 carries A0, and no amount of measurement here
// changes that. So the numbering is the one authored table on the page, taken
// from the pinout figure in the family hardware manual, and it is the only
// thing on it that was not derived.
//
// Everything beside it is. Whether the signal exists at all, which functional
// block it belongs to, how much of the chip it reaches, and -- the interesting
// one -- whether it is an input, an output or both, are all read out of the
// switch network. The direction in particular is worth deriving rather than
// copying: a datasheet arrow is somebody's summary, and the silicon will say so
// itself if you ask it the right way.

import { blockCss } from './block-palette.js';
import { el } from './sch-draw.js';

const $ = (id) => document.getElementById(id);

/**
 * The package. `node` is what this die calls the pin, or null where there is
 * nothing to call: three pins are not connected and the manual says so.
 *
 * `role` is ours -- one line each, written here rather than lifted -- and it is
 * the only authored column. It carries no numbers for the same reason
 * `block-notes.js` carries none: a count typed into prose is a count nothing
 * checks again.
 */
const PACKAGE = [
  { n: 1, label: 'VSS', node: 'vss', power: true, role: 'Ground. It arrives twice, on this pin and on 21.' },
  { n: 2, label: 'RDY', node: 'rdy', role: 'Held low, the chip stalls on a read rather than stopping its clock.' },
  { n: 3, label: 'PHI1 OUT', node: 'clk1out', role: 'The first internal phase, driven back out for the rest of the system.' },
  { n: 4, label: 'IRQ', node: 'irq', role: 'Maskable interrupt, active low. Sampled rather than latched.' },
  { n: 5, label: 'N.C.', node: null, role: 'No connection.' },
  { n: 6, label: 'NMI', node: 'nmi', role: 'Non-maskable interrupt, active low, taken on the falling edge.' },
  { n: 7, label: 'SYNC', node: 'sync', role: 'High while the byte being fetched is an opcode. The chip saying what it is doing.' },
  { n: 8, label: 'VCC', node: 'vcc', power: true, role: 'Supply.' },
  { n: 9, label: 'A0', node: 'ab0', role: 'Address, low bit.' },
  { n: 10, label: 'A1', node: 'ab1', role: 'Address.' },
  { n: 11, label: 'A2', node: 'ab2', role: 'Address.' },
  { n: 12, label: 'A3', node: 'ab3', role: 'Address.' },
  { n: 13, label: 'A4', node: 'ab4', role: 'Address.' },
  { n: 14, label: 'A5', node: 'ab5', role: 'Address.' },
  { n: 15, label: 'A6', node: 'ab6', role: 'Address.' },
  { n: 16, label: 'A7', node: 'ab7', role: 'Address. The top of the zero page, and of the stack.' },
  { n: 17, label: 'A8', node: 'ab8', role: 'Address.' },
  { n: 18, label: 'A9', node: 'ab9', role: 'Address.' },
  { n: 19, label: 'A10', node: 'ab10', role: 'Address.' },
  { n: 20, label: 'A11', node: 'ab11', role: 'Address.' },
  { n: 21, label: 'VSS', node: 'vss', power: true, role: 'Ground again. The die names one node; the package brings it out twice.' },
  { n: 22, label: 'A12', node: 'ab12', role: 'Address.' },
  { n: 23, label: 'A13', node: 'ab13', role: 'Address.' },
  { n: 24, label: 'A14', node: 'ab14', role: 'Address.' },
  { n: 25, label: 'A15', node: 'ab15', role: 'Address, high bit. This is the whole of the space the chip can reach.' },
  { n: 26, label: 'D7', node: 'db7', role: 'Data, high bit. Also the bit a branch tests after a load.' },
  { n: 27, label: 'D6', node: 'db6', role: 'Data.' },
  { n: 28, label: 'D5', node: 'db5', role: 'Data.' },
  { n: 29, label: 'D4', node: 'db4', role: 'Data.' },
  { n: 30, label: 'D3', node: 'db3', role: 'Data.' },
  { n: 31, label: 'D2', node: 'db2', role: 'Data.' },
  { n: 32, label: 'D1', node: 'db1', role: 'Data.' },
  { n: 33, label: 'D0', node: 'db0', role: 'Data, low bit.' },
  { n: 34, label: 'R/W', node: 'rw', role: 'High to read, low to write. The chip telling memory which way the byte goes.' },
  { n: 35, label: 'N.C.', node: null, role: 'No connection.' },
  { n: 36, label: 'N.C.', node: null, role: 'No connection.' },
  { n: 37, label: 'PHI0 IN', node: 'clk0', role: 'The one clock the chip is given. Everything else it makes itself.' },
  { n: 38, label: 'S.O.', node: 'so', role: 'Set overflow: pulls the V flag high from outside, without an instruction.' },
  { n: 39, label: 'PHI2 OUT', node: 'clk2out', role: 'The second phase, driven back out. Memory is read and written against it.' },
  { n: 40, label: 'RES', node: 'res', role: 'Reset, active low. It runs the BRK sequence with the writes suppressed.' },
];

/**
 * Which way a pin points, measured rather than copied off an arrow.
 *
 * A pin is an OUTPUT if a gate drives it, an INPUT if it feeds gates, and both
 * if both. The subtlety, and it is the reason this is derived at all: a gate
 * whose every pulldown leg is gated by **vss** can never pull anything down.
 * It is a pullup wearing a gate's clothes.
 *
 * Two pins have exactly that -- RDY and S.O., both inputs, both with a
 * permanently-off pulldown holding them high when nothing outside is driving
 * them. Counting those as drivers reports two input pins as outputs, which is
 * what the first version of this did. Seventeen transistors on this die are
 * gated by vss and they are all this kind of thing.
 */
function direction(d, node) {
  const i = d.byName.get(node);
  if (i === undefined) return null;
  const g = d.driver.get(i);
  const driven = !!g;
  const read = (d.feeds.get(i) || 0) > 0;
  if (driven && read) return 'bidirectional';
  if (driven) return 'output';
  if (read) return 'input';
  return 'neither';
}

function resolve(d) {
  return PACKAGE.map((p) => {
    if (!p.node) return { ...p, node: null, dir: null, block: null, reach: 0 };
    // A rail is not a signal and the question does not apply to it. Asked
    // anyway, the rule calls ground an input -- it feeds gates and nothing
    // drives it -- which is true of the wire and nonsense about the pin.
    if (p.power) {
      const pi = d.byName.get(p.node);
      return { ...p, id: pi, dir: 'power', block: 'power rail', blockId: null,
               reach: (d.feeds.get(pi) || 0) + (d.chan.get(pi) || 0) };
    }
    const i = d.byName.get(p.node);
    if (i === undefined) return { ...p, id: null, dir: null, block: null, reach: 0 };
    return {
      ...p,
      id: i,
      dir: direction(d, p.node),
      block: d.sch.blockNames[d.sch.nodeBlock[i] & 0x7f],
      blockId: d.sch.nodeBlock[i] & 0x7f,
      reach: (d.feeds.get(i) || 0) + (d.chan.get(i) || 0),
    };
  });
}

/* -- the package ----------------------------------------------------------
 *
 * A dual in-line package is drawn one way because it only has one shape: pin 1
 * at the top left, counting down that side and back up the other. That is the
 * arrangement, and it is a fact about the part rather than a choice here, which
 * is why this is the one drawing on the site whose layout is not derived from
 * the netlist and does not need to be.
 */
const GEO = { w: 620, top: 54, rowH: 30, bodyX: 232, bodyW: 156, padW: 26, padH: 16 };

function drawPackage(rows) {
  const svg = $('po-svg');
  svg.replaceChildren();
  const perSide = rows.length / 2;
  const h = GEO.top + perSide * GEO.rowH + 40;
  svg.setAttribute('viewBox', `0 0 ${GEO.w} ${h}`);

  el('rect', { x: GEO.bodyX, y: GEO.top - 12, width: GEO.bodyW,
               height: perSide * GEO.rowH + 4, rx: 6, class: 'po-body' }, svg);
  // The notch. Every DIP has one and it is the only reason pin 1 is findable on
  // a real chip, so a drawing without it is missing the thing that makes the
  // numbering usable.
  el('path', { d: `M ${GEO.bodyX + GEO.bodyW / 2 - 13} ${GEO.top - 12} `
                  + `a 13 13 0 0 0 26 0`, class: 'po-notch' }, svg);
  const t = el('text', { x: GEO.bodyX + GEO.bodyW / 2, y: GEO.top + perSide * GEO.rowH / 2,
                         class: 'po-part' }, svg);
  t.setAttribute('text-anchor', 'middle');
  t.textContent = 'MCS6502';

  for (const r of rows) {
    const left = r.n <= perSide;
    const row = left ? r.n - 1 : rows.length - r.n;
    const y = GEO.top + row * GEO.rowH;
    const g = el('g', { class: `po-pin po-${r.dir || 'none'}`, 'data-pin': r.n }, svg);
    const px = left ? GEO.bodyX - GEO.padW : GEO.bodyX + GEO.bodyW;
    el('rect', { x: px, y: y - GEO.padH / 2, width: GEO.padW, height: GEO.padH,
                 class: 'po-pad' }, g);
    const num = el('text', { x: left ? GEO.bodyX + 9 : GEO.bodyX + GEO.bodyW - 9, y: y + 4,
                             class: 'po-num' }, g);
    num.setAttribute('text-anchor', left ? 'start' : 'end');
    num.textContent = String(r.n);

    const lab = el('text', { x: left ? px - 9 : px + GEO.padW + 9, y: y + 4,
                             class: 'po-lab' }, g);
    lab.setAttribute('text-anchor', left ? 'end' : 'start');
    lab.textContent = r.label;
    if (r.blockId != null) lab.style.fill = blockCss(r.blockId);
    // A hit target the width of the row, so a pin is clickable by its label as
    // well as its pad. The pads are 16 units tall and a finger is not.
    const hit = el('rect', { x: left ? 0 : GEO.bodyX + GEO.bodyW,
                             y: y - GEO.rowH / 2, width: GEO.bodyX, height: GEO.rowH,
                             class: 'po-hit' }, g);
    hit.setAttribute('data-pin', String(r.n));
  }
}

function table(rows) {
  const host = $('po-rows');
  host.replaceChildren();
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.dataset.pin = String(r.n);
    if (!r.node) tr.classList.add('po-nc');
    const cell = (s, cls) => {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      td.textContent = s;
      tr.append(td);
    };
    cell(String(r.n), 'mono');
    cell(r.label, 'mono');
    cell(r.node || 'not connected', 'mono');
    cell(r.dir || 'none', 'mono');
    cell(r.block || 'none');
    cell(r.node ? String(r.reach) : '0', 'mono');
    host.append(tr);
  }
}

function pick(n) {
  const rows = resolve(window.__po);
  const r = rows.find((x) => x.n === n);
  for (const g of $('po-svg').querySelectorAll('.po-pin.on')) g.classList.remove('on');
  for (const t of $('po-rows').querySelectorAll('tr.on')) t.classList.remove('on');
  if (!r) return;
  const g = $('po-svg').querySelector(`.po-pin[data-pin="${n}"]`);
  if (g) g.classList.add('on');
  const tr = $('po-rows').querySelector(`tr[data-pin="${n}"]`);
  if (tr) { tr.classList.add('on'); tr.scrollIntoView({ block: 'nearest' }); }
  $('po-picked').innerHTML = r.node
    ? `<b class="mono">${r.label}</b> · pin ${r.n} · <span class="mono">${r.node}</span> · `
      + `${r.dir} · ${r.block} · reaches ${r.reach} places<br>${r.role}`
    : `<b class="mono">${r.label}</b> · pin ${r.n}<br>${r.role}`;
}

const FACTS = {
  pins: () => PACKAGE.length,
  connected: () => PACKAGE.filter((p) => p.node).length,
  signals: () => new Set(PACKAGE.filter((p) => p.node).map((p) => p.node)).size,
};

async function boot() {
  const status = $('po-status');
  try {
    const sch = await fetch('schematic.json').then((r) => {
      if (!r.ok) throw new Error(`schematic.json: HTTP ${r.status}`);
      return r.json();
    });
    const byName = new Map(sch.names.map((n, i) => [n, i]).filter(([n]) => n));
    // A driver is a gate that can actually pull down. See `direction`.
    const driver = new Map();
    const feeds = new Map();
    for (const [node, , pre, legs] of sch.gates) {
      if (legs.some((leg) => !leg.every((x) => x === sch.vss))) driver.set(node, true);
      for (const leg of legs) for (const i of leg) feeds.set(i, (feeds.get(i) || 0) + 1);
      if (pre >= 0) feeds.set(pre, (feeds.get(pre) || 0) + 1);
    }
    const chan = new Map();
    for (const [, a, b] of sch.switches) {
      chan.set(a, (chan.get(a) || 0) + 1);
      chan.set(b, (chan.get(b) || 0) + 1);
    }
    const d = { sch, byName, driver, feeds, chan };
    window.__po = d;

    for (const e of document.querySelectorAll('[data-fact]')) {
      const fn = FACTS[e.dataset.fact];
      if (!fn) throw new Error(`no such fact: ${e.dataset.fact}`);
      e.textContent = String(fn(d));
    }

    const rows = resolve(d);
    drawPackage(rows);
    table(rows);

    const dirs = rows.filter((r) => r.dir);
    const count = (k) => dirs.filter((r) => r.dir === k).length;
    $('po-stats').textContent =
      `${PACKAGE.length} pins · ${count('input')} inputs, ${count('output')} outputs, `
      + `${count('bidirectional')} bidirectional, all measured from the switch network · `
      + `${PACKAGE.filter((p) => !p.node).length} not connected`;

    $('po-svg').addEventListener('click', (e) => {
      const t = e.target.closest('[data-pin]');
      if (t) pick(Number(t.dataset.pin));
    });
    $('po-rows').addEventListener('click', (e) => {
      const t = e.target.closest('tr[data-pin]');
      if (t) pick(Number(t.dataset.pin));
    });
    pick(1);

    $('po-boot').hidden = true;
    $('po-main').hidden = false;
  } catch (e) {
    status.textContent = 'Could not load: ' + (e && e.message ? e.message : e);
    status.classList.add('error');
    throw e;
  }
}

boot();
