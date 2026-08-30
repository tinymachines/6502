# The engine ladder: four engines, one pin contract

Handoff for the coding agent. Read `CLAUDE.md` and `docs/notes/engine.md`
first; every rule in there applies here, and the ones this document leans on
hardest are repeated in the last section.

## What is being built

Four engines that all present the same chip at the pins and differ in how much
of the silicon they still simulate. Each lives in its own crate. Each is
verified against the one above it, and all of them against the pin contract
defined below. Nothing in this ladder changes `halfphi` or `v6502-sim`: the
switch-level engine is the oracle and stays exactly as it is.

| Rung | Crate | What runs | Nodes survive? | Verified against |
|---|---|---|---|---|
| 0 | `halfphi` + `v6502-sim` (existing) | 1725 nodes, 3510 switches, queue solver | yes | golden.txt (the JS reference), functional tests |
| 1 | `v6502-hybrid` | recognised gates as boolean functions, switches as groups | yes | rung 0, every node every half-cycle |
| 2 | `v6502-compiled` | the whole recognised network levelised into straight-line code | yes | rung 0, every node every half-cycle |
| 3 | `v6502-micro` | a table-driven state machine derived from the measured decode and timing | no | rung 0, every pin every half-cycle |

Rung numbering counts down toward the silicon, which is the direction
verification flows. The word "tier" is not used anywhere in code or docs, so a
grep for `rung` finds the whole ladder.

**Already done and not to be rebuilt:** `halfphi::slice` is a bit-sliced kernel
(64 machines per `u64`, thermometer-encoded drive lattice, relaxation instead
of group walks) and `examples/bitslice.rs` compares it against the scalar
`Cpu` every node every half-cycle, with lanes deliberately made to disagree.
**It is NOT bit-exact with the scalar engine, and cannot be made so**: charge
retention makes the settled state path-dependent, the queue's order is data
dependent and therefore lane dependent, and a lane-uniform sweep does not
enter the momentary configurations the queue does (2061 of 3000 half-cycles
agree on all live nodes; first divergence at half-cycle 8; worst differs on 2
nodes). It agrees at the level `functional.rs` tests, not the level
`golden.rs` tests. Documented under Performance in `docs/notes/engine.md`
(M0, done 2026-08-30) and held by `check-self-counts.py`. This bears directly
on rung 2: an engine "bit-sliced from the start" on this encoding cannot also
pass a node-lockstep comparison against rung 0, so rung 2 either keeps queue
order (one machine per call, lockstep provable) or takes the slice encoding
(64 lanes, pin-contract only). The choice is made at M3, not assumed here. Likewise `Schematic::derive(&nl)` in
`v6502-netlist` is the compiler front end for rungs 1 and 2: 1160 gates
(inverter 534, nor 354, nand 39, aoi 91, dynamic 142), 873 switches, 2637 of
3510 transistors inside gates, one node unresolved (`series deeper than 2`,
node 1085). `web/decode.json` (122 terms, 256 opcodes x 16 half-cycles) and
`web/timing.json` (44 datapath control lines, per-opcode lengths) are the
source tables for rung 3.

## The pin contract (`v6502-pins`)

A fifth, tiny crate that every rung depends on and none may modify without a
note. It defines what "same external behaviour" means, so the definition lives
in one place and cannot drift between engines.

```rust
/// One half-cycle at the package pins. Everything an external observer can
/// see, and nothing an external observer cannot.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct PinFrame {
    pub h: u64,        // half-cycles since power_cycle(); the native unit, never converted
    pub clk0: bool,    // the input clock, as driven
    pub ab: u16,       // A0..A15
    pub db: u8,        // D0..D7, as the chip drives or samples them this half-cycle
    pub rw: bool,      // true = read
    pub sync: bool,
    pub res: bool, pub irq: bool, pub nmi: bool, pub rdy: bool, pub so: bool, // inputs, as driven
}

pub trait PinEngine {
    fn power_cycle(&mut self);
    fn set_inputs(&mut self, res: bool, irq: bool, nmi: bool, rdy: bool, so: bool);
    fn half_step(&mut self);          // advance exactly one half-cycle
    fn pins(&self) -> PinFrame;
    fn h(&self) -> u64;
}
```

