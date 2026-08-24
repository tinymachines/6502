# The derived documents, and the oracles behind them

The address rubric, the idiom catalogue, the Snake walk, and the third oracle. Split out of `CLAUDE.md`; the documents themselves are `docs/atlas.md`, `docs/idioms.md` and `docs/walk-snake.md`.

## The address rubric, and `docs/atlas.md`

Every node, transistor and wire gets exactly one address, and a prefix of one
is a valid way to name the set beneath it. **8365 addresses: 1547 nodes, 3510
transistors, 3308 wires**, all unique across the three namespaces.
`tools/export-atlas-doc.py` derives them, checks them, and only then writes
`docs/atlas.md` -- the rubric plus an entry per container. Nothing in that
document is typed by hand, so it cannot drift from the derivations.

```
<container> : <class> : <slot>
```

- **Parse from the right.** Slot after the last colon, class before it,
  container is the rest. A fixed field count does not work: container keys
  contain colons (`alat:ADL/ABL`) and a bundle names two (`regs:a~sbus:sb`).
- **The separator is measured, not chosen.** A colon appears in **zero** of the
  die's 707 names, and `kind:id` is already the spelling everywhere here. `.`
  is in 33 names and 14 keys and `/` in 47 and 5, so both were out.
- **The class is the shape of the pulldown network, which in NMOS IS the
  boolean function.** Legs in parallel are the ORs, series are the ANDs, the
  pullup inverts: `aoi2.1` is `NOT((A AND B) OR C)`. **34 tokens** cover the
  die and ten of them cover 90% of it.
- **The slot is the die's own number, always, and that is the load-bearing
  decision.** Every other field is a derivation, and derivations here move.
  The generator proves the property rather than asserting it: reversing the
  kind ownership order **re-owns 88 of 1547 nodes and moves 0 slots**. Strip an
  address to its last field and the part is still findable.
- **Facts ride as tags, never as fields** (`bit=3@sb`, `depth=6`, `opens=243`,
  `precharged`, `phase=phi1`, `also=sdp:sd1`). An address needs exactly one
  discriminator and it must be immutable; everything else is a query.
- **The taxonomy has exactly one hole and it is provably unobservable.** Node
  866 classifies as `inert`: no driver, in no switch. It gates one transistor
  and nothing in the chip can drive it, which is one of the two inert
  structures this file already documents.

Three things the address deliberately cannot carry, each stated in the doc:
**direction** (a pass transistor conducts both ways, so only Hanson's authored
`SOURCE/DEST` names record it), **neighbourhood** (`depth=` is a distance from
a pin, and "what is within two hops" is a query), and **which container is most
interesting** (the partition picks one owner so a box can be drawn; `also=`
carries the rest).

- **Two traps hit while building it, both already in this file and both hit
  anyway.** Keying wires on `(a, b, control)` silently dropped **70 of 3308**
  edges, which is exactly the parallel-pair case `graph.json` carries `t` for.
  And a generated sentence claiming the rare class tail was "all AOI shapes"
  was false the moment it was written (`nor9`, `dyn6`, `inert` are in it); it
  is computed now. **Generated prose can go stale in the same breath it is
  generated.**
- **Mutation-proved**: dropping the slot from the address makes the generator
  fail "addresses unique across all three namespaces" and refuse to write.

## The circuit idioms, counted (`tools/export-idioms.py`, `docs/idioms.md`)

The other half of the atlas: the atlas says *where* a part is, this says *what
shape* it is. A knowledge base of how the chip is BUILT, derived rather than
recalled, for the eventual purpose of teaching somebody to think like a chip
designer. Every count comes out of `web/*.json`; the one-line "why a designer
would do this" on each idiom is authored and marked as such, the same split
`block-notes.js` keeps, because mixing a reading in with a measurement
launders one into the other.

- **There is no AND gate and no OR gate anywhere on this die**, and the
  technology's cost model is visible in the mix: **354 NORs against 39 NANDs**,
  because parallel transistors are cheap and series ones are slow.
