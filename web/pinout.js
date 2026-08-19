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
import { PACKAGE, direction, pinFacts } from './pins.js';

const $ = (id) => document.getElementById(id);

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
    const d = pinFacts(sch);
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
