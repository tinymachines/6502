/* Die Runner: the page around the console.
 * ===========================================================================
 * Loads a cartridge, powers the chip, and runs frames as fast as the round
 * trip allows -- which is the actual frame rate, since a frame of chip time is
 * 0.3 ms and a request is two hundred times that.
 */
import { Console6502 } from './console.js';
import { starterTiles, buildSheet, drawScreen, TILE } from './chr.js';

const $ = (s) => document.querySelector(s);
const API = new URLSearchParams(location.search).get('api') || `${location.origin}/api`;

/* -- cartridge zero -------------------------------------------------------
 * Silicon Snake. Every address here was read off the disassembly and then
 * confirmed on the running chip, not guessed: an earlier reading had 2 = right
 * and the snake walked downwards to say otherwise.
 *
 * `tiles` maps the ROM's cell values onto the tile set. The ROM knows nothing
 * about tiles; it writes 0, 1 and 2, and the console decides what those look
 * like. That indirection is what lets one cartridge wear a new sprite sheet.
 */
const SNAKE = {
  name: 'Silicon Snake',
  rom: 'rom/snake.rom',
  org: 0x0200,
  reset: 0x0200,
  tick: 0x000d,
  input: 0x0002,
  status: 0x0003,
  screen: 0x0400,
  width: 16,
  height: 16,
  // Measured, not padded: the ROM raises its flag after exactly 600
  // half-cycles, so one request of 600 completes a frame and the top-up
  // chunks below never run. Padding it to 800 made the HUD report 800 and
  // spend the difference in the spin loop.
  frameCost: 600,
  dirs: { up: 1, down: 2, left: 3, right: 4 },
  tiles: { 0: 0, 1: 1, 2: 2 },  // empty -> substrate, body -> metal, food -> charge
  over: (v) => v !== 0,
};

/* -- cartridge one --------------------------------------------------------
 * Die Runner, written for this console in 6502 and assembled by this
 * project's own assembler. It writes tile indices straight into the screen
 * page, so there is no mapping table: what the ROM stores is what gets drawn.
 */
const DIERUNNER = {
  name: 'Die Runner',
  rom: 'rom/dierunner.rom',
  org: 0x0200,
  reset: 0x0200,
  tick: 0x000d,
  input: 0x0002,
  status: 0x0003,
  score: 0x0011,
  screen: 0x0400,
  width: 16,
  height: 16,
  frameCost: 8400,              // measured
  dirs: { up: 0, down: 0, left: 3, right: 4 },
  tiles: {},                    // the ROM addresses tiles directly
  gateMask: 0x0014,
  /* The eight gates are REAL switches on this die, and each conducts exactly
   * when its own control line is high on the chip running the game. Chosen by
   * measurement rather than taste: these are the lines that gate a switch
   * between two NAMED nodes and that actually move while this ROM executes.
   * Twenty-four frames of play flipped them 10, 9, 9, 6, 4, 4, 4 and 2 times;
   * the ones that never moved would have made a gate that is always shut or
   * always open, which is scenery rather than a gate. */
  watch: ['dpc25_SBDB', 'dpc9_DBADD', 'dpc10_ADLADD', 'dpc21_ADDADL',
          'dpc23_SBAC', 'dpc30_ADHPCH', 'dpc40_ADLPCL', 'dpc2_XSB'],
  joins: ['sb0 - idb0', 'idb0 - alub0', 'adl0 - alub0', 'alu2 - adl2',
          'sb0 - a0', 'pch3 - adh3', 'adl0 - pcl0', 'x0 - sb0'],
  over: (v) => v !== 0,
  blurb: 'Ride the metal. Thread the gates. A pass transistor conducts on one '
       + 'clock phase and blocks on the other, so a channel that is shut now '
       + 'will open in a moment.',
};

const CARTS = [DIERUNNER, SNAKE];

