// Halfshot: the chosen program on the chip, one photograph per half-cycle.
//
// Every other page that runs the chip shows it *now*. This one records: it
// steps the machine one half-cycle at a time and keeps the level of every node
// at every step, then lets you walk the frames back and forth like a gallery.
// Two things are drawn for each frame, and they are different kinds of picture:
//
//   * the PLATE, which never moves. The datapath from blueprint.json (the same
//     layout the Blueprint page draws, from blueprint-draw.js), the registers,
//     the pins and the memory the program has touched -- everything a block
//     diagram puts a name on, in a fixed place, showing what it holds in this
//     frame;
//   * the ISLAND, which is what happened between the previous frame and this
//     one: the pass transistors whose control line changed, drawn in the
//     schematic's own symbols by sch-draw.js, with the wires either side lit by
//     their level; and under it the memory access, the decode terms that
//     arrived, and the registers whose stored value moved.
//
// Nothing here consults an instruction table and nothing is animated by hand.
// A register's value in a frame is whatever its eight storage nodes held at
// that edge, read out of the same node-level array the die view colours. The
// whole recording is exportable through halfshot-codec.js, losslessly.

import init, { Machine } from './pkg/v6502_wasm.js';
import { PROGRAMS, LOAD_ADDR, selectedProgram, setSelectedProgram } from './programs.js';
import { setupProgramNav } from './program-nav.js';
import { setupChipNav } from './chip-nav.js';
import { isRunning, setRunning, toggleRunning, subscribe, halfCyclesFor } from './chip-controls.js';
import { layOut, draw, placeLabels, unitValue, label } from './blueprint-draw.js';
import { createDraw } from './sch-draw.js';
import { disassemble } from './disasm.js';
import { lamps, hex2, hex4 } from './demos.js';
import { encode } from './halfshot-codec.js';

const $ = (id) => document.getElementById(id);

// How much is recorded at once, and how much at most. A program here loops
// forever, so a recording has to stop somewhere; it grows by a batch whenever
// you step past its end, up to the cap, and the caption says both numbers.
export const BATCH = 256;
export const MAX_FRAMES = 4096;

// The pins the plate reports beside the two buses. Names as the die has them.
const PINS = ['rw', 'sync', 'rdy', 'irq', 'nmi', 'res', 'so'];

const state = {
  m: null,
  bp: null,          // blueprint.json: units, links
  sch: null,         // schematic.json: names, blocks, rails
  dec: null,         // decode.json: the PLA rows, for which terms are high
  layout: null,      // the plate's positions, from blueprint-draw
  drawer: null,      // sch-draw, for the island
  program: 0,
  frames: [],
  cur: 0,
  segs: [],          // [{ start, end, label, fetch }] one per instruction, plus reset
  mem0: null,        // memory before the first frame
  pinNode: {},
  termNodes: [],
  running: false,
  lastFrame: 0,
  nav: null,
};

const nameOf = (n) => state.sch.names[n] ?? `#${n}`;

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

function loadProgram(index) {
  const m = state.m;
  const prog = PROGRAMS[index] || PROGRAMS[0];
  state.program = PROGRAMS[index] ? index : 0;
  m.powerCycle();
  m.load(LOAD_ADDR, new Uint8Array(prog.bytes));
  m.setResetVector(LOAD_ADDR);
  m.powerCycle();
  state.mem0 = new Uint8Array(m.memorySlice(0, 65536));
  state.frames = [];
  state.segs = [];
  state.cur = 0;
  record(BATCH);
}

/**
 * One frame: everything the plate and the island need, read out of the chip
 * at this instant. `levels` is the whole chip; the rest is derived from it and
 * from the bus, and is kept so a frame can be drawn without a machine.
 */
