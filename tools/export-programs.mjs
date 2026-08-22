// The seven programs, assembled once, for anything that cannot run a browser.
//
//     node tools/export-programs.mjs [out]        # default web/programs.txt
//
// `web/programs.js` is the one place the program set lives, and `web/asm.js`
// (which inverts the disassembler's table) is the one assembler. This runs
// both under node and writes the bytes out, exactly as export-groups.mjs runs
// the chip map's own module rather than porting it. A second copy of a
// program, or a second assembler, is the copy that drifts.
//
// The output is TAB-SEPARATED, not JSON, so the consumer needs no parser:
//
//     short <TAB> org(hex) <TAB> bytes(hex) <TAB> name
//
// The workspace has no dependencies and the Rust side is not about to grow a
// JSON crate to read seven lines. Parse simple, emit rich, the same rule the
// engine's line protocol follows.

import { writeFileSync } from 'node:fs';
import { PROGRAMS } from '../web/programs.js';

const out = process.argv[2] || 'web/programs.txt';
const lines = [
  '# The seven programs, assembled by web/asm.js from web/programs.js.',
  '# Regenerate with: node tools/export-programs.mjs',
  '# short\torg\tbytes\tname',
];

let total = 0;
for (const p of PROGRAMS) {
  if (!p.asm || !p.asm.bytes) throw new Error(`${p.short}: did not assemble`);
  const hex = p.asm.bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  // A tab inside a field would split it in two on the other side. Nothing in
  // the set has one; this refuses rather than emitting a line that decodes
  // into the wrong number of fields.
  for (const [field, v] of [['short', p.short], ['name', p.name]]) {
    if (/[\t\n]/.test(v)) throw new Error(`${p.short}: ${field} contains a tab or newline`);
  }
  lines.push(`${p.short}\t${p.asm.org.toString(16).padStart(4, '0')}\t${hex}\t${p.name}`);
  total += p.asm.bytes.length;
}

writeFileSync(out, lines.join('\n') + '\n');
console.log(`export-programs: ${PROGRAMS.length} programs, ${total} bytes -> ${out}`);
