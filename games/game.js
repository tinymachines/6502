/* Die Runner: the page around the console.
 * ===========================================================================
 * Loads a cartridge, powers the chip, and runs frames as fast as the round
 * trip allows -- which is the actual frame rate, since a frame of chip time is
 * 0.3 ms and a request is two hundred times that.
 */
import { Console6502 } from './console.js';
import { starterTiles, decodeCHR, buildSheet, drawScreen, TILE } from './chr.js';

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
  // A page higher than the first cartridge's: this ROM grew past $0400 when
  // the scenery arrived, and a ROM that reaches its own screen is overwritten
  // by its own display.
  screen: 0x0500,
  width: 16,
  height: 16,
  // Measured by /v1/cartridge, which brackets the tick flag and then walks
  // the last chunk in sixteenths. The 12000 that stood here was the chunker's
  // own arithmetic read back as a measurement: the console requests the first
  // chunk at frameCost and then reports the half-cycles it spent, so whatever
  // was written here confirmed itself. The true steady cost is 8704, rock
  // solid over twelve frames; the first frame is 5440.
  frameCost: 8704,
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
  /* What each line opens, DERIVED rather than typed: this is what
   * /v1/cartridge reads out of the switch network, and it is the same list a
   * minted cartridge carries. The eight that stood here by hand agreed on
   * five. The three that moved are the useful part: ADDADL and ADHPCH open
   * one switch a bit and the hand-written pair had picked bit 2 and bit 3,
   * where bit 0 is canonical; and XSB joins sb0 to a node THE DIE NEVER
   * NAMED, so `x0 - sb0` was naming the register a reader knows is there.
   * The atlas says that node is owned by regs:x, which is the measured
   * version of the same claim. The pair is unordered: a pass transistor
   * conducts both ways, so the order here is alphabetical and means nothing.
   */
  joins: ['idb0 - sb0', 'alub0 - idb0', 'adl0 - alub0', 'adl0 - alu0',
          'a0 - sb0', 'adh0 - pch0', 'adl0 - pcl0', 'regs:x - sb0'],
  over: (v) => v !== 0,
  blurb: 'Ride the metal. Thread the gates. A pass transistor conducts on one '
       + 'clock phase and blocks on the other, so a channel that is shut now '
       + 'will open in a moment.',
};

const CARTS = [DIERUNNER, SNAKE];

/* -- cartridges from a file ------------------------------------------------
 * A .cart.gz is gzipped JSON carrying the ROM, its tiles and the contract it
 * was written to, all three together. That togetherness is the whole point of
 * the format: this page needs eight addresses to play a game and there is no
 * hardware to ask about any of them, so a cartridge whose contract lived in a
 * different file from its bytes would be the copy that drifts. Die Runner
 * learned that when its screen moved and one of four places naming it was
 * missed -- the game drew unrelated memory and nothing errored.
 *
 * `?cart=<url>` loads one, and so does the file picker. Minted by
 * POST /api/v1/cartridge, which refuses a layout that cannot work.
 */
async function ungzip(buf) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('this browser cannot un-gzip; DecompressionStream is missing');
  }
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

function cartFromDoc(doc) {
  if (doc.format !== 'tinymachines.cartridge') {
    throw new Error(`format is ${doc.format || 'missing'}, not tinymachines.cartridge`);
  }
  const c = doc.console || {};
  const rom = doc.rom || {};
  if (c.kind === 'headless') {
    // No screen page and no tick flag: nothing here could draw it, and a
    // console that booted it would show a blank screen and call it a game.
    throw new Error(`${(doc.meta && doc.meta.name) || 'this cartridge'} is headless: it draws nothing. `
      + 'Its page in the registry shows what it computed; the explorer runs it.');
  }
  const bytes = Uint8Array.from((rom.bytes || '').match(/../g) || [],
                                (h) => parseInt(h, 16));
  if (!bytes.length) throw new Error('the cartridge carries no ROM bytes');
  return {
    name: (doc.meta && doc.meta.name) || 'cartridge',
    blurb: doc.meta && doc.meta.blurb,
    bytes,
    org: rom.org ?? 0x0200,
    reset: rom.reset ?? rom.org ?? 0x0200,
    tick: c.tick ?? 0x000d,
    input: c.input ?? 0x0002,
    status: c.status,
    score: c.score,
    entropy: c.entropy,
    gateMask: c.gate_mask,
    screen: c.screen ?? 0x0500,
    width: c.width ?? 16,
    height: c.height ?? 16,
    frameCost: c.frame_cost,
    dirs: c.dirs || {},
    watch: c.watch || [],
    joins: c.joins || [],
    tiles: {},
    chr: doc.tiles && doc.tiles.chr,
    over: (v) => v !== 0,
  };
}

