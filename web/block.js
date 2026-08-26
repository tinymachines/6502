// One functional block of the die, as a circuit you can walk without leaving it.
//
// The exploded view pulls the chip apart into twelve blocks and says how big
// each one is. This is what happens when you climb inside one: what crosses its
// boundary, what it is made of, and what it does when the chip runs.
//
// Everything structural here is derived in the page from `schematic.json` --
// which gates and switches are filed to the block, which signals cross its
// edge, and which control lines reach in. Nothing consults a table of what a
// 6502 contains. The one authored part is `block-notes.js`, kept separate for
// exactly that reason.
//
// One document serves all twelve, chosen by `?b=<slug>`, and with no `b` it is
// the directory of them. Twelve near-identical files would be twelve chances
// for one of them to drift, which is the failure this project keeps finding.

import init, { Machine } from './pkg/v6502_wasm.js';
import { assemble } from './asm.js';
import { createDraw, el } from './sch-draw.js';
import { blockCss } from './block-palette.js';
import { setupProgramNav } from './program-nav.js';
import { PROGRAMS, LOAD_ADDR, selectedProgram, setSelectedProgram } from './programs.js';
import { setupChipNav } from './chip-nav.js';
import { adopt, chipDriver } from './chip-machine.js';
import { halfCyclesFor } from './chip-controls.js';
import { SLUGS, NOTES, DOES } from './block-notes.js';
import { createBlockView } from './block-cone.js';

const $ = (id) => document.getElementById(id);

const state = {
  data: null,       // schematic.json -- the only file indexed by node number
  meta: null,       // blocks.json's per-block metadata, indexed by block id
  id: null,         // which block, or null for the directory
  root: null,       // the signal the workbench link and picker point at
  // Which port pills the reader has switched on, keyed `${group}:${stem}`.
  // Per pill rather than per wire, deliberately: a signal can cross the
  // boundary more than one way and therefore appears under more than one
  // heading, and clicking `Told` must never silently flip a pill under
  // `Joined` that nobody touched. The DRAWING takes the union of them, and a
  // pill whose wires are already on screen through another heading is marked
  // as such rather than left looking inert. That way the overlap is surfaced
  // instead of being either hidden or spooky.
  lit: new Set(),
  litNodes: new Set(),   // the union, rebuilt whenever `lit` changes
  drawn: new Set(),      // what the last drawing actually placed
  portOf: new Map(),     // pill key -> the outside nodes it stands for
  // How far a LIT port is followed outward. The block itself is always drawn
  // whole, so this is the only distance left for a reader to choose. One means
  // the port is drawn as the boundary pill it has always been.
  depth: 1,
  dir: 'back',
  machine: null,
  inside: null,     // Set of node ids blocks.rs places in this block
  // Static-logic gates blocks.rs attributes to this block by what they drive.
  // A weaker claim than membership and kept separate for that reason -- see
  // `affiliated` below.
  affiliated: null,
  view: null,       // block-cone.js, closed over this block's membership
  gateOf: new Map(),
  gatesUsing: new Map(),
  switchesOn: new Map(),
  switchesBy: new Map(),
};

let draw = null;
const nameOf = (n) => draw.nameOf(n);

// Same cap and the same reason as the workbench: the median forward fan-out is
// 1, but one control line opens 273 switches. A drawing that quietly showed
// sixteen of those would be a claim about the chip rather than a limit of the
// page, so the number dropped is reported.
const MAX_FAN = 16;

// The block's boundary and the drawing of its inside both live in
// block-cone.js, because the workbench puts the same block on its bench and two
// pages answering "where does this block stop" from two copies would eventually
// disagree about which wires are ports. These are thin delegations so the rest
// of this file reads as it did.
const isRail = (n) => state.view.isRail(n);

/** In the block, as `blocks.rs` measured it. */
const inside = (n) => state.view.inside(n);

/**
 * A static gate this block's own signals are made of.
 *
 * The first version of this page stopped the walk at `inside` alone, and almost
 * every block came out two or three signals deep. That is not a bug in the walk,
 * it is a fact about the chip: a functional block is not a closed circuit. Its
 * gates are built out of the static logic the blocks are embedded in -- the
 * inverters and NORs that no block claimed, because a static gate's output
 * touches nothing but its own pullup and pulldown and the growth rule refuses to
 * cross a rail. Twenty of them make the ALU's gates; 191 make the control
 * pipeline's.
 *
 * `blocks.rs` already attributes each of those to the block it mostly drives, so
 * the drawing follows that attribution. It is deliberately a *second* category
 * rather than being folded into membership, because it is a weaker claim: a
 * quarter of the attributions sit more than 3000 die units from what they drive,
 * which is correct for a control signal generated beside the decoder and
 * consumed in the datapath. Affiliation is not location. Here there is no
 * floorplan to get wrong -- a schematic has no die coordinates -- but the pills
 * still say which they are.
 */
