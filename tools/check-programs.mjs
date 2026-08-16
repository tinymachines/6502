// Refuse to publish programs that do not assemble to what they used to.
//
//     node tools/check-programs.mjs
//
// The programs on this site are source now, assembled at load by `web/asm.js`.
// That is a better arrangement than a column of hand-typed hex -- a comment
// cannot come to describe a byte that is no longer there -- but it moves the
// risk rather than removing it: a bad edit to the assembler now changes every
// program at once, silently, and every page still boots.
//
// So the deploy checks three things that a broken assembler cannot fake:
//
//   1. Every program assembles at all, and lands where it is loaded.
//   2. The three programs that predate the rewrite assemble to exactly the
//      bytes that were typed into this repository before it. Those arrays are
//      written out below rather than derived, because deriving the expectation
//      from the source being tested is how a test comes to prove nothing.
//   3. Every instruction round-trips through the disassembler's table.
//
// What it deliberately does not check is whether the programs *compute* what
// they claim. That needs the chip, so it lives in `web/_asm-test.html`, which
// runs each one on the real simulation until its answer appears in memory.
//
// This needs node only because the assembler is JavaScript. `web/package.json`
// exists to let node read that directory as ES modules; it is never shipped.

import { PROGRAMS, LOAD_ADDR } from '../web/programs.js';
import { OPCODES } from '../web/disasm.js';
import { MODE_SIZE } from '../web/asm.js';

const fail = (msg) => { console.error(`check-programs: ${msg}`); process.exitCode = 1; };
const hex = (a) => [...a].map((b) => b.toString(16).padStart(2, '0')).join(' ');

// The literal arrays that were in programs.js before it took source.
const HISTORICAL = {
  counter: [0xa9, 0x00, 0x20, 0x10, 0x02, 0x4c, 0x02, 0x02,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0xe8, 0x88, 0xe6, 0x0f, 0x38, 0x69, 0x02, 0x60],
  fibonacci: [0xa9, 0x00, 0x85, 0xf0, 0xa9, 0x01, 0x85, 0xf1,
              0xa5, 0xf0, 0x18, 0x65, 0xf1, 0x85, 0xf2,
              0xa5, 0xf1, 0x85, 0xf0, 0xa5, 0xf2, 0x85, 0xf1,
              0x4c, 0x08, 0x02],
  fill: [0xa2, 0x00, 0x8a, 0x9d, 0x00, 0x03, 0xe8, 0xd0, 0xf9, 0x4c, 0x00, 0x02],
};

if (PROGRAMS.length < 3) fail(`only ${PROGRAMS.length} programs`);

let instructions = 0;
for (const p of PROGRAMS) {
  if (!p.bytes.length) fail(`${p.id} assembled to nothing`);
  if (p.asm.org !== LOAD_ADDR) {
    fail(`${p.id} assembles at $${p.asm.org.toString(16)}, not the load address`);
  }
  if (!p.blurb || !p.name) fail(`${p.id} has no name or blurb`);

  for (const label of Object.keys(p.notes || {})) {
    if (!p.asm.lines.some((l) => l.label === label)) {
      fail(`${p.id}: a note is anchored to "${label}", which the program does not define`);
    }
  }

  for (const ln of p.asm.lines) {
    if (!ln.mnemonic) continue;
    instructions++;
    const entry = OPCODES[ln.opcode];
    if (!entry || entry[0] !== ln.mnemonic || entry[1] !== ln.mode) {
      fail(`${p.id} line ${ln.n}: ${ln.mnemonic}/${ln.mode} does not round-trip`);
    } else if (ln.bytes.length !== 1 + MODE_SIZE[ln.mode]) {
      fail(`${p.id} line ${ln.n}: ${ln.bytes.length} bytes for ${ln.mode}`);
    }
  }
}

for (const [id, want] of Object.entries(HISTORICAL)) {
  const p = PROGRAMS.find((x) => x.id === id);
  if (!p) { fail(`${id} is gone`); continue; }
  if (hex(p.bytes) !== hex(want)) {
    fail(`${id} no longer assembles to the bytes it shipped with\n`
       + `  got  ${hex(p.bytes)}\n  want ${hex(want)}`);
  }
}

if (!process.exitCode) {
  console.log(`  ${PROGRAMS.length} programs, ${instructions} instructions, `
    + `${PROGRAMS.reduce((n, p) => n + p.bytes.length, 0)} bytes — all assembled and `
    + 'round-tripped');
}
