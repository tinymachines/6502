// The assembler end of the service: web/asm.js, spoken over stdin/stdout.
//
//     node service/asm-bridge.mjs  <  {"source": "...", "org": 512}
//
// There is exactly one assembler in this project, and it inverts the
// disassembler's table so the two cannot drift. The service therefore does
// not get a second one in Python: it gets this bridge, which reads one JSON
// request on stdin and writes one JSON response on stdout. An assembly error
// is a normal response with ok:false and the line number, never a crash.

import { assemble, AsmError } from '../web/asm.js';

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  let out;
  try {
    const req = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const res = assemble(String(req.source ?? ''), { org: req.org ?? 0x0200 });
    out = {
      ok: true,
      org: res.org,
      end: res.end,
      size: res.size,
      bytes: res.bytes.map((b) => b.toString(16).padStart(2, '0')).join(''),
      labels: Object.fromEntries(res.labels),
      listing: res.lines.map((ln) => ({
        n: ln.n,
        text: ln.text,
        label: ln.label,
        addr: ln.addr === undefined ? null : ln.addr,
        bytes: ln.bytes && ln.bytes.length
          ? ln.bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
          : null,
      })),
    };
  } catch (e) {
    out = e instanceof AsmError
      ? { ok: false, error: e.message, line: e.line ?? null }
      : { ok: false, error: String(e && e.message || e), line: null };
  }
  process.stdout.write(JSON.stringify(out) + '\n');
});
