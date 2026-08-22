#!/usr/bin/env node
// Assemble a cartridge with this project's own assembler.
//
//   node games/tools/asm.mjs games/rom/dierunner.s games/rom/dierunner.rom
//
// There is one assembler here and this is how a cartridge uses it, rather than
// growing a second one: web/asm.js inverts the disassembler's table, so a
// listing that assembles disassembles back to the same lines.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { assemble, AsmError } = await import(path.join(ROOT, 'web', 'asm.js'));

// A ROM that runs past the address its own screen starts at will be
// overwritten by its own display, and nothing about the assembly is wrong --
// it assembles, it boots, and the picture eats the code. `--limit $0500` makes
// that a build failure instead of a mystery.
const argv = process.argv.slice(2);
const limIdx = argv.indexOf('--limit');
const limit = limIdx >= 0 ? parseInt(argv[limIdx + 1].replace(/^\$/, ''), 16) : null;
const [src, out] = argv.filter((a, i) => i !== limIdx && i !== limIdx + 1);
if (!src) { console.error('usage: asm.mjs <source.s> [out.rom]'); process.exit(1); }
const text = fs.readFileSync(src, 'utf8');
let res;
try {
  res = assemble(text);
} catch (e) {
  if (e instanceof AsmError) { console.error(`${src}:${e.line}: ${e.detail}`); process.exit(1); }
  throw e;
}
const bytes = Buffer.from(res.bytes, 'hex');
console.log(`${path.basename(src)}: ${res.size} bytes at $${res.org.toString(16).toUpperCase().padStart(4, '0')}`
  + ` .. $${res.end.toString(16).toUpperCase().padStart(4, '0')}`);
const labels = Object.entries(res.labels).sort((a, b) => a[1] - b[1]);
console.log('labels: ' + labels.map(([k, v]) => `${k}=$${v.toString(16).toUpperCase()}`).join(' '));
if (limit !== null && res.end >= limit) {
  console.error(`${src}: ends at $${res.end.toString(16).toUpperCase()}, which is past`
    + ` $${limit.toString(16).toUpperCase()} -- it would be overwritten by whatever lives there.`);
  process.exit(1);
}
if (out) { fs.writeFileSync(out, bytes); console.log(`wrote ${out}`); }
