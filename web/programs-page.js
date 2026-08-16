// The Programs page: source, assembled, annotated, and running.
//
// Nothing here is written down twice. The listing's address and byte columns
// come out of the assembler, the cycle column comes out of `timing.json` --
// measured on the silicon, sync to sync -- and the run panel reads registers
// and memory back out of the chip's storage nodes. The only authored text is
// the assembly itself and the notes beside it.
//
// The notes are anchored to labels rather than to line numbers, and a note
// naming a label the program does not define is a page error rather than a
// silently missing paragraph. That is the whole trick for keeping prose honest
// here: make the drift impossible instead of promising to check for it.

import init, { Machine } from './pkg/v6502_wasm.js';
import {
  PROGRAMS, LOAD_ADDR, selectedProgram, setSelectedProgram, programFromUrl,
} from './programs.js';
import { setupProgramNav } from './program-nav.js';
import {
  createChip, transport, readout, el, hex2, hex4, lamps, runWhileVisible,
} from './demos.js';

const $ = (id) => document.getElementById(id);

const state = {
  index: 0,
  cycles: null,     // opcode -> measured cycle count, or null if it never ends
  jam: new Set(),
  chip: null,
  nav: null,
  unbind: null,
  // `new Machine()` before `init()` throws, so the run panel is built only once
  // the wasm is up. Everything else on the page works without it.
  ready: false,
};

// ---------------------------------------------------------------------------
// The listing
// ---------------------------------------------------------------------------

/**
 * Where a note goes.
 *
 * A note names a label; the row carrying that label gets it. Resolving it here
 * rather than at write time means a renamed label breaks loudly.
 */
function noteRows(program) {
  const byLabel = new Map();
  for (const [label, text] of Object.entries(program.notes || {})) {
    const line = program.asm.lines.find((l) => l.label === label);
    if (!line) {
      throw new Error(
        `${program.id}: a note is anchored to "${label}", which the program does not define`);
    }
    byLabel.set(line.n, text);
  }
  return byLabel;
}

function renderListing(program) {
  const tbody = $('prog-listing').querySelector('tbody');
  tbody.replaceChildren();
  const notes = noteRows(program);

  for (const ln of program.asm.lines) {
    const blank = !ln.mnemonic && !ln.directive && !ln.label && !ln.comment;
    if (blank) continue;

    const tr = el('tr', { class: 'pg-row' }, tbody);
    if (ln.label) tr.dataset.label = ln.label;

    const addr = el('td', { class: 'c-addr mono' }, tr);
    const bytes = el('td', { class: 'c-bytes mono' }, tr);
    const src = el('td', { class: 'c-src' }, tr);
    const cyc = el('td', { class: 'c-cyc mono' }, tr);

    // A .org that skips forward leaves real memory the chip will fetch
    // through. Showing the gap is more honest than omitting it.
    if (ln.directive === '.org') {
      addr.textContent = `$${hex4(ln.addr)}`;
      bytes.textContent = '';
      tr.classList.add('is-org');
    } else if (ln.bytes && ln.bytes.length) {
      addr.textContent = `$${hex4(ln.addr)}`;
      bytes.textContent = ln.bytes.map(hex2).join(' ');
    }

    const code = el('code', { class: 'pg-src' }, src);
    code.textContent = ln.text.replace(/\s+$/, '') || ' ';
    if (ln.mnemonic) code.classList.add('has-op');

    if (ln.mnemonic && state.cycles) {
      const n = state.cycles[ln.opcode];
      if (state.jam.has(ln.opcode)) {
        cyc.textContent = '∞';
        cyc.title = 'This opcode never finishes: the timing chain stops advancing.';
      } else if (n != null) {
        cyc.textContent = String(n);
        cyc.title = `${n} cycles, measured sync to sync`;
      }
    }

    const note = notes.get(ln.n);
    if (note) {
      const nr = el('tr', { class: 'pg-note-row' }, tbody);
      el('td', {}, nr);
      const cell = el('td', { class: 'pg-note' }, nr);
      cell.colSpan = 3;
      el('p', { html: note }, cell);
    }
  }
}

