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

const [src, out] = process.argv.slice(2);
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
if (out) { fs.writeFileSync(out, bytes); console.log(`wrote ${out}`); }