const affiliated = (n) => state.view.affiliated(n);

/** Somewhere the walk may keep going, as opposed to somewhere it must stop. */
const expandable = (n) => state.view.expandable(n);

// ---------------------------------------------------------------------------
// The block's interface and circuit
// ---------------------------------------------------------------------------
//
// Both live in block-cone.js. They moved there when the workbench wanted to put
// the same block on its bench: this is the code that decides where a block
// stops, and two pages answering that from two copies would eventually disagree
// about which wires are ports, with no way for a reader comparing them to tell
// which was lying. Same reasoning as sch-draw.js and block-palette.js.

/** What crosses the boundary, as four relations. */
const ports = () => state.view.ports();

/** Collapse `ab0..ab15` into one port sixteen wide. */
const byStem = (map) => state.view.byStem(map);

/**
 * The whole block, plus whatever ports the reader switched on.
 *
 * `state.litNodes` is the union of the wires the lit pills stand for, and
 * `state.depth` is how far a lit port is followed outward. `root` is carried
 * through so the drawing can still mark one pill as the subject; it is no
 * longer what the walk is built from, because the block is.
 */
const blockCone = (seedNodes, dir) => ({
  root: state.root,
  dir,
  ...state.view.cone(seedNodes, dir, state.litNodes, state.depth),
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const text = (tag, cls, s, parent) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (s != null) e.textContent = s;
  if (parent) parent.append(e);
  return e;
};

const html = (tag, cls, s, parent) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (s != null) e.innerHTML = s;
  if (parent) parent.append(e);
  return e;
};

/** A coloured dot plus a name, the same colours the exploded view uses. */
function blockChip(id, parent, { link = false } = {}) {
  const name = state.data.blockNames[id] || 'unknown';
  const slug = SLUGS[name];
  const node = link && slug
    ? text('a', 'bk-chip', null, parent)
    : text('span', 'bk-chip', null, parent);
  if (link && slug) node.href = `block?b=${slug}`;
  const dot = text('i', 'bk-dot', '', node);
  dot.style.background = blockCss(id);
  text('span', null, name, node);
  return node;
}

function renderPorts() {
  const host = $('bk-ports');
  host.replaceChildren();
  state.portOf.clear();
  // Cached: the drawing needs the same measurement to pick its seeds, and
  // computing the boundary twice is two chances to disagree about it.
  const p = state.ports = ports();

  const groups = [
    ['Told', 'feedsIn', p.feedsIn,
     'gate inputs arriving from outside: what the block is given'],
    ['Tells', 'drivesOut', p.drivesOut,
     'signals inside that something outside reads: what the block produces'],
    ['Joined', 'joined', p.joined,
     'wires a pass transistor can short to one inside: neither one causes the other'],
    ['Operated by', 'control', p.control,
     'control lines gating switches in here: machinery the decoder owns from outside'],
  ];

  for (const [title, key, map, why] of groups) {
    const stems = byStem(map);
    const sec = text('div', 'bk-portgroup', null, host);
    const h = text('h3', null, title, sec);
    text('span', 'bk-count mono', `${map.size} signals · ${stems.length} buses`, h);
    text('p', 'bk-why', why, sec);
    const list = text('div', 'bk-portlist', null, sec);
    if (!stems.length) {
      text('p', 'muted', 'Nothing crosses the boundary this way.', list);
      continue;
    }
    for (const [i, s] of stems.entries()) {
      // One pill, one key. A stem stands for every bit of a bus, so switching
      // `ab` on brings all sixteen wires in at once, which is the only reading
      // that matches what the pill says.
      //
      // Keyed by POSITION, not by stem, and that is not fussiness: unnamed
      // nodes are deliberately grouped by the block they come from rather than
      // by stem, because `#1446` and `#1451` are not a bus. So one heading can
      // hold several pills all labelled `unnamed`, and a `${group}:${stem}` key
      // collides between them -- clicking one lit two. The harness caught it.
      const pk = `${key}:${i}`;
      state.portOf.set(pk, s.nodes);
      const b = text('button', 'bk-port', null, list);
      b.type = 'button';
      b.dataset.port = pk;
      // The stem separately, because the key is positional now and anything
      // asking "is this the same wire under another heading" needs the name.
      b.dataset.stem = s.stem;
      b.dataset.node = String(s.inner);
      b.title = s.nodes.map(nameOf).sort().join(' ');
      const dot = text('i', 'bk-dot', '', b);
      dot.style.background = blockCss(s.block);
      text('span', 'bk-port-name mono', s.stem, b);
      if (s.nodes.length > 1) text('span', 'bk-port-w mono', `×${s.nodes.length}`, b);
      b.addEventListener('click', () => togglePort(pk));
    }
  }
  // The four counts are of *signals*, and a signal can cross more than one way:
  // a wire can be both joined by a switch and read by a gate outside. The note
  // under them says so, and paintPorts owns it because what needs saying
  // changes once pills start overlapping. It is not called here: it reads what
  // the drawing placed, so it runs at the end of drawCircuit instead.
}