function sample(prev) {
  const m = state.m;
  const levels = m.nodeLevels();
  const clk0 = m.clk0();
  const read = m.isRead();
  const pins = {};
  for (const p of PINS) pins[p] = levels[state.pinNode[p]] > 0 ? 1 : 0;
  const f = {
    h: m.halfCycle(), ph: m.phase(), clk0, sync: m.sync(),
    t: m.timingStates() || 'none',
    ab: m.addressBus(), db: m.dataBus(), rw: read ? 'R' : 'W',
    pc: m.pc(), a: m.a(), x: m.x(), y: m.y(), s: m.s(), p: m.p(), ir: m.ir(),
    flags: m.flagsString(),
    fetch: m.lastFetchAddr(), op: m.lastFetchOpcode(),
    pins,
    units: state.bp.units.map((u) => unitValue(levels, u)),
    open: state.bp.links.map((l) => levels[l.controlNode] > 0),
    terms: [],
    // The bus is serviced on the edge: a read as clk0 falls, a write as it
    // rises (cpu.rs). So a frame taken after the falling edge with R/W high
    // is one in which memory was read, and one after the rising edge with R/W
    // low is one in which it was written. Frame 0 is the power-on state and
    // had no edge of its own.
    access: !prev ? null
      : !clk0 && read ? { kind: 'R', addr: m.addressBus(), val: m.dataBus() }
      : clk0 && !read ? { kind: 'W', addr: m.addressBus(), val: m.dataBus() }
      : null,
    levels,
  };
  state.termNodes.forEach((n, i) => { if (levels[n]) f.terms.push(i); });
  return f;
}

/** Extend the recording by `n` half-cycles (or start it). */
function record(n) {
  const m = state.m;
  const frames = state.frames;
  if (!frames.length) frames.push(sample(null));
  const stop = Math.min(MAX_FRAMES, frames.length + n);
  while (frames.length < stop) {
    m.halfStep();
    frames.push(sample(frames[frames.length - 1]));
  }
  segment();
}

/**
 * Cut the frames into instructions. An instruction begins on the frame in
 * which its opcode was read: sync high, clk0 low, which is the falling edge
 * whose read latched the fetch (the same condition stepInstruction uses).
 * Whatever comes before the first is the reset sequence.
 */
function segment() {
  const { frames } = state;
  const segs = [];
  let open = { start: 0, label: 'reset', fetch: -1, op: null };
  const memEnd = memAt(frames.length - 1);
  const read = (a) => memEnd[a];
  for (let k = 0; k < frames.length; k++) {
    const f = frames[k];
    if (f.sync && !f.clk0 && f.fetch >= 0 && (k === 0 || !(frames[k - 1].sync && !frames[k - 1].clk0))) {
      if (k > 0) { open.end = k - 1; segs.push(open); }
      // The operand bytes as they are at the END of the recording. A program
      // that rewrote its own operands would mislabel here; none of these do,
      // and the byte the chip fetched is the one shown beside the label.
      const d = disassemble(f.op, f.fetch, read);
      open = { start: k, label: d.text, fetch: f.fetch, op: f.op, len: d.length };
    }
  }
  open.end = frames.length - 1;
  segs.push(open);
  state.segs = segs;
}

/**
 * Memory as it stood at frame k: the initial image plus every write so far.
 *
 * Cached from the last frame asked about, so stepping forward applies only the
 * writes in between rather than copying 64 KiB per frame; going back or
 * changing program starts again from the image. Callers get a view they must
 * not keep, which is why the harness compares rather than holds it.
 */
const memCache = { k: -1, mem: null, mem0: null };
function memAt(k) {
  let from = 1;
  if (memCache.mem0 === state.mem0 && memCache.k >= 0 && memCache.k <= k) from = memCache.k + 1;
  else { memCache.mem = new Uint8Array(state.mem0); memCache.mem0 = state.mem0; }
  const mem = memCache.mem;
  for (let i = from; i <= k; i++) {
    const a = state.frames[i].access;
    if (a && a.kind === 'W') mem[a.addr] = a.val;
  }
  memCache.k = k;
  return mem;
}

const segOf = (k) => state.segs.find((s) => k >= s.start && k <= s.end);

// ---------------------------------------------------------------------------
// The plate
// ---------------------------------------------------------------------------

function paintPlate(f, prev) {
  const svg = $('hs-svg');
  const bp = state.bp;
  bp.units.forEach((u, i) => {
    const t = svg.querySelector(`[data-value="${u.name}"]`);
    if (!t) return;
    const { value, mask } = f.units[i];
    t.textContent = mask === 0xff ? '$' + hex2(value) : '$' + hex2(value) + '*';
    const g = t.closest('[data-unit]');
    const was = prev ? prev.units[i].value : value;
    if (g) g.classList.toggle('moved', was !== value);
  });
  bp.links.forEach((l, i) => {
    const g = svg.querySelector(`[data-control="${CSS.escape(l.control)}"]`);
    if (!g) return;
    g.classList.toggle('open', f.open[i]);
    g.classList.toggle('toggled', !!prev && prev.open[i] !== f.open[i]);
  });
  svg.classList.toggle('phase-high', f.clk0);
}