Rules:

- `db` is defined as "the value on D0..D7 at the point the bus is serviced this
  half-cycle": reads are serviced as `clk0` falls, writes as it rises, which
  is what `v6502-sim` already does. The contract must say this in the doc
  comment, and the rung 0 adapter must implement it by calling the existing
  `Cpu` accessors rather than reading nodes itself.
- Internal clock phase (`phase`) is NOT in the frame. It lags `clk0` through
  the on-die clock generator and is not visible at the pins. An engine that
  cannot reproduce it (rung 3) must still pass.
- Registers are NOT in the frame. The ALU hold-register lag is real silicon
  and rung 3 must reproduce its externally visible consequences (the write
  data, the address sequence), not the register itself. Tests that want
  registers use rung 0.
- `PinFrame` is `Copy` and `Eq` so a trace is `Vec<PinFrame>` and a comparison
  is `==`, and a mismatch reports `h` and which field.

### The pin golden

`tools/pin-golden/` (Rust example in `v6502-pins`, not a JS tool) runs rung 0
through the existing `Cpu` adapter on the seven shipped programs
(`web/programs.txt`, via `tools/export-programs.mjs`) plus the golden
program from `tools/golden-trace/gen.js`, and writes one `.pins` file per
program: a header line naming the program, its bytes and the rung 0 build
stamp, then one line per half-cycle. Format is hex text, not binary, so a
`diff` on two of them is readable.

The interrupt and RDY cases from `tests/interrupts.rs` are recorded too, as
scripted input sequences (`.stim` files: `h`, then the five input levels), so
the pin golden exercises every input pin and not only the free-running case.

Every rung's test suite has one test shaped like `tests/golden.rs`: replay the
`.pins` files, compare every frame, fail on the first difference with `h`
named. `REQUIRE_PINS=1` makes the files' absence a failure; without it the
test SKIPS, the same convention as `V6502_REQUIRE_GOLDEN`.

## Rung 1: `v6502-hybrid`

The queue solver with the gate population removed from it.

- Depends on `halfphi`, `v6502-netlist`, `v6502-pins`.
- At construction, run `Schematic::derive` and partition nodes into three
  sets: gate outputs (the 1160), pure switch-network nodes, and the unresolved
  node. Gate inputs that are themselves gate outputs form the levelised part;
  everything else stays in a `halfphi::Engine`.
- A gate output's level is a boolean function of its input levels for the
  four static kinds. The 142 dynamic gates carry a stored `ChargedHigh` bit
  and are evaluated exactly as the lattice says: driven when a pull is
  present, retained when not. Encode the lattice the way `slice.rs` does
  (thermometer, `max` is `|`) so rung 2 can reuse the tables unchanged.
- The switch network is still settled by the queue, seeded with the gate
  outputs that changed. Gate evaluation and switch settling alternate to a
  fixed point, capped at 100 rounds like the reference.
- Node 1085 stays in the switch network. It is one node; do not special-case
  it, and do not extend the recogniser to absorb it as part of this work.
- **Exposes every node.** `state_string()` must be reproducible from it, so
  `tests/golden.rs` runs unchanged against this engine, and a second test
  runs rung 0 and rung 1 in lockstep on the same `Bus` and compares
  `state_string()` at every half-cycle, which is the test that says the gate
  functions are the same functions the switches compute.
- **Measure before claiming.** The profile in `engine.md` says 87.9% of
  searches never leave one container and waste is 97.4% in `stage` and 91.8%
  in `regs`, which is where the gates are. So the expected win is large, but
  the expected number is not written down anywhere until `examples/benchmarks.rs`
  has been run against it best-of-N. Record the counted columns too: the
  recalc count is the thing this rung exists to reduce.

