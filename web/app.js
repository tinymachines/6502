// Application shell: wires the WASM simulator to the WebGL renderer and the UI.

import init, { Machine, netlistInfo } from './pkg/v6502_wasm.js';
import { DieRenderer, parseLayout, LAYER_INFO } from './renderer.js';
import { disassemble } from './disasm.js';

const LOAD_ADDR = 0x0200;

// Small programs chosen to look different on the die: one exercises the stack
// and the ALU, one is pure ALU and zero-page traffic, one hammers the address
// bus with indexed writes.
const PROGRAMS = [
  {
    name: 'Counter (visual6502 default)',
    bytes: [
      0xa9, 0x00,             // LDA #$00
      0x20, 0x10, 0x02,       // JSR $0210
      0x4c, 0x02, 0x02,       // JMP $0202
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0xe8,                   // $0210  INX
      0x88,                   //        DEY
      0xe6, 0x0f,             //        INC $0F
      0x38,                   //        SEC
      0x69, 0x02,             //        ADC #$02
      0x60,                   //        RTS
    ],
  },
  {
    name: 'Fibonacci (zero page $F0)',
    bytes: [
      0xa9, 0x00,       // LDA #$00
      0x85, 0xf0,       // STA $F0
      0xa9, 0x01,       // LDA #$01
      0x85, 0xf1,       // STA $F1
      0xa5, 0xf0,       // $0208 LDA $F0
      0x18,             //       CLC
      0x65, 0xf1,       //       ADC $F1
      0x85, 0xf2,       //       STA $F2
      0xa5, 0xf1,       //       LDA $F1
      0x85, 0xf0,       //       STA $F0
      0xa5, 0xf2,       //       LDA $F2
      0x85, 0xf1,       //       STA $F1
      0x4c, 0x08, 0x02, //       JMP $0208
    ],
  },
  {
    name: 'Fill page $0300',
    bytes: [
      0xa2, 0x00,       // LDX #$00
      0x8a,             // $0202 TXA
      0x9d, 0x00, 0x03, //       STA $0300,X
      0xe8,             //       INX
      0xd0, 0xf9,       //       BNE $0202
      0x4c, 0x00, 0x02, //       JMP $0200
    ],
  },
];

const $ = (id) => document.getElementById(id);
const hex = (v, n) => v.toString(16).padStart(n, '0').toUpperCase();

const state = {
  machine: null,
  renderer: null,
  running: false,
  speed: 16,
  selection: null,     // { node, group: number[] }
  traceGroup: true,
  mouse: { x: 0, y: 0, inside: false, moved: false },
  dragging: false,
  scrubbing: false,
  frames: 0,
  fpsTime: 0,
  lastHalfCycle: -1,
  rails: [],
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  const status = $('boot-status');
  const bar = $('boot-bar-fill');
  const setProgress = (pct, text) => {
    bar.style.width = pct + '%';
    if (text) status.textContent = text;
  };

  try {
    setProgress(10, 'Loading simulator…');
    // The wasm and the 1.5 MB of die geometry are independent; fetch together.
    const [, layoutBuffer] = await Promise.all([
      init(),
      fetch('layout.bin').then((r) => {
        if (!r.ok) {
          throw new Error(
            `layout.bin: ${r.status} ${r.statusText}\n` +
            'Generate it with:\n' +
            '  cargo run -p v6502-netlist --bin export-layout -- web/layout.bin'
          );
        }
        return r.arrayBuffer();
      }),
    ]);

    setProgress(55, 'Decoding die geometry…');
    const layout = parseLayout(layoutBuffer);

    setProgress(70, 'Building the chip…');
    state.machine = new Machine();

    setProgress(85, 'Uploading geometry…');
    state.renderer = new DieRenderer($('die'), layout, state.machine.nodeCount());
    // Power rails cover most of the die; keep them out of the state overlay.
    state.rails = [state.machine.nodeId('vss'), state.machine.nodeId('vcc')].filter((n) => n >= 0);
    state.renderer.setRailNodes(state.rails);

    $('chip-facts').textContent =
      `${netlistInfo()} · ${(layout.vertexCount / 3).toLocaleString()} triangles`;

    setupUI();

    setProgress(100, 'Ready');
    $('boot').hidden = true;
    $('app').hidden = false;
    // Measure only once the panel is visible -- the canvas has no useful size
    // while hidden, and anything that frames the camera before this point would
    // be computing against a 1x1 viewport.
    state.renderer.resize();
    applyUrlParams();
    requestAnimationFrame(frame);
  } catch (err) {
    status.textContent = 'Failed to start';
    const box = $('boot-error');
    box.hidden = false;
    box.textContent = String(err && err.message ? err.message : err);
    console.error(err);
  }
}