- **The 386 storage nodes partition into six shapes**, and the generator
  refuses to write unless they partition exactly: `latch` 236, `ring` 53,
  `chain` 27, `mux` 25, `gated` 24, `precharge` 21. **The guard is checked
  immediately after classification rather than at the end**, so a rule that
  drops a node is caught by the claim it violates instead of by whatever
  crashes first; mutation-proved by dropping five nodes.
- **Every register bit is the same two-inverter ring broken by a switch, 53 of
  53, all depth 2.** Four transistors where a static cell needs six, and the
  price is the 6502's minimum clock: it forgets if you stop it. That
  uniformity is the finding; nothing here asserted it.
- **The widest wire is `sb0` with 12 sources**, each a pass transistor under
  its own decode line, and the doc prints the list rather than summarising it.
  **The line names come out in load/drive pairs** (`SBAC`/`ACSB`, `SBX`/`XSB`,
  `SBY`/`YSB`, `SSB`/`SBS`), which is Hanson's `SOURCE/DEST` convention
  falling out of the data.
- **Every bit-slice exception is derived, and each one is a feature of the
  instruction set showing up as a wire that is not like its neighbours.**
  Comparing the eight bits of each measured bus finds **15 exceptions across
  24 buses**, and four of them name themselves:
  - **The shifter**: bit 7 of `sb` and `alu` is opened by `dpc19_ADDSB7` where
    bits 0..6 share `dpc20_ADDSB06`.
  - **The decimal adjust**: `sb0` and `sb4` reach the accumulator directly
    under `dpc23_SBAC` and the other six bits do not, because BCD correction
    adds `0110` and **bits 0 and 4 can never change**. `dasb` exists for
    exactly the other six. Verified both ways before it was written down.
  - **The interrupt vectors**: `adl0..2` are driven by `0/ADL0..2` where every
    other bit of that bus is a pure wire. Three bits, because the six vector
    addresses differ only in their low three.
  - **The flag that is not stored**: `p` has no bit 5, and `idb5` is the only
    data bus bit `H1x1` does not reach, because the status register cannot put
    a bit on the bus that it does not have. `p4` is an inverter rather than
    storage: B is a reading of why P is being pushed, not a stored flag.
- **"Driven by a dynamic where the others are dynamic" is a bug in a
  report, not a finding.** When two bits share a gate kind but differ in the
  pulldown network, the leg count IS the difference; printing only the kind
  announces a difference and then hides it.

- **`LAX` is derived, not told.** `op-T0-lda` fires for 16 opcodes and
  `op-T0-ldx/tax/tsx` for 15; **both fire for exactly 8**, `$A3 $A7 $AB $AF
  $B3 $B7 $BB $BF`, every one with low two bits `11`, which is the bit neither
  row constrains. The PLA does not know what an instruction is: it matches
  patterns, and every pattern it can match, it will.

- **Two motif detectors were wrong before they were right, both the same way.**
  A hand-written detector for "the recirculating latch" found **3** instances
  when the chip has 53, because it assumed the feedback arrives as a gate
  input; on a storage node it arrives through a *switch*. The fix was not a
  better guess: it was to dump one known instance (`a0`, `s0`, `pipeUNK01`),
  read the shape off it, and write the detector from that. **Then classify
  every node and require the shapes to partition**, so a leaky detector cannot
  hide behind the ones that work.
- **A mutation that only re-labels proves nothing.** The first attempt deleted
  the `gated` branch, those nodes fell through to `chain`, the total still came
  to 386 and the guard passed. Dropping nodes is the mutation that tests a
  partition claim.

## The Snake series, part one (`tools/export-walk.py`, `docs/walk-snake.md`)

One instruction out of the real Snake ROM, followed through five cycles, with
the vocabulary set on the way: RAM against ROM, gates against dynamic nodes
against paths, the address rubric, and how a keypress actually arrives. Written
for a reader who has never seen inside a chip.

