# `@tinymachines/6502-asm`

A 6502 assembler and disassembler. **No die data, no dependencies, no chip.**

```js
import { assemble } from "@tinymachines/6502-asm";

const { bytes, labels, lines } = assemble("  LDA #$2E\n  CLC\n  ADC #$14\n  BRK\n", { org: 0x0200 });
// bytes -> a9 2e 18 69 14 00
```

## Why it is a package

There is exactly one assembler in this project. The Python service does not
have a second one: it shells out to this code through
`service/asm-bridge.mjs`, so the two cannot drift. This package is the same
arrangement extended outward, which is why `dist/` is generated at build time
from `web/` rather than committed. Editing the assembler here would be editing
a copy.

It also inverts the disassembler's opcode table, so anything that assembles
disassembles back to the same instruction. That is why both files ship
together: publishing one without the other would let them drift in the way
keeping a single assembler was meant to prevent.

## Why it is MIT, when most of this workspace is not

Most of what this repository builds embeds `netlist.bin`, which is derived from
CC BY-NC-SA 3.0 die data. **NonCommercial and ShareAlike travel with it**,
whatever a licence file says about the code around it. The WebAssembly bundle
is the clearest case: it is MIT code wrapped around data that is not.

An assembler is opcode tables. It never touches a netlist, so it is clean the
way `halfphi` is clean, and can be MIT without qualification.

That is a property worth keeping rather than assuming. `build.mjs` refuses to
produce `dist/` if either file mentions a netlist or die data, or grows an
import that reaches outside this package. See `../../NOTICE.md`.

## What is in it

| | |
|---|---|
| `assemble(source, { org })` | bytes, labels, and a line by line listing |
| `AsmError` | thrown with the line number, never a bare string |
| `instructionLength(opcode)` | **null** for anything that transfers control |
| `disassemble(opcode, pc, read)` | the inverse of the table `assemble` uses |
| `OPCODES` | the table itself |

`instructionLength` returning null rather than a number is deliberate. An
instruction that transfers control has no meaningful "next address", and
reporting one would be a plausible answer where a refusal belongs.

## Build and test

```bash
node build.mjs      # copy from ../../web, refusing anything with die data in it
node test.mjs       # run against dist/, which is what gets installed
```

The tests run against `dist/` and not against `../../web/`, because a package
that tests the source tree and ships something else has tested nothing that
matters. They assemble the same worked example the API assembles and compare
bytes: `a9 2e 18 69 14 00`.

## What is not here

No chip. This package cannot run a program, only turn it into bytes. To run
one, use the engine: `Machine.fromNetlist()` in the WebAssembly build, or
`POST /v1/step` on the API.