/** Take a loaded cartridge over: its tiles are its own, so they replace the
 *  sheet, and the picker gains an entry for it rather than lying about which
 *  cartridge is on screen. */
function useCart(cart) {
  CARTS.push(cart);
  const opt = document.createElement('option');
  opt.value = String(CARTS.length - 1);
  opt.textContent = `${cart.name} (loaded)`;
  $('#cart').append(opt);
  $('#cart').value = opt.value;
  state.cart = cart;
  state.con = null;
  state.running = false;
  state.gen++;
  // Decoded ONTO the cartridge, once, so the set travels with it and the
  // picker can put it back, or put the house set back, later. `tileset` and
  // not `tiles`: `tiles` is already the per-cartridge index remap that
  // drawScreen applies.
  if (cart.chr && cart.chr.length >= 32) {
    const t = decodeCHR(Uint8Array.from(cart.chr.match(/../g), (h) => parseInt(h, 16)));
    if (t.length) cart.tileset = t;
  }
  selectTiles();
  $('#note').textContent = cart.blurb || 'A cartridge, loaded from a file.';
  $('#k-cart').textContent = `${cart.name} · ${cart.bytes.length}B`;
  $('#b-power').textContent = 'power on';
  $('#b-pause').disabled = true;
  fit();
  legend();
  preview();
  say(`${cart.name}: ${cart.bytes.length} bytes, ${TILES.length} tiles. Power on to run it.`);
}

async function loadCartFrom(url) {
  say(`loading ${url} ...`);
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  useCart(cartFromDoc(JSON.parse(await ungzip(await r.arrayBuffer()))));
}

/* The tile set. `art/tiles.chr` is the shipped sheet; the drawn-in-code
 * starter set is the fallback AND the spec, so a missing or broken sheet costs
 * the artwork and nothing else -- the game still renders, in shapes that are
 * by definition the ones the sheet was meant to match. */
let TILES = starterTiles(16);

// The shipped sheet, held apart from TILES because TILES follows the
// cartridge on screen. A loaded cartridge brings its own set, and when a
// built-in one is chosen afterwards the house set has to come back. For as
// long as ?cart= existed nothing put it back: the next cartridge drew in the
// linked one's sprites, and the legend, painted from the same TILES the
// screen draws from, agreed with the wrong screen. Reported from the apex
// site's console with the owner's repro (Die Invaders, then Silicon Snake:
// snake and food drawn as invaders and a ship).
let HOUSE = TILES;

/** Point TILES at the cartridge on screen. The sheet is a property of the
 *  cartridge, not of the page: a cartridge with its own CHR draws in it and
 *  every other one draws in the house set. Called wherever `state.cart` or
 *  HOUSE changes. */
function selectTiles() {
  const want = (state.cart && state.cart.tileset) || HOUSE;
  if (want === TILES) return;
  TILES = want;
  state.sheet = null;              // the atlas was built from the old set
  legend();
}

