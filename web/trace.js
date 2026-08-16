// One instruction, half-cycle by half-cycle: what changed, and what was wired
// to what while it changed.
//
// Nothing here consults a table of what an instruction is supposed to do. The
// opcode goes into memory, the chip fetches it, and every number on the page is
// read back out of the silicon afterwards -- which is what makes agreeing with
// the datasheet evidence rather than a tautology.
//
// Three things are shown per half-cycle, and they are different kinds of fact:
//
//   * the architectural state (registers, PC, stack, the pins), which is what a
//     programmer thinks the chip has;
//   * the nodes that changed level, which is what actually moved;
//   * the wires that are *shorted together right now*, which is the part no
//     behavioural emulator has to model and this one gets for free -- a node's
//     level is a property of the group it is in, not of the node.

import init, { Machine } from './pkg/v6502_wasm.js';
import { OPCODES, instructionLength } from './disasm.js';
// The header's program picker. This page shows measurements rather than running
// a program, so the choice made here is recorded for the pages that do -- which
// is why the control says so instead of implying that something on screen
// just changed.
import { setupProgramNav } from './program-nav.js';


const $ = (id) => document.getElementById(id);
const hex2 = (v) => v.toString(16).padStart(2, '0').toUpperCase();
const hex4 = (v) => v.toString(16).padStart(4, '0').toUpperCase();

// Where the traced instruction is assembled, and what runs before it.
//
// The preamble exists so the instruction under test does not execute against a
// chip full of whatever reset left behind: A, X and Y hold known values and the
// carry is clear. It is printed on the page rather than hidden, because the
// starting state is part of what the trace means.
const BASE = 0x0200;
const PREAMBLE = [
  0xa9, 0x41,   // LDA #$41
  0xa2, 0x02,   // LDX #$02
  0xa0, 0x03,   // LDY #$03
  0x18,         // CLC
];
const SUBJECT = BASE + PREAMBLE.length;

// Somewhere for the addressing modes to point. $0010/$0011 and $0012/$0013 both
// hold the pointer $1234 so that (zp,X) with X=2 and (zp),Y land on the same
// data, and $1234 holds a byte that is obviously not an operand.
const POKES = [
  [0x0010, [0x34, 0x12, 0x34, 0x12, 0x5f, 0x60, 0x61, 0x62]],
  [0x1234, [0x5a, 0x6b]],
  [0x1236, [0x77]],
];

// A sensible operand per addressing mode, so choosing an opcode is one click.
const DEFAULT_OPERAND = {
  imp: [], acc: [],
  imm: [0x42],
  zp: [0x10], zpx: [0x10], zpy: [0x10],
  izx: [0x10], izy: [0x10],
  abs: [0x34, 0x12], abx: [0x34, 0x12], aby: [0x34, 0x12], ind: [0x34, 0x12],
  rel: [0x02],
};

// The named wires worth watching for joins. One bit of the datapath at a time:
// the whole point is that these are eight independent copies of a wire, and
// mixing bits would make a join look wider than it is.
const DATAPATH = [
  'idl', 'idb', 'sb', 'dasb', 'alua', 'alub', 'alu',
  'a', 'x', 'y', 's', 'pcl', 'pch', 'pclp', 'pchp',
  'adl', 'adh', 'abl', 'abh', 'dor',
];

// What the stems stand for. A reading of the names, not a measurement -- the
// same authored table the schematic keeps, kept just as small.
const STEM_MEANING = {
  idl: 'input data latch', idb: 'internal data bus', sb: 'special bus',
  dasb: 'special bus (its other name)', alua: 'ALU input A', alub: 'ALU input B',
  alu: 'ALU result', a: 'accumulator', x: 'X', y: 'Y', s: 'stack pointer',
  pcl: 'PC low', pch: 'PC high', pclp: 'PC low precharge', pchp: 'PC high precharge',
  adl: 'address low', adh: 'address high', abl: 'address low latch',
  abh: 'address high latch', dor: 'data output register',
};

