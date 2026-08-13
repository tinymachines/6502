// The timing chain: every instruction's length, measured.
//
// There is no cycle counter in the 6502. The chain advances one stage per
// cycle and an instruction ends when the decode PLA sends it back to the
// start, so a cycle count is not stored anywhere -- it is however many cycles
// elapsed before something reset the chain. Every number here was taken from
// `sync` to `sync` with no instruction table involved, which is why it is worth
// checking them against the published ones rather than reciting them.

import { OPCODES } from './disasm.js';

const $ = (id) => document.getElementById(id);
const hex2 = (v) => v.toString(16).padStart(2, '0').toUpperCase();
const documented = (op) => Object.prototype.hasOwnProperty.call(OPCODES, op);
const mnemonic = (op) => (documented(op) ? OPCODES[op][0] : '—');

const state = { data: null, byOp: [], opcode: null };

// `op-T0-cpx/cpy/inx/iny` -> the readable half. Matches the Decode page.
const termLabel = (name) => (name || 'irline3').replace(/^op-(T[0-9+]+)-/, '');
const isT0 = (name) => !!name && name.startsWith('op-T0-');

// Cycle count -> a step on the accent ramp. Jams get their own.
function cellClass(rec) {
  if (rec.jam) return 'op-cell jam';
  return `op-cell cyc-${Math.min(rec.cycles, 8)}` + (documented(rec.op) ? '' : ' undoc');
}

function buildGrid() {
  const grid = $('op-grid');
  grid.replaceChildren();
  for (let op = 0; op < 256; op++) {
    const rec = state.byOp[op];
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = cellClass(rec);
    cell.dataset.op = String(op);
    cell.innerHTML = `<span class="op-hex">${hex2(op)}</span>`
      + `<span class="op-mn">${rec.jam ? '∞' : rec.cycles}</span>`;
    cell.title = `$${hex2(op)} ${mnemonic(op)} — `
      + (rec.jam ? 'never reaches another fetch' : `${rec.cycles} cycles`);
    cell.onclick = () => select(op);
    grid.append(cell);
  }
}

function select(op) {
  state.opcode = op;
  for (const c of document.querySelectorAll('.op-cell')) {
    c.classList.toggle('picked', Number(c.dataset.op) === op);
  }
  const rec = state.byOp[op];
  const last = rec.states.length - 1;
  const steps = rec.states.map((s, i) =>
    `<tr class="${i === last && !rec.jam ? 'final' : ''}">`
    + `<td class="hc">cycle ${i}</td><td class="mono">${s || '—'}</td></tr>`).join('');

  const name = (i) => state.data.terms[i];
  const chip = (i) => `<a class="chip" href="decode.html?term=`
    + `${encodeURIComponent(name(i) || 'irline3')}"><span class="chip-stage">`
    + `${isT0(name(i)) ? 'T0' : '·'}</span>${termLabel(name(i))}</a>`;
  const arrived = rec.arrived.map(chip).join(' ');
  const alsoHigh = rec.ending.filter((i) => !rec.arrived.includes(i)).map(chip).join(' ');

  $('detail').innerHTML = `
    <h3>$${hex2(op)} <span class="mn">${mnemonic(op)}</span></h3>
    <p class="muted">${rec.jam
      ? 'The chain stops advancing and no further opcode is ever fetched. '
        + 'This is not a hang in the simulation — it is what the silicon does.'
      : `${rec.cycles} cycles, measured from this opcode's fetch to the next one.`}</p>
    <div class="table-scroll"><table class="hc-table">
      <thead><tr><th>Cycle</th><th>Timing chain</th></tr></thead>
      <tbody>${steps}</tbody></table></div>
    ${rec.jam ? '' : `
    <dl class="ends">
      <dt>Arrives in the last cycle</dt>
      <dd>${arrived || '<span class="muted">nothing new — every term that is '
        + 'high at the end was already high earlier</span>'}</dd>
      ${alsoHigh ? `<dt>Also high</dt><dd>${alsoHigh}</dd>` : ''}
    </dl>`}`;
  history.replaceState(null, '', `?op=${hex2(op)}`);
}

async function boot() {
  try {
    const res = await fetch('timing.json');
    if (!res.ok) throw new Error(`timing.json: HTTP ${res.status}`);
    state.data = await res.json();
    state.byOp = [];
    for (const r of state.data.opcodes) state.byOp[r.op] = r;

    buildGrid();

    const timed = state.data.opcodes.filter((r) => !r.jam);
    const jams = state.data.opcodes.length - timed.length;
    const counts = {};
    for (const r of timed) counts[r.cycles] = (counts[r.cycles] || 0) + 1;
    const range = Object.keys(counts).map(Number).sort((a, b) => a - b);
    const withT0 = timed.filter((r) => r.arrived.some((i) => isT0(state.data.terms[i])));
    $('stats').textContent =
      `${timed.length} instructions timed · ${range[0]}–${range[range.length - 1]} cycles · `
      + `${jams} that never finish · ${withT0.length} end on a T0 term`;

    $('histogram').innerHTML = range.map((c) => {
      const n = counts[c];
      const pct = Math.round((100 * n) / timed.length);
      return `<div class="bar-row"><span class="bar-label mono">${c} cyc</span>`
        + `<span class="bar"><i class="cyc-${c}" style="width:${Math.max(pct * 2.6, 2)}%"></i></span>`
        + `<span class="bar-n mono">${n}</span></div>`;
    }).join('');

    const q = new URLSearchParams(location.search);
    const op = q.has('op') ? parseInt(q.get('op'), 16) : 0xa9;
    select(op >= 0 && op < 256 ? op : 0xa9);

    $('boot').hidden = true;
    $('main-panel').hidden = false;
  } catch (e) {
    const s = $('status');
    s.textContent = 'Could not load: ' + (e && e.message ? e.message : e);
    s.classList.add('error');
    throw e;
  }
}

boot();