async function loadTiles() {
  try {
    // Resolved against THIS MODULE's url, not the document's. The page is
    // served at /b/<handle>/<slug> as well as at /, and a document-relative
    // fetch there asks for /b/<handle>/art/tiles.chr. Same reason the wasm
    // glue uses new URL(..., import.meta.url).
    const r = await fetch(new URL('art/tiles.chr', import.meta.url), { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const chr = new Uint8Array(await r.arrayBuffer());
    if (chr.length < 16) throw new Error(`${chr.length} bytes is not a tile`);
    const t = decodeCHR(chr);
    if (!t.length) throw new Error('no tiles in it');
    // A linked cartridge can land before this sheet does. Its own set stays
    // on screen while it is selected; the house set is here for the next one.
    HOUSE = t;
    selectTiles();
    fit();
    if (state.con) paint(); else preview();
  } catch (e) {
    // Not an error the player needs: the starter set is a real tile set.
    console.info('art/tiles.chr not loaded, drawing the starter set:', e.message);
  }
}

const state = {
  con: null, cart: CARTS[0], sheet: null, running: false, input: 0,
  fpsAt: 0, fpsFrames: 0, scale: 2,
  // When the last frame was released, for `data-frame-ms` pacing. See `loop`.
  paceAt: 0,
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
  state.sheet = buildSheet(TILES, s);
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

/* The legend's swatches are the REAL tiles, drawn from the same sheet the game
 * draws from, so a key cannot show something the screen does not. */
function legend() {
  for (const i of document.querySelectorAll('.legend i')) {
    const t = +i.className.slice(1);
    if (!Number.isFinite(t) || !TILES[t]) continue;
    const c = document.createElement('canvas');
    c.width = c.height = TILE * 2;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    const one = buildSheet([TILES[t]], 2);
    g.drawImage(one.canvas, 0, 0, TILE * 2, TILE * 2, 0, 0, TILE * 2, TILE * 2);
    i.style.backgroundImage = `url(${c.toDataURL()})`;
    i.style.backgroundSize = 'cover';
  }
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
      <span>${(c.joins && c.joins[g]) || ''}</span>
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

/**
 * How long a frame must last, in milliseconds, or 0 for as fast as the round
 * trip allows.
 *
 * Read from `[data-frame-ms]` on the page rather than from a control here, so
 * a host embedding this console can pace it without forking the loop: the
 * apex site carried an eleven-line build-time patch to do exactly this for its
 * fast/slow switch, and a patch that has to be reapplied on every upstream
 * change is a fork with extra steps.
 *
 * A PERIOD, not a rate, because it composes with the round trip instead of
 * fighting it: a frame is a request that already takes about 200ms, so the
 * longer of the two wins and asking for 10ms frames changes nothing. Read
 * every frame, so the value can change while the console runs.
 */
function frameMs() {
  const el = document.querySelector('[data-frame-ms]');
  const v = el ? Number(el.dataset.frameMs) : 0;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

async function loop(gen) {
  while (state.running && gen === state.gen) {
    try {
      // Pace before the work, not after: waiting afterwards would add the
      // period to the round trip rather than absorbing it.
      const period = frameMs();
      if (period) {
        const wait = period - (performance.now() - state.paceAt);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (gen !== state.gen) return;   // rechecked after the await, as ever
        if (!state.running) return;
      }
      state.paceAt = performance.now();
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
    // A loaded cartridge carries its bytes; a built-in one is a file beside
    // this page. Either way what reaches the console is a Uint8Array.
    const cart = state.cart;           // the one being booted, not the current one
    let rom = cart.bytes;
    if (!rom) {
      const r = await fetch(new URL(cart.rom, import.meta.url));
      if (!r.ok) throw new Error(`${cart.rom}: HTTP ${r.status}`);
      rom = new Uint8Array(await r.arrayBuffer());
    }
    // Anything decided before an await has to be rechecked after it, the rule
    // `loop` already keeps. Changing the cartridge mid-boot bumps `gen`, nulls
    // `state.con` and puts the button back to "power on"; without this guard
    // the in-flight boot resumed and overwrote all three, painting a live
    // console whose `loop` then exited at once on the stale gen. It also built
    // the console from the NEW cartridge's contract over the OLD cartridge's
    // bytes, so a later resume ran the wrong ROM. Reported from the apex
    // site's console shell, with a repro.
    if (gen !== state.gen) return;
    $('#k-cart').textContent = `${cart.name} · ${rom.length}B`;
    state.con = new Console6502(cart, rom, API);
    await state.con.power();
    if (gen !== state.gen) return;
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
  selectTiles();
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
  const n = Math.min(TILES.length, 16);
  for (let t = 0; t < n; t++) {
    demo[(4 + ((t / 8) | 0) * 3) * SNAKE.width + 1 + (t % 8) * 2] = t;
  }
  drawScreen($('#screen').getContext('2d'), state.sheet, demo, SNAKE.width, SNAKE.height);
  say(`${n} tiles. Power on to run the cartridge.`);
}
$('#cart-file').onchange = async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    useCart(cartFromDoc(JSON.parse(await ungzip(await file.arrayBuffer()))));
  } catch (err) {
    say(`${file.name}: ${err.message}`, true);
  }
  e.target.value = '';
};

$('#note').textContent = CARTS[0].blurb;
preview();
legend();
loadTiles();

// A cartridge named in the URL wins over the built-in one, because a link
// naming a cartridge is somebody asking for it. Two spellings: an explicit
// ?cart=<url>, and /b/<handle>/<slug>, which nginx serves this same document
// for so that a published ROM has a URL of its own rather than a query string.
function wantedCart() {
  const explicit = new URLSearchParams(location.search).get('cart');
  if (explicit) return { url: explicit, from: null };
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts[0] === 'b' && parts.length >= 3) {
    const [, handle, slug] = parts;
    return {
      url: `${API}/v1/registry/b/${encodeURIComponent(handle)}`
         + `/roms/${encodeURIComponent(slug)}/cart`,
      from: { handle, slug },
    };
  }
  return null;
}

const WANT = wantedCart();
if (WANT) {
  if (WANT.from) {
    // A way back to whoever published it. Added before the fetch, so it is
    // there even if the cartridge turns out not to load.
    const back = document.createElement('span');
    back.className = 'sub';
    back.innerHTML = ' &middot; <a href="/b/' + WANT.from.handle + '">by '
      + WANT.from.handle.replace(/[<>&"]/g, '') + '</a>';
    document.querySelector('header .sub').after(back);
  }
  loadCartFrom(WANT.url).catch((e) => say(`could not load that cartridge: ${e.message}`, true));
}
