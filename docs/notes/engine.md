# The engine: crates, solver, verification, performance

How the simulation is built and why it is trusted. Split out of `CLAUDE.md`; the load-bearing invariants are summarised there and stated in full here.

## `halfphi`, and why it is separate

Also published on its own at <https://github.com/tinymachines/halfphi>. It is the
part of this project that is about switch networks rather than about a 6502:
`source.rs` (the JS-literal parser for visual6502-format die data), `netlist.rs`
(CSR topology) and `engine.rs` (the solver).

- **The split is a licence boundary as much as a design one.** `halfphi` embeds
  **no die data** and is MIT. `v6502-netlist` embeds `netlist.bin` and therefore
  carries the CC BY-NC-SA obligations. Adding die data to `halfphi` would undo
  the only reason it can be depended on freely.
- **Nothing in `halfphi/src` may name a chip.** Rails are a parameter because
  the 6800 calls ground `gnd`; layers are data because the 6800 and Z80 have no
  layer 2. Measured before the split: the solver contained zero literals naming
  a signal on this die, and ~72% of the workspace was already the library.
- **The parser moved out of `build.rs`, and that is the change that mattered.**
  It could always read any of these dies; nothing could call it.
- **`Netlist::mos6502()` is now the free function `v6502_netlist::mos6502()`.**
  A type that knows how to construct itself as one particular chip is the exact
  coupling the split removes.
- **`rustfmt.toml` exists to stop whitespace drift**, not as a style opinion. The
  standalone repo runs `cargo fmt --check` in CI and this one has never been
  fmt'd, so default rustfmt reflowed the one-line struct literals used
  throughout. Do not run `cargo fmt --all` here expecting a no-op on the rest of
  the workspace.

**The source exists in two repositories, and `tools/check-halfphi.mjs` is what
keeps them honest.** The five shared files (`src/{lib,source,netlist,engine}.rs`,
`tests/chips.rs`) were byte-identical the day of the split and drifted on
whitespace within minutes of it, which is how this project learned that
"remember to copy it across" is not a mechanism. The check diffs them and
`deploy.sh` refuses to publish on a difference; `--fix` copies THIS repo's copy
over the published one, which is the direction that is almost always right (the
engine is developed here, against three chips, and published there) and never
the other way, because that would undo work silently rather than reveal it. It
**SKIPS** when the sibling checkout is absent, like the golden trace and the
manual, so a clone with only this repo can still deploy; `REQUIRE_HALFPHI=1`
insists, and an explicit `HALFPHI=<path>` is used ALONE rather than falling back
to a sibling, or a wrong path would quietly check a different checkout and
report it fine. `tests/chips.rs` searches two candidate paths for the die
submodule precisely so one file can be correct in both layouts. The real fix is
still a git or crates.io dependency.

## `v6502-netlist`

`build.rs` parses `extern/visual6502/{segdefs,transdefs,nodenames}.js` with a
small tolerant JS-literal parser and emits `netlist.bin` (31 KiB) into `OUT_DIR`;
`lib.rs` embeds it with `include_bytes!`. Nothing generated is checked in and the
1.4 MB of JavaScript never ships.

Adjacency is **CSR** (flat index array + per-node offsets), not the reference's
array-of-arrays. Two adjacency lists per node: transistors it *gates*, and
`Terminal { transistor, other }` for transistors it is a *terminal* of — `other`
is precomputed to remove a branch from the innermost loop.

Facts: **1725 nodes, 3510 transistors, 846 names.**

## `v6502-sim`

- `engine.rs` — chip-agnostic switch-level solver.
- `cpu.rs` — two-phase clock, bus handshake, register/timing readout.
- `timing.rs` — decodes the internal T-state chain.
- `bus.rs` — `Bus` trait + `FlatMemory` with an undo journal.
- `history.rs` — keyframed rewind.

## The simulation model

A node's level is not a property of the node but of the **group** of nodes
currently shorted together through conducting transistors. Settling = rebuild
groups, resolve, propagate, repeat to a fixed point (capped at 100 rounds, like
the reference).

Group resolution takes the **maximum** of `Drive`:

```
Floating < ChargedHigh < PullDown < PullUp < Vcc < Vss
```

`ChargedHigh` is a group with no driver that still contains a node holding charge —
this is how the 6502's dynamic logic retains state between clock phases. There is
no decay or capacitance ratio; the two-phase clock never floats a node long enough
to need it.

Note the reference resolves by *first match in traversal order*, not by maximum.
These differ only when a group contains both a pullup and a pulldown.
`Stats::contested_groups` counts that case; it is **0** across all tests, so the
divergence is unobservable in practice — but if it ever goes nonzero, that is the
first thing to suspect.

## Invariants ported deliberately — do not "clean up"

- **Transistor terminal normalisation** (`build.rs`) uses two *sequential* ifs, so
  the second sees the first's result. Faithful to `wires.js:setupTransistors()`.
- **Pullup comes from the first segdef mentioning a node**, not the OR of all of
  them. Later polygons cannot change it.
- **`transistor_on` queues only `c1`; `transistor_off` queues `c1` and `c2`.**
  Closing a switch merges two groups (either end reaches both); opening it splits
  them (both ends need independent re-evaluation). Load-bearing asymmetry.
- **Group traversal records rails but does not cross them.** vss/vcc connect to
  hundreds of transistors; crossing would merge most of the chip into one group.
  They get no CSR terminal entries at all.
- **`p5: -1`** in the name table is a sentinel — the status register has no bit 5.
  It is kept out of the name map, and `Registers::p` reports bit 5 as 1, as silicon
  does. The reference's own `readP()` crashes on this.
- **17 transistors are gated by vss** → permanently off, which is physically
  correct. `build.rs` warns only about vcc-gated ones (none exist), which *would*
  be wrong: permanently on in silicon, permanently off in this model.