const state = {
  con: null, cart: CARTS[0], sheet: null, running: false, input: 0,
  fpsAt: 0, fpsFrames: 0, scale: 2,
  // Anything decided before an await has to be rechecked after it. A frame IS
  // a round trip, so powering on or changing cartridge while one is in flight
  // left the OLD loop alive: it woke up, saw `running` true again, and carried
  // on driving a console that had been replaced. Two loops, one machine, and
  // the failure surfaced as "the engine stopped answering" while the engine
  // was answering every request with a 200. Each loop carries the generation
  // it started in and stops the moment that is stale.
  gen: 0,
};

function say(msg, bad) {
  const e = $('#err');
  e.hidden = !msg;
  e.textContent = msg || '';
  if (msg && !bad) e.style.color = 'var(--dim)';
  else e.style.removeProperty('color');
}

function fit() {
  const c = state.cart;
  const box = $('.screen').clientWidth - 18;
  // Integer scale only: a tile is 8 pixels and a fractional scale turns
  // pixel art into porridge. Never below 1.
  const s = Math.max(1, Math.min(6, Math.floor(box / (c.width * TILE))));
  if (s === state.scale && state.sheet) return;
  state.scale = s;
  state.sheet = buildSheet(starterTiles(), s);
  const cv = $('#screen');
  cv.width = c.width * TILE * s;
  cv.height = c.height * TILE * s;
  cv.getContext('2d').imageSmoothingEnabled = false;
}

function paint() {
  const c = state.cart;
  const cells = state.con.screen();
  // The ROM's values are not tile numbers. Map them, and let anything
  // unmapped through as itself, so a cartridge can address tiles directly.
  const idx = new Uint8Array(cells.length);
  const mask = state.con.mask;
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i];
    // 16+g and 24+g are the two channels of gate g. What is drawn and what
    // kills you come from the same byte, so the picture cannot lie about
    // which way is open.
    if (v >= 16 && v < 32) {
      const g = v & 7;
      const high = (mask >> g) & 1;
      const conducts = v < 24 ? high : !high;
      idx[i] = conducts ? 6 : 7;
    } else {
      idx[i] = c.tiles[v] ?? v;
    }
  }
  drawScreen($('#screen').getContext('2d'), state.sheet, idx, c.width, c.height);
}

function gates() {
  const c = state.cart;
  const con = state.con;
  const box = $('#gates');
  if (!c.watch || !con) { box.innerHTML = ''; return; }
  box.innerHTML = c.watch.map((n, g) => {
    const high = (con.mask >> g) & 1;
    return `<div class="gate ${high ? 'hi' : 'lo'}">
      <b>${n.replace(/^dpc\d+_/, '')}</b>
      <span>${c.joins[g]}</span>
      <i>${high ? 'A' : 'B'}</i></div>`;
  }).join('');
}

function hud() {
  const con = state.con;
  gates();
  if (con && state.cart.score !== undefined) {
    $('#k-score').textContent = con.read(state.cart.score);
  }
  $('#k-hc').textContent = con ? con.halfCycle.toLocaleString() : '0';
  $('#k-frames').textContent = con ? con.frames : '0';
  $('#k-req').textContent = con ? (con.retried ? `${con.requests} (${con.retried} retried)` : con.requests) : '0';
  if (con && con.lastFrameHalfCycles) {
    $('#k-fc').textContent = con.lastFrameHalfCycles;
    $('#k-cost').textContent = con.lastFrameHalfCycles;
  }
}