- **The state is measured by running Snake on the simulation**, and the
  schematics are **pulled from the live schematic page** (`tools/walk/grab-svg.py`)
  rather than drawn again. A second drawing of an NMOS gate would eventually
  draw it differently, which is the failure `sch-draw.js` exists to prevent.
  The grabber inlines the `.sch-*` rules with `var()` resolved, because a
  standalone SVG inherits no stylesheet and an unresolved token drops the whole
  declaration silently.
- **The subject is `STA $0400,X` at `$021F`**, the screen clear, taken at a pass
  where X is non-zero so the adder has work to do. Five cycles, ten
  half-cycles, and **only two of them are the write**: a store spends most of
  its life working out where to put the byte.
- **A `#` in a URL starts the fragment, and that produced a perfectly good
  schematic of the wrong wire.** `?signal=#WR` was truncated to `?signal=`, the
  page fell back to its default (`dpc3_SBX`), and the figure looked entirely
  plausible. Values are URL-encoded now, **and the grabber checks the drawing
  names the signal it asked for**, because a fallback renders perfectly.
- **Three fields on a halfwave observation are strings, not what they look
  like.** `rw` is `"read"`/`"write"`, so `if o["rw"]` is always true and every
  cycle reads as a read. `tstates` is a string, so `",".join(...)` splits it
  into `T,2`. Both produced confident wrong output. **Check the type of a
  field before formatting it**; this cost two rounds in one sitting.
- **The prose is held to what the figure shows.** A first draft said the write
  control checks ready and reset; those inputs are not in the depth-2 cone and
  not in depth 3 either, so the text now says what the labels say (opcode bits,
  T-states, the two store-data latches) and names the ready interlock as a fact
  that is deliberately *not* in the picture.
- **Registers are only meaningful at instruction boundaries**, and the walk
  says so with an example from its own data: X reads a value mid-store that it
  never held, because it is a dynamic node with the bus driving past it.

### The walk ends at the silicon

`docs/walk-snake.md` finishes at the transistor: `dpc2_XSB` is **4 devices**,
listed with their addresses and their real geometry out of `transdefs.js`.
Three findings there, and the second corrects the first.

- **`dpc2_XSB` has no pull-up flag**, so nothing holds it high: it is charged
  through one transistor and then holds by charge alone. The minimum clock, as
  four devices.
- **The naive `pullup` class is misleading exactly here, and the document says
  so rather than hiding it.** `t2468` has one end on vcc, which is what
  `graph.json`'s per-transistor `kind` reads; it is a **precharge** device, not
  a load. **A depletion load and a precharge transistor are indistinguishable
  from one transistor's terminals** and do different jobs. The real loads are
  not in the transistor table at all: they are a polygon flag, on **1018**
  nodes.
- **The median channel is 7.8 micrometres, derived rather than looked up**:
  polygon coordinates against the 168 mil die width marked on sheet 1 of the
  MOS blueprint gives 0.487 um per die unit, and a median channel length of 16
  units. The 6502 was fabricated on an eight-micron process.
- A first draft said the pulldown-to-pullup size ratio "is why NMOS works",
  from the 7:1 seen on this one gate. **Die-wide it is 1.5:1**, because the
  234 vcc-connected devices are not the loads. Measured before it shipped.
- The section is skipped whole when `extern/` is absent rather than
  half-written, and that was checked by pointing it at a missing file.

## The datapath control lines, checked against the wiki (`tools/check-dpc-vs-wiki.py`)

A third independent oracle, in the shape of `check-timing-vs-manual.py`. The
archived visual6502 wiki carries a three-way name table for all 44 datapath
control lines and, in prose, the clock phase each is effective in. Both are
re-asked of the running chip. **37 of 37 phase claims agree**, over 3600
half-cycles of four programs; the two lines the programs never raise
(`dpc34_PCLC`, `dpc35_PCHC`) are reported rather than counted.

