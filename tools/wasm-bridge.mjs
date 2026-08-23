// The browser engine, spoken over stdin/stdout.
//
//     node tools/wasm-bridge.mjs < {"op":"run","program":"a92e...","half_cycles":20}
//
// Same shape as service/asm-bridge.mjs, and for the same reason: one JSON
// request in, one JSON response out, so something that is not a browser can
// drive the WebAssembly build. It exists to prove that a machine exported here
// is the same machine the HTTP API passes around, which is the whole claim of
// "one engine, two ways in".
//
// Needs a nodejs-target build, which is NOT what the site ships:
//     wasm-pack build crates/v6502-wasm --target nodejs --out-dir /tmp/pkg-node
// The site's own bundle is --target web and cannot be require()d.

import { createRequire } from 'node:module';

const PKG = process.env.WASM_PKG || '/tmp/pkg-node';
const require = createRequire(import.meta.url);

function read() {
  return new Promise((ok) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
  });
}

const hexBytes = (hex) => Uint8Array.from(hex.match(/../g) || [], (b) => parseInt(b, 16));

/** Write a sparse image the way the API describes one: a fill byte, then only
 *  the pages that differ from it. */
function writeMemory(m, mem) {
  m.fillMemory(parseInt(mem.fill ?? '00', 16));
  for (const [page, hex] of Object.entries(mem.pages || {})) {
    m.load(parseInt(page, 16) * 256, hexBytes(hex));
  }
}

/** What a caller wants to compare, read back off the chip. */
const report = (m) => ({
  half_cycle: m.halfCycle(),
  a: m.a(), x: m.x(), y: m.y(), s: m.s(), p: m.p(), pc: m.pc(),
  flags: m.flagsString(),
  last_fetch_addr: m.lastFetchAddr(),
});

const req = await read();
let out;
try {
  const { Machine } = require(`${PKG}/v6502_wasm.js`);
  const m = new Machine();

  if (req.op === 'run') {
    m.load(req.org ?? 0x0200, hexBytes(req.program));
    m.setResetVector(req.org ?? 0x0200);
    m.powerCycle();
  } else if (req.op === 'resume') {
    // Memory first: importState restores the chip, and a chip resumed over
    // the wrong RAM would fetch the wrong opcode on its very next cycle.
    writeMemory(m, req.machine.memory);
    const s = req.machine.state;
    m.importState(s.value, s.pullup, s.pulldown, s.trans_on, s.half_cycle,
                  s.last_fetch ? s.last_fetch.addr : -1,
                  s.last_fetch ? s.last_fetch.opcode : 0);
  } else if (req.op === 'resume-whole') {
    // The same restore in one call. Kept as a separate op rather than
    // replacing the one above, because check-wasm-import.py runs both over the
    // same machine and requires the answers to be identical: a convenience
    // that is subtly not equivalent is worse than no convenience.
    const s = req.machine.state;
    const ids = [], bytes = [];
    for (const [page, hex] of Object.entries(req.machine.memory.pages || {})) {
      ids.push(parseInt(page, 16));
      bytes.push(...hexBytes(hex));
    }
    m.importMachine(s.value, s.pullup, s.pulldown, s.trans_on, s.half_cycle,
                    s.last_fetch ? s.last_fetch.addr : -1,
                    s.last_fetch ? s.last_fetch.opcode : 0,
                    parseInt(req.machine.memory.fill ?? '00', 16),
                    Uint8Array.from(ids), Uint8Array.from(bytes));
  } else {
    throw new Error(`unknown op ${req.op}`);
  }

  for (let i = 0; i < (req.half_cycles || 0); i++) m.halfStep();

  out = {
    ok: true,
    report: report(m),
    peek: Object.fromEntries((req.peek || []).map((a) => [a, m.peek(a)])),
    machine: JSON.parse(m.exportMachine()),
  };
} catch (e) {
  out = { ok: false, error: String((e && e.message) || e) };
}
process.stdout.write(JSON.stringify(out) + '\n');