function paintPins(f, prev) {
  const was = (k) => (prev ? prev[k] : f[k]);
  const pinRow = PINS.map((p) => {
    const moved = prev && prev.pins[p] !== f.pins[p];
    return `<span class="hs-pin${f.pins[p] ? ' hi' : ''}${moved ? ' moved' : ''}" title="${p}: ${f.pins[p]}">`
      + `<b>${p.toUpperCase()}</b><i>${f.pins[p]}</i></span>`;
  }).join('');
  $('hs-pins').innerHTML =
    `<div class="hs-bus${was('ab') !== f.ab ? ' moved' : ''}"><b>AB</b>${lamps(f.ab, 16)}<span class="hs-hex">$${hex4(f.ab)}</span></div>`
    + `<div class="hs-bus${was('db') !== f.db ? ' moved' : ''}"><b>DB</b>${lamps(f.db, 8)}<span class="hs-hex">$${hex2(f.db)}</span></div>`
    + `<div class="hs-pinrow"><span class="hs-pin${f.clk0 ? ' hi' : ''}" title="clk0, the clock pin"><b>φ0</b><i>${f.clk0 ? 1 : 0}</i></span>${pinRow}</div>`;
}

const REGS = [
  ['A', (r) => hex2(r.a)], ['X', (r) => hex2(r.x)], ['Y', (r) => hex2(r.y)],
  ['S', (r) => hex2(r.s)], ['PC', (r) => hex4(r.pc)], ['P', (r) => r.flags],
  ['IR', (r) => hex2(r.ir)],
];

function paintRegs(f, prev) {
  $('hs-regs').innerHTML = REGS.map(([k, get]) => {
    const now = get(f);
    const was = prev ? get(prev) : now;
    const moved = now !== was;
    return `<div class="tr-reg${moved ? ' moved' : ''}"><span class="tr-reg-k">${k}</span>`
      + `<span class="tr-reg-v">${now}</span>${moved ? `<span class="tr-reg-was">was ${was}</span>` : ''}</div>`;
  }).join('');
}

function paintMem(k, f) {
  const mem = memAt(k);
  const a = f.access;
  // A window of memory around the last thing the bus touched, so the byte
  // being read or written sits in view. At an edge with no access of its own
  // the window stays where the previous access left it, marked as such,
  // rather than jumping back to the program.
  let last = null;
  for (let i = k; i >= 1 && !last; i--) last = state.frames[i].access;
  const focus = a ? a.addr : last ? last.addr : LOAD_ADDR;
  const base = Math.max(0, (focus & 0xfff0) - 16);
  const rows = [];
  for (let r = 0; r < 3; r++) {
    const start = (base + r * 16) & 0xffff;
    const cells = [];
    for (let i = 0; i < 16; i++) {
      const addr = (start + i) & 0xffff;
      const hit = a && a.addr === addr ? ` hit ${a.kind === 'W' ? 'wr' : 'rd'}`
        : !a && last && last.addr === addr ? ' last' : '';
      cells.push(`<i class="${hit}" title="$${hex4(addr)}">${hex2(mem[addr])}</i>`);
    }
    rows.push(`<div class="hs-memrow"><b>$${hex4(start)}</b>${cells.join('')}</div>`);
  }
  const writes = new Map();
  for (let i = 1; i <= k; i++) {
    const w = state.frames[i].access;
    if (w && w.kind === 'W') writes.set(w.addr, w.val);
  }
  const written = [...writes.entries()].sort((p, q) => p[0] - q[0])
    .map(([addr, v]) => `<span class="hs-w mono">$${hex4(addr)}=${hex2(v)}</span>`).join(' ');
  $('hs-mem').innerHTML =
    `<div class="hs-memhead"><b>Memory</b> `
    + (a ? `<span class="hs-access ${a.kind === 'W' ? 'wr' : 'rd'}">${a.kind === 'W' ? 'write' : 'read'} `
           + `$${hex4(a.addr)} ${a.kind === 'W' ? '←' : '→'} $${hex2(a.val)}</span>`
         : last ? `<span class="muted">no access at this edge; last was `
                  + `${last.kind === 'W' ? 'a write to' : 'a read of'} $${hex4(last.addr)}</span>`
         : '<span class="muted">no access yet</span>')
    + '</div>'
    + rows.join('')
    + `<div class="hs-written"><b>Written so far</b> ${written || '<span class="muted">nothing yet</span>'}</div>`;
}