async function loop(gen) {
  while (state.running && gen === state.gen) {
    try {
      // Read and clear BEFORE the await, not after. A request takes about
      // 200ms and frames run back to back, so almost every keypress lands
      // while one is in flight -- and clearing afterwards threw away the
      // press that had just arrived rather than the one that was used. The
      // snake kept going straight and the harness said so.
      const inp = state.input;
      state.input = 0;
      const r = await state.con.frame(inp || undefined);
      if (gen !== state.gen) return;    // a newer loop owns the console now
      paint();
      hud();
      if (!r.done) say('the cartridge did not raise its flag: budget spent', true);
      if (state.cart.over(state.con.read(state.cart.status))) {
        state.running = false;
        $('#b-pause').disabled = true;
        $('#b-power').textContent = 'power on';
        say('game over. Power on to run it again.');
        break;
      }
      state.fpsFrames++;
      const now = performance.now();
      if (now - state.fpsAt > 1000) {
        $('#k-fps').textContent = (state.fpsFrames * 1000 / (now - state.fpsAt)).toFixed(1);
        state.fpsAt = now;
        state.fpsFrames = 0;
      }
    } catch (e) {
      if (gen !== state.gen) return;    // torn down under us; not an error
      state.running = false;
      $('#b-pause').disabled = true;
      say(`the engine stopped answering: ${e.message}`, true);
      break;
    }
  }
}

async function power() {
  say('');
  const gen = ++state.gen;           // whatever was running is now stale
  state.running = false;
  $('#b-power').disabled = true;
  $('#b-power').textContent = 'booting...';
  try {
    const r = await fetch(state.cart.rom);
    if (!r.ok) throw new Error(`${state.cart.rom}: HTTP ${r.status}`);
    const rom = new Uint8Array(await r.arrayBuffer());
    $('#k-cart').textContent = `${state.cart.name} · ${rom.length}B`;
    state.con = new Console6502(state.cart, rom, API);
    await state.con.power();
    fit();
    paint();
    hud();
    state.running = true;
    state.fpsAt = performance.now();
    state.fpsFrames = 0;
    $('#b-pause').disabled = false;
    $('#b-pause').textContent = 'pause';
    $('#b-power').textContent = 'reset';
    loop(gen);
  } catch (e) {
    say(`could not boot: ${e.message}`, true);
  } finally {
    $('#b-power').disabled = false;
  }
}

$('#b-power').onclick = power;
$('#b-pause').onclick = () => {
  state.running = !state.running;
  $('#b-pause').textContent = state.running ? 'pause' : 'resume';
  if (state.running) { state.fpsAt = performance.now(); state.fpsFrames = 0; loop(++state.gen); }
};

const KEYS = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  w: 'up', s: 'down', a: 'left', d: 'right',
  W: 'up', S: 'down', A: 'left', D: 'right',
};
addEventListener('keydown', (e) => {
  const dir = KEYS[e.key];
  if (!dir) return;
  e.preventDefault();
  state.input = state.cart.dirs[dir];
});
for (const b of document.querySelectorAll('[data-dir]')) {
  b.onclick = () => { state.input = state.cart.dirs[b.dataset.dir]; };
}
addEventListener('resize', () => { if (state.con) { fit(); paint(); } });

$('#cart').onchange = () => {
  state.gen++;
  state.running = false;
  state.cart = CARTS[+$('#cart').value];
  state.con = null;
  $('#k-cart').textContent = '--';
  $('#k-score').textContent = '0';
  $('#note').textContent = state.cart.blurb || 'The screen is a page of the '
    + "chip's own memory. Nothing draws it but this page.";
  $('#b-pause').disabled = true;
  $('#b-power').textContent = 'power on';
  fit();
  preview();
};

// Something on screen before anything is booted: the starter tiles, laid out
// so the palette and the shapes can be judged without playing.
function preview() {
  fit();
  const demo = new Uint8Array(SNAKE.width * SNAKE.height);
  for (let i = 0; i < demo.length; i++) demo[i] = 0;
  for (let t = 0; t < 9; t++) demo[(2 + ((t / 3) | 0) * 2) * SNAKE.width + 6 + (t % 3) * 2] = t;
  drawScreen($('#screen').getContext('2d'), state.sheet, demo, SNAKE.width, SNAKE.height);
  say('nine starter tiles. Power on to run the cartridge.');
}
$('#note').textContent = CARTS[0].blurb;
preview();
