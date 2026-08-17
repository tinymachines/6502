# halfphi

Switch-level simulation and analysis of a photographed die.

A chip traced from photographs is a set of polygons, a set of transistors and
some names. Nothing in it says what the chip *does*. This library takes that
description and gives you a simulation in which behaviour is emergent, plus
analyses that recover structure from the switch network rather than being told
it.

The name is the unit: a chip driven by a two-phase clock does work on both
edges, so half of phi is the smallest step that means anything.

```rust
let parsed = halfphi::parse(&halfphi::ChipSource {
    segdefs: &segdefs_js,
    transdefs: &transdefs_js,
    nodenames: &nodenames_js,
    // The 6800 calls ground `gnd`. This is a parameter for a reason.
    rails: halfphi::Rails { ground: "vss", supply: "vcc" },
})?;
let netlist = halfphi::Netlist::decode(&parsed.blob)?;
let mut engine = halfphi::Engine::new(std::sync::Arc::new(netlist));
engine.force_power_on_state();
engine.settle_all();
```

## It carries no die data

That is a licence boundary as much as a design one. The visual6502 die data is
CC BY-NC-SA 3.0, and NonCommercial and ShareAlike propagate to anything that
ships it. This crate is MIT and stays MIT by holding none of it: you supply the
bytes. See `NOTICE.md` at the repository root.

## Verified on three chips

`cargo test -p halfphi` loads the 6502, the 6800 and the Z80 through identical
calls. Measured:

| | nodes | transistors | names | polygons | rails |
|---|---|---|---|---|---|
| 6502 | 1725 | 3510 | 846 | 8233 | `vss` / `vcc` |
| 6800 | 2944 | 3995 | 1144 | 9805 | `gnd` / `vcc` |
| Z80  | 3597 | 6813 | 511 | 14604 | `vss` / `vcc` |

The 6502 figures are checked against values this repository knows
independently. The other two are checked for shape only: nothing here has
verified them against an outside source.

**The Z80 does not reach a fixed point from a cold power-on** within the hundred
rounds the reference implementation also capped at. That is recorded rather than
asserted away, and it is not evidence that the Z80 oscillates: the test performs
no chip-specific initialisation, and visual6502 ships a `support.js` per chip
that does. What it does establish is that the engine runs a die twice the size
of the one it was developed against and *reports* non-convergence instead of
hanging or lying.

## What a chip layer adds

The library stops where a switch network becomes a processor. What a clock edge
is, which nodes are pins, what counts as a register and how a bus handshake
works are facts about a particular chip. See `crates/v6502-netlist` and
`crates/v6502-sim` in this repository for one worked example.
