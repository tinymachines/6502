# The pin golden

What every engine on the ladder (`docs/engine-ladder.md`) is held to: the
package pins of rung 0, the switch-level `Cpu`, every half-cycle, on the seven
programs, the reference's program, seven scripted interrupt and RDY runs and
all 256 opcodes.

    node tools/export-programs.mjs                                # web/programs.txt
    cargo run --release -p v6502-pins --example pin-golden        # writes here
    cargo test -p v6502-pins                                      # replays it
    MUTATE=1 cargo test -p v6502-pins --test replay               # must go red
    REQUIRE_PINS=1 cargo test -p v6502-pins                       # absence fails

The `.pins` and `.stim` files are derived from the CC BY-NC-SA die data and
are gitignored, like `tools/golden-trace/golden.txt`. Their format is in
`crates/v6502-pins/src/lib.rs`, hex text, so `diff` on two of them reads.