/**
 * Where the walk starts, which is a property of the block rather than a choice.
 *
 * Backward reads "what makes each value", so it starts at what the block hands
 * to the rest of the chip and works inward. Forward reads "what each value
 * changes", so it starts at what the block is handed. Either way the seeds are
 * measured, not picked, and a block that has neither falls back to all of its
 * members so the drawing cannot come out empty.
 */
const seeds = () => state.view.seeds(state.ports, state.dir);

/**
 * Switch one port pill on or off, and reconcile the overlap.
 *
 * `state.lit` is per pill; `state.litNodes` is the union of the wires those
 * pills stand for, and the union is what the drawing reads. Those are two
 * different things whenever one wire crosses the boundary more than one way,
 * which is common: a bus can be joined by a pass transistor *and* read by a
 * gate outside, so it has a pill under two headings.
 *
 * Keeping them separate is what lets the page be honest about that. Nothing
 * flips a pill the reader did not click, and a pill whose wires are already on
 * screen because of a different heading is marked `shown` rather than left
 * looking as though it did nothing. Switching that pill off then does not
 * remove the wires either, because the other pill is still asking for them --
 * which is exactly what `shown` is warning about.
 */
function togglePort(pk) {
  if (state.lit.has(pk)) state.lit.delete(pk); else state.lit.add(pk);
  state.litNodes = new Set();
  for (const k of state.lit) {
    for (const n of state.portOf.get(k) || []) state.litNodes.add(n);
  }
  drawCircuit();
}

/**
 * Repaint the pills. The markup is built once; only the state moves.
 *
 * Called from `drawCircuit`, and it has to be, because `shown` is a fact about
 * what ended up on screen rather than about what was asked for. It is read from
 * the drawing's own placement.
 */
function paintPorts() {
  let on = 0;
  for (const b of document.querySelectorAll('.bk-port')) {
    const pk = b.dataset.port;
    const lit = state.lit.has(pk);
    // Already on screen, for ANY reason. Two get here: another heading's pill
    // asked for the same wire, and a static-logic gate this block is credited
    // with driving, which `ports()` lists on the boundary but the drawing has
    // always treated as part of the block and drawn. Both cases are a switch
    // that would visibly do nothing, and marking them is better than letting a
    // reader press one and watch the picture sit still.
    //
    // Only meaningful for a pill that is itself off, and only when EVERY wire
    // it stands for is on screen: a partly drawn bus is not "already shown",
    // and saying so would be a lie about the half that is missing.
    const nodes = state.portOf.get(pk) || [];
    const covered = !lit && nodes.length > 0 && nodes.every((n) => state.drawn.has(n));
    b.classList.toggle('on', lit);
    b.classList.toggle('shown', covered);
    b.setAttribute('aria-pressed', String(lit));
    if (lit) on += 1;
  }
  $('bk-ports-note').textContent = on
    ? `${on} port${on === 1 ? '' : 's'} switched on and drawn with the block. `
      + 'A signal can appear under more than one heading, so a pill marked '
      + '"shown" is already on screen through another one.'
    : 'The block is drawn on its own. Switch a port on to bring that wire into '
      + 'the circuit below. A signal can appear under more than one heading: '
      + 'being joined to a wire and being read by a gate are different relations.';
}

