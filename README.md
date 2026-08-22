# Visual 6502

[![site](https://img.shields.io/badge/site-6502.tinymachines.ai-0aa?logo=firefox&logoColor=white)](https://6502.tinymachines.ai)
[![API](https://img.shields.io/badge/API-%2Fapi-0aa)](https://6502.tinymachines.ai/api/)
[![halfphi](https://img.shields.io/badge/engine-halfphi-blue?logo=github&logoColor=white)](https://github.com/tinymachines/halfphi)
[![license](https://img.shields.io/badge/code-MIT-blue.svg)](LICENSE)
[![die data](https://img.shields.io/badge/die%20data-CC%20BY--NC--SA%203.0-orange.svg)](NOTICE.md)

A transistor-level simulation of the MOS 6502, in Rust and WebAssembly, with a
WebGL renderer of the actual die.

**→ [6502.tinymachines.ai](https://6502.tinymachines.ai)**

Nothing here models 6502 *behaviour*. There is no instruction decoder, no
addressing-mode table, no cycle-count lookup. There are 1725 wires and 3510
switches, and the behaviour falls out of simulating them. Every register value
you see is read back out of storage nodes on the die; every cycle count is
emergent.

This is a ground-up rebuild of [visual6502](http://visual6502.org), whose die
trace and simulation approach it is built on.

## What it does

- **Runs the real chip.** Switch-level simulation of the revD die, verified
  bit-exact against the original implementation.
- **Shows the die.** 83,227 triangles of real polygon geometry, with live logic
  state, at any zoom.
- **Traces signals.** Click any wire to see what it is connected to *at that
  instant* — the connected group changes as transistors switch.
- **Steps backwards.** Keyframed rewind over the last 4096 half-cycles.
- **Exposes the microarchitecture.** Internal T-states, clock phase, the bus
  handshake, and the ALU's hold register — including things behavioural
  emulators paper over (see below).

## Try this

The 6502 does not put an ALU result into the accumulator when the instruction
ends. `ADC` reaches the *next* opcode fetch with the accumulator still holding
the old value; the result sits in the ALU hold register and transfers a cycle
later. `LDA`, which bypasses the ALU, lands a cycle earlier.

Step through `LDA #$50 / CLC / ADC #$50` one half-cycle at a time and watch
where `A` actually changes. An emulator that commits results at instruction
boundaries cannot show you this, because it isn't true of the silicon.

## Architecture

| Crate | Role |
|---|---|
| `v6502-netlist` | Immutable topology — nodes, transistors, names. No state. |
| `v6502-sim` | Switch-level solver, 6502 clock/bus layer, rewind. |
| `v6502-wasm` | `wasm-bindgen` surface. |
| `web/` | WebGL2 renderer and UI. Plain ES modules, no framework, no build step. |

A node's logic level is not a property of the node but of the **group** of nodes
currently shorted together through conducting transistors. Settling means
rebuilding groups, resolving each to a level, propagating, and repeating to a
fixed point.

The renderer turns on one fact: the layout never changes. The triangles go to
the GPU once; each frame uploads only a 1725-byte array of node levels as a
texture the vertex shader samples by node ID. A frame is six draw calls,
regardless of zoom.

## Verification

Two independent oracles, because either alone is insufficient:

1. **Differential against the original.** A headless harness runs the visual6502
   JavaScript engine and dumps the level of *all 1725 nodes at every half-cycle*.
   The Rust engine matches bit-exactly. Matching registers would only show
   agreement about the 6502; matching every node shows agreement about the
   silicon.

2. **Against the documented ISA.** Datasheet cycle counts including
   page-crossing and branch penalties, the read-modify-write double write,
   JSR/RTS stack layout, ADC/SBC flags, BCD. A shared misreading of the die data
   would pass the first test and fail this one.

~28,500 half-cycles/s natively — about 94× the original JavaScript.

## Building

Requires a Rust toolchain, `wasm-pack`, and Node (only to regenerate the test
oracle).

```bash
git clone --recurse-submodules https://github.com/tinymachines/6502
cd 6502

cargo test --workspace

# The differential test against the original needs an oracle generated first;
# without it that one test skips.
node tools/golden-trace/gen.js --steps 3000

wasm-pack build crates/v6502-wasm --target web --out-dir ../../web/pkg
cargo run -p v6502-netlist --bin export-layout -- web/layout.bin
python3 -m http.server 8777 --directory web
```

The die data is a submodule rather than a copy — see the licensing note below.
If you already cloned without `--recurse-submodules`:

```bash
git submodule update --init
```

## Licensing — read before redistributing

The code in this repository is **MIT**. The chip data it is built from is not.

`segdefs.js` and `transdefs.js` in the visual6502 submodule — the polygon and
transistor geometry — are **CC BY-NC-SA 3.0**, copyright 2010 Greg James, Brian
Silverman and Barry Silverman, with attribution required to Greg James and
www.visual6502.org.

That matters because the build *derives from* that data. The generated
`netlist.bin` and `layout.bin`, any `.wasm` embedding them, and any deployed
instance of this app all inherit **NonCommercial** and **ShareAlike** terms.
This repository does not redistribute the data (hence the submodule), but a
build does.

In short: fork it, learn from it, host it non-commercially with attribution. A
commercial use would need the geometry re-derived from an independent die trace,
or separate permission from the rights holders.

See [`NOTICE.md`](NOTICE.md) for the full breakdown,
[`LICENSE-THIRD-PARTY`](LICENSE-THIRD-PARTY) for the upstream texts and
obligations, and [`LICENSE`](LICENSE) for the MIT terms covering this source.

## Credit

This project exists because the [visual6502](http://visual6502.org) team
decapped a 6502, photographed the die, and traced every polygon by hand — then
gave it away. Greg James, Brian Silverman, Barry Silverman, Ed Spittles, Segher
Boessenkool, Achim Breidenbach, and everyone else who contributed.