## Rung 2: `v6502-compiled`

The whole recognised network as straight-line code, generated at build time.

- Depends on `v6502-netlist` (build-dependency, for `Schematic::derive`),
  `v6502-pins`. Does NOT depend on `halfphi` at runtime; the switch network
  is compiled too.
- `build.rs` derives the schematic, levelises the gate network per clock
  phase, and emits Rust into `OUT_DIR`: one function per phase that evaluates
  every gate in dependency order, with strongly connected components (the
  latches and the cross-coupled pairs) iterated to a fixed point inside a
  bounded loop. Switches are compiled as guarded merges: a conducting switch
  ORs the two sides' drive planes, which is the `slice.rs` relaxation written
  out as code rather than looped over an array.
- **Bit-sliced from the start.** Every level is a `u64`, one machine per bit,
  using `LANES` and the plane encoding from `halfphi::slice`. A single-machine
  caller uses lane 0. This is where "machines per second is bounded by cores"
  stops being true, and it costs nothing to do now and a rewrite to do later.
- **Exposes every node** through the same plane arrays, so the lockstep
  comparison against rung 0 runs here too, and `examples/bitslice.rs`'s
  lane-independence check is copied into this crate's tests: 64 lanes that
  agree prove nothing until lane 1 has been given a different byte.
- Generated code is never committed and never shipped; it is a build product
  like `netlist.bin`. `tools/check-wasm-nodata.py` gets a sibling that checks
  the generated file names no chip-specific string outside what
  `v6502-netlist` already carries, because this crate's licence position is
  the same as `v6502-netlist`'s (NC-SA), and the note must say so.
- Expect LLVM to matter here: `lto = "fat"`, `codegen-units = 1` are already
  set for release. Measure with and without; do not assume.

## Rung 3: `v6502-micro`

No nodes. A cycle-accurate state machine whose tables are the measured ones.

- Depends on `v6502-pins` only. Its data is a build-time embedding of
  `web/decode.json` and `web/timing.json` in a compact form; `build.rs` reads
  the two JSON files and refuses to build if either is missing, and stamps
  the embedded table with their content digest, which `pins()` exposes as
  `build_stamp()` so a trace can say which measurement it came from. (This is
  the same gap `halfwave-lab` issue 07 filed against the atlas export; do not
  open the gap again here.)
- The state is the architectural registers plus the T-state counter, the
  interrupt latches, and the ALU hold register, because the hold register's
  one-cycle lag is externally visible in the write sequence of a
  read-modify-write and in the data written by `PHA` after an `ADC`, and rung
  3 has to get those bytes right.
- Per half-cycle: look up the firing PLA terms for (opcode, T-state, half),
  which `decode.json` gives directly; map fired terms to the 44 datapath
  control lines using `timing.json`'s `dpc` table; apply the control lines to
  the datapath model. The random-logic lines that `decode.json` leaves
  unresolved (`unresolvedLines`, 14 of 46 in the current export) are the hard
  part: each one that is needed for pin behaviour is hand-written, listed by
  name in the note with the run that justified it, and it is a known gap
  until it is measured. **Do not pad the table with datasheet behaviour**; a
  line derived from the manual is authored, not measured, and gets labelled
  as such in the code and the note.
- The 12 opcodes that never finish (`timing.json` says which) must never
  finish here either. A `.pins` file for each is recorded from rung 0 over a
  fixed length, and rung 3 must match it. A model that "helpfully" completes
  a `KIL` opcode fails the contract.
- Undefined and undocumented opcodes are in scope: 244 opcodes are timed and
  rung 0 gives a pin trace for every one of the 256. Record all 256 as
  `.pins` (short runs, one opcode each after a fixed preamble) and rung 3
  passes all 256 or the note lists which ones it does not, by number.