// ---------------------------------------------------------------------------
// The island
// ---------------------------------------------------------------------------

/** The lowest bit a link carries on which both units have a node. */
function repBit(l) {
  const ua = state.bp.units[l.a];
  const ub = state.bp.units[l.b];
  for (let b = 0; b < 8; b++) {
    if (!((l.bits >> b) & 1)) continue;
    if (ua.bits[b] != null && ub.bits[b] != null) return b;
  }
  return -1;
}

/**
 * The transition as a cone sch-draw can lay out: every datapath switch whose
 * control line changed between the previous frame and this one, on one bit.
 *
 * Two columns and nothing deeper. A pass transistor has no direction, so
 * whichever end is placed first goes to the anchored column and the other end
 * to the column beside it; a wire already on the island keeps its column, and
 * a switch reaching it from the other side joins to it where it is.
 */
function islandCone(k) {
  const f = state.frames[k];
  const prev = state.frames[k - 1];
  const events = [];
  if (prev) {
    state.bp.links.forEach((l, i) => {
      if (f.open[i] !== prev.open[i]) events.push({ i, l, opened: f.open[i] });
    });
  }
  const level = new Map();
  const levels = [[], []];
  const put = (n, li) => { if (!level.has(n)) { level.set(n, li); levels[li].push(n); } };
  const elements = [];
  for (const ev of events) {
    const b = repBit(ev.l);
    if (b < 0) continue;
    const na = state.bp.units[ev.l.a].bits[b];
    const nb = state.bp.units[ev.l.b].bits[b];
    let la = level.get(na);
    let lb = level.get(nb);
    if (la == null && lb == null) { la = 0; lb = 1; }
    else if (la == null) la = 1 - lb;
    else if (lb == null) lb = 1 - la;
    put(na, la);
    put(nb, lb);
    const out = la === 0 ? na : nb;
    const inp = out === na ? nb : na;
    elements.push({ kind: 'switch', out, inputs: [inp], control: ev.l.controlNode, level: 0,
                    link: ev.i, opened: ev.opened, bit: b });
  }
  return { root: -1, levels, elements, dir: 'back', events };
}