function drawCircuit() {
  const svg = $('bk-svg');
  svg.replaceChildren();
  if (!state.ports) return;

  const c = blockCone(seeds(), state.dir);
  const L = draw.layout(c);
  svg.setAttribute('viewBox', `0 0 ${L.width} ${L.height}`);
  svg.setAttribute('width', L.width);
  svg.setAttribute('height', L.height);

  const g = el('g', { class: 'sch-graph' }, svg);
  draw.drawGraph(g, c, L, {
    pick: (n) => { if (expandable(n)) setRoot(n); },
    // Three kinds of pill, three strengths of claim. A member is measured to be
    // here; an attributed gate is only affiliated; a port belongs to a
    // neighbour and is where the block ends. Saying so under the pill is the
    // difference between "the block ends here" and "the drawing does".
    markOf: (n) => {
      if (inside(n)) return null;
      if (affiliated(n)) return { cls: 'logic', label: 'static logic, drives this block' };
      return { cls: 'port',
               label: state.data.blockNames[state.data.nodeBlock[n] & 0x7f] };
    },
  });

  const drawn = [...L.place.keys()];
  // What actually got placed, which is what `shown` on a pill is a claim about.
  state.drawn = new Set(drawn);
  const members = drawn.filter(inside).length;
  const logic = drawn.filter(affiliated).length;
  const outside = drawn.length - members - logic;
  $('bk-circuit-note').textContent =
    `${members} signals in the block, ${logic} attributed static gates, `
    + `${c.elements.length} elements, ${outside} ports where it ends`
    + (c.truncated ? ` · ${c.truncated} further connections not drawn` : '')
    + `. Walking ${state.dir === 'back' ? 'backward: what makes each value'
                                        : 'forward: what each value changes'}.`;

  // Last, because a pill's `shown` marking is read off the placement above.
  paintPorts();
  // The workbench link carries the switched-on ports, so it has to be rebuilt
  // whenever they change rather than only when the block does.
  paintRoot();
  // A rebuilt drawing arrives already lit, not waiting for the next frame.
  paint();
}

/**
 * Colour the drawing from the running chip: a signal that is high right now is
 * lit, a switch whose control is high is drawn open. The same rule, the same
 * classes and the same stylesheet as the workbench, because the drawing comes
 * from the same sch-draw.js and two pages lighting the same circuit two ways
 * would leave a reader no way to tell which was lying.
 *
 * Called from the frame loop while running, and directly after any discrete
 * step: a step that waits for the next animation frame is a real
 * responsiveness bug, and it is invisible until the page is driven somewhere
 * frames are throttled, which is what an iframe does.
 */
function paint() {
  if (state.id == null || !state.machine) return;
  const levels = state.machine.nodeLevels();
  const svg = $('bk-svg');
  for (const g of svg.querySelectorAll('.sch-node')) {
    g.classList.toggle('hot', levels[Number(g.dataset.node)] > 0);
  }
  for (const g of svg.querySelectorAll('.sch-switch')) {
    g.classList.toggle('open', levels[Number(g.dataset.control)] > 0);
  }
}

function tick(now = 0) {
  const n = halfCyclesFor(now);
  for (let i = 0; i < n; i++) state.machine.halfStep();
  if (n) paint();
  requestAnimationFrame(tick);
}

function setRoot(node) {
  if (!inside(node)) return;
  state.root = node;
  const sel = $('bk-signal');
  if (sel.value !== String(node)) sel.value = String(node);
  paintRoot();
  drawCircuit();
}

/**
 * The subject, and the link that takes the whole block to the workbench.
 *
 * The link used to say `?find=`, which `schematic.js` has never read -- it
 * takes `?signal=`. So the button had always landed on the schematic page
 * without selecting anything, and looked like it did nothing because it very
 * nearly did. It now carries three things: the signal, the block, and which
 * ports are switched on, so the bench opens showing exactly what was on screen
 * here.
 */
function paintRoot() {
  $('bk-root-name').textContent = nameOf(state.root);
  const q = new URLSearchParams({
    signal: nameOf(state.root),
    block: SLUGS[state.meta.blocks[state.id].name],
    solo: '1',
  });
  // Only when there are some: an empty `ports=` is noise in a URL somebody may
  // well paste somewhere.
  if (state.lit.size) q.set('ports', [...state.lit].join(','));
  $('bk-root-link').href = `schematic?${q}`;
}

// ---------------------------------------------------------------------------
// The labs
// ---------------------------------------------------------------------------
//
// A lab is a short program, an instruction inside it to follow, and a handful
// of half-cycle offsets from that instruction's own opcode fetch. The offsets
// are offsets, never absolute half-cycle numbers: reset timing moving would
// shift every one of them by the same amount and the page would go on looking
// exactly as convincing.

const hex2 = (v) => v.toString(16).padStart(2, '0').toUpperCase();

/** A named bus read back a bit at a time, or null if the die has no such name. */
function readBus(m, stem) {
  const one = m.nodeId(stem);
  if (one >= 0) return { width: 1, value: m.isNodeHigh(one) ? 1 : 0 };
  let v = 0, bits = 0;
  for (let i = 0; i < 8; i++) {
    const id = m.nodeId(`${stem}${i}`);
    if (id < 0) continue;
    bits++;
    if (m.isNodeHigh(id)) v |= 1 << i;
  }
  return bits ? { width: bits, value: v } : null;
}