function renderBinary(program) {
  const b = program.bytes;
  const org = program.asm.org;
  const lines = [];
  for (let i = 0; i < b.length; i += 8) {
    const chunk = b.slice(i, i + 8);
    lines.push(`$${hex4(org + i)}  ${chunk.map(hex2).join(' ')}`);
  }
  $('prog-dump').textContent = lines.join('\n');
  $('prog-binary-note').textContent =
    `${b.length} bytes, loaded at $${hex4(org)}. The reset vector is pointed here `
    + 'before the chip is powered up — without that it comes out of reset at '
    + '$0000 and runs a BRK loop against itself.';
}

function renderGoLinks(program, index) {
  const host = $('prog-go');
  host.replaceChildren();
  const q = `?program=${index}`;
  const links = [
    [`./${q}&run=1#explorer`, 'Explorer', 'the die, lit by what it is doing'],
    [`blueprint${q}&run=1`, 'Blueprint', 'the datapath as buses and switches'],
    [`exploded${q}`, 'Exploded', 'the three mask layers, pulled apart'],
    ['schematic', 'Schematic', 'the gates behind any one signal'],
  ];
  for (const [href, name, why] of links) {
    const a = el('a', { class: 'pg-go-link', href }, host);
    el('strong', {}, a).textContent = name;
    el('span', {}, a).textContent = why;
  }
}

// ---------------------------------------------------------------------------
// The run panel
// ---------------------------------------------------------------------------