- Target is "as fast as it can be made while passing the 256 + interrupt +
  program traces". No number is written down until measured.

## Verification, in order of strength

1. Rung 0 against the JS reference: `tests/golden.rs`, unchanged.
2. Rungs 1 and 2 against rung 0: every node, every half-cycle, lockstep on
   one `Bus`. The `state_string()` comparison from `tests/state.rs` is the
   model.
3. Every rung against the pin golden: every pin, every half-cycle, all
   programs, all 256 opcodes, the interrupt and RDY stimulus files.
4. `tests/functional.rs` run through the `PinEngine` adapter where the
   assertion is expressible at the pins (cycle counts, RMW double write,
   stack layout). Where it needs registers, it stays rung 0 only.
5. `MUTATE=1` for every comparison: flip one bit in the replayed trace and
   the test must go red. A comparison that has never been seen to fail is
   not a test.

The counts in this document (1160, 873, 2637, 142, 122, 44, 12, 244, 256) come
from the current exports. `tools/check-self-counts.py` gets a pattern for each
one that lands in a shipped doc, so a re-derivation that moves a number fails
the deploy instead of leaving stale prose.

## Milestones and gates

| | Deliverable | Gate |
|---|---|---|
| M0 | `docs/notes/engine.md` gains a section on `halfphi::slice` and `examples/bitslice.rs`, with its measured throughput best-of-3 | `check-self-counts.py` green |
| M1 | `v6502-pins`: the frame, the trait, the rung 0 adapter, the `.pins` and `.stim` recorder, the replay test proved to fail under `MUTATE=1` | rung 0 passes its own pin golden. **Done 2026-08-30**: 271 traces including the 256 opcodes rung 3 needs, replay green, mutant red by name. See `docs/notes/engine.md`, "The pin contract". |
| M2 | `v6502-hybrid` | node-lockstep against rung 0 bit-exact; pin golden; `benchmarks.rs` numbers recorded in the note with recalc counts |
| M3 | `v6502-compiled` | same two comparisons; lane-independence test; generated-code licence check; throughput per machine and per 64 machines recorded |
| M4 | `v6502-micro` | pin golden on 7 programs + 256 opcodes + stimulus files; the unresolved-line list in the note; throughput recorded |
| M5 | `halfwave` grows an `ENGINE rung` line-protocol word defaulting to 0, and the service exposes it | `tests/state.rs`-style resume proof for each rung that supports state; rung 3's state codec is its own, smaller, and says so |

M5 is optional and only starts when M1 through M4 are green. The pool
measurements in `service.md` (5.55x at pool 12 on six cores) will change
shape under rung 2, and the note must be re-measured rather than re-read.

## Traps, restated for this work

- **Half-cycles, never cycles.** `h` is the unit in every struct, file and
  table. A "cycle" column is derived at the edge for display and nowhere else.
- **A comparison that passes on nothing.** The lockstep tests must assert the
  trace has the expected length before comparing, and the `MUTATE=1` path
  must exist from the first commit of each test.
- **Measured and authored are kept apart.** Rung 3 will need hand-written
  logic. It is labelled `authored` in the source and listed in the note. It
  is not silently mixed with the table.
- **No number in prose without a run behind it.** The throughput of each rung
  is unknown until `benchmarks.rs` has been run against it best-of-N, and the
  counted columns are the ones that carry the argument.
- **Check which binary is running.** Four engines with one trait means four
  ways to benchmark the wrong one. The bench prints the rung and the crate
  version on its first line.
- **The licence boundary.** Rung 2's generated code and rung 3's embedded
  tables are derived from NC-SA data. `NOTICE.md` gains a line per crate.
- **No em dashes in anything shipped.** `grep -c '—'` over the new crates'
  `src/` and the note prints only zeroes.
- **Do not touch `halfphi` or `v6502-sim`** except to add the `PinEngine`
  adapter for rung 0, and `tools/check-halfphi.mjs` must stay green.