function runLab(lab) {
  const img = assemble(lab.source);
  const at = img.labels.get(lab.from);
  if (at == null) throw new Error(`lab ${lab.id}: no label "${lab.from}"`);

  const m = new Machine();
  m.load(img.org, new Uint8Array(img.bytes));
  m.setResetVector(img.org);
  m.powerCycle();

  // Run until the chip fetches the instruction we are following. Bounded, so a
  // lab that can never reach its own instruction fails loudly rather than
  // hanging the page.
  let guard = 0;
  while (!(m.sync() && m.lastFetchAddr() === at)) {
    if (guard++ > 20000) throw new Error(`lab ${lab.id}: never fetched $${at.toString(16)}`);
    m.halfStep();
  }

  const rows = [];
  let k = 0;
  for (const step of lab.steps) {
    while (k < step.at) { m.halfStep(); k++; }
    const buses = {};
    for (const w of lab.watch) buses[w] = readBus(m, w);
    const checks = (lab.checks || []).filter((c) => c.at === step.at).map((c) => {
      const plain = {};
      for (const [key, b] of Object.entries(buses)) plain[key] = b ? b.value : null;
      return { claim: c.claim, held: c.fn(plain) === true };
    });
    rows.push({
      at: step.at, note: step.note, buses, checks,
      phase: m.clk0() ? 'φ1' : 'φ2',
      sync: m.sync(),
      t: m.timingStates(),
      a: m.a(), ir: m.ir(),
    });
  }
  return rows;
}

