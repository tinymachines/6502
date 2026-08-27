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