function loadProgram(index) {
  const prog = PROGRAMS[index];
  const m = state.machine;
  m.load(LOAD_ADDR, new Uint8Array(prog.bytes));
  m.setResetVector(LOAD_ADDR);
  m.powerCycle();
  state.lastHalfCycle = -1;
  clearSelection();
}

/**
 * Deep links, in the spirit of the original's query parameters:
 *   ?program=1&run=1&speed=64&find=sync
 * so a particular view of a particular signal can be shared.
 */
function applyUrlParams() {
  const p = new URLSearchParams(location.search);

  const programIndex = Number(p.get('program') ?? 0);
  const index = Number.isInteger(programIndex) && PROGRAMS[programIndex] ? programIndex : 0;
  $('program-select').value = String(index);
  loadProgram(index);

  if (p.has('speed')) {
    const speed = Number(p.get('speed'));
    if (Number.isFinite(speed) && speed >= 0) {
      state.speed = speed;
      const sel = $('speed');
      if ([...sel.options].some((o) => Number(o.value) === speed)) sel.value = String(speed);
    }
  }

  // Advance to a specific half-cycle before showing anything, so a link can
  // point at one moment in the chip's life. Capped: this runs synchronously
  // before the first paint, and the chip simulates at roughly 20k half-cycles
  // per second, so an unbounded value would look like a hang.
  const steps = Number(p.get('steps') ?? 0);
  if (Number.isFinite(steps) && steps > 0) {
    state.machine.runHalfCycles(Math.min(steps, 50000));
  }

  if (p.has('find')) {
    $('find-input').value = p.get('find');
    runFind();
  }

  if (p.get('run') === '1') setRunning(true);
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

function setupUI() {
  const r = state.renderer;

  const select = $('program-select');
  PROGRAMS.forEach((p, i) => select.add(new Option(p.name, String(i))));
  select.onchange = () => {
    setRunning(false);
    loadProgram(Number(select.value));
  };

  // -- layers --
  const layers = $('layers');
  LAYER_INFO.forEach((info) => {
    const row = document.createElement('div');
    row.className = 'layer-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.id = `layer-${info.id}`;
    cb.onchange = () => r.setLayerVisible(info.id, cb.checked);
    const sw = document.createElement('span');
    sw.className = 'layer-swatch';
    sw.style.background = `rgb(${info.color.map((c) => Math.round(c * 255)).join(',')})`;
    const label = document.createElement('label');
    label.htmlFor = cb.id;
    label.textContent = info.name;
    row.append(cb, sw, label);
    layers.append(row);
  });

  $('dim').oninput = (e) => { r.dim = Number(e.target.value) / 100; };
  $('bloom').oninput = (e) => { r.bloomAmount = Number(e.target.value) / 100; };

  // -- transport --
  $('btn-run').onclick = () => setRunning(!state.running);
  $('btn-half').onclick = () => { setRunning(false); state.machine.halfStep(); };
  $('btn-cycle').onclick = () => { setRunning(false); state.machine.stepCycle(); };
  $('btn-instr').onclick = () => { setRunning(false); state.machine.stepInstruction(400); };
  $('btn-back').onclick = () => { setRunning(false); state.machine.stepBack(); };
  $('btn-reset').onclick = () => { setRunning(false); resetMachine(); };
  $('speed').onchange = (e) => { state.speed = Number(e.target.value); };

  // -- scrubber --
  const scrub = $('scrub');
  scrub.oninput = () => {
    state.scrubbing = true;
    setRunning(false);
    state.machine.rewindTo(Number(scrub.value));
  };
  scrub.onchange = () => { state.scrubbing = false; };

  // -- selection --
  $('trace-group').onchange = (e) => {
    state.traceGroup = e.target.checked;
    if (state.selection) selectNode(state.selection.node, false);
  };
  $('find-btn').onclick = runFind;
  $('find-input').onkeydown = (e) => { if (e.key === 'Enter') runFind(); };

  // -- memory --
  $('mem-addr').onchange = () => { $('mem-follow').checked = false; };

  setupCanvasInput();
  setupKeyboard();
  window.addEventListener('resize', () => r.resize());
}

function setupCanvasInput() {
  const canvas = $('die');
  const r = state.renderer;
  let dragStart = null;
  let movedDuring = 0;

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    dragStart = { x: e.clientX, y: e.clientY };
    movedDuring = 0;
    state.dragging = true;
    canvas.classList.add('dragging');
  });

  canvas.addEventListener('pointermove', (e) => {
    state.mouse.x = e.clientX;
    state.mouse.y = e.clientY;
    state.mouse.inside = true;
    state.mouse.moved = true;
    if (dragStart) {
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      movedDuring += Math.abs(dx) + Math.abs(dy);
      r.panByPixels(dx, dy);
      dragStart = { x: e.clientX, y: e.clientY };
    }
  });

  canvas.addEventListener('pointerup', (e) => {
    canvas.releasePointerCapture(e.pointerId);
    state.dragging = false;
    canvas.classList.remove('dragging');
    // A click is a drag that went nowhere.
    if (movedDuring < 4) {
      const hit = r.pick(e.clientX, e.clientY);
      if (hit) selectNode(hit.node, false);
      else clearSelection();
    }
    dragStart = null;
  });

  canvas.addEventListener('pointerleave', () => {
    state.mouse.inside = false;
    $('hover-card').hidden = true;
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    // Exponential in the wheel delta so trackpads and mice both feel right.
    r.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0016));
  }, { passive: false });

  canvas.addEventListener('dblclick', (e) => {
    const hit = r.pick(e.clientX, e.clientY);
    if (hit) selectNode(hit.node, true);
  });
}