**One deliberate departure: a rail is never written.** `recalc_node` writes the
resolved level into every member of the group, and `build_group` records a
rail it reaches as a member (it has to, to count the rail's drive), so a group
joined to both rails resolved to Vss and wrote `false` into vcc's own storage.
The reference does exactly the same and neither engine ever *reads* a rail's
stored level -- a rail resolves by identity -- so it was unobservable to the
solver, and the golden test could not see it either: the reference's
`stateString` prints the rails as `g`/`v` without looking, and ours mirrors
it. What saw it was the halfshot export, where a reader found the declared vcc
node toggling forty times in a batch, low for half a cycle on most opcode
fetches. `recalc_node` now skips rails in the write loop;
`rails_hold_their_level_at_every_half_cycle` in `tests/functional.rs` fails
without that line. Two consequences worth knowing:

- **The Z80 now converges from a cold power-on**, where `halfphi`'s
  `tests/chips.rs` used to record that it did not and attribute that to the
  missing per-chip `support.js`. The attribution was wrong: the Z80 has 32
  transistors gated by vcc (the 6502 has none), the write loop turns a node's
  gated transistors on and off with its level, and vcc's level was bouncing.
  With the rail pinned they stay where the model documents them, permanently
  off, and it settles. Same lesson as everywhere else here: a recorded
  measurement is what catches a change of mind.
- **A bit-exact golden test is only as wide as its encoding.** Every node,
  every half-cycle, and still blind to two of them by construction. When
  something reads a value out that the tests only ever *mask*, expect the mask
  to be hiding something.

## Timing and state

`half_cycle` is the fundamental unit — the chip does work on both clock edges, so
counting whole cycles loses half the story. Bus reads are serviced as `clk0` falls,
writes as it rises.

**The 6502 overlaps the tail of one instruction with the next opcode fetch.** An
ALU result is *not* in the accumulator when `sync` rises: it sits in the ALU hold
register and transfers during the following cycle. Tests asserting on register
contents must step one extra cycle (`run_to_writeback` in `tests/functional.rs`).
`LDA` (no ALU) lands a cycle earlier than `ADC`. This is real silicon behaviour
that behavioural emulators hide.

`reset()` is a **warm** reset, faithful to the reference's `initChip()`: node pull
state carries over, including data-bus pulls left by a previous run.
`power_cycle()` restores layout pulls first. Use `power_cycle()` for reproducible
runs.

## Verification

Two independent oracles. Both must pass; either alone is insufficient.

1. **`tests/golden.rs`** — diffs against the original JavaScript engine running
   headlessly (`tools/golden-trace/gen.js`), comparing the level of **all 1725
   nodes at every half-cycle**, plus registers and bus. Matching registers alone
   would only show agreement about the 6502; matching every node shows agreement
   about the silicon. Currently bit-exact over 3000 half-cycles.

2. **`tests/functional.rs`** — the documented ISA: datasheet cycle counts
   (including page-crossing and branch penalties), the RMW double-write, JSR/RTS
   stack layout, ADC/SBC flags, BCD. A shared misreading of the die data would
   pass the golden test but fail these.

If you change the test program in `gen.js`, regenerate the golden file — the Rust
test reads the program bytes out of its header rather than duplicating them.

## The pin contract (`v6502-pins`)

`docs/engine-ladder.md` plans four engines that present the same chip at the
package pins and differ in how much silicon they still simulate; rung 0 is the
`Cpu` above, and it is the oracle for the rest. What "the same chip at the
pins" means lives in one crate with no dependencies and no die data, so the
definition cannot drift between engines:

- **`PinFrame`**: `h`, `clk0`, `ab`, `db`, `rw`, `sync` and the five inputs
  as driven. `Copy` and `Eq`, so a trace is a `Vec` and a comparison is `==`.
  Not in it, deliberately: the internal clock phase (it lags `clk0` through
  the on-die generator and is not visible at the pins) and the registers (the
  ALU hold-register lag is real silicon; an engine reproduces its visible
  consequences, not the register).
- **`h` counts from the end of the reset sequence**, the way `Cpu::half_cycle`
  and the golden trace count, and a frame is the state after `h` steps, so a
  run of `n` steps is `n + 1` frames. `db` is the value on D0..D7 at the point
  the bus is serviced this half-cycle: reads as `clk0` falls, writes as it
  rises, which is what `half_step` already does.
- **`PinEngine`**: `power_cycle`, `set_inputs`, `half_step`, `pins`, `h`.
  `v6502-sim/src/pins.rs` implements it for `Cpu<B>` by calling the crate's
  own accessors (`address_bus`, `data_bus`, `rw`, `sync`, `clk0`) rather than
  reading nodes, so if those are wrong the golden test says so first.
- **One driver, one comparison.** `run(engine, steps, stim)` cold-starts any
  engine and applies a `.stim` script (at `h`, before the step to `h + 1`,
  set the five inputs; visible in the frame at `h + 1`); `compare` returns
  the first differing `h` and field, and refuses a short trace by name. The
  recorder and every replay test go through the same two functions, and
  through the same `rung0(loads, reset_vector)` builder for memory, so a
  trace cannot be recorded one way and replayed another.

**The pin golden** (`tools/pin-golden/`, gitignored, 1.8 MB) is recorded by
`examples/pin-golden.rs`: the seven programs from `web/programs.txt` at 3000
half-cycles; the reference's program read out of `golden.txt`'s header; the
`tests/interrupts.rs` fixture scripted seven ways so every input pin is
exercised (IRQ inside the window where the BRK is lost and outside it, reset
in mid-run, RDY held low ten half-cycles, an NMI edge, an SO pulse, and the
free run); and all 256 opcodes after a fixed preamble, 96 half-cycles each,
so the twelve that never finish are recorded not finishing. The scripted
half-cycles are measured from rung 0 in the recording run (the BRK's fetch is
found by watching `sync` and the bus) and written into the `.stim` file as
numbers; a replay reads the numbers and measures nothing, because the engine
under test is the thing that might get the fetch wrong. Each recorded trace
was read back to check it shows what its name claims: the lost BRK pushes
`$0203` and the ordinary IRQ `$0202`; the NMI reads `$FFFA`; the mid-run
reset reaches `$FFFC`; RDY holds `$0202` for exactly the scripted span; the
SO pulse shows in the pushed P (`$72` against `$32`); `KIL` sits on `$FFFF`
to the end.

`tests/replay.rs` replays all 274 through rung 0 and is the shape every other
rung's test takes: swap the constructor, nothing else. It SKIPS without the
files (`REQUIRE_PINS=1` insists) and `MUTATE=1` flips one `db` bit halfway
through the first trace and must go red, which it does, naming the trace, the
half-cycle and the field. The stamp in each header is the crate version and
the netlist's node and transistor counts, not a digest: nothing here computes
one, and it is labelled as what it is.

## Rung 1: `v6502-hybrid`, the gates folded out of the walk

The queue solver again, with one change at gate outputs. `halfphi::Engine`
settles by rebuilding, for each queued node, the group shorted to it through
conducting transistors, probing every terminal of every member. On this die
most of what a walk probes at a gate output is the gate's own pulldown
network (a decode term has dozens of pulldown transistors on its output),
and no probe there ever leads anywhere but a junction or vss. `v6502-hybrid`
reads the network through `Schematic::derive` (**1160 gates** absorbing
**2637 transistors**, **873 switches** left, node 1085 unresolved and left in
the switch network, not special-cased) and keeps two counters per output,
maintained where transistors toggle: conducting straight-to-ground pulldowns
and conducting series tops. "Is this output at ground" is then a comparison,
and the walk enters the network only through a top that is actually on,
whose junction keeps its own adjacency (bottom to ground, top to output) so
a walk seeded at a junction goes exactly where the scalar's would.

**Bit-exact with rung 0 by construction, and held to it.** The seeds, the
queue order, the drive lattice and the write set are the scalar's; only what
is probed changed, and everything the scalar walk would have found (a rail,
a charged junction) the counters find too. `tests/lockstep.rs` steps both
engines on one memory image and compares `state_string()` and `trans_on`
after every half-cycle on the seven programs, the tight loop, the interrupt
fixture with an IRQ in the lost-BRK window, and the reference's program:
every node identical. `tests/replay.rs` is the pin replay with the
constructor swapped. `MUTATE=1` goes red in both, naming the node or the
field. Every node survives, junctions included, so the golden comparison
against the JavaScript engine would run against this rung unchanged.

**Measured, and the number is not a speedup.** On the seven programs
(`examples/bench.rs`, best of three, 20,000 half-cycles) rung 1 runs at
between 0.97x and 1.13x rung 0 across two runs, inside the 1.18x noise floor
recorded above, and its
recalc count is the scalar's to the decimal (893.0 against 893.0 on Counter),
which is the construction showing. On counters, which do not need repeats
(`examples/run.rs` under `sudo perf stat`, 200,000 half-cycles of
Fibonacci): **4.5% fewer instructions** (95.6 G against 91.3 G), 13% fewer
branch mispredicts, L1 dcache misses about doubled (336 M against 705 M,
the hybrid's tables beside the netlist's rather than inside it), cycles
equal within the box's noise. The probes the fold removes were about 2% of
the instructions; the rest is per-recalc overhead, queue mechanics and
bitset bookkeeping, spent 922 times a half-cycle for 186 changes. So the
finding is the one the search profile already pointed at from the other
side: **the lever is the recalc count, and a rung that is bit-exact by
construction cannot touch it**, because the recalc list is the queue order
and the queue order is what bit-exactness hangs on. Rung 2 is where that
overhead is compiled away rather than skipped.

### The machine value crosses the rungs, and the console rides it

Because rung 1's whole mutable state is the same four bitsets, rung 0's
`MachineState` is its snapshot format too: `v6502-hybrid/src/state.rs` is
`snapshot`/`restore` in that shape, and the per-output counters, which are a
function of `trans_on`, are rebuilt on restore rather than carried
(`HybridEngine::restore_state`). `tests/state.rs` proves the crossing the
way lockstep proves the construction: rung 0 runs a loop 777 half-cycles
(odd, so the seam lands mid-cycle), its value restores into a COLD rung 1
that never ran a reset, and both engines then step 600 half-cycles with
every node and every transistor compared at every half-cycle; then the same
the other way. `MUTATE=1` flips one node's level in the travelling value and
both directions must go red at the first comparison.

`HybridCpu` also latches `last_fetch` where rung 0 latches it (the sync
read in `service_read`), so the bookkeeping half of the value is the same
bookkeeping and not just compatible.

The wasm surface exposes this as `HybridMachine` (data build only: the
hybrid netlist is derived from the schematic, which is derived from the die
data), behind the same method names the console's worker already drives:
`importMachine`/`exportMachine` through ONE shared emitter (`machine_json`,
factored out of `Machine` so the two rungs cannot drift in shape),
`fillMemory`, `powerCycle`, `runHalfCycles`, `nodeId`/`isNodeHigh` for the
gate sampling with the same refusal. No rewind and no node-level buffer:
this is the console contract, not the explorer's. The crossing is checked
through the JS surface itself in the public site's console spec; on this
side the proof is `tests/state.rs` plus a node smoke run of
rung 0 -> rung 1 -> rung 0 with byte-identical exports.

## Rung 2: `v6502-compiled`, the network as code, 64 machines per word

`build.rs` reads the die through `Schematic::derive` and emits the kernel
into `OUT_DIR` as Rust: **1159 gates folded** (2633 transistors), each
output's ground drive one sum-of-products expression over its inputs'
values; **871 switches swept**, unrolled, as guarded merges of the five
thermometer planes; 154 junction rules; the one unresolved gate left as
switches; 6 transistors that can never conduct dropped. No engine crate at
run time: the netlist is gone and what remains is what it compiled to,
2225 lines of numbers. `tools/check-compiled-nodata.py` holds the generated
file to that (no string literal, no identifier outside the generator's
vocabulary), because the die's name table is MIT and the network is NC-SA
and neither should leak into the other; `deploy.sh` runs it.

The semantics are `halfphi::slice`'s on purpose: the same planes, the same
round (switches follow gates; each node's own drive; spread to closure;
resolve), Jacobi within a round, so the two share one account of why they
are not bit-exact with rung 0. What the fold changes is which loop the
transistors are in. The spread loop runs to closure several times a round
(3.4 passes measured); the 2633 absorbed transistors leave it, and a gate
costs one expression once per round. Levelising the gates would take fewer
rounds and change trajectories; it is not done here.

**Two things the kernel never met, because it started from the scalar's
reset state.** First, from the all-low power-on condition every latch on the
die is undefined and a simultaneous update flips both halves of a
cross-coupled pair every round, forever: the power-on settle hit the
100-round cap. `settle_power_on` damps it with a tie-break (a node that
flipped last round and would flip again is frozen for the rest of that
settle): 10 rounds, 708 node-lanes frozen per lane, and no other settle in
a run ever needs it (4,124 settles, none nonconvergent, 13.3 rounds each).
Second, the persistent disagreement with rung 0 is those latches: after
reset the odd accumulator bits and their storage nodes differ at every
half-cycle, because the queue resolves an undefined latch by visiting one
side first and the sweep by the tie-break, and a real chip by noise. The
program result agrees. `examples/agree.rs` reports the node agreement and
names the persistent nodes; it asserts nothing.

**Held to the pin golden, all of it.** Lane 0 replays every one of the 274
traces identically: the seven programs, the reference's program, the seven
scripted interrupt and RDY runs, the three decimal chains, all 256 opcodes
including the twelve that never finish. `MUTATE=1` goes red by name. `tests/lanes.rs` gives lane 1 a
different program and checks each lane touched only its own memory and
counted the same number of times, that lanes 2 to 63 are identical to lane
0 in every node, and that the accumulator carries `LDA #$41 / ADC #$01`'s
result one cycle late.

**Measured**, `examples/bench.rs`, best of three on `INC $20; JMP`:
**3,442 sweeps/s, 220,286 machine-half-cycles/s over 64 lanes, 6.83x rung
0 per machine** (rung 0 at 32,276 half-cycles/s in the same run). Per
sweep it is 0.11x the scalar: one machine is slower here and 64 are not,
and this is where "machines per second is bounded by cores" stops being
true. The kernel it descends from measured 2.3x on the same box. Not wired
into anything yet.

### The machine value crosses this rung too, held at the contract, not the nodes

The pin golden covers rung 2 from power-on; a console engine switch resumes
a foreign snapshot mid-run, which is outside it. So the crossing was
measured before it was promised (`examples/crossing.rs`): rung 0 runs a
loop 777 half-cycles, its value is broadcast into every lane
(`State::inject_all`; broadcast because `half_step` branches on the whole
clk0 word, so one imported machine has to be all lanes), and the two
engines run 20,000 half-cycles side by side. All 20,000 agreed at all
eleven pins and on Die Runner's eight watched control lines, with the
memory identical at the end, while the internal nodes diverged exactly as
the kernel's account predicts (first at +3, worst 2 nodes, 13,748/20,000
half-cycles fully identical). The charge divergence is real and it does not
reach the pins.

