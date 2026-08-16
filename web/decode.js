// The decode PLA, as a measured table.
//
// Unlike the blueprint and the die view, this page runs no simulation. It does
// not need to: `export-decode` already ran the chip 768 times -- every opcode
// under three scenarios -- and recorded which of the 122 product terms were
// high at each half-cycle. What you see here is that measurement, not a model
// of it, and not something a single live run could show at once.
//
// The structure (which nodes are product terms, what gates each one) comes from
// the netlist; the firing comes from the engine. Same division as the
// blueprint, for the same reason: computing a term's opcode set from its gates
// gets `irline3` wrong and "corrects" the undocumented opcodes out of
// existence.

import { OPCODES } from './disasm.js';
// The header's program picker. This page shows measurements rather than running
// a program, so the choice made here is recorded for the pages that do -- which
// is why the control says so instead of implying that something on screen
// just changed.
import { setupProgramNav } from './program-nav.js';


const $ = (id) => document.getElementById(id);
const hex2 = (v) => v.toString(16).padStart(2, '0').toUpperCase();

const state = {
  data: null,
  firedBy: [],     // term index -> [opcodes]
  linksOf: [],     // term index -> [{line, mode, lag}]
  opcode: null,
  term: null,
  filter: '',
};

// `op-T0-cpx/cpy/inx/iny` -> the T-state and the rest, for display.
function splitTerm(name) {
  if (!name) return { stage: '—', label: 'the irline3 generator' };
  const m = /^op-(T[0-9+]+)-(.*)$/.exec(name);
  return m ? { stage: m[1], label: m[2] } : { stage: '', label: name.replace(/^op-/, '') };
}

const documented = (op) => Object.prototype.hasOwnProperty.call(OPCODES, op);
const mnemonic = (op) => (documented(op) ? OPCODES[op][0] : '—');
const mode = (op) => (documented(op) ? OPCODES[op][1] : 'undocumented');

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function buildGrid() {
  const grid = $('op-grid');
  grid.replaceChildren();
  for (let op = 0; op < 256; op++) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'op-cell' + (documented(op) ? '' : ' undoc');
    cell.dataset.op = String(op);
    cell.innerHTML =
      `<span class="op-hex">${hex2(op)}</span><span class="op-mn">${mnemonic(op)}</span>`;
    cell.title = `$${hex2(op)} — ${mnemonic(op)} (${mode(op)}), `
      + `${state.data.opcodes[op].any.length} terms`;
    cell.onclick = () => selectOpcode(op);
    grid.append(cell);
  }
}