**Where the die names come from, which nothing here recorded before.** The
question "did MOS have a naming convention, and are we aligned to it" has a
documented answer in `archive/wiki-raw/wikitext/6502_datapath.wiki`, and it is
three schemes deep:

- **Hanson** named the signals `SOURCE/DEST` (`Y/SB` drives SB from Y, `SB/Y`
  loads Y from SB) in the block diagram he drew from the MOS blueprints he
  received in 1979. `650X_Schematic_Notes.wiki` records that the blueprints
  themselves carry internal signal names, and `D1x1`, `H1x1` and `C1x5Reset`
  survive in our name table in that style.
- **Balazs** used a positional grid, `R1x7`, `R2x14`, `Dkx2`, off his own die
  photograph.
- **JSSim** -- the names in `nodenames.js`, and therefore ours -- is
  **position + Hanson**: `dpc4_SSB` is Hanson's `S/SB` with a prefix assigned
  by where the line sits across the die. **Measured: the `dpc` index really is
  a left-to-right ordering, 6 inversions in 43, all adjacent pairs.** So half
  of every control-line name we use is a coordinate and half is a function,
  and neither half is ours.

**A negative result worth keeping: Balazs's rows are contiguous in order but
not separable by position.** Sorted by die X the 39 coded lines come out as
six clean runs, R1 R2 R3 R4 R5 Dk with no interleaving, which looks like a
derivable banding. It is not: the largest gap *within* a row is 448 die units
and the smallest gap *between* rows is 142, so no cut threshold reproduces the
bands. What does reproduce them is function rather than position -- grouping
each line by the container its switches operate gives R1 -> `regs` 7 of 7,
R2 -> `alu` 13 of 14, R4 -> `pcr` (pch) 4 of 4, R5 -> `pcr` (pcl) 4 of 4. Every
line that lands nowhere gates **no switches at all**: the ALU operation selects
(`ORS SRS ANDS EORS SUMS DAA DSA`) and the constant generators are gate inputs,
not pass-transistor controls, which is why a switch-based rule cannot see them
and should not pretend to.

- **The phase split is 18 phi1-only against 24 both, and nothing is
  phi2-only.** A transfer is effective on the next phi1; a line that
  pass-connects two buses, or selects an ALU function, holds across both.
- **`MUTATE=1` swaps the two clocks and must go red.** It fails exactly the 17
  phi1 rows and correctly leaves the 24 `both` rows agreeing, because "both" is
  symmetric under the swap. An all-green comparison is what a broken one
  produces, so the check ships with the proof that it can tell.
- **The wiki parser is the part that was wrong first.** A fixed 400-character
  window from each `;` entry let `Y/SB` inherit `S/SB`'s claim from the entry
  below it, and 16 rows read as disagreements. An entry is its own `;` line
  plus the `:` lines under it and nothing past the next `;`. **Sixteen
  plausible findings, all of them my parser.**
- **The clock non-overlap is asserted, not assumed**: 0 of 3600 half-cycles
  have both phases high and 0 have neither.

### Two corrections to this file, both found in the archive

- **`blog.visual6502.org` IS archived**, 173 MB under
  `archive/wayback/files/`. The drip picked it up even though the note under
  "Known gaps" says it is outside the domain index; that note was true of the
  targeted harvest and is stale for the full sweep.
- **An intermediate visual6502 staging build had the N and V flag nodes
  swapped**, and our submodule is the correct one.
  `archive/wayback/files/visual6502.org/stage/JSSim/nodenames.js` has `p6: 77,
  p7: 1370` where `extern/visual6502/nodenames.js` has `p6: 1625, p7: 69`.
  **The functional tests cannot arbitrate this** -- the one case that sets both
  V and N sets them together, and the case that clears V has a zero result, so
  N is clear too. The wiring can: a bounded backward walk shows `p6` reaching
  `aluvout` and `idb6` (overflow, and BIT's copy of bit 6) and `p7` reaching
  `DBNeg` and `idb7` (the sign bit). Ours is right. Worth knowing before
  trusting any file out of `stage/`.