function renderLabs(notes) {
  const host = $('bk-labs');
  const section = $('bk-labs-section');
  host.replaceChildren();
  const labs = (notes && notes.labs) || [];
  section.hidden = labs.length === 0;
  if (!labs.length) return;

  for (const lab of labs) {
    const box = text('article', 'bk-lab', null, host);
    text('h3', null, lab.title, box);
    html('p', 'bk-lab-blurb', lab.blurb, box);

    const pre = text('pre', 'bk-lab-src mono', lab.source, box);
    pre.setAttribute('aria-label', 'The program this lab runs');

    let rows;
    try {
      rows = runLab(lab);
    } catch (e) {
      // A lab that cannot run says so where it would have been. The rest of the
      // page is measurements and stands without it.
      text('p', 'bk-lab-failed', `This lab did not run: ${e.message}`, box);
      continue;
    }

    const table = text('div', 'bk-lab-rows', null, box);
    for (const r of rows) {
      const row = text('div', 'bk-lab-row', null, table);
      const head = text('div', 'bk-lab-when mono', null, row);
      text('b', null, `+${r.at}`, head);
      text('span', null, ` ${r.phase}${r.sync ? ' sync' : ''} · ${r.t}`, head);
      html('p', 'bk-lab-note', r.note, row);
      const strip = text('div', 'bk-lab-buses', null, row);
      for (const [name, b] of Object.entries(r.buses)) {
        const cell = text('span', 'bk-bus mono', null, strip);
        text('i', null, name, cell);
        text('b', null, b == null ? '??' : b.width === 1 ? String(b.value) : `$${hex2(b.value)}`, cell);
      }
      text('span', 'bk-bus mono bk-bus-reg', null, strip).append(
        Object.assign(document.createElement('i'), { textContent: 'A' }),
        Object.assign(document.createElement('b'), { textContent: `$${hex2(r.a)}` }));
      for (const c of r.checks) {
        const ck = text('p', `bk-check ${c.held ? 'held' : 'broke'}`, null, row);
        text('span', 'bk-check-mark', c.held ? '✓' : '✗', ck);
        text('span', null, `${c.claim}: ${c.held ? 'held on this run'
          : 'did not hold, which is a page error'}`, ck);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The directory, and the page
// ---------------------------------------------------------------------------

function renderDirectory() {
  $('bk-block').hidden = true;
  const host = $('bk-directory');
  host.hidden = false;
  host.replaceChildren();

  const cov = state.meta.coverage;
  $('bk-title').textContent = 'Functional blocks';
  $('bk-lede').innerHTML =
    'The die pulled apart into the parts that do something, and each part opened '
    + 'up. The boundaries are not a floorplan: nobody has MOS\'s original, and '
    + 'these are inferred from the names on the die and the way the wiring runs.';
  document.title = 'Functional blocks of the MOS 6502';

  const grid = text('div', 'bk-grid', null, host);
  for (const b of state.meta.blocks) {
    if (!SLUGS[b.name]) continue;
    const card = text('a', 'bk-card', null, grid);
    card.href = `block?b=${SLUGS[b.name]}`;
    const bar = text('i', 'bk-card-bar', '', card);
    bar.style.background = blockCss(b.id);
    text('h3', null, b.name, card);
    text('p', 'bk-card-blurb', b.blurb, card);
    const stats = text('p', 'bk-card-stats mono', null, card);
    text('span', null, `${b.transistors} transistors`, stats);
    text('span', null, `${b.nodes} signals`, stats);
    text('span', null, `${Math.round((b.seeded / b.nodes) * 100)}% named`, stats);
  }

  text('p', 'bk-coverage', `${cov.transistorsPlaced} of ${cov.transistors} transistors `
    + `are placed, ${cov.nodesPlaced} of ${cov.nodes} signals. What is not in a `
    + `functional block is the static logic those blocks are embedded in, and two `
    + `transistors that cannot affect the chip at all.`, host);
}

function renderBlock() {
  $('bk-directory').hidden = true;
  $('bk-block').hidden = false;

  const b = state.meta.blocks[state.id];
  const notes = NOTES[SLUGS[b.name]] || null;

  document.title = `${b.name}: a functional block of the MOS 6502`;
  $('bk-title').textContent = b.name;
  $('bk-lede').innerHTML = notes && notes.lede ? notes.lede : b.blurb;

  // What this block does, above its measured interface. Authored, from
  // block-notes.js, and hidden rather than left empty if a block has none: an
  // empty paragraph reads as a stylesheet that failed to load, and the derived
  // half below it stands up on its own regardless. Same rule the sections and
  // labs already follow.
  const does = $('bk-does');
  const said = DOES[SLUGS[b.name]];
  does.innerHTML = said || '';
  does.hidden = !said;
  $('bk-eyebrow').textContent = `Functional block · ${b.half}`;

  const dot = $('bk-hero-dot');
  dot.style.background = blockCss(b.id);

  // The measured header. Every figure comes out of blocks.rs, and the share of
  // named signals is the one that matters most: it is how strong the claim that
  // this *is* a block happens to be. The decode PLA is 95% named; the status
  // register is 40%, and a reader deserves to know which they are looking at.
  const stats = $('bk-stats');
  stats.replaceChildren();
  const stat = (k, v) => {
    const s = text('div', 'bk-stat', null, stats);
    text('b', 'mono', v, s);
    text('span', null, k, s);
  };
  stat('transistors', String(b.transistors));
  stat('signals', String(b.nodes));
  stat('named on the die', `${b.seeded} of ${b.nodes}`);
  stat('die centre', `${Math.round(b.die[0])}, ${Math.round(b.die[1])}`);
  // `bounds` is (xmin, xmax, ymin, ymax), not (x0, y0, x1, y1). Read the wrong
  // way round it gives a negative width on most blocks and a plausible one on
  // the rest, which is worse -- the ALU came out as -1402 x 759 and only the
  // minus sign said so. The order is fixed in blocks.rs, where the fold is
  // seeded (MAX, 0, MAX, 0).
  stat('extent', `${b.bounds[1] - b.bounds[0]} × ${b.bounds[3] - b.bounds[2]}`);

  // The signal picker: every named signal in the block, and nothing else.
  const sel = $('bk-signal');
  sel.replaceChildren();
  const namedInside = [...state.inside]
    .filter((n) => state.data.names[n])
    .sort((a, c) => nameOf(a).localeCompare(nameOf(c), undefined, { numeric: true }));
  for (const n of namedInside) {
    const o = document.createElement('option');
    o.value = String(n);
    o.textContent = nameOf(n);
    sel.append(o);
  }

  // Where to start. The authored note if there is one, otherwise the named
  // signal with the most connections *inside this block*.
  //
  // Global fan-out was tried first and is the wrong measure: it picked signals
  // whose connections nearly all leave, so the drawing opened one step deep with
  // a wall of ports, and the timing chain arrived showing a single signal. What
  // makes a good place to stand is how much of the block you can see from it,
  // which is a count of the elements filed here that touch it.
  const wanted = notes && notes.start ? state.machine.nodeId(notes.start) : -1;
  if (wanted >= 0 && inside(wanted)) {
    state.root = wanted;
  } else {
    const reach = new Map(namedInside.map((n) => [n, 0]));
    const bump = (n) => { if (reach.has(n)) reach.set(n, reach.get(n) + 1); };
    for (const g of state.gateOf.values()) {
      if (!expandable(g.out)) continue;
      bump(g.out);
      for (const lit of new Set(g.terms.flat())) bump(lit);
    }
    for (const list of state.switchesBy.values()) {
      for (const w of list) {
        if (!expandable(w.a) && !expandable(w.b)) continue;
        bump(w.a); bump(w.b);
      }
    }
    state.root = namedInside.reduce((best, n) =>
      (reach.get(n) > reach.get(best) ? n : best), namedInside[0]);
  }
  sel.value = String(state.root);

  // Ports are switched off on arrival, and the set is cleared per block: a pill
  // key is only meaningful against the block that built it, so carrying one
  // across would light a wire on a page that has never heard of it.
  state.lit.clear();
  state.litNodes = new Set();

  renderPorts();
  paintRoot();
  drawCircuit();

  // The reading. Absent for a block nobody has written up yet, and the section
  // is then not rendered at all -- a heading over an apology is worse than no
  // heading, and the derived half above stands on its own.
  const prose = $('bk-prose');
  const proseSection = $('bk-prose-section');
  prose.replaceChildren();
  const sections = (notes && notes.sections) || [];
  proseSection.hidden = sections.length === 0;
  for (const s of sections) {
    const art = text('article', 'bk-note', null, prose);
    text('h3', null, s.title, art);
    html('p', null, s.body, art);
  }

  renderLabs(notes);

  // Where else this block is drawn. Three pages show the same silicon three
  // ways, and from inside one block the other two are the obvious next stop.
  const seeAlso = $('bk-seealso');
  seeAlso.replaceChildren();
  const link = (href, label, why) => {
    const a = text('a', 'bk-seealso-link', null, seeAlso);
    a.href = href;
    text('b', null, label, a);
    text('span', null, why, a);
  };
  link('exploded', 'Exploded', 'this block in its place on the die');
  link(`schematic?find=${encodeURIComponent(nameOf(state.root))}`, 'Schematic',
       'walk this signal without stopping at the boundary');
  if (b.half === 'datapath') link('blueprint', 'Blueprint', 'the datapath as one diagram');

  // Previous and next, in the order the exploded view lists them.
  const ids = state.meta.blocks.filter((x) => SLUGS[x.name]).map((x) => x.id);
  const i = ids.indexOf(state.id);
  const nav = $('bk-blocknav');
  nav.replaceChildren();
  const step = (target, label) => {
    if (target == null) return;
    const t = state.meta.blocks[target];
    const a = text('a', 'bk-step', null, nav);
    a.href = `block?b=${SLUGS[t.name]}`;
    text('span', 'bk-step-dir', label, a);
    text('b', null, t.name, a);
  };
  step(i > 0 ? ids[i - 1] : null, 'Previous');
  const all = text('a', 'bk-step bk-step-all', null, nav);
  all.href = 'block';
  text('b', null, 'All twelve blocks', all);
  step(i < ids.length - 1 ? ids[i + 1] : null, 'Next');
}

// ---------------------------------------------------------------------------

function setupControls() {
  $('bk-signal').addEventListener('change', (e) => setRoot(Number(e.target.value)));
  $('bk-depth').addEventListener('input', (e) => {
    state.depth = Number(e.target.value);
    $('bk-depth-val').textContent = String(state.depth);
    drawCircuit();
  });
  for (const btn of document.querySelectorAll('[data-dir]')) {
    btn.addEventListener('click', () => {
      state.dir = btn.dataset.dir;
      for (const b of document.querySelectorAll('[data-dir]')) {
        b.classList.toggle('on', b.dataset.dir === state.dir);
      }
      drawCircuit();
    });
  }
}

async function boot() {
  const status = $('bk-status');
  try {
    const [, data, meta] = await Promise.all([
      init(),
      fetch('schematic.json').then((r) => {
        if (!r.ok) throw new Error(`schematic.json: HTTP ${r.status}`);
        return r.json();
      }),
      fetch('blocks.json').then((r) => {
        if (!r.ok) throw new Error(`blocks.json: HTTP ${r.status}`);
        return r.json();
      }),
    ]);
    state.data = data;
    state.meta = meta;
    draw = createDraw(data);

    // Two published files, both indexed by node number, and the standing
    // objection to that is real: three files indexed by node is three chances
    // for the numbering to disagree. So they are not trusted, they are checked.
    //
    // Block ids are checked by name, and the node arrays element by element --
    // 1725 comparisons, once, at boot. blocks.json carries `was_seeded` in bit 7
    // and schematic.json does not, so the masked values are what must agree.
    // With that check in place the coupling is verified rather than assumed,
    // which is a stronger position than avoiding the second file would have
    // been: `nodeDrives` lives only in blocks.json and the drawing needs it.
    for (const b of meta.blocks) {
      if (data.blockNames[b.id] !== b.name) {
        throw new Error(`blocks.json and schematic.json disagree about block ${b.id}: `
          + `"${b.name}" vs "${data.blockNames[b.id]}"`);
      }
    }
    if (meta.nodeBlock.length !== data.nodeBlock.length) {
      throw new Error('blocks.json and schematic.json cover different numbers of nodes');
    }
    for (let n = 0; n < data.nodeBlock.length; n++) {
      if ((meta.nodeBlock[n] & 0x7f) !== (data.nodeBlock[n] & 0x7f)) {
        throw new Error(`blocks.json and schematic.json disagree about node ${n}`);
      }
    }
    const missing = meta.blocks
      .filter((b) => b.half !== 'unknown' && b.half !== 'logic' && !SLUGS[b.name]);
    if (missing.length) {
      throw new Error(`block-notes.js has no slug for: ${missing.map((b) => b.name).join(', ')}`);
    }

    for (const [out, kind, precharge, terms] of data.gates) {
      state.gateOf.set(out, { out, kind: data.kinds[kind], precharge, terms });
    }
    for (const [control, a, b] of data.switches) {
      for (const n of [a, b]) {
        if (n === data.vss || n === data.vcc) continue;
        if (!state.switchesOn.has(n)) state.switchesOn.set(n, []);
        state.switchesOn.get(n).push({ control, a, b });
      }
      if (!state.switchesBy.has(control)) state.switchesBy.set(control, []);
      state.switchesBy.get(control).push({ control, a, b });
    }
    for (const g of state.gateOf.values()) {
      for (const lit of new Set(g.terms.flat())) {
        if (!state.gatesUsing.has(lit)) state.gatesUsing.set(lit, []);
        state.gatesUsing.get(lit).push(g);
      }
    }

    // One machine, used only to resolve names to node numbers and to run the
    // labs. Each lab builds its own, because a lab is a program of its own and
    // sharing a chip between them would make the second one depend on the first.
    state.machine = new Machine();

    const slug = new URLSearchParams(location.search).get('b');
    if (slug) {
      const found = meta.blocks.find((b) => SLUGS[b.name] === slug);
      if (!found) throw new Error(`no functional block called "${slug}"`);
      state.id = found.id;
      state.inside = new Set();
      state.affiliated = new Set();
      // Which block id the static logic is, asked by name rather than assumed
      // to be 13: an id hardcoded here would silently point at whatever ends up
      // in that slot the day a block is added.
      const logicId = data.blockNames.indexOf('Static logic');
      for (let n = 0; n < data.nodeBlock.length; n++) {
        if (n === data.vss || n === data.vcc) continue;
        const b = data.nodeBlock[n] & 0x7f;
        if (b === found.id) state.inside.add(n);
        else if (b === logicId && meta.nodeDrives[n] === found.id) state.affiliated.add(n);
      }
      // The boundary and the circuit, from the module the workbench shares. It
      // is built once per block because membership is what it closes over.
      state.view = createBlockView({
        data,
        inside: state.inside,
        affiliated: state.affiliated,
        gateOf: state.gateOf,
        gatesUsing: state.gatesUsing,
        switchesOn: state.switchesOn,
        switchesBy: state.switchesBy,
        nameOf,
      });
    }

    // A block page runs the chosen program on its one machine, so the circuit
    // below is the chip working rather than a diagram of it. The reset vector
    // is set because two pages of this site once ran a BRK loop against
    // themselves for want of it. The directory draws no circuit, so it keeps
    // the picker that only records the choice and leaves the transport slot
    // empty, the way the measurement pages do.
    if (state.id != null) {
      const m = state.machine;
      const loadProgram = (i) => {
        state.program = i;
        m.load(LOAD_ADDR, new Uint8Array(PROGRAMS[i].bytes));
        m.setResetVector(LOAD_ADDR);
        m.powerCycle();
      };
      loadProgram(selectedProgram(location.search));
      adopt(m, selectedProgram(location.search));
      setupProgramNav({
        onChange: (i) => { setSelectedProgram(i); loadProgram(i); paint(); },
      });
      setupChipNav(chipDriver(m, { reset: () => m.powerCycle(), after: paint }));
      requestAnimationFrame(tick);
    } else {
      setupProgramNav();
    }

    setupControls();
    if (state.id == null) renderDirectory(); else renderBlock();

    $('bk-boot').hidden = true;
    $('bk-main').hidden = false;
  } catch (e) {
    status.textContent = `Could not build the page: ${e.message}`;
    status.classList.add('bk-error');
  }
}

boot();