`tests/crossing.rs` holds that, both directions (an extracted lane 0 is a
well-formed rung 0 machine), on two programs, at pins, gates and memory
every half-cycle; node equality is deliberately NOT asserted, because it
would fail on what the rung is rather than on a bug. `MUTATE=1` corrupts
one opcode byte in the crossed machine and both directions go red.

The wasm surface exposes it as `CompiledMachine`, the same console verbs as
`HybridMachine` and the same shared emitter, with two things of its own:
names resolve through the embedded netlist on the wasm side of the licence
boundary (the generated kernel stays numbers, and
`tools/check-compiled-nodata.py` keeps it that way), and `last_fetch` is
latched post-edge off the settled pins (a falling edge that serviced a
fetch leaves clk0 low, sync high, rw reading, the opcode on the bus), which
reproduces rung 0's bookkeeping exactly from the first fetch after boot; a
node smoke run held rung 0 -> rung 2 -> rung 0 equal at pins, gates,
memory, half_cycle and last_fetch. What is expected to differ, and says so
in the type's doc: exported `value`/`trans_on` against another rung.
Compare memory and gates instead.

## Rung 3: `v6502-micro`, the table measured out of the transistors

No nodes. `build.rs` runs rung 0 over all 256 opcodes in ten contexts
(registers, flags, operands, base pages and the C-versus-offset-sign
correlation all varied) and records, per opcode and per half-cycle from its
own h=2, the 52-bit control vector of `src/lines.rs`: the 46 named lines,
the three vector-address constants, rw and sync read through the same pins
adapter the pin golden is recorded through, and the ALU carry-in where an
ALU operation consumes it. Spans are keyed by six authored selector bits
(branch taken, branch page cross, X and Y index cross, the carry, the
offset's sign), the build refuses if one key ever maps to two spans, and
the smallest single-valued selector mask per opcode is found by exhaustive
search over the six bits: 402 variants, the twelve known KILs, and a
vector-relative reset seed classified against two reset vectors. The
sequencer (`machine.rs`) plays spans through the datapath
(`datapath.rs`, the proven `m4-datapath.py` model ported line for line),
with the flags and the P-to-stack timing authored (`flags.rs`) and the
selector shared with the recorder by include.

**Held to the pin golden: all 274 traces replay with every pin equal at
every half-cycle**, `EXPECTED_FAILURES` and `UNAUTHORED_STIM` both empty,
undocumented opcodes and the six scripted stimulus traces included.
Decimal mode is unexercised by any trace. `MUTATE=1` goes red on the
table (one expected bit), the datapath (one suppressed #IPC, caught at
pclp that half-cycle) and the replay (one flipped db bit, named by
trace).

The input pins are authored against those six traces (2026-08-31), and
the mechanism is smaller than it sounds because the silicon's own trick
carries over: **an interrupt is the recorded BRK span hijacked**. The
poll at the coming fetch (IRQ level sampled every phi2 except the final
cycle's, the NMI edge latched until serviced) turns the next instruction
into op 00's span with three word edits: `#IPC` forced through the
fetch's and T1's phi2, so the pins re-read the fetch address and push the
un-incremented PC; the pushed P carries B clear; and the flavour's vector
select asserts beside the recorded lines, through BOTH vector cycles.
That last clause was the one measured surprise: T6's low address byte is
undriven precharge in the recorded span (ffff is just a precharged bus),
so an NMI keyed off `0/ADL0` alone read ffff where the chip reads fffb.
I sets right after the P push, which also closed a latent gap in plain
BRK: nothing had observed I before an IRQ could be held asserted into
the handler. RDY holds a read cycle still while the clock keeps toggling
(latched at the phi1 that would begin a new cycle after a read; writes
ignore it), and SO's false-to-true transition sets V.

The reset-mid-run trace looked unauthorable from the pins alone: three
cycles of junk addresses (0200 without sync, 5801, 0057, then a sync at
00ff) between the in-flight BRK and the warm reset sequence. It was
measured instead (`v6502-sim --example reset-probe`: the fixture's own
script on rung 0, printing the 51 control lines and the datapath latches
per half-cycle), and the freewheel turned out to be mechanical: **under
res the fetch never registers, and the machine replays the overlap
word-pair; the junk addresses are the datapath itself**, `ADDADL` and
`DL/ADH` walking DL and ADD through 58:01, 00:57, 00:ff. One pair after
release the same words play with sync, the warm reset's own fetch, and
the BRK span follows in the Res flavour: rw forced high through the span
(the pushes read; measured, and independent of the pin's level by then),
`0/ADL1` through both vector cycles (fffc, fffd), I set. Two latches
carry the measured timing: the boundary decisions consult res as of the
last phi1 (release takes one extra pair, exactly as recorded), and the
vector-select arm is double-latched at phi2 (an in-flight BRK's T6
steals to fffd while its T5 still read fffe). What res does mid-way
through a non-BRK instruction is the same machinery by construction and
is not separately measured; the fixture is the one oracle.

**39.0 M half-cycles/s on the inc loop, about 1,465x rung 0: 19.5x a real
1 MHz part.** This is the latency rung: the other rungs settle a network
per half-cycle, this one looks a vector up.

What the pin golden taught that the experiments had not, each now encoded
where it belongs:

- **`SRS` shifts the B input alone** (plus the carry-in into bit 7). The
  Python model's `(a | b) >> 1` could not be told apart on the four
  programs because an accumulator shift loads both latches with A; rung 0's
  own latches through `LSR zp` (ai=ff, bi=ea, add=75) settled it.
- **DL latches written bytes too; the external pin holds the last read.**
  Through BRK's three pushes the input latch steps 34 -> 02 -> 09 -> 34
  while the data pin shows the operand byte at every write's phi1. The
  machine keeps the two apart (`pin_hold` against `dp.dl`); DCP's compare
  is what consumes the latched written byte.
- **The ADD-path write-back lands inside the NEXT instruction's first
  execution half-cycle** (SBX after INX, SBAC after ADC, nothing after
  CLC, measured at the seam), which is the famous result-overlap seen from
  the control side. Each variant records its seam word and the sequencer
  ORs the finished instruction's word into the next span's first
  half-cycle. Direct loads complete inside their own span, which is why
  the recorder's contexts, all ending in loads or flag ops, recorded clean
  spans.
- **`dpc34_PCLC`/`dpc35_PCHC` are data signals wearing control-line
  names** (the PC incrementer's carries), masked out of the table; the
  datapath computes them.
- **The overlap's alucin is control where it is an increment's +1 and data
  where an RMW's fresh carry rides it**; the recorder keeps it per
  variant, masking only where same-key recordings disagreed, and the
  sequencer supplies its not-yet-updated C there, which is also what the
  ADC class computes with.
- **One instrument bug worth remembering**: when the alucin node joined
  the id list, the vector packer kept looping over the whole list and
  OR-ed alucin into bit 49, which is rw. The recorder, its probe and the
  coverage test all shared the bug and agreed with each other while every
  RMW's dummy write replayed as a read. The measurement that broke the
  symmetry was reading the pins directly beside the packed vector.

The coverage test (`tests/table.rs`) is the other half of the
single-valuedness claim: three contexts the recorder never saw run all 256
opcodes on rung 0 and the table must predict every control line at every
half-cycle through the same included harness and selectors. The datapath
test (`tests/datapath.rs`) drives the model from the chip's own line levels
and holds `abl abh pc pclp pchp a x y s` exact over 2,400 half-cycles,
with the hold registers at their measured figures (alu 95.4%, dor 97.8%,
idl 98.9%) above a 90% floor.

**The rung 3 machine value** (`machine.rs`: `MicroState`, 2026-08-31) is
its own and smaller than the four bitsets, and does not pretend to be
them: every sequencer field, the datapath latches, the authored input
latches and the memory, with the span pointer reconstructed from
`(op, key)` on restore so a state cannot smuggle in control words the
table never measured. On the wire it is a versioned byte codec of about
90 bytes (`state.micro` in the machine JSON, beside the same sparse
memory pages every engine emits), against rung 0's 1.3 KB of node
planes. `tests/state.rs` proves it the only way that counts here: run to
a half-cycle, snapshot, restore into a COLD machine, and the rest of the
recorded trace must hold at the pins, with the ten snapshot points
placed inside an interrupt's pushes, a RDY stall, the reset freewheel
and the Res span; MUTATE flips one P bit and goes red at the push that
exposes it. The wasm surface (`MicroMachine`, `crates/v6502-wasm`)
speaks the console's verbs over it, resolves `nodeId` against the 51
control-vector columns (which is exactly what Die Runner's eight watched
gates are) and refuses every other name with -1; there is deliberately
no `importMachine`, so a node-shaped value has no way in and an engine
switch onto this rung means powering the cartridge here.

In wasm the whole per-frame flow, export, import into a fresh machine and
an 8,704 half-cycle frame, measured **0.86 ms per frame (10.1 M hc/s)**
in node against the same frame's 350 ms on rung 0's wasm: the first
in-page engine that is real time with headroom. M5's `ENGINE` word is
live in halfwave (the account is in `service.md`: the binary moved to
`v6502-halfwave`, `ENGINE 3` speaks `MICRO`, and the FastAPI half routes
a step by the machine value's shape).

**Decimal mode, measured and authored (2026-08-31).** Three BCD chain
fixtures joined the pin golden (274 traces now): every result lands in a
`STA` and every flag set in a `PHP`, so a binary add where the chip
adjusts fails by address and byte. `decimal-probe` (a `v6502-sim`
example, the `reset-probe` method) showed where the adjust lives: `#DAA`
drops through the ALU compute half-cycles, the ADD register holds the
BINARY sum ($41 for $19+$28), SB carries it, and A receives the adjusted
$47: Hanson's decimal adjust adders sit on the SB-to-AC path alone. The
authoring follows the silicon: a seventh selector bit (`SEL_D`), two
`SED` recorder contexts so the `#DAA`/`#DSA` drops are recorded control,
a `dec_add` latch in the datapath set beside a decimal-enabled SUMS and
applied only on `SBAC`, and NMOS decimal flags for the ADC family (Z
binary, N and V from the intermediate, C decimal; SBC keeps every flag
binary, so its ordinary path serves).

The decimal fresh context (`gen-d` in the coverage test) then flushed
two latent bugs the recorder's contexts had agreed past by luck, both
the same disease: **data in the table wearing a control bit's clothes.**
The overlap alucin was recorded wherever any ALU op ran, including ANDS
and kin that ignore it (op 3b's AND carried a data level, single-valued
across ten contexts, wrong on the eleventh); the recording rule now
names the consumers (SUMS, SRS), and where nothing consumes the overlap
sum at all the bit is masked outright. And the RRA family's overlap
carry-in is its own ROR's carry OUT, the fresh-carry case: no selector
key can determine it, so the recorder masks it and the sequencer
computes it from its own mid-span shift capture, which is also what the
ADC-half's flags consume.

Still open, deliberately: a fetch-boundary crossing from a node rung's
machine value (the seam word of the finishing instruction is the hard
part: it needs the previous opcode's variant, which a node state does
not carry at the boundary).

### The same kernel on a GPU (`v6502-gpu`)

The same `build.rs` emits the kernel a second time as WGSL, from the same
folds and switch list, so the two cannot drift; `v6502_compiled::KERNEL_WGSL`
is the text and `v6502-gpu` runs it through `wgpu`. That crate is the one
place in the workspace with registry dependencies (73 crates behind `wgpu`
and `pollster`) and nothing shipped depends on it. Tests SKIP without an
adapter, `REQUIRE_GPU=1` insists, `GPU_INDEX=n` picks a card.

**Bit-exact with the CPU rung, lane for lane.** Per-lane semantics are
lane-independent, so GPU lane `k` of any word must equal CPU lane `k` of a
`Machines` given the same memory: `tests/parity.rs` loads the CPU state
into four words of 32 lanes (lane 1 on a different program), steps both
sides 361 half-cycles in six batches, and compares every node and every
transistor after each: identical. `MUTATE=1` flips one CPU bit and goes red
naming the node. The one bookkeeping bug on the way was mine, not the
kernel's: `power_cycle` leaves `clk0` low, so the first dispatched edge
must be the rising one.

**Three shapes were tried, and the driver decided the first two.**
1. *Straight-line code, as on the CPU.* The NVIDIA shader compiler took the
   871 unrolled switch blocks to 38 GB of memory before the kernel was
   OOM-killed; with the switches as data, the 1,159 gate statements still
   took 15 GB and two minutes and failed. On a GPU the fold is the
   compile-time work and the code shape is data: the switch list, the gate
   terms and the junction rules are storage buffers interpreted by loops,
   with every loop bound in the uniform, because as constants the driver
   unrolled the nested settle and spread loops. Pipeline compile: 0.19 s.
2. *One thread per word, the whole half-step serial.* Correct, and 273,000
   machine-half-cycles/s at 8,192 machines: 33 sweeps/s, barely the CPU
   rung, because a thread is a slow serial machine and 256 of them leave
   the card idle.
3. *One workgroup per word, 256 threads cooperating.* The relaxation is a
   monotone OR over the planes, so switches can be merged in parallel with
   `atomicOr` and reach the same fixed point; the nodes, transistors, gates
   and junctions are split across the threads with barriers between
   phases and shared atomics for the reductions. With the planes in global
   memory: 1.64 M machine-half-cycles/s at 2,048 machines, falling past
   that as the working set left L2. **With the five planes in workgroup
   memory** (34.5 KB of the 48 KB the card allows), atomics are on chip and
   the curve stops falling: **3.62 M at 2,048 machines, 3.78 M at 6,400
   machines** (`examples/bench.rs`, best of three, 400 half-cycles of the
   `INC $20; JMP` loop, one readback at the end), about 17x the CPU rung 2
   and about 128x rung 0, still rising with width.

What stopped the curve at first was the box, not the kernel: each lane
carried a dense 64 KiB of memory, 2 MB a word, 99% of the footprint, and
200 words was the widest that fit. **Sparse per-lane memory removed that
ceiling (2026-08-31)**: one shared base image, a 256-entry page table per
lane, and a pool of 256-byte pages allocated copy-on-write at a lane's
first write into a page. Each lane's table and pages belong to that
lane's thread alone, so the one shared atomic is the allocator; a spent
pool raises a flag and every readback refuses the run by the numbers
rather than serving memory whose writes were dropped (`tests/parity.rs`
proves the refusal fires, and holds the reconstructed per-lane memory
byte-for-byte against the CPU lane, including a lane loaded with a
different image whose pages are pre-seeded into the pool). The budget is
the host's: 16 pages a lane by default, 4 KiB against the dense 64.

Measured on the same card, same bench, after the change: **3.69 M
machine-half-cycles/s at the old 6,400-machine ceiling (parity with the
dense 3.78 M, inside run noise), rising to 4.95 M at 128,000 machines
(4,000 words), and 512,000 machines run at 4.46 M** (16,000 words, about
3.3 GB) -- eighty times the machine count, with the aggregate at about
167x rung 0 at the peak. The card was underfed at 200 words; the limit
is now the serial phases inside a word (the barriers between steps and
the per-word settle loop), not memory.

## Performance

**~29,600 half-cycles/s native (~14.8 kHz simulated 6502)**, against the
reference JavaScript's 302 half-cycles/s: **98x faster**. A real 6502 runs at
1 to 2 MHz, so this is 68x to 135x slower than the part.

```bash
node tools/export-programs.mjs                                  # web/programs.txt
cargo run --release -p v6502-sim --example benchmarks           # all seven programs
REPEAT=9 cargo run --release -p v6502-sim --example benchmarks 25000
cargo run --release -p v6502-sim --example bench                # one tight loop
```

`benchmarks` runs the seven shipped programs. `bench` runs `INC $20; JMP` and
is the older smoke test.

**It is not memory-bound, and that was measured after the opposite was
guessed.** The instruction mix inside `settle` is a CSR walk with bitset
probes, which reads like pointer chasing; `perf stat` says otherwise.

| | |
|---|---|
| instructions / half-cycle | **393,000** |
| IPC | **2.04** |
| L1 dcache miss | **1.28%** |
| cache miss | 2.15% of references |
| time in `Engine::settle` | **99.6%**, fully inlined, flat, no line over 3.4% |

The netlist is 31 KiB and stays in cache. The solver is not waiting, it is
working, so there is no micro-optimisation to find and no hot line to fix.

**The lever is the recalc-to-change ratio: 922 node recalcs per half-cycle
against 186 nodes that actually change level, so 80% of recalcs resolve to the
value the node already held.** The change guard in `recalc_node` is already
there; the waste is upstream of it. Every transistor toggle queues its
terminals, and finding out that a terminal did not move costs a whole group
build. Group size averages 2.0 and there are 16.3 settle rounds per
half-cycle.

- **The workload does not matter.** The seven programs spread about 1.09x
  against a measured noise floor of about 1.18x, and which one looks slowest
  changes between runs. The chip does the same fetch, decode and settle work
  whatever the opcode is. Worth knowing before optimising against one program.
- **Timed columns need repeats; counted columns do not.** `hc/s` is best-of-N
  because noise only ever slows a run down. Recalcs, rounds and changed nodes
  are counters and come back bit-identical.
- The obvious optimisation, skipping nodes already covered by a group
  processed this round, is **not** safe: applying a group toggles transistors
  and can change connectivity before the later node is reached.
- **A global-epoch pre-filter was built, proved correct, and reverted for
  firing 0.63% of the time.** The idea: count every event that can change how
  a group resolves (a transistor toggling, a pull being driven, the state
  being replaced) in one monotonic `epoch`, stamp each node when its group is
  resolved, and skip the walk when the stamp still equals the epoch. It is
  sound where the unsafe version is not, because a toggle moves the epoch and
  the skip stops firing; **the golden test passed bit-exact over all 1725
  nodes at every half-cycle.** It is also useless: 5.65 skips per half-cycle
  against 899 attempts, and throughput unchanged within noise.
  - **The granularity is the whole problem.** ~180 nodes change level per
    half-cycle and each toggles its gated transistors, so a *global* epoch
    advances hundreds of times per half-cycle and no stamp survives to be
    reused. A node's group only cares about toggles affecting *its* members,
    not about any toggle on the die.
  - What this rules out is the cheap version, not the idea. A per-node or
    per-group staleness stamp could still work, but validating it needs the
    group membership, which is the walk being avoided. Anything tried here has
    to beat 437 instructions per recalc including its own bookkeeping.
  - One hazard found while building it, worth knowing if this is revisited:
    `Engine::state_mut()` hands out `&mut ChipState` and `v6502-sim`'s restore
    path uses it to replace all four bitsets. Any scheme that caches a fact
    about the state must invalidate there, or it will trust stamps taken
    against a different machine, and the failure lands on the one path whose
    promise is bit-exact resume.
- **The searches were profiled against the atlas, and the result closes a
  door.** `examples/search-profile.rs` (behind `halfphi`'s `probe` feature)
  records every recalc: its seed, the group it reached, and whether anything
  moved. `tools/analyse-searches.py` joins that to the address table.
  Measured over 120 half-cycles: **927 searches per half-cycle, mean group
  2.03, 79.6% changing nothing** -- which reproduces the figures above from a
  different instrument, so the profiler is sound.
  - **The 80% waste is NOT redundancy, and that is the finding.** **82.6% of
    searches are the first look at that node this half-cycle**; only 17.4% are
    repeats, only 40% of those return an identical group, and only **7.0% of
    all searches are both memoisable and worthless.** That 7% is the ceiling
    for caching by seed *before* any bookkeeping, which is why the global
    epoch pre-filter could not win and why a smarter cache will not either.
    Four searches in five are a correct first look that finds nothing.
  - **87.9% of searches never leave one container**, and the crossings that do
    are exactly the datapath transfers: `dbus:idb ~ sbus:sb` (SBDB),
    `bus:adl ~ pcr:pclp` (PCLADL), `bus:adh ~ pcr:pchp`, `dbus:idb ~ dbus:idl`
    (DL/DB), `alu:b ~ dbus:idb` (DBADD), `alu:a ~ sbus:sb` (SBADD). The
    solver's runtime behaviour recovers the bus architecture without being
    told it.
  - **Waste concentrates by class, not by place.** Seeds of class `bus` are
    33% of all searches and waste **93.5%** of them: a pure bus bit is joined
    to dozens of switches, so anything toggling anywhere on the bus re-queues
    it, and its level almost never moves. By container kind the worst is
    `stage` (the decode terms) at **97.4%**, then `regs` at 91.8%.
  - The most-searched single nodes are the precharged control lines,
    `regs:s.SS:dyn3:#654` (`dpc7_SS`) at 420 searches in 120 half-cycles, each
    gating eight switches.
  - **The feature costs nothing when off**, and that was checked rather than
    assumed: zero `probe` strings in the default rlib, and throughput
    unchanged at 25,045 half-cycles/s best of three.

- **Throughput and latency are different problems.** One machine is bounded by
  the above; machines per second is bounded by cores, and there are 12.

### The solver as a kernel: `halfphi::slice`

The same fixed point computed the other way round, so that 64 machines can
share one instruction stream. `engine::Engine` is queue-driven and
materialises groups, which is the right shape for one machine and the wrong
shape for many: the queue is data dependent, so two machines cannot share a
control path, and its inner loop branches on "is this transistor conducting",
which is the thing being simulated. `halfphi::slice` (`SliceNetlist`,
`SliceState`, `LANES`) keeps no queue and no groups: every node repeatedly
takes the maximum drive of its conducting neighbours until nothing moves, one
bit of every `u64` being one machine. Two encodings make that a straight
sweep with no per-lane control flow:

- **The drive lattice is a thermometer, so `max` is `|`.** `Floating <
  ChargedHigh < PullDown < PullUp < Vcc < Vss` becomes five planes, plane `k`
  meaning "at least level k+1", and the maximum of two drives is the bitwise
  OR of their planes: one instruction for all 64 lanes.
- **Nothing branches on machine state.** Conduction is a mask (`& on`), not
  an `if`. Every lane executes every step; the ones for which it is a no-op
  OR in zero.

Rails are recorded but never crossed, the same invariant `build_group` gets by
giving them no adjacency; here it is a per-transistor direction computed once,
and the 17 vss-gated transistors fall out as permanently off. It is
deliberately kernel-shaped (flat arrays, a fixed sweep over all nodes and all
transistors, no early exit per lane) because that is what ports to a compute
shader without being redesigned: a `u64` lane becomes a `u32` lane and the
sweep becomes the dispatch.

```bash
cargo run --release -p v6502-sim --example bitslice [half-cycles]   # default 2000
```

`examples/bitslice.rs` is the harness. It runs the scalar `Cpu` and the kernel
side by side on `INC $20; JMP` and compares the level of every live node every
half-cycle; then it gives lane 1 a different program (`INC $21`) and checks
that each lane touched only its own memory, because 64 copies of one machine
would pass the first comparison while proving nothing about independence.
That check began as a perturbed byte, which passed at 400 half-cycles and
failed at 3000 because the run starts mid-instruction and the next write can
put the same value in every lane; a check that depends on where the clock
stopped is not a check.

**It is not bit-exact with the scalar engine, and that is a property of the
problem rather than a defect.** Over 3000 half-cycles the program result is
identical in both, **2061 of 3000 half-cycles agree on all 1702 live nodes**,
the first divergence is at half-cycle 8, and the worst half-cycle differs on
2 of 1702 nodes. The cause is charge: a node briefly joined to a driver keeps
that level after the switch reopens, so the settled state depends on the path
and not only on the final switch configuration. The queue stages a specific
sequence of configurations including momentary ones (node 802 goes low
because 781 rises just long enough to join it to vss through t254), and the
sweep reaches a consistent state without entering that configuration. Queue
order is data dependent, therefore lane dependent, which is exactly what a
lane-uniform kernel cannot reproduce. So the kernel agrees at the level
`functional.rs` tests and not at the level `golden.rs` tests, the example
says so instead of printing a pass, and any engine built on this encoding
needs its own oracle at that level. `tools/check-self-counts.py` re-runs the
example and holds the four counts above.

Measured, best of three at 3000 half-cycles on the usual loaded box (load
5.6): **68,235 machine-half-cycles/s, 1,066 sweeps/s**, with every transistor
swept every round and nothing skipped. Per machine that is more work than the
queue does (the whole die every round against ~900 nodes touched), and the 64
lanes pay for it. The scalar figure to set it against is the one in
`CLAUDE.md`, and the ratio is not typed here: a timing is not held by the
count check, and the two are rarely measured in the same minute. Not wired
into anything; the scalar engine remains the one the site and the API run.

## The reference (`extern/visual6502/`)

Load order in its HTML *is* its dependency graph (`wires.js` reads
`nodenames['vss']` at top level). `chipsim.js` is the whole engine in ~180 lines;
`macros.js` is the 6502 layer; `expertWires.js`/`kioskWires.js` are the UI shells.
`expert-allinone.js` is an unreferenced concatenated bundle — ignore it.

## Data formats

```js
// segdefs.js -- one polygon; a node owns many
[nodeNumber, '+'|'-' /* pullup */, layerIndex, x0,y0, x1,y1, ...]
// layerIndex: 0 metal, 1 switched diffusion, 2 inputdiode,
//             3 grounded diffusion, 4 powered diffusion, 5 polysilicon

// transdefs.js
['t123', gateNode, c1Node, c2Node, [xmin,xmax,ymin,ymax], [w1,w2,len,segments,area]]

// nodenames.js -- name -> node; buses are numbered scalars (ab0..ab15)
```

`v6502-netlist/build.rs` consumes the node number, pullup flag and transistor
terminals. **The polygons are not yet extracted** — the renderer will need them,
plus the transistor bounding boxes for hit-testing.

## Two builds of the wasm crate, and why the die data is a feature

`v6502-wasm` builds two ways. **Two builds of one crate rather than two
crates**, for the reason every shared module here exists: a second copy of the
bindings would drift, and a reader comparing them would have no way to tell
which was lying.

| | | |
|---|---|---|
| default | **117 KB**, embeds `netlist.bin` | what the site ships. Carries **CC BY-NC-SA** |
| `--no-default-features` | **85 KB**, embeds nothing | can be **MIT**, like `halfphi`. Takes a netlist at runtime |

The 32,628-byte blob is derived from the die data, so it drags NonCommercial
and ShareAlike into anything that ships it, whatever the code's licence file
says. A published JavaScript package that wants to be MIT must therefore
embed none, which is the whole point of the split.

- **The split was shallower than it looked.** `v6502-sim` embeds nothing
  itself, and `Cpu::new(netlist, bus)` already took a netlist. The only ties
  were `mos6502()` and two modules importing `Netlist` and `NodeId` from
  `v6502-netlist`, which **re-exports them from halfphi anyway**. Naming the
  original means `cpu.rs` and `timing.rs` compile with no die data near them.
- **`Machine.fromNetlist(bytes)`** is the data-free constructor. The format is
  halfphi's own, magic `HALFPHI1`, and `Netlist::decode` refuses anything else
  rather than building a chip out of the wrong bytes. It is not 6502-specific,
  though the clock and bus layer around it expects a 6502's signal names.
- **Every binary and example in `v6502-sim` declares
  `required-features = ["mos6502"]`.** They call `mos6502()` or `boot()`, so
  without that declaration `--no-default-features` builds the library fine and
  then fails compiling tools that cannot work without a chip.
- **`tools/check-wasm-nodata.py` is the guard, and it needs to exist.** This
  property regresses silently: somebody adds a convenience, reaches for
  `mos6502()`, the dependency comes back, and nothing fails. The build works,
  the tests pass, and the package has quietly stopped being MIT. The check
  reads the dependency tree, which is fast and catches it at the source, and
  **also asserts the crate IS present with the feature** so it cannot pass on
  a workspace where the crate was simply deleted.
- **Proof it works rather than merely compiles:** the data-free bundle, handed
  `netlist.bin` at runtime, reports 1725 nodes and 3510 transistors and
  reaches the project witness, A=$42 and `$0082`=$42 at half-cycle 41.
- **`new Machine()` on the data-free build returns an empty JS object rather
  than throwing**, because wasm-bindgen classes are plain JS classes and there
  is no constructor in the generated glue. Using it throws `null pointer
  passed to rust`. That looked like a leak and is not one; the binary carries
  no `HALFPHI1` and the dependency tree has no `v6502-netlist` in it.

## The machine as a value, in the browser too

`exportMachine`, `importState` and `fillMemory` on the wasm `Machine`. The
codec is `v6502-sim`'s, not a second one, so **what the browser exports is the
object the HTTP API passes**: `{state: {half_cycle, last_fetch, value, pullup,
pulldown, trans_on}, memory: {fill, pages}}`, memory sparse by the service's
own rule.

- **Nothing new had to be true for this to work.** The service is stateless
  because a machine IS a value, and `tests/state.rs` already proved the codec
  restores bit-exact into a machine that never ran the first half. What was
  missing was any way to get one in or out of the browser.
- **JSON is emitted here and parsed in JavaScript, never the reverse.**
  Emitting it is a format string; parsing it would be a parser, and this crate
  has one dependency. Same asymmetry as the engine's line protocol:
  `importState` takes the fields one by one for that reason.
- **`halfCycle` crosses as an `f64`**, so it stays an ordinary JavaScript
  number. A `u64` arrives as a BigInt, and no run reaches 2^53 half-cycles at
  fourteen kilohertz.
- **`importState` throws the rewind buffer away.** It belongs to the run that
  just ended, and keeping it would let `stepBack` walk into a machine this one
  never was.
- **Memory travels separately and must be written first.** `fillMemory` then
  `load` per page. A chip resumed over the wrong RAM fetches the wrong opcode
  on its very next cycle, which is why `wasm-bridge.mjs` does memory before
  the state.
- **`tools/check-wasm-parity.py` splits a run in half and hands it across,
  both directions**, and requires the answer a single uninterrupted run gives:
  A=$42 at half-cycle 41, and the `value` bitset identical over all 1725
  nodes. It also resumes one half-cycle short and requires that to differ,
  because an assertion that cannot fail is not an assertion.
  `tools/wasm-bridge.mjs` drives the wasm from outside a browser, the same
  shape as `service/asm-bridge.mjs`.
- **`traceRows(halfCycles, watch)` is the API's `format: "rows"` in the
  tab.** Same 34 columns, same encodings, same watch bitset, because it is
  the same Rust function (`v6502_sim::rows::push_row`) that `halfwave`
  runs for its `ROWS` line; the service passes the result through and
  encodes nothing. `watch` is names separated by whitespace, the `WATCH`
  line's shape; an unknown name or more than `MAX_TRACED` (10,000)
  half-cycles throws before the chip moves. The parity check records the
  same 41 half-cycles both ways and requires every cell equal; a mutant
  that swapped the phase encoding at one end was named by column.
- **The site ships `--target web`, which cannot be `require`d.** The parity
  check needs a `--target nodejs` build, and it skips without one.
- **The bundle embeds the die data** (`v6502-wasm` -> `v6502-sim` ->
  `v6502-netlist`, which `include_bytes!`s `netlist.bin`), so those 106 KB
  carry CC BY-NC-SA whatever the code's licence says. A published JS package
  that wants to be MIT the way `halfphi` is must ship no die data and take it
  at runtime. See `NOTICE.md`.

## `graph.json`: the chip as one node-and-edge file

Asked "do we have a single node-edge data structure of the chip network",
the honest answer was: at three levels, and not as one file. The raw netlist
(`transdefs.js`, 3510 rows of `gate, c1, c2`: the chip as a hypergraph, every
edge a transistor labelled by a third node; `netlist.bin` is that in CSR, Rust
only), the interpreted circuit (`schematic.json`'s `gates` and `switches`,
which every page flattens its own way), and the live graph
(`Machine.nodeGroup`). `export-graph` now writes the first two as one file:

- `nodes[i]`: `{id, name, block, seeded, role, pullup, x, y, drives}` by the
  die's own numbering, `null` at the 21 numbers the die leaves unused.
- `transistors[t]`: `{id, gate, c1, c2, kind, block}` by the die's own
  transistor number, terminals after the reference's normalisation (a rail is
  always `c2`); `kind` is the naive per-transistor reading, and it recounts
  to exactly the **2493 pulldowns / 783 pass / 234 pull-ups** the blueprint
  section states.
- `edges`: `{kind: 0, a, b}` for every distinct gate (input → output) pair
  (2435) and `{kind: 1, a, b, control, t}` per switch transistor (873, of
  which **70 are parallel pairs** on the same ends under the same control;
  `t` tells them apart, and a harness comparing as a set reported 803 and
  failed on correct behaviour).
- **`vss` is a gate-edge input on eleven gates.** Those are legs gated by a
  permanently-off vss-gated transistor, the ones the pinout page's direction
  rule turns on (RDY, S.O.); a rail is never a gate edge's *output*. The
  first comment said "never an endpoint" and the harness caught it.
- **Centroids are computed in Rust the way `die-centroids.js` computes them**
  (mean of the node's vertices, Y flipped) and `_graph-test.html` compares the
  two to the hundredth the file is written with: a second implementation of a
  one-sign flip is exactly what drifts. `deploy.sh` refuses to publish if the
  gate edges are not exactly `schematic.json`'s pairs, the switch count or
  gate count differs, an edge names an undefined node, or a name disagrees.

- **A dashed outline is a node with no pullup**, read from `schematic.json`'s
  `dynamic` gate kind: 142 nodes, of which 118 are precharged by a clock
  (`cclk` or an unnamed clock) and 24 are the `ab`/`db` pads, where the same
  shape (a transistor to vcc, no depletion load) is the pull-up half of a
  push-pull output driver. The page does not decide which reading applies:
  the key says both, and the pick card names the node gating the pull-up
  transistor (`state.pre`). The dash is the resting outline only; a ring for
  a change or a watch wins over it. `_tracer-test.html` recounts the set from
  the file and checks the computed `stroke-dasharray` on a node at rest,
  because the first version of that check picked a ringed one and read `none`
  on both sides.
- **The watch is stems, and a latch is eight nodes on the die.** `abh abl adh
  adl db idb sb` by default, presets for address, data, registers and ALU, and
  a free text field. Each stem is a byte readout with the moved bits marked, a
  ringed and labelled dot per bit in the drawing, and a thin dashed polyline
  through the bits so the latch reads as one thing. Clicking a row flies to
  it. `p` reads through the same code as everywhere and has no bit 5. A stem
  the die does not have stays listed and says so; vanishing would read as a
  typo the page silently forgave.
- **The code tracer is the program's own source** (`asm.lines`), the fetching
  instruction marked by `lastFetchAddr`, with a count of fetches per line.
  Fetches are observed on **every** half-cycle, at any clock: the first version
  observed only when fewer than sixteen half-cycles passed in a frame, so a
  deep link counted nothing and a fast clock would have quietly under-counted.
  The four readouts a fetch check costs are nothing beside a settle. **A rewind
  un-counts**: `fetchLog` records `(h, addr)` and `forgetFetchesAfter()` pops
  past the chip's half-cycle, because stepping back over a fetch and forward
  again counted it twice, which the harness caught by comparing the whole map
  against its own chip. The fetch the chip powers on into is counted too, or
  every program's first instruction reads as never having run.
- **The head line says when a frame spans more than one half-cycle.** At the
  fastest clocks the chip runs many half-cycles between paints and the change
  set is the union; a drawing claiming one half-cycle while showing forty would
  be the wrong kind of convincing. `?step=N` lands showing what the *last*
  half-cycle changed (run to N-1, paint, step, paint), not everything since
  power-on, which is what the first version did and what 411 ringed nodes at
  `?step=40` looked like.
- **"Only what moved"** hides every node that is not ringed, was not ringed at
  the previous paint, and is not watched, and every edge that did not fire or
  toggle. Named labels: watched bits and moved names always, every name past 3×
  zoom (`LABEL_ZOOM`); on a drawing of 1544 nodes a label per node is a wall.
- **The moved list is the change set in words**, grouped by block, named nodes
  as pills with the way they went and unnamed as a count, each pill flying the
  drawing to its node. It is the same list the trace page shows for one opcode.
- **Deep links:** `?program=N&run=1&step=N&watch=abl,pcl&fly=abl&mode=named&only=1&full=1`.
  `?fly=STEM` frames a watched stem and exists because it is also the only way
  to photograph a zoomed view headlessly.
- **Two layout bugs, both measured off a screenshot.** `scrollIntoView` on the
  current code row scrolled every ancestor, so loading the page dragged the
  document down to the listing (and the screenshot came back with a blank
  band); the box is scrolled by hand now. And the side column, a grid
  stretched to the stage's height, squeezed its two scroll boxes to one line:
  a scroll container's automatic minimum is zero, so with a definite height
  the grid gave them nothing. It is a flex column the stage's height now, the
  code box fixed and the moved list taking what remains.
- **Fullscreen is the workbench's study view, floating console included.**
  The console covers the viewport (the shared `.immersive`/`.faux` rules;
  `#bench` lifted like `#view`; `.solo` added as the schematic does), the
  drawing takes all of it through the viewBox, the side column and the control
  fields go, and the strip-and-drawer console from `solo-palette.js` floats
  over the stage: five drawers (**Registers**, **Watch**, **Code**, **Moved**,
  **View**), the transport (back, run, step, cycle, reset) on the strip, the
  exit at the bottom, and the half-cycle readout, the clock select and Fit in
  the drawer head. Position, drawer and tab persist under
  `v6502.tracer.console`. `?full=1` clicks the button rather than calling the
  API, as `?solo=1` does, for the same reason. The first version kept the side
  column beside the drawing with a `panel` button to hide it; it was replaced
  rather than kept as a second mode.
  - **The drawers BORROW the side column's own elements** rather than drawing
    copies: opening Registers moves `#tc-head` and `#tc-regs` into the drawer,
    and the next drawer (or leaving the mode) puts them back where they were,
    `HOMES` recording parent and next sibling and returning later-first so
    neighbours find their place. Every painter keeps its one target by id, so
    the console cannot disagree with the page about a register because there
    is only one copy of it to paint. Two consequences: `getElementById` must
    never be called between `host.replaceChildren()` and the builder's
    `borrow()` (the element is detached for that instant), and the
    panel painters are no-ops because `paint()` already paints by name.
  - **`_tracer-test.html` drives it**: covers the viewport, the console sits
    inside the stage, each drawer holds the borrowed elements and the side
    column has them back afterwards in order, the strip's transport moves the
    chip and the borrowed cards repaint in place, a drag on the exit icon moves
    the console without leaving, the clamp holds, the configuration is
    written, and re-entering opens the same drawer. The drag assertion had to
    pull *upward*: the default position is the bottom-left corner, and a drag
    down measured the clamp and failed on correct behaviour.
- **The camera pans and pinches through one pointer map** (`setupCamera`):
  one pointer holds a die point under the finger, two hold the die point under
  their midpoint and scale by spread against the gesture's *start*, and a
  finger lifting mid-pinch re-seeds so the other pans from where it is. Same
  shape as the schematic's, with the two rules that each cost a round there
  (one `pinchOf`, ratio never accumulated). Move and release are on the
  window, so a finger leaving the stage keeps panning; the first version
  released on `pointerleave` and had no second pointer at all, so a phone
  could not zoom it. `_tracer-test.html` drives pan, pinch and lift-one
  through the real handlers and asserts the die point under the fingers stays
  under the fingers; with the anchor moved to (0,0) the scale still reads
  2.00x and only that clause goes red, which is the check "did the scale go
  up" cannot make. Touch slop 12px, mouse 4px, read by the click that picks.
- **Header picker and transport drive it**, as on the blueprint; the console's
  own Run, Back, ½ cycle, Cycle and Reset are a second view of the store, and
  Back is `stepBack()` (rewind, so bounded by the keyframes). Arrow keys and
  space work when focus is not in a field; the key handler guards
  `e.target.closest`, because a harness dispatching at the document has no
  `closest` and the first version threw.

## Geometry pipeline

`build.rs` triangulates all 8233 polygons with earcut at build time (0 degenerate)
and emits `layout.bin`: a header, then `x:u16, y:u16, node:u16` per vertex sorted
into contiguous per-layer runs, then transistor bounding boxes. 1.46 MiB, fetched
separately so it never bloats the `.wasm`.

Coordinates stay in raw die space (x 214..8983, y 179..9807). **The Y flip the
original baked into every `drawSeg` call lives in one sign in the projection.**

## Reference rendering, for comparison

The original stacked four canvases: static layout, a high-node overlay, highlight,
and a hidden hit buffer encoding the 12-bit node number into the high nibbles of
R, G, B. Zoom/pan was CSS sizing on the canvases rather than a transform, which is
where its 600/800 constants come from.