function setupKeyboard() {
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    switch (e.key) {
      case ' ': e.preventDefault(); setRunning(!state.running); break;
      case '.': setRunning(false); state.machine.halfStep(); break;
      case ',': setRunning(false); state.machine.stepBack(); break;
      case 'c': setRunning(false); state.machine.stepCycle(); break;
      case 'i': setRunning(false); state.machine.stepInstruction(400); break;
      case 'r': setRunning(false); resetMachine(); break;
      case 'f': state.renderer.fitToDie(); break;
      case 'Escape': clearSelection(); break;
    }
  });
}

/** Cold boot, clearing everything derived from the run that just ended. */
function resetMachine() {
  state.machine.powerCycle();
  state.lastHalfCycle = -1;
}

function setRunning(on) {
  state.running = on;
  $('btn-run').textContent = on ? '❚❚' : '▶';
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function selectNode(node, zoom) {
  const m = state.machine;
  const group = state.traceGroup ? Array.from(m.nodeGroup(node)) : [node];
  state.selection = { node, group };
  state.renderer.setHighlight(group);
  if (zoom) {
    // Frame the signal, not the power rail it happens to be driven by: vcc and
    // vss span the whole die, so including them would always zoom to fit
    // everything and look like the zoom did nothing.
    const target = group.filter((n) => !state.rails.includes(n));
    state.renderer.zoomToNodes(target.length ? target : [node]);
  }
  renderSelection();
}

function clearSelection() {
  state.selection = null;
  state.renderer.setHighlight([]);
  renderSelection();
}

function renderSelection() {
  const el = $('selection');
  if (!state.selection) {
    el.innerHTML = 'Nothing selected. Click a wire on the die.';
    return;
  }
  const m = state.machine;
  const { node, group } = state.selection;
  const name = m.nodeName(node);
  const level = m.isNodeHigh(node) ? 'high' : 'low';

  const named = group
    .map((n) => m.nodeName(n) || `#${n}`)
    .sort((a, b) => a.localeCompare(b));

  el.innerHTML = `
    <div><span class="sel-name">${name ? escapeHtml(name) : `node ${node}`}</span>
      <span class="sel-meta">· node ${node} · ${level}</span></div>
    ${group.length > 1
      ? `<div class="sel-sub">connected to ${group.length - 1} other node${group.length === 2 ? '' : 's'} right now:</div>
         <div class="sel-list">${escapeHtml(named.join(', '))}</div>`
      : '<div class="sel-sub sel-meta">isolated at this instant</div>'}
  `;
}

function runFind() {
  const raw = $('find-input').value.trim();
  if (!raw) return;
  const m = state.machine;
  let node = m.nodeId(raw);
  if (node < 0 && /^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n >= 0 && n < m.nodeCount()) node = n;
  }
  if (node < 0) {
    $('selection').innerHTML =
      `<span class="sel-error">No signal named “${escapeHtml(raw)}”.</span>`;
    return;
  }
  selectNode(node, true);
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------------------------------------------------------------------------
// Per-frame
// ---------------------------------------------------------------------------

function frame(now) {
  const m = state.machine;
  const r = state.renderer;

  if (state.running && !state.scrubbing) {
    if (state.speed === 0) {
      // Time-budgeted: keep stepping until we would miss the frame.
      const deadline = performance.now() + 9;
      do { m.runHalfCycles(8); } while (performance.now() < deadline);
    } else {
      m.runHalfCycles(state.speed);
    }
  }

  // The chip only needs re-uploading when it has actually advanced.
  const hc = m.halfCycle();
  if (hc !== state.lastHalfCycle) {
    r.setNodeLevels(m.nodeLevels());
    updatePanels();
    // A live selection's connected group changes as transistors switch.
    if (state.selection && state.traceGroup) {
      const group = Array.from(m.nodeGroup(state.selection.node));
      state.selection.group = group;
      r.setHighlight(group);
    }
    state.lastHalfCycle = hc;
  }

  r.render();
  updateHover();

  state.frames++;
  if (now - state.fpsTime > 500) {
    const fps = (state.frames * 1000) / (now - state.fpsTime);
    const hz = state.running ? ` · ${(fps * currentSpeed() / 2).toFixed(0)} Hz` : '';
    $('fps').textContent = `${fps.toFixed(0)} fps${hz}`;
    state.frames = 0;
    state.fpsTime = now;
  }

  requestAnimationFrame(frame);
}

function currentSpeed() {
  return state.speed === 0 ? 64 : state.speed;
}

function updateHover() {
  const card = $('hover-card');
  if (!state.mouse.inside || state.dragging) {
    card.hidden = true;
    return;
  }
  if (!state.mouse.moved) return;
  state.mouse.moved = false;

  const hit = state.renderer.pick(state.mouse.x, state.mouse.y);
  if (!hit) {
    card.hidden = true;
    return;
  }
  const m = state.machine;
  const name = m.nodeName(hit.node);
  const high = m.isNodeHigh(hit.node);
  const layer = LAYER_INFO[hit.layer];

  card.innerHTML =
    `<div class="hc-name">${name ? escapeHtml(name) : `node ${hit.node}`}</div>` +
    (name ? `<div class="hc-meta">node ${hit.node}</div>` : '') +
    `<div class="${high ? 'hc-high' : 'hc-low'}">${high ? '● high' : '○ low'}</div>` +
    `<div class="hc-meta">${layer ? layer.name : 'layer ' + hit.layer}</div>`;
  card.hidden = false;

  // Keep the card on screen near the cursor.
  const stage = $('stage').getBoundingClientRect();
  const w = card.offsetWidth;
  const h = card.offsetHeight;
  let x = state.mouse.x - stage.left + 16;
  let y = state.mouse.y - stage.top + 16;
  if (x + w > stage.width - 8) x = state.mouse.x - stage.left - w - 16;
  if (y + h > stage.height - 8) y = state.mouse.y - stage.top - h - 16;
  card.style.left = Math.max(4, x) + 'px';
  card.style.top = Math.max(4, y) + 'px';
}

function updatePanels() {
  const m = state.machine;

  $('r-pc').textContent = hex(m.pc(), 4);
  $('r-a').textContent = hex(m.a(), 2);
  $('r-x').textContent = hex(m.x(), 2);
  $('r-y').textContent = hex(m.y(), 2);
  $('r-s').textContent = hex(m.s(), 2);

  // Flags come back as NV-BDIZC with case carrying the value.
  const flags = m.flagsString();
  $('flags').innerHTML = [...flags]
    .map((ch) => {
      const on = ch === ch.toUpperCase() && ch !== '-';
      return `<span class="flag ${on ? 'on' : ''}">${ch.toUpperCase()}</span>`;
    })
    .join('');

  const ab = m.addressBus();
  const db = m.dataBus();
  $('b-ab').textContent = hex(ab, 4);
  $('b-db').textContent = hex(db, 2);
  $('b-rw').textContent = m.isRead() ? 'read' : 'write';
  $('b-cycle').textContent = m.cycle().toLocaleString();
  $('b-half').textContent = m.halfCycle().toLocaleString();
  $('b-phase').textContent = 'φ' + m.phase();

  togglePin('pin-sync', m.sync());
  togglePin('pin-clk', m.clk0());
  togglePin('pin-rw', m.isRead());

  // The T-state chain, with active states emphasised.
  $('tstates').innerHTML = m
    .timingFixedWidth()
    .split(' ')
    .map((tok) => (tok.startsWith('.') ? tok : `<b>${escapeHtml(tok)}</b>`))
    .join(' ');

  // Disassembly of the instruction in flight.
  //
  // The simulator latches each opcode fetch, so this is correct however coarsely
  // we step. Reading the instruction register instead would not be: IR holds the
  // opcode, but PC has already advanced past its operands.
  const fetchAddr = m.lastFetchAddr();
  const el = $('disasm');
  if (fetchAddr >= 0) {
    const d = disassemble(m.lastFetchOpcode(), fetchAddr, (a) => m.peek(a));
    el.textContent = `${hex(fetchAddr, 4)}  ${d.text}`;
    el.classList.toggle('undoc', d.undocumented);
  } else {
    el.textContent = '—';
    el.classList.remove('undoc');
  }

  updateMemory(ab);
  updateScrubber();
}

function togglePin(id, on) {
  $(id).classList.toggle('on', !!on);
}

function updateMemory(ab) {
  const m = state.machine;
  const follow = $('mem-follow').checked;
  let base;
  if (follow) {
    base = (ab - 0x40) & 0xffff & ~0xf;
    $('mem-addr').value = hex(base, 4);
  } else {
    base = (parseInt($('mem-addr').value, 16) || 0) & 0xfff0;
  }

  const rows = [];
  for (let r = 0; r < 8; r++) {
    const addr = (base + r * 16) & 0xffff;
    const bytes = m.memorySlice(addr, 16);
    let line = `<span class="addr">${hex(addr, 4)}</span> `;
    for (let i = 0; i < 16; i++) {
      const cell = hex(bytes[i], 2);
      const isCursor = ((addr + i) & 0xffff) === ab;
      line += (isCursor ? `<span class="cur">${cell}</span>` : cell) + (i === 7 ? '  ' : ' ');
    }
    rows.push(line);
  }
  $('memory').innerHTML = rows.join('\n');
}

function updateScrubber() {
  if (state.scrubbing) return;
  const m = state.machine;
  const scrub = $('scrub');
  const now = m.halfCycle();
  const earliest = m.earliestHalfCycle();
  scrub.min = earliest < 0 ? 0 : earliest;
  scrub.max = now;
  scrub.value = now;
  $('scrub-label').textContent =
    earliest < 0
      ? `half-cycle ${now}`
      : `half-cycle ${now.toLocaleString()} · rewind to ${Math.round(earliest).toLocaleString()}`;
}

boot();
