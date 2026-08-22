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
    this.retried = 0;
    // The levels of the control lines the cartridge asked to watch, and the
    // same thing packed into the byte the ROM reads. Sampled at the end of a
    // frame and handed to the NEXT one, which is the only ordering available:
    // the chip has to have run before there is anything to sample.
    this.watch = {};
    this.mask = 0xff;
  }

  /**
   * A frame is a request, so a game is hundreds of them, and one transient
   * failure used to end the session: a `net::ERR_NETWORK_CHANGED` from the
   * browser -- the OS reconfiguring an interface -- reported itself on screen
   * as "the engine stopped answering" while the engine was answering every
   * request with a 200.
   *
   * Retrying is free here in a way it is not for most APIs: the machine is a
   * value we still hold, so the retry is the SAME body sent again, and the
   * server has no session to have lost. An HTTP status is a real answer and
   * is never retried -- only a rejected fetch, which is a transport failure.
   */
  async post(path, body, tries = 3) {
    const payload = JSON.stringify(body);
    for (let n = 1; ; n++) {
      this.requests++;
      try {
        const r = await fetch(`${this.api}/v1/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: payload,
        });
        if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
        return await r.json();
      } catch (e) {
        if (!(e instanceof TypeError) || n >= tries) throw e;
        this.retried++;
        await new Promise((ok) => setTimeout(ok, 150 * n));
      }
    }
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

    const boot = await this.post('boot', {
      memory: { fill: '00', pages },
      watch: this.cart.watch || [],
    });
    this.machine = boot.machine;
    this.sample(boot.observe);
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
    // The gates: one bit per real control line, read off this very chip at the
    // end of the last frame. Nothing here decides when a gate opens -- the
    // 6502 executing the game does, by whatever it happened to be doing.
    if (c.gateMask !== undefined) mem = poke(mem, c.gateMask, this.mask);
    mem = poke(mem, c.tick, 0);
    this.machine = { ...this.machine, memory: mem };

    const before = this.machine.state.half_cycle;
    // One chunk sized at what a frame is known to cost, then smaller top-ups.
    // A chunk that overshoots spends the chip's time in the spin loop, and a
    // chunk that undershoots spends a round trip.
    let spent = 0;
    // Sized from what the cartridge actually costs, so a normal frame is one
    // request. Die Runner is 8,400 half-cycles a frame and 19,200 on the
    // eighth, when the clock phase flips and every pass transistor on screen
    // changes state -- so the second chunk has to cover that or a phase frame
    // pays three round trips instead of two.
    const base = c.frameCost || 800;
    const chunks = [base, base * 2, 32000];
    for (const step of chunks) {
      if (spent >= budget) break;
      const r = await this.post('step', {
        machine: this.machine,
        half_cycles: Math.min(step, budget - spent),
        watch: c.watch || [],
      });
      this.machine = r.machine;
      this.sample(r.observe);
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

  /** Pack the watched levels into the byte the ROM reads. */
  sample(observe) {
    const names = this.cart.watch;
    if (!names || !observe || !observe.watch) return;
    this.watch = observe.watch;
    let m = 0;
    names.forEach((n, i) => { if (observe.watch[n]) m |= 1 << i; });
    this.mask = m;
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
