/* The console: a 6502, a page of its memory called the screen, and a contract.
 * ===========================================================================
 *
 * There is no video hardware on this chip and no interrupt line in use, so a
 * "frame" is not something the silicon knows about. It is an agreement between
 * the ROM and whatever drives it, and that agreement IS the console:
 *
 *     the host clears a byte   ->  the ROM notices, runs one frame, sets it back
 *     the host writes a byte   ->  that byte is the controller
 *     the host reads a page    ->  that page is the screen
 *
 * Nothing else is needed, and nothing else is offered. The ROM busy-waits on
 * the flag, which is the only way to synchronise with the outside world when
 * you have no interrupt and no timer -- and it works over HTTP precisely
 * because the API is stateless: the frame boundary is a memory edit between
 * two /v1/step calls, and the whole machine travels in each one.
 *
 * Measured on the first cartridge: 5400 half-cycles to initialise, then
 * exactly 600 half-cycles per frame. 300 cycles. The chip is not the
 * bottleneck by three orders of magnitude -- the round trip is, which is why
 * `run()` below batches whole frames per request wherever the cartridge lets
 * it.
 */

const HEX = (n, w) => n.toString(16).toUpperCase().padStart(w, '0');
const pkey = (p) => p.toString(16).padStart(2, '0');

/* -- memory, in the shape the API carries it: a fill byte and the pages that
 *    differ from it. A page that is all fill is dropped on the way back, which
 *    is the whole meaning of "sparse", so a reader must never assume a page
 *    exists just because it wrote one. -------------------------------------- */
export function pageOf(mem, p) {
  const hex = mem.pages[pkey(p)];
  const out = new Uint8Array(256);
  if (!hex) return out.fill(parseInt(mem.fill, 16));
  for (let i = 0; i < 256; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
export const peek = (mem, addr) => pageOf(mem, addr >> 8)[addr & 0xff];
export function poke(mem, addr, value) {
  const page = pageOf(mem, addr >> 8);
  page[addr & 0xff] = value & 0xff;
  let hex = '';
  for (const b of page) hex += b.toString(16).padStart(2, '0');
  return { fill: mem.fill, pages: { ...mem.pages, [pkey(addr >> 8)]: hex } };
}

export class Console6502 {
  /**
   * @param {object} cart  the cartridge: where its bytes go and which
   *   addresses the host and the ROM have agreed on.
   * @param {Uint8Array} rom
   * @param {string} api
   */
  constructor(cart, rom, api) {
    this.cart = cart;
    this.rom = rom;
    this.api = api || `${location.origin}/api`;
    this.machine = null;
    this.frames = 0;
    this.lastFrameHalfCycles = 0;
    this.requests = 0;
  }

  async post(path, body) {
    this.requests++;
    const r = await fetch(`${this.api}/v1/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  }

  /** Lay the ROM out, aim the reset vector at it, and power-cycle for real. */
  async power() {
    const { org, reset } = this.cart;
    const pages = {};
    for (let n = 0; n < this.rom.length; n += 256) {
      const addr = org + n;
      const page = pageOf({ fill: '00', pages: {} }, addr >> 8);
      const off = addr & 0xff;
      for (let i = 0; i + off < 256 && n + i < this.rom.length; i++) page[off + i] = this.rom[n + i];
      let hex = '';
      for (const b of page) hex += b.toString(16).padStart(2, '0');
      pages[pkey(addr >> 8)] = hex;
    }
    // $FFFC/D is the one thing every ROM needs and no ROM can place itself.
    const vec = new Uint8Array(256);
    vec[0xfc] = reset & 0xff;
    vec[0xfd] = reset >> 8;
    let vhex = '';
    for (const b of vec) vhex += b.toString(16).padStart(2, '0');
    pages.ff = vhex;

    const extra = this.cart.memory || {};
    for (const [p, hex] of Object.entries(extra)) pages[p] = hex;

    const boot = await this.post('boot', { memory: { fill: '00', pages } });
    this.machine = boot.machine;
    this.frames = 0;
    return boot.observe;
  }

  /**
   * Run one frame: hand the ROM the controller, drop the flag, let it go, and
   * come back when it raises the flag again. `budget` bounds a ROM that never
   * does -- a hung cartridge must cost one slow frame, not a hung page.
   */
  async frame(input, budget = 20000) {
    const c = this.cart;
    let mem = this.machine.memory;
    if (input !== undefined && input !== null) mem = poke(mem, c.input, input);
    if (c.entropy !== undefined) mem = poke(mem, c.entropy, (Math.random() * 256) | 0);
    mem = poke(mem, c.tick, 0);
    this.machine = { ...this.machine, memory: mem };

    const before = this.machine.state.half_cycle;
    // One chunk sized at what a frame is known to cost, then smaller top-ups.
    // A chunk that overshoots spends the chip's time in the spin loop, and a
    // chunk that undershoots spends a round trip.
    let spent = 0;
    const chunks = [c.frameCost || 800, 800, 4000, 16000];
    for (const step of chunks) {
      if (spent >= budget) break;
      const r = await this.post('step', {
        machine: this.machine,
        half_cycles: Math.min(step, budget - spent),
      });
      this.machine = r.machine;
      spent += step;
      if (peek(this.machine.memory, c.tick) !== 0) break;
    }
    this.frames++;
    this.lastFrameHalfCycles = this.machine.state.half_cycle - before;
    return { done: peek(this.machine.memory, c.tick) !== 0, halfCycles: this.lastFrameHalfCycles };
  }

  /** The screen, as tile indices. */
  screen() {
    const c = this.cart;
    const out = new Uint8Array(c.width * c.height);
    // Read whole pages rather than a peek per cell: a 32x24 screen is 768
    // peeks, each of which rebuilds a page from hex.
    const first = c.screen >> 8;
    const last = (c.screen + out.length - 1) >> 8;
    const pages = {};
    for (let p = first; p <= last; p++) pages[p] = pageOf(this.machine.memory, p);
    for (let i = 0; i < out.length; i++) {
      const a = c.screen + i;
      out[i] = pages[a >> 8][a & 0xff];
    }
    return out;
  }

  read(addr) { return peek(this.machine.memory, addr); }
  write(addr, v) { this.machine = { ...this.machine, memory: poke(this.machine.memory, addr, v) }; }
  get halfCycle() { return this.machine ? this.machine.state.half_cycle : 0; }

  /** What the chip is doing right now, for the HUD. */
  registers() {
    const s = this.machine && this.machine.state;
    return s ? { half_cycle: s.half_cycle, pc: s.last_fetch ? s.last_fetch.addr : 0 } : null;
  }
}

export { HEX };