function buildTermList() {
  const list = $('term-list');
  list.replaceChildren();
  const f = state.filter.toLowerCase();
  let shown = 0;
  state.data.rows.forEach((row, i) => {
    const { stage, label } = splitTerm(row.name);
    const text = (row.name || 'irline3') + ' ' + label;
    if (f && !text.toLowerCase().includes(f)) return;
    shown++;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'term' + (state.term === i ? ' picked' : '');
    b.dataset.term = String(i);
    b.innerHTML =
      `<span class="term-stage">${stage}</span>`
      + `<span class="term-label">${label}</span>`
      + `<span class="term-count">${state.firedBy[i].length}</span>`;
    b.onclick = () => selectTerm(state.term === i ? null : i);
    list.append(b);
  });
  $('term-shown').textContent =
    shown === state.data.rows.length ? `${shown} terms` : `${shown} of ${state.data.rows.length}`;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function selectTerm(i) {
  state.term = i;
  for (const b of document.querySelectorAll('.term')) {
    b.classList.toggle('picked', Number(b.dataset.term) === i);
  }
  const fired = i === null ? null : new Set(state.firedBy[i]);
  for (const c of document.querySelectorAll('.op-cell')) {
    c.classList.toggle('lit', fired ? fired.has(Number(c.dataset.op)) : false);
  }
  document.getElementById('op-grid').classList.toggle('dimmed', i !== null);
  renderTermDetail(i);
  if (i !== null) history.replaceState(null, '', `?term=${encodeURIComponent(state.data.rows[i].name || 'irline3')}`);
}

function selectOpcode(op) {
  state.opcode = op;
  for (const c of document.querySelectorAll('.op-cell')) {
    c.classList.toggle('picked', Number(c.dataset.op) === op);
  }
  renderOpcodeDetail(op);
  history.replaceState(null, '', `?op=${hex2(op)}`);
}

// ---------------------------------------------------------------------------
// Detail panels
// ---------------------------------------------------------------------------

function renderOpcodeDetail(op) {
  const el = $('op-detail');
  if (op === null) {
    el.innerHTML = '<p class="muted">Pick an opcode to see the terms it fires, half-cycle by half-cycle.</p>';
    return;
  }
  const rec = state.data.opcodes[op];
  const rowName = (i) => {
    const { stage, label } = splitTerm(state.data.rows[i].name);
    return `<button type="button" class="chip" data-goto="${i}">`
      + `<span class="chip-stage">${stage}</span>${label}</button>`;
  };
  const lines = [];
  for (let hc = 0; hc < rec.hc.length; hc++) {
    const { r, o } = rec.hc[hc];
    if (!r.length && !o.length) continue;
    lines.push(
      `<tr><td class="hc">+${hc}</td>`
      + `<td>${r.map(rowName).join(' ') || '<span class="muted">—</span>'}</td>`
      + `<td class="ctl">${o.map((j) => state.data.outputs[j].name.replace(/^dpc-?\d*_?/, ''))
          .join(' ') || '<span class="muted">—</span>'}</td></tr>`
    );
  }
  el.innerHTML = `
    <h3>$${hex2(op)} <span class="mn">${mnemonic(op)}</span>
      <span class="mode">${mode(op)}</span></h3>
    <p class="muted">${rec.any.length} product terms fire across this instruction.
      Half-cycles are counted from its own opcode fetch.</p>
    <div class="table-scroll"><table class="hc-table">
      <thead><tr><th>½cyc</th><th>Product terms high</th><th>Control lines</th></tr></thead>
      <tbody>${lines.join('')}</tbody>
    </table></div>`;
  for (const b of el.querySelectorAll('[data-goto]')) {
    b.onclick = () => {
      selectTerm(Number(b.dataset.goto));
      $('terms').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
  }
}

function renderTermDetail(i) {
  const el = $('term-detail');
  if (i === null) {
    el.innerHTML = '<p class="muted">Pick a product term to light up every opcode that fires it.</p>';
    return;
  }
  const row = state.data.rows[i];
  const ops = state.firedBy[i];
  const doc = ops.filter(documented);
  const und = ops.filter((o) => !documented(o));
  const names = [...new Set(doc.map(mnemonic))].sort();

  // The product term as a bit pattern: which IR bits it constrains.
  const bits = [];
  for (let b = 7; b >= 0; b--) {
    const t = row.ir.find((x) => x[0] === b);
    bits.push(t ? (t[1] ? '1' : '0') : '·');
  }
  const gates = row.other.length ? row.other.join(', ') : 'none';

  // Control lines this term was verified to explain, split by which way round.
  const links = state.linksOf[i];
  const short = (line) => state.data.outputs[line].name.replace(/^dpc-?\d*_?/, '');
  const chips = (mode) => links.filter((l) => l.mode === mode)
    .map((l) => `<span class="chip"><span class="chip-stage">+${l.lag}</span>${short(l.line)}</span>`)
    .join(' ');
  const drives = chips('drive');
  const overrides = chips('override');
  const lineRows =
    (drives ? `<dt>Drives</dt><dd>${drives}</dd>` : '')
    + (overrides ? `<dt>Overrides</dt><dd>${overrides}</dd>` : '')
    + (links.length ? '' : '<dt>Control lines</dt><dd class="muted">none verified</dd>');

  el.innerHTML = `
    <h3>${row.name || 'unnamed term'}</h3>
    ${row.name ? '' : '<p class="muted">The die names every product term but this one. '
      + 'Its inputs are IR bits 0 and 1, both required low, and it is what drives '
      + '<span class="mono">irline3</span> — the line that lets other terms '
      + 'constrain the low two opcode bits without gating them directly.</p>'}
    <dl>
      <dt>IR pattern</dt><dd class="mono">${bits.join(' ')} <span class="muted">(7→0, · = free)</span></dd>
      <dt>Other inputs</dt><dd class="mono">${gates}</dd>
      <dt>Fires for</dt><dd>${ops.length} opcodes${names.length ? ' — ' + names.join(', ') : ''}</dd>
      ${und.length ? `<dt>Undocumented</dt><dd class="undoc-list">${und.map((o) => '$' + hex2(o)).join(' ')}</dd>` : ''}
      <dt>Node</dt><dd class="mono">#${row.node}${row.irOnly ? '' : ' · has inputs beyond the IR'}</dd>
      ${lineRows}
    </dl>
    ${links.length ? '<p class="bp-detail-note">A term reaches a control line through '
      + 'the OR plane and a <span class="mono">cclk</span> pipeline latch, so the line '
      + 'responds a half-cycle or two later — the lag shown is measured, not assumed. '
      + '<em>Overrides</em> means the line is asserted by default and this term takes it '
      + 'away: that is how the hold lines work.</p>' : ''}`;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  try {
    const res = await fetch('decode.json');
    if (!res.ok) throw new Error(`decode.json: HTTP ${res.status}`);
    state.data = await res.json();

    // term -> opcodes, inverted once rather than scanned per click.
    state.firedBy = state.data.rows.map(() => []);
    for (const rec of state.data.opcodes) {
      for (const t of rec.any) state.firedBy[t].push(rec.op);
    }
    // ...and term -> the control lines it was verified to explain.
    state.linksOf = state.data.rows.map(() => []);
    for (const l of state.data.links || []) {
      for (const t of l.terms) {
        state.linksOf[t].push({ line: l.line, mode: l.mode, lag: l.lag });
      }
    }

    buildGrid();
    buildTermList();
    selectTerm(null);
    renderOpcodeDetail(null);

    // Deliberately not "N undocumented opcodes share a term with a documented
    // one": the irline3 generator fires for all 256, so that statistic is
    // trivially 105 of 105 and says nothing. Report what was measured instead.
    const undoc = [...Array(256).keys()].filter((o) => !documented(o)).length;
    const fitted = (state.data.links || []).length;
    $('decode-stats').textContent =
      `${state.data.rows.length} product terms · ${state.data.outputs.length} control lines, `
      + `${fitted} traced back to their terms · 256 opcodes measured · ${undoc} undocumented`;

    $('term-filter').oninput = (ev) => { state.filter = ev.target.value; buildTermList(); };

    const q = new URLSearchParams(location.search);
    if (q.has('op')) {
      const op = parseInt(q.get('op'), 16);
      if (op >= 0 && op < 256) selectOpcode(op);
    }
    if (q.has('term')) {
      const want = q.get('term');
      const i = state.data.rows.findIndex((r) => (r.name || 'irline3') === want);
      if (i >= 0) selectTerm(i);
    }

    $('decode-boot').hidden = true;
    $('decode-main').hidden = false;
  } catch (e) {
    const s = $('decode-status');
    s.textContent = 'Could not load: ' + (e && e.message ? e.message : e);
    s.classList.add('error');
    throw e;
  }
}

setupProgramNav();
boot();
