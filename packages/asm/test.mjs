/**
 * What the package actually does, run rather than asserted.
 *
 * It runs against dist/, which is what a consumer installs, not against
 * ../../web/. A package that passes its tests through the source tree and
 * ships something else is the failure this ordering avoids.
 *
 *     node build.mjs && node test.mjs
 */

import { assemble, AsmError } from "./dist/asm.js";
import { instructionLength, disassemble, OPCODES } from "./dist/disasm.js";

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  if (!ok) failed++;
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");

// The worked example the site and the API both use. Same source, same bytes:
// this is the number that proves the package is the same assembler.
const sum = assemble("  LDA #$2E\n  CLC\n  ADC #$14\n  BRK\n", { org: 0x0200 });
check("the worked example assembles", hex(sum.bytes), "a9 2e 18 69 14 00");
check("org and end", [sum.org, sum.end, sum.size], [0x0200, 0x0205, 6]);

// Labels, and a branch that has to reach backwards.
const loop = assemble("start\n  DEX\n  BNE start\n  RTS\n", { org: 0x0300 });
check("a label resolves", loop.labels.start ?? loop.labels.get?.("start"), 0x0300);
check("a backward branch assembles", hex(loop.bytes), "ca d0 fd 60");

// A refusal carries the line number. An assembler that fails without saying
// where is an assembler you debug by bisecting your own source.
let err = null;
try {
  assemble("  LDA #$2E\n  NOPE $10\n", { org: 0x0200 });
} catch (e) {
  err = e;
}
check("a bad mnemonic throws AsmError", err instanceof AsmError, true);
check("and carries the line", err?.line, 2);

// The disassembler is the other half, and the reason the two ship together:
// asm.js inverts this table, so shipping one without the other would let them
// drift in exactly the way keeping one assembler was meant to prevent.
check("instruction length agrees", instructionLength(0xa9), 2);
const back = disassemble(0xa9, 0x0200, (a) => sum.bytes[a - 0x0200]);
check("LDA #$2E disassembles back", back.text ?? back, "LDA #$2E");
check("the opcode table is whole", Object.keys(OPCODES).length > 100, true);

if (failed) {
  console.error(`\ntest: ${failed} failure(s)`);
  process.exit(1);
}
console.log("\ntest: the package assembles what the API assembles");