const state = {
  m: null,
  data: null,          // schematic.json: names, blocks, switches, control paths
  opcode: 0xa9,
  operand: [0x42],
  bit: 0,
  rows: [],            // one per half-cycle of the traced instruction
  startHalf: 0,
  endHalf: 0,
  watch: [],           // [{ stem, node }] for the chosen bit
  controlOf: new Map(),// control node -> [{a, b}] switches it opens
  running: false,
  lastFrame: 0,
  acc: 0,
  rate: 3,             // half-cycles per second: slow enough to read
};

const nameOf = (n) => state.data.names[n] ?? `#${n}`;

// ---------------------------------------------------------------------------
// Running the instruction
// ---------------------------------------------------------------------------

/** Assemble preamble + subject + padding, and fill the data the modes point at. */
function loadProgram() {
  const m = state.m;
  const bytes = [...PREAMBLE, state.opcode, ...state.operand,
                 0xea, 0xea, 0xea, 0xea, 0xea, 0xea];
  m.load(BASE, new Uint8Array(bytes));
  for (const [addr, data] of POKES) m.load(addr, new Uint8Array(data));
  m.setResetVector(BASE);
  m.powerCycle();
}

/**
 * Step until the chip fetches the instruction under test.
 *
 * Found by watching for its own opcode fetch rather than by counting
 * half-cycles: a hardcoded number would break the first time reset timing
 * moved, and reset timing is emergent here rather than specified.
 */
function runToSubject() {
  const m = state.m;
  for (let i = 0; i < 4000; i++) {
    m.halfStep();
    if (m.sync() && m.lastFetchAddr() === SUBJECT) return true;
  }
  return false;
}

function sampleRow(prev) {
  const m = state.m;
  const levels = m.nodeLevels();
  const changed = [];
  if (prev) {
    const { vss, vcc } = state.data;
    for (let i = 0; i < levels.length; i++) {
      if (levels[i] !== prev[i] && i !== vss && i !== vcc) changed.push(i);
    }
  }
  return {
    half: m.halfCycle(),
    phase: m.phase(),
    sync: m.sync(),
    tstates: m.timingStates() || '—',
    ab: m.addressBus(), db: m.dataBus(), read: m.isRead(),
    a: m.a(), x: m.x(), y: m.y(), s: m.s(), p: m.p(), pc: m.pc(), ir: m.ir(),
    flags: m.flagsString(),
    changed,
    levels,
  };
}

/**
 * Record the whole instruction, then go back to its start.
 *
 * It deliberately runs *past* the next `sync`. The 6502 overlaps the tail of one
 * instruction with the next opcode fetch, so an ALU result is not in the
 * accumulator when sync rises -- it is sitting in the hold register and
 * transfers during the following cycle. Stopping at sync would show the
 * instruction not having happened, which is the single most misleading thing
 * this page could do.
 */
function trace() {
  loadProgram();
  if (!runToSubject()) return false;

  state.startHalf = state.m.halfCycle();
  const rows = [];
  let prev = null;
  let syncsSeen = 0;
  for (let i = 0; i < 48; i++) {
    const row = sampleRow(prev);
    // The fetch itself is high for two half-cycles; the *next* rise is the end.
    if (i > 2 && row.sync && !rows[rows.length - 1].sync) syncsSeen++;
    row.tail = syncsSeen > 0;
    rows.push(row);
    prev = row.levels;
    if (syncsSeen > 0 && rows.filter((r) => r.tail).length >= 4) break;
    state.m.halfStep();
  }
  state.rows = rows;
  state.endHalf = rows[rows.length - 1].half;
  state.m.rewindTo(state.startHalf);
  return true;
}

const cursor = () => {
  const h = state.m.halfCycle();
  return Math.max(0, Math.min(state.rows.length - 1, h - state.startHalf));
};