function paintIsland(k) {
  const f = state.frames[k];
  const prev = state.frames[k - 1];
  const svg = $('hs-island-svg');
  svg.replaceChildren();
  const cone = islandCone(k);
  const nSw = cone.elements.length;
  if (nSw) {
    const L = state.drawer.layout(cone);
    svg.setAttribute('viewBox', `0 0 ${L.width} ${L.height}`);
    svg.style.height = `${Math.max(90, L.height)}px`;
    state.drawer.drawGraph(svg, cone, L, {});
    // The wires either side, lit by their level in THIS frame; the switch open
    // or not, and marked for which way it just went.
    for (const g of svg.querySelectorAll('.sch-node')) {
      g.classList.toggle('hot', f.levels[Number(g.dataset.node)] > 0);
    }
    for (const g of svg.querySelectorAll('.sch-switch')) {
      const c = Number(g.dataset.control);
      const now = f.levels[c] > 0;
      g.classList.toggle('open', now);
      g.classList.add(now ? 'opened' : 'closed');
    }
  } else {
    svg.removeAttribute('viewBox');
    svg.style.height = '0px';
  }
  const opened = cone.events.filter((e) => e.opened).length;
  const closed = cone.events.length - opened;
  $('hs-island-note').textContent = !prev
    ? 'Frame 0 is the power-on state: nothing has switched yet.'
    : nSw
      ? `${opened} switch${opened === 1 ? '' : 'es'} opened and ${closed} closed on the `
        + `datapath at this edge, one bit of each drawn.`
      : 'No datapath switch changed at this edge: the pass transistors all stayed as they were.';
  $('hs-island-stats').textContent = switchStats();

  // What else happened at this edge, and is not a switch.
  const items = [];
  if (f.access) {
    items.push(`<li class="hs-ev ${f.access.kind === 'W' ? 'wr' : 'rd'}"><b>${f.access.kind === 'W' ? 'wrote' : 'read'}</b> `
      + `<span class="mono">$${hex4(f.access.addr)} ${f.access.kind === 'W' ? '←' : '→'} $${hex2(f.access.val)}</span>`
      + (f.sync && f.access.kind === 'R' ? ' <span class="tr-flag">opcode fetch</span>' : '') + '</li>');
  }
  if (prev) {
    for (const [i, u] of state.bp.units.entries()) {
      if (prev.units[i].value !== f.units[i].value) {
        items.push(`<li class="hs-ev unit"><b>${label(u)}</b> <span class="mono">$${hex2(prev.units[i].value)} → $${hex2(f.units[i].value)}</span></li>`);
      }
    }
    const before = new Set(prev.terms);
    const arrived = f.terms.filter((i) => !before.has(i));
    const left = prev.terms.filter((i) => !f.terms.includes(i));
    if (arrived.length) {
      items.push(`<li class="hs-ev term"><b>decode</b> `
        + arrived.map((i) => `<span class="mono">${state.dec.rows[i].name || `term #${state.dec.rows[i].node}`}</span>`).join(' ')
        + ' <span class="muted">arrived</span></li>');
    }
    if (left.length) {
      items.push(`<li class="hs-ev term off"><b>decode</b> `
        + left.map((i) => `<span class="mono">${state.dec.rows[i].name || `term #${state.dec.rows[i].node}`}</span>`).join(' ')
        + ' <span class="muted">dropped</span></li>');
    }
    if (prev.t !== f.t) items.push(`<li class="hs-ev t"><b>timing</b> <span class="mono">${prev.t} → ${f.t}</span></li>`);
    let changed = 0;
    for (let i = 0; i < f.levels.length; i++) if (f.levels[i] !== prev.levels[i]) changed++;
    items.push(`<li class="hs-ev n"><b>${changed}</b> nodes changed level</li>`);
  }
  $('hs-events').innerHTML = items.length ? `<ul>${items.join('')}</ul>` : '';
}

/**
 * How much the datapath switches per edge, over the whole recording.
 *
 * Measured rather than asserted, because the first draft of this page's prose
 * said an empty island was the common case and the harness found there is no
 * such frame: every edge changes some of the twenty-one paths. The four that
 * change most are named, so the prose can point at them without typing them.
 */
function switchStats() {
  const { frames } = state;
  if (frames.length < 2) return '';
  const counts = [];
  const per = new Map();
  for (let k = 1; k < frames.length; k++) {
    let n = 0;
    state.bp.links.forEach((l, i) => {
      if (frames[k].open[i] !== frames[k - 1].open[i]) {
        n++;
        per.set(l.control, (per.get(l.control) || 0) + 1);
      }
    });
    counts.push(n);
  }
  counts.sort((p, q) => p - q);
  const min = counts[0];
  const max = counts[counts.length - 1];
  const med = counts[Math.floor(counts.length / 2)];
  const top = [...per.entries()].sort((p, q) => q[1] - p[1]).slice(0, 4)
    .map(([c, n]) => `${c.replace(/^dpc-?\d*_?/, '')} (${n})`);
  return `In this recording: ${min} to ${max} of the ${state.bp.links.length} paths change per edge, `
    + `median ${med}. Changing most: ${top.join(', ')}.`;
}

// ---------------------------------------------------------------------------
// The strip, the head, the caption
// ---------------------------------------------------------------------------

function paintStrip() {
  const host = $('hs-strip');
  const { frames, segs, cur } = state;
  // Rebuilt only when the recording grows; the cursor is a class toggle.
  if (host.dataset.n !== String(frames.length)) {
    host.dataset.n = String(frames.length);
    host.replaceChildren();
    for (const s of segs) {
      const seg = document.createElement('div');
      seg.className = 'hs-op' + (s.fetch < 0 ? ' reset' : '');
      seg.title = s.fetch >= 0 ? `$${hex4(s.fetch)}  ${s.label}` : 'reset sequence';
      const lab = document.createElement('span');
      lab.className = 'hs-op-label mono';
      lab.textContent = s.label;
      seg.append(lab);
      const ticks = document.createElement('span');
      ticks.className = 'hs-ticks';
      for (let k = s.start; k <= s.end; k++) {
        const t = document.createElement('i');
        t.dataset.k = String(k);
        t.setAttribute('role', 'option');
        t.title = `half-cycle ${frames[k].h}`;
        ticks.append(t);
      }
      seg.append(ticks);
      host.append(seg);
    }
  }
  const prev = host.querySelector('i.here');
  if (prev) { prev.classList.remove('here'); prev.removeAttribute('aria-selected'); }
  const now = host.querySelector(`i[data-k="${cur}"]`);
  if (now) {
    now.classList.add('here');
    now.setAttribute('aria-selected', 'true');
    now.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
}

function paintHead(k, f) {
  const s = segOf(k);
  const inOp = s ? k - s.start + 1 : 0;
  const opLen = s ? s.end - s.start + 1 : 0;
  $('hs-head').innerHTML =
    `<span class="tr-op">frame ${k}</span>`
    + `<span class="tr-sep">·</span><span>half-cycle <b>${f.h}</b></span>`
    + `<span class="tr-sep">·</span><span>cycle <b>${Math.floor(f.h / 2)}</b> φ${f.ph}</span>`
    + `<span class="tr-sep">·</span><span class="mono">${f.t}</span>`
    + (f.sync ? '<span class="tr-flag">sync</span>' : '')
    + (s ? `<span class="tr-sep">·</span><span class="tr-mn">${s.label}</span>`
           + (s.fetch >= 0 ? `<span class="muted"> at $${hex4(s.fetch)}</span>` : '')
           + `<span class="tr-sep">·</span><span>${inOp} of ${opLen} in this ${s.fetch >= 0 ? 'instruction' : 'sequence'}</span>`
         : '');
}

function paintCaption() {
  const n = state.frames.length;
  const ops = state.segs.filter((s) => s.fetch >= 0).length;
  const prog = PROGRAMS[state.program];
  $('hs-stat').textContent =
    `${prog.name} · ${n} frames recorded · ${ops} instructions · grows by ${BATCH} up to ${MAX_FRAMES}`;
  $('hs-caption').textContent =
    `Frame ${state.cur} of ${n - 1}. Click a tick on the strip to jump to it; stepping past the end `
    + (n < MAX_FRAMES ? `records ${BATCH} more half-cycles, up to ${MAX_FRAMES}.` : `is the end: ${MAX_FRAMES} is the cap.`);
}

function refresh() {
  const k = state.cur;
  const f = state.frames[k];
  const prev = state.frames[k - 1];
  paintHead(k, f);
  paintPins(f, prev);
  paintRegs(f, prev);
  paintPlate(f, prev);
  paintMem(k, f);
  paintIsland(k);
  paintStrip();
  paintCaption();
  $('hs-back').disabled = k === 0;
  $('hs-next').disabled = k >= MAX_FRAMES - 1;
}

// ---------------------------------------------------------------------------
// Moving through the frames
// ---------------------------------------------------------------------------

/** Go to frame `want`, recording more if it is past the end. Returns whether it moved. */
function seek(want) {
  let target = Math.max(0, want);
  while (target > state.frames.length - 1 && state.frames.length < MAX_FRAMES) record(BATCH);
  target = Math.min(target, state.frames.length - 1);
  if (target === state.cur) return false;
  state.cur = target;
  refresh();
  return true;
}

function paintRun() {
  const on = isRunning();
  $('hs-run').textContent = on ? 'Pause' : 'Run';
  $('hs-run').classList.toggle('btn-primary', !on);
}

function tick(now = 0) {
  requestAnimationFrame(tick);
  if (!isRunning()) return;
  const n = halfCyclesFor(now);
  if (n <= 0) return;
  if (!seek(state.cur + n) && state.cur >= MAX_FRAMES - 1) setRunning(false);
}

function exportRecording() {
  const prog = PROGRAMS[state.program];
  const file = encode(state.frames, {
    program: { id: prog.id, name: prog.name, loadAddr: LOAD_ADDR,
               bytes: Array.from(prog.bytes, hex2).join('') },
    nodes: state.sch.names.length,
    vss: state.sch.vss, vcc: state.sch.vcc,
    units: state.bp.units.map((u) => u.name),
    controls: state.bp.links.map((l) => l.control),
    terms: state.termNodes.map((n, i) => state.dec.rows[i].name || `#${n}`),
  });
  const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `halfshot-${prog.id}-${state.frames.length}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return file;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  const status = $('hs-status');
  try {
    // Three literal fetch calls rather than a helper taking a name, so that
    // build-web.py's dangling-reference scan, which reads the quoted file name
    // inside each fetch, can see every file this page depends on.
    const asJson = (name) => (r) => {
      if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
      return r.json();
    };
    const [, bp, sch, dec] = await Promise.all([
      init(),
      fetch('blueprint.json').then(asJson('blueprint.json')),
      fetch('schematic.json').then(asJson('schematic.json')),
      fetch('decode.json').then(asJson('decode.json')),
    ]);
    state.bp = bp;
    state.sch = sch;
    state.dec = dec;
    state.m = new Machine();
    state.drawer = createDraw(sch);
    const byName = new Map(sch.names.map((n, i) => [n, i]).filter(([n]) => n));
    for (const p of PINS) {
      const n = byName.get(p);
      if (n == null) throw new Error(`the die names no pin "${p}"`);
      state.pinNode[p] = n;
    }
    state.termNodes = dec.rows.map((r) => r.node);

    for (const s of document.querySelectorAll('[data-fact]')) {
      const v = { nodes: sch.names.length, transistors: sch.counts.transistors }[s.dataset.fact];
      if (v == null) throw new Error(`no fact "${s.dataset.fact}"`);
      s.textContent = String(v);
    }

    // The plate is the Blueprint's own drawing, from the shared module.
    state.layout = layOut(bp);
    draw($('hs-svg'), bp, state.layout);

    const q = new URLSearchParams(location.search);
    const chosen = selectedProgram(location.search);
    loadProgram(chosen);

    // One place changes the program: the header picker.
    state.nav = setupProgramNav({ onChange: (i) => {
      setSelectedProgram(i);
      setRunning(false);
      loadProgram(i);
      refresh();
    } });
    if (state.nav) state.nav.set(chosen);

    // The header transport drives the cursor. Its "reset" is frame 0; its
    // "step" is the next frame; running paces through the frames at the clock
    // rate, exactly as it paces a live chip on the other pages.
    setupChipNav({
      step: () => seek(state.cur + 1),
      back: () => seek(state.cur - 1),
      reset: () => seek(0),
      halfCycle: () => state.frames[state.cur].h,
    });
    subscribe(paintRun);
    paintRun();

    $('hs-back').addEventListener('click', () => { setRunning(false); seek(state.cur - 1); });
    $('hs-next').addEventListener('click', () => { setRunning(false); seek(state.cur + 1); });
    $('hs-run').addEventListener('click', () => toggleRunning());
    $('hs-export').addEventListener('click', () => exportRecording());
    $('hs-strip').addEventListener('click', (ev) => {
      const t = ev.target.closest('i[data-k]');
      if (!t) return;
      setRunning(false);
      seek(Number(t.dataset.k));
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement) return;
      if (ev.key === 'ArrowRight') { setRunning(false); seek(state.cur + 1); ev.preventDefault(); }
      else if (ev.key === 'ArrowLeft') { setRunning(false); seek(state.cur - 1); ev.preventDefault(); }
      else if (ev.key === ' ') { toggleRunning(); ev.preventDefault(); }
      else if (ev.key === 'Home') { setRunning(false); seek(0); ev.preventDefault(); }
    });

    $('hs-boot').hidden = true;
    $('hs-main').hidden = false;
    // Only now can the labels be measured: getBBox() inside a hidden container
    // reports zero and the collision pass silently does nothing.
    placeLabels($('hs-svg'));

    const want = Number(q.get('frame'));
    if (Number.isInteger(want) && want > 0) seek(want);
    refresh();
    tick();

    // For the harness: the recording, the segments and the codec entry point.
    window.__halfshot = { state, seek, record, memAt, islandCone, exportRecording, encode };
  } catch (e) {
    status.textContent = 'Could not load: ' + (e && e.message ? e.message : e);
    status.classList.add('error');
    throw e;
  }
}

boot();