function buildRunPanel(program) {
  const host = $('prog-run-host');
  host.replaceChildren();

  // One chip for the life of the page, reloaded rather than replaced.
  //
  // `createChip` starts a frame loop that never stops, so building a new one
  // per program would leave every previous chip running forever with a Machine
  // apiece -- and clicking through seven programs a few times is not an unusual
  // thing to do on this page. The listener has to be dropped explicitly for the
  // same reason: `chip.on` returns its own unbind and nothing else calls it.
  if (state.unbind) { state.unbind(); state.unbind = null; }

  let chip = state.chip;
  if (chip) {
    chip.setRunning(false);
    const m = chip.machine;
    m.load(program.asm.org, new Uint8Array(program.bytes));
    m.setResetVector(program.asm.org);
    m.powerCycle();
  } else {
    chip = createChip({
      Machine,
      program: program.bytes,
      loadAddr: program.asm.org,
      // The slowest rate anything on this site runs at. A program page is for
      // reading what happened, not for watching a blur.
      rate: 2,
    });
    state.chip = chip;
  }

  transport(host, chip, { label: 'chip' });

  const regs = el('div', { class: 'pg-regs' }, host);
  const paintRegs = readout(regs, [
    ['pc', 'PC'], ['ir', 'IR'], ['a', 'A'], ['x', 'X'], ['y', 'Y'],
    ['s', 'S'], ['p', 'P'], ['bus', 'bus'],
  ]);

  const watchHost = el('div', { class: 'pg-watch' }, host);
  const watches = program.watch || [];
  const paintWatch = watches.length
    ? readout(watchHost, watches.map((w) => [String(w.addr), w.page
        ? `${w.name} (first 8)` : `${w.name} <span class="muted">$${hex4(w.addr)}</span>`]))
    : null;

  const unbind = chip.on((m) => {
    paintRegs({
      pc: `$${hex4(m.pc())}`,
      ir: `$${hex2(m.ir())}`,
      a: `$${hex2(m.a())} ${lamps(m.a(), 8)}`,
      x: `$${hex2(m.x())}`,
      y: `$${hex2(m.y())}`,
      s: `$${hex2(m.s())}`,
      p: `<span class="mono">${escapeHtml(m.flagsString())}</span>`,
      bus: `$${hex4(m.addressBus())} ${m.isRead() ? 'r' : 'w'} $${hex2(m.dataBus())}`,
    });
    if (paintWatch) {
      const values = {};
      for (const w of watches) {
        values[String(w.addr)] = w.page
          ? [...m.memorySlice(w.addr, 8)].map(hex2).join(' ')
          : `$${hex2(m.peek(w.addr))}`;
      }
      paintWatch(values);
    }
  });
  state.unbind = unbind;

  // The chip comes out of a power cycle in the middle of its reset sequence,
  // which is not what a page about programs wants on screen.
  chip.warm(16);
  runWhileVisible(chip, $('prog-run'));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function renderList() {
  const host = $('prog-list');
  host.replaceChildren();
  PROGRAMS.forEach((p, i) => {
    const b = el('button', { class: 'pg-item', type: 'button' }, host);
    b.dataset.index = String(i);
    el('strong', {}, b).textContent = p.name;
    el('span', { class: 'pg-item-size mono' }, b).textContent =
      `${p.bytes.length} bytes · ${p.asm.lines.filter((l) => l.mnemonic).length} instructions`;
    b.addEventListener('click', () => show(i, { save: true }));
  });
}

function show(index, { save = false } = {}) {
  const program = PROGRAMS[index];
  if (!program) return;
  state.index = index;

  for (const b of $('prog-list').querySelectorAll('.pg-item')) {
    b.classList.toggle('on', Number(b.dataset.index) === index);
    if (Number(b.dataset.index) === index) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
  }

  $('prog-name').textContent = program.name;
  $('prog-blurb').textContent = program.blurb;
  $('prog-bar-note').textContent =
    `${program.name} — ${program.bytes.length} bytes at $${hex4(program.asm.org)}`;

  renderListing(program);
  renderBinary(program);
  renderGoLinks(program, index);
  if (state.ready) buildRunPanel(program);

  if (save) {
    setSelectedProgram(index);
    if (state.nav) state.nav.set(index);
  }

  // The address bar follows the page, so a link off this page names what is
  // being looked at rather than whatever was selected when it was loaded.
  const url = new URL(location.href);
  url.searchParams.set('program', String(index));
  history.replaceState(null, '', url);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  renderList();

  state.nav = setupProgramNav({ onChange: (i) => show(i, { save: true }) });

  // The measured cycle counts. The page is worth reading without them, so a
  // failure here loses the column rather than the page.
  try {
    const timing = await fetch('timing.json').then((r) => {
      if (!r.ok) throw new Error(`timing.json: ${r.status}`);
      return r.json();
    });
    state.cycles = {};
    for (const row of timing.opcodes) {
      if (row.jam) state.jam.add(row.op);
      else state.cycles[row.op] = row.cycles;
    }
  } catch (err) {
    console.warn('cycle counts unavailable:', err);
  }

  const totals = PROGRAMS.reduce((acc, p) => {
    acc.bytes += p.bytes.length;
    acc.instructions += p.asm.lines.filter((l) => l.mnemonic).length;
    return acc;
  }, { bytes: 0, instructions: 0 });
  const distinct = new Set(
    PROGRAMS.flatMap((p) => p.asm.lines.filter((l) => l.mnemonic).map((l) => l.mnemonic)));
  $('prog-stats').innerHTML = [
    `${PROGRAMS.length} programs`,
    `${totals.instructions} instructions`,
    `${totals.bytes} bytes assembled`,
    `${distinct.size} distinct mnemonics`,
  ].map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');

  show(programFromUrl() ?? selectedProgram());

  $('prog-use').addEventListener('click', () => {
    setSelectedProgram(state.index);
    if (state.nav) state.nav.set(state.index);
    const b = $('prog-use');
    b.textContent = 'Selected';
    setTimeout(() => { b.textContent = 'Use everywhere'; }, 1400);
  });

  // The simulator last: everything above is readable without it, and it is the
  // one part that can fail on a browser without wasm.
  try {
    await init();
    state.ready = true;
    $('prog-run-status')?.remove();
    buildRunPanel(PROGRAMS[state.index]);
  } catch (err) {
    const s = $('prog-run-status');
    if (s) s.textContent = `The simulator could not start: ${err.message}`;
    console.error(err);
  }
}

boot().catch((err) => {
  console.error(err);
  const note = $('prog-bar-note');
  if (note) note.textContent = `This page failed to build: ${err.message}`;
});