// ---------------------------------------------------------------------------
// What is one wire right now
// ---------------------------------------------------------------------------

/**
 * The named datapath wires that are shorted together at this instant.
 *
 * This is the fact the whole simulator rests on and the one a behavioural
 * emulator never has to represent: a node's level is a property of the *group*
 * of nodes currently joined through conducting transistors, not of the node.
 * When SBAC is open, `sb0` and `a0` are not two wires with equal values -- they
 * are one wire.
 */
function joins() {
  const m = state.m;
  const inWatch = new Map(state.watch.map((w) => [w.node, w.stem]));
  const seen = new Set();
  const out = [];
  for (const { node } of state.watch) {
    if (seen.has(node)) continue;
    const group = Array.from(m.nodeGroup(node)).filter((n) => inWatch.has(n));
    group.forEach((n) => seen.add(n));
    if (group.length > 1) {
      out.push({
        members: group.map((n) => ({ node: n, stem: inWatch.get(n) })),
        key: group.slice().sort((p, q) => p - q).join(','),
        high: m.isNodeHigh(node),
      });
    }
  }
  return out;
}

/** Which switches changed state this half-cycle, and what they join. */
function switchEdges(row, prevRow) {
  if (!prevRow) return [];
  const out = [];
  for (const [control, list] of state.controlOf) {
    const was = prevRow.levels[control] > 0;
    const now = row.levels[control] > 0;
    if (was === now) continue;
    // Only report a control that steers something on the watched bit -- the
    // clock tree alone opens 273 switches and would bury everything else.
    const relevant = list.filter((w) => state.watch.some(
      (v) => v.node === w.a || v.node === w.b));
    if (relevant.length) out.push({ control, opened: now, count: list.length });
  }
  return out.sort((p, q) => Number(q.opened) - Number(p.opened));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function mnemonic(opcode) {
  const e = OPCODES[opcode];
  return e ? e[0] : '???';
}

function subjectText() {
  const e = OPCODES[state.opcode];
  const bytes = [state.opcode, ...state.operand].map(hex2).join(' ');
  if (!e) return `$${hex2(state.opcode)} — undocumented · ${bytes}`;
  const [mn, mode] = e;
  const o = state.operand;
  // Each formatter is a function, and only the one for this mode is called.
  // Written as a table of strings first, which evaluates every entry eagerly --
  // so an implied instruction, which has no operand bytes at all, formatted
  // `hex2(undefined)` and threw. The throw escaped through `refresh()`, and the
  // page went on displaying the *previous* instruction's trace: the numbers
  // stayed plausible and stopped being about the opcode that was selected.
  const arg = {
    imp: () => '', acc: () => 'A',
    imm: () => `#$${hex2(o[0])}`, zp: () => `$${hex2(o[0])}`,
    zpx: () => `$${hex2(o[0])},X`, zpy: () => `$${hex2(o[0])},Y`,
    izx: () => `($${hex2(o[0])},X)`, izy: () => `($${hex2(o[0])}),Y`,
    abs: () => `$${hex4((o[1] << 8) | o[0])}`, abx: () => `$${hex4((o[1] << 8) | o[0])},X`,
    aby: () => `$${hex4((o[1] << 8) | o[0])},Y`, ind: () => `($${hex4((o[1] << 8) | o[0])})`,
    rel: () => `+$${hex2(o[0])}`,
  }[mode];
  return `${mn} ${arg ? arg() : ''}`.trim();
}

const REGS = [
  ['A', (r) => hex2(r.a)], ['X', (r) => hex2(r.x)], ['Y', (r) => hex2(r.y)],
  ['S', (r) => hex2(r.s)], ['P', (r) => r.flags], ['PC', (r) => hex4(r.pc)],
  ['IR', (r) => hex2(r.ir)],
  ['AB', (r) => hex4(r.ab)], ['DB', (r) => hex2(r.db)],
  ['R/W', (r) => (r.read ? 'R' : 'W')],
];

function renderState(row, prevRow) {
  const cells = REGS.map(([label, get]) => {
    const now = get(row);
    const was = prevRow ? get(prevRow) : now;
    const moved = now !== was;
    return `<div class="tr-reg${moved ? ' moved' : ''}">
        <span class="tr-reg-k">${label}</span>
        <span class="tr-reg-v">${now}</span>
        ${moved ? `<span class="tr-reg-was">was ${was}</span>` : ''}
      </div>`;
  });
  $('tr-state').innerHTML = cells.join('');
}

function renderHead(row) {
  const cycle = Math.floor((row.half - state.startHalf) / 2) + 1;
  const total = Math.ceil(state.rows.filter((r) => !r.tail).length / 2);
  $('tr-head').innerHTML =
    `<span class="tr-op">$${hex2(state.opcode)}</span>`
    + `<span class="tr-mn">${subjectText()}</span>`
    + `<span class="tr-sep">·</span>`
    + `<span>cycle <b>${cycle}</b>${row.tail ? '' : ` of ${total}`}</span>`
    + `<span class="tr-sep">·</span><span>φ${row.phase}</span>`
    + `<span class="tr-sep">·</span><span class="mono">${row.tstates}</span>`
    + (row.sync ? '<span class="tr-flag">sync</span>' : '')
    + (row.tail ? '<span class="tr-flag tr-tail">tail — next fetch already begun</span>' : '');
}

function renderJoins(row, prevRow) {
  const now = joins();
  const before = prevRow ? new Set(prevJoinKeys) : new Set();
  const html = now.length
    ? now.map((g) => {
      const fresh = !before.has(g.key);
      const names = g.members.map((mm) =>
        `<span class="tr-wire" title="${STEM_MEANING[mm.stem] || ''}">${mm.stem}</span>`);
      return `<li class="${fresh ? 'fresh' : ''}">${names.join('<span class="tr-eq">=</span>')}
        <span class="tr-lvl ${g.high ? 'hi' : 'lo'}">${g.high ? '1' : '0'}</span></li>`;
    }).join('')
    : '<li class="muted">nothing joined — every watched wire is on its own</li>';
  $('tr-joins').innerHTML = html;
  prevJoinKeys = now.map((g) => g.key);
}
let prevJoinKeys = [];

function renderChanged(row, prevRow) {
  const d = state.data;
  const byBlock = new Map();
  let unnamed = 0;
  for (const n of row.changed) {
    if (d.names[n] == null) { unnamed++; continue; }
    const b = d.blockNames[d.nodeBlock[n]] || 'unclassified';
    if (!byBlock.has(b)) byBlock.set(b, []);
    byBlock.get(b).push({ n, up: row.levels[n] > 0 });
  }
  const blocks = [...byBlock.entries()].sort((p, q) => q[1].length - p[1].length);
  $('tr-changed-sum').textContent =
    `${row.changed.length} nodes changed level · ${row.changed.length - unnamed} named`;
  $('tr-changed').innerHTML = blocks.length
    ? blocks.map(([b, list]) => `<div class="tr-blk">
        <h4>${b} <span class="muted">${list.length}</span></h4>
        <p>${list.sort((p, q) => nameOf(p.n).localeCompare(nameOf(q.n)))
          .map((e) => `<span class="tr-node ${e.up ? 'up' : 'down'}">${nameOf(e.n)}`
            + `<i>${e.up ? '↑' : '↓'}</i></span>`).join(' ')}</p></div>`).join('')
    : '<p class="muted">nothing named moved this half-cycle</p>';

  const edges = switchEdges(row, prevRow);
  $('tr-switches').innerHTML = edges.length
    ? edges.map((e) => {
      const path = (state.data.controlPaths || []).find((p) => p[0] === e.control);
      const what = path ? ` <span class="muted">${path[1]} → ${path[2]}</span>` : '';
      return `<li class="${e.opened ? 'opened' : 'closed'}">
        <b>${e.opened ? 'opens' : 'closes'}</b>
        <span class="mono">${nameOf(e.control)}</span>${what}</li>`;
    }).join('')
    : '<li class="muted">no switch on this bit changed</li>';
}

function renderTable() {
  const here = cursor();
  const rows = state.rows.map((r, i) => {
    const cycle = Math.floor((r.half - state.startHalf) / 2) + 1;
    return `<tr class="${i === here ? 'here' : ''}${r.tail ? ' tail' : ''}" data-i="${i}">
      <td class="mono">${cycle}</td><td class="mono">φ${r.phase}</td>
      <td class="mono">${r.tstates}</td>
      <td class="mono">${hex4(r.ab)}</td><td class="mono">${hex2(r.db)}</td>
      <td class="mono">${r.read ? 'R' : 'W'}</td>
      <td class="mono">${hex2(r.a)}</td><td class="mono">${hex2(r.x)}</td>
      <td class="mono">${hex2(r.y)}</td><td class="mono">${hex2(r.s)}</td>
      <td class="mono">${r.flags}</td><td class="mono">${hex4(r.pc)}</td>
      <td class="mono">${r.changed.length}</td></tr>`;
  }).join('');
  $('tr-table-body').innerHTML = rows;
  for (const tr of $('tr-table-body').querySelectorAll('tr')) {
    tr.addEventListener('click', () => {
      setRunning(false);
      seek(Number(tr.dataset.i));
    });
  }
  const el = $('tr-table-body').querySelector('tr.here');
  if (el) el.scrollIntoView({ block: 'nearest' });
}

function refresh() {
  const i = cursor();
  const row = state.rows[i];
  if (!row) return;
  const prevRow = i > 0 ? state.rows[i - 1] : null;
  renderHead(row);
  renderState(row, prevRow);
  renderJoins(row, prevRow);
  renderChanged(row, prevRow);
  renderTable();
  $('tr-back').disabled = i === 0;
  $('tr-step').disabled = i >= state.rows.length - 1;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * Move the cursor to a row, forwards or back.
 *
 * The two directions are genuinely different operations and cannot share one
 * call. `rewindTo` refuses a target in the future -- correctly, since rewinding
 * replays from a keyframe and there is nothing yet to replay -- so asking it to
 * step forward fails silently and the cursor sticks at the start. Forward is
 * simply running the chip.
 */
function seek(want) {
  const target = Math.max(0, Math.min(state.rows.length - 1, want));
  const i = cursor();
  if (target === i) return;
  if (target > i) for (let k = i; k < target; k++) state.m.halfStep();
  else state.m.rewindTo(state.startHalf + target);
  refresh();
}

function step(dir) {
  setRunning(false);
  seek(cursor() + dir);
}

function setRunning(on) {
  state.running = on;
  state.acc = 0;
  const b = $('tr-run');
  b.textContent = on ? 'Pause' : 'Run';
  b.classList.toggle('on', on);
}

function restart() {
  setRunning(false);
  state.m.rewindTo(state.startHalf);
  refresh();
}

function tick(now = 0) {
  if (state.running) {
    const dt = state.lastFrame ? Math.min(now - state.lastFrame, 250) : 0;
    state.acc += (dt / 1000) * state.rate;
    while (state.acc >= 1) {
      state.acc -= 1;
      if (cursor() >= state.rows.length - 1) { setRunning(false); break; }
      state.m.halfStep();
    }
    refresh();
  }
  state.lastFrame = now;
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function setBit(b) {
  state.bit = b;
  const byName = state.byName;
  state.watch = DATAPATH
    .map((stem) => ({ stem, node: byName.get(`${stem}${b}`) }))
    .filter((w) => w.node != null);
  $('tr-bit-val').textContent = String(b);
  $('tr-watch').textContent = state.watch.map((w) => w.stem).join(' · ');
}

function chooseOpcode(op) {
  state.opcode = op;
  const mode = OPCODES[op] ? OPCODES[op][1] : null;
  const want = mode ? DEFAULT_OPERAND[mode] : null;
  // An undocumented opcode has no declared length here, so fall back to what
  // the disassembler will admit to and pad with zeroes rather than guessing.
  const len = want ? want.length : Math.max(0, instructionLength(op) - 1);
  state.operand = want ? want.slice() : new Array(len).fill(0);
  $('tr-operand').value = state.operand.map(hex2).join(' ');
  $('tr-operand').disabled = state.operand.length === 0;
  go();
}

function go() {
  const ok = trace();
  $('tr-warn').hidden = ok;
  if (!ok) return;
  prevJoinKeys = [];
  setRunning(false);
  refresh();
}

async function boot() {
  const status = $('tr-status');
  try {
    const [, data] = await Promise.all([
      init(),
      fetch('schematic.json').then((r) => {
        if (!r.ok) throw new Error(`schematic.json: HTTP ${r.status}`);
        return r.json();
      }),
    ]);
    state.data = data;
    state.byName = new Map(data.names.map((n, i) => [n, i]).filter(([n]) => n));
    for (const [control, a, b] of data.switches) {
      if (!state.controlOf.has(control)) state.controlOf.set(control, []);
      state.controlOf.get(control).push({ a, b });
    }
    state.m = new Machine();

    // The opcode picker. Documented instructions first and named; the rest are
    // offered too, because the chip executes them and this page has no opinion
    // about which opcodes are supposed to exist.
    const sel = $('tr-opcode');
    for (let op = 0; op < 256; op++) {
      const o = document.createElement('option');
      o.value = String(op);
      o.textContent = OPCODES[op]
        ? `$${hex2(op)}  ${mnemonic(op)} ${OPCODES[op][1]}`
        : `$${hex2(op)}  (undocumented)`;
      sel.append(o);
    }
    sel.value = String(state.opcode);
    sel.addEventListener('change', (e) => chooseOpcode(Number(e.target.value)));

    $('tr-operand').addEventListener('change', (e) => {
      const bytes = e.target.value.trim().split(/[\s,]+/).filter(Boolean)
        .map((t) => parseInt(t, 16) & 0xff).filter((v) => !Number.isNaN(v));
      if (bytes.length === state.operand.length) { state.operand = bytes; go(); }
      else e.target.value = state.operand.map(hex2).join(' ');
    });

    $('tr-bit').addEventListener('input', (e) => { setBit(Number(e.target.value)); refresh(); });
    $('tr-step').addEventListener('click', () => step(+1));
    $('tr-back').addEventListener('click', () => step(-1));
    $('tr-run').addEventListener('click', () => setRunning(!state.running));
    $('tr-restart').addEventListener('click', restart);

    document.addEventListener('keydown', (ev) => {
      if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement) return;
      if (ev.key === 'ArrowRight') { step(+1); ev.preventDefault(); }
      else if (ev.key === 'ArrowLeft') { step(-1); ev.preventDefault(); }
      else if (ev.key === ' ') { setRunning(!state.running); ev.preventDefault(); }
      else if (ev.key === 'r' || ev.key === 'R') { restart(); ev.preventDefault(); }
    });

    $('tr-preamble').textContent =
      'LDA #$41 · LDX #$02 · LDY #$03 · CLC   then the instruction at $'
      + hex4(SUBJECT);

    setBit(0);
    chooseOpcode(state.opcode);
    $('tr-boot').hidden = true;
    $('tr-main').hidden = false;
    tick();
  } catch (e) {
    status.textContent = 'Could not load: ' + (e && e.message ? e.message : e);
    status.classList.add('error');
    throw e;
  }
}

setupProgramNav();
boot();
