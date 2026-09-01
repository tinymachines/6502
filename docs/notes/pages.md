# The reading pages, one by one

The rest of the site: what each page claims, how it derives it, and what each cost to get right. Split out of `CLAUDE.md`.

## The Lab (`lab.js`)

Follows one instruction from the opcode byte on the pins to the register it
changes, framing the die on whichever part is working. Four walkthroughs: `lda`,
`adc`, `inx`, `sta`.

This is tractable only because the die data **names the entire pipeline**:
`pd` (predecode), `ir`, 38 `dpc*` decode-PLA outputs, `idb`/`sb`/`adl`/`adh`,
`alua`/`alub`/`alu`, and the registers. Each `dpc` name carries its own meaning —
`dpc24_ACSB` gates the accumulator onto the special bus, `dpc17_SUMS` selects the
adder's sum, `dpc3_SBX` writes the special bus into X. Resolving those names
through `nodeId()` gives both a die region to frame and a live readout.

- **The prose was written from measurements, not from the datasheet.**
  `_lab-probe.html` dumps T-states, asserted control lines and every bus per
  half-cycle; the narration was written against that dump, and `_lab-test.html`
  then asserts each claim against the engine. Writing plausible prose about
  silicon is easy and checking it afterwards is not, so **run the probe before
  editing any Lab text.**
- **Steps are offsets from the instruction's own opcode fetch**, found by
  stepping until `sync && lastFetchAddr == at` — never hardcoded half-cycle
  numbers, which would break the first time reset timing moved.
- **The control lines shown are read live**, not stored beside the prose. If the
  narration and the silicon ever disagree, the reader sees the silicon.
- **The Lab never starts on its own.** It replaces the loaded program and
  power-cycles the chip, and above the sidebar breakpoint every panel is visible
  at once, so there is no "opening" it — an auto-start would silently reset a
  running chip. It waits for an explicit button, or `?lab=`.
- `onTakeOver` clears the node selection, because the per-frame highlight that
  follows a selection would otherwise overwrite the Lab's every frame.

What `adc` demonstrates is the thing the whole project exists to show: at +5
half-cycles the adder holds `$42` and the accumulator still reads `$40`. The
result exists and is in no register. `?lab=adc&step=4` links to that moment.

## The Trace (`trace.html`, `trace.js`)

Any of the 256 opcodes, half-cycle by half-cycle. The opcode is assembled into
memory behind a fixed preamble, the chip fetches it, and every number on the
page is read back out of the silicon. **Nothing consults an instruction table**,
so the cycle counts are free to be wrong — eight of them agreeing with the
datasheet in `_trace-test.html` is therefore evidence rather than tautology.

**No new Rust.** `schematic.json` already carries names, blocks, switches and
control paths, and a switch conducts exactly when its control node is high — so
the whole thing computes in the page from node levels. Sharing that one file
with the schematic is also what stops the two pages disagreeing about which node
is which.

Three kinds of fact per half-cycle, deliberately not mixed: architectural state
with the changed fields marked, the nodes that changed level grouped by block,
and **the named wires that are shorted together right now** (`Machine.nodeGroup`).
The last is the one no behavioural emulator has to model — a level belongs to
the *group* a node is joined to, not to the node.

- **It runs past the next `sync` on purpose**, and marks those rows as tail. The
  6502 overlaps the tail of one instruction with the next opcode fetch, so
  ADC's sum is not in the accumulator when the instruction ends. Stopping at the
  boundary would report ADC as not having happened. Pinned: A is `$41` at the
  end and `$52` in the tail.
- **Forward and back are different operations.** `rewindTo` correctly refuses a
  target in the future, so using it to step forward fails *silently* and the
  cursor sticks at row 0 while the table still looks right. Forward is just
  running the chip. `seek()` is the only place either happens.
- **A table of formatted strings evaluates every entry.** `subjectText` built
  one keyed by addressing mode, so an implied instruction ran the immediate
  formatter and did `hex2(undefined)`. The throw escaped through `refresh()` and
  the page went on showing the *previous* instruction's trace — INX reported 4
  cycles because the rows on screen were still LDA's. Formatters are functions
  now, and only the one for the mode is called. **Both of this page's bugs
  produced plausible output**; both were found by dumping the console and the
  DOM, not by reasoning.

### The instruction's length, measured on this page

The head line carries the length beside the cycle count, and this page measures
it itself rather than reading `timing.json`: the distance from this opcode's own
fetch to the next one, taken from rows it had already recorded because it runs
past that fetch to show the tail.

- **It declines where a length cannot be had.** A jump, a call, a return and a
  taken branch all land somewhere that is not the following byte, and the
  distance to it is not a length. Those say so instead of printing a number.
- **The branch is the case worth understanding, and the two pages disagree
  correctly.** Timing's fixture assembles an offset of `$00`, so a branch lands
  on the following byte and measures two either way. This page's operand is
  `$02`, so the branch is taken and lands outside. Both are right about their
  own run, and a page that imported the other's answer would be wrong on one of
  them. `_trace-test.html` pins both halves.

### What the measurement said before any of it was drawn

`cargo run --release -p v6502-sim --example activity`. Run this before designing
anything that wants to visualise "what changed" — the numbers rule out the
obvious design:

- **~165 nodes change level per half-cycle** (median; 63 named, p90 252). A tenth
  of the chip at every edge, so a list of everything that moved is a wall.
- **1503 of 3510 transistors conduct at any instant.** Lighting up everything
  that is on draws the whole chip.
- **But the datapath is not that graph.** Almost all of what conducts is
  pulldowns inside gates rather than switches joining named wires, so walking
  only *open pass transistors* from `idb0` reaches a median of **three** nodes.
  `idb0` is connected to `a0` in **2 of 90 half-cycles**, and both times the path
  is exactly two switches — `SBDB` then `SBAC`.
- **A pin is not a wire.** The first version of that walk started at `db0` and
  found nothing, ever: all eleven of its terminals go to a rail, because a pad
  is an output *driver*. Nothing enters the chip from a pin through a pass
  transistor — the way in is the input receiver, which is a gate. A trace that
  follows only switches can never leave the pad ring, which is why the watch
  list starts at `idl`/`idb`.

## The Exploded view (`exploded.html`, `exploded-gl.js`, `blocks.rs`)

The same 83,227 triangles as the die view, **moved rather than redrawn**, along
two independent axes. The die view shows the chip as it is and is nearly
unreadable; the blueprint throws the geometry away entirely. This is the step
between, and it is the page to reach for when explaining what the chip *is*.

- **Z — the physical layers.** Diffusion, polysilicon, metal. Note it is
  **three heights, not six**: `segdefs` distinguishes switched, grounded and
  powered diffusion, but those are one physical layer coloured by what it is
  tied to, so `LAYER_HEIGHT` collapses 6 segdef layers onto 3. Getting this
  wrong would draw the power rails floating above the signal wiring.
- **XY — the functional blocks**, derived in `crates/v6502-netlist/src/blocks.rs`.
- **One filament per transistor**, from the diffusion it switches to the poly
  that gates it, lit when its gate is high. This is the whole point of the page:
  a transistor is a place where poly crosses diffusion, and separating the
  layers is what makes all 3510 of them visible as objects.

**`Z_GAP` is a legibility choice and is documented as one.** The real oxide is
submicron; any honest value is invisible. The first attempt used 2600 die units
against a die ~9000 across, which turned the filaments into an opaque wall two
thirds the width of the chip. It is now 850 — the smallest value at which the
three layers read as separate.

- **The block explode must recolour.** Without it the pieces fly apart still
  wearing their layer colours and are impossible to tell apart, which defeats
  the only thing that axis does. Luminance carries over from the layer colour so
  the material still reads through the block hue. `BLOCK_COLOR` is presentation,
  but the *order* is not arbitrary: control blocks warm, datapath cool.
- **The camera must back off by less than the scene grows.** Matching the growth
  exactly holds the die at a constant size and makes the slider look dead;
  overshooting shrinks the chip as it comes apart. `0.72 ×` explode, found by
  looking.
- **Camera input lives in `exploded-gl.js`, not the page glue**, so a harness can
  attach the real handlers without booting the page. It was in `exploded.js`
  first, and the pinch test then dispatched events at a canvas nobody was
  listening to — every gesture assertion "passed" because nothing happened,
  which is the same false pass as a slider wired to nothing.
- **`applyZoom` is the only place zoom changes**, and it refuses a non-finite
  result. Pinch state has one constructor and reads the ratio against the
  gesture's own start rather than accumulating per event, which drifts. Zoom is
  read back out of the renderer for the readout instead of being tracked beside
  it, so wheel, pinch, keyboard and buttons cannot disagree.
- **Pitch is clamped above the plane** (`0.14..1.53` rad). Metal is translucent
  and is drawn last with depth writes off, which is only correct while it is the
  near face — from underneath it sorts wrongly and the wiring vanishes behind
  the silicon.
- **The pads move radially, not by translation.** They are a ring around the die
  edge, so their centroid is the middle of the chip and translating by it would
  move them nowhere. `the_pads_are_a_ring_not_a_blob` pins this, and pins it over
  the **seeded** pads only — growth reaches inward along the drivers, so
  asserting it over the whole block would be testing the growth rule while
  appearing to test the ring.
- **Layers are kept fractionally apart even at zero** (`Z_BASELINE`), or the
  coplanar polygons z-fight and the die crawls with speckle at rest — which
  reads exactly like a corrupted upload.

### The blocks (`blocks.rs`)

Seeded from the names on the die, grown along the wiring, then the remainder
identified electrically: **2448 transistors in 12 functional blocks, 1060 in
static logic, 2 unaccounted for.**

**The final 2 transistors are inert, and that is the answer rather than a gap.**
They form two isolated structures at the top edge of the die. One is a transistor
whose gate node has *no terminals at all* — nothing in the chip can drive it, so
it can never switch — tying a dead-end node to vcc. The other is gated by `cclk`
and really does switch every cycle, joining two nodes that connect to nothing and
gate nothing. A node influences the chip only by gating a transistor, so a node
that gates nothing is provably unobservable; `the_residue_is_two_inert_structures`
asserts exactly that rather than sampling a run. The block keeps the catch-all
name `Unaccounted` even so, because it is where anything a broken rule stops
matching will land — naming it after today's contents would make it lie.

**The remainder was not a ragged edge — it was one thing.** The 1086 transistors
that reached no functional block are the chip's *static gates*: the inverters and
NORs that are not pass transistors. They survive growth for a structural reason,
not by accident. A static gate's output touches nothing but its pullup to vcc and
its pulldown to vss, and growth refuses to cross a rail — so no path exists from
a named wire to a gate output however close together they sit. Measured: **511
islands, the largest holding three nodes, 447 of them a single node**, and 856 of
their 1060 transistors are pulldowns. They are identified by that signature (a
pullup, or a terminal on vss), not by name — the die names none of them, and
`deploy.sh` fails if a name rule ever starts matching one.

- **The seeds are a name table written from a dump of every name the trace
  carries**, not from what a 6502 is supposed to contain. This works because the
  die names entire structures rather than a few interesting signals: the adder's
  carry chain bit by bit (`#C01`..`~C78`), its intermediate products as the logic
  they compute (`A+B3`, `#(AxB)4`, `#A.B7`), the PC's precharge nodes, and every
  decode term after the instructions it serves.
- **Growth follows terminals, never gates.** A node gated by a decode line is
  being *told what to do* by the decoder, which is the opposite of belonging to
  it; following gates lets the PLA swallow the chip in three rounds.
  `growth_does_not_let_the_decoder_swallow_the_chip` pins it.
- **A switch is filed by its channel, not its gate.** The gate is the control
  line reaching in from the decoder. Filing by gate would put all 159 datapath
  pass transistors under `Control pipeline` and empty the datapath of the
  switches that are the point of it.
- **Stems are matched exactly, never by prefix.** `a0` is the accumulator and
  `abl0` is the low address latch; a prefix match merges them.
- **Decoration is stripped, and the adder depends on it.** `#`, `~`, `x-`, `xx-`,
  `.phi1`, `.delay` mark phases and duplicate copies of the same structure. Half
  the ALU is only reachable once they are off.
- **Seeded and grown are published separately** (`was_seeded`, bit 7 of
  `nodeBlock`) and drawn at different brightness, because they are different
  strengths of claim. Decode PLA is 95% named; Status register is 40%.
- **Neither the static logic nor the unclassified residue translates**, and they
  fade by different amounts: the residue hardest (it is unknown), the logic less
  (it is identified). What lifts away at full explode is the functional blocks;
  what stays is the web of gates they were embedded in. `deploy.sh` fails if the
  residue ever empties — a run that accounted for everything would mean the
  honesty check now shows an empty set.
- **A gate is attributed to the block it drives, and that never positions it.**
  351 of the 587 logic nodes have ≥75% of their fan-out in one block (iterated,
  converging in five rounds); the other 236 feed no single block. But **a quarter
  of the attributions sit more than 3000 die units from what they drive** —
  correctly, since control signals are generated beside the decoder and consumed
  in the datapath. Affiliation is not location, so `nodeDrives` is exported as a
  separate array and `deploy.sh` refuses to publish if any non-logic node carries
  one. Moving a gate to the block it drives would be inventing a floorplan.
- **Growth runs twice, and the second pass is narrower.** The first ran before
  the static logic existed as a block, so 89 nodes whose only neighbour was a
  gate output saw nothing classified and stopped — the far side of pass
  transistors tapping a gate. The second pass joins a node only if *every*
  classified neighbour is static logic: a majority vote there would let the logic
  out-vote the functional blocks on sheer count and hollow them out.
- **Static-logic membership has two tiers and the test says so.** 587 nodes carry
  the signature (a pullup, or a terminal on vss); the other 87 joined by touching
  one that does. Asserting the signature over the whole block would claim more
  than is true.
- **Two name-rule bugs found by asking what was left over**, which is the reason
  to ask: only 12 of 690 leftovers had names at all, and all 12 were real misses.
  `pd0.clearIR`..`pd7.clearIR` needed the general "strip any dotted suffix" rule
  rather than an enumerated list of known suffixes, and the adder's per-bit carry
  terms are `(AxB1).C01` — the bit index is *inside* the parentheses, so a rule
  reading `(AxB)` missed the four nodes carrying between bit pairs.
- The blocks are checked for **spatial coherence** rather than taken on trust: a
  block whose nodes scattered across the die would explode into confetti. All
  except the pad ring have RMS spread < 0.25 of the die diagonal.
- **This is not a floorplan.** Nobody has MOS's original; it is an inference from
  a photograph, and the page says so. A boundary here is where the names and the
  wiring say one part stops.

## The Blueprint (`blueprint.html`, `blueprint.js`, `blueprint.rs`)

An idealised block diagram of the datapath, on its own page. The die view shows
the chip as it is and is nearly unreadable; this shows the same chip with the
geometry removed — buses as rails, registers as boxes, a switch wherever the
silicon has one, running live off the same engine.

**Nothing in it is drawn.** The units, the paths, the control line on each path
and the order things sit in are all derived in
`crates/v6502-netlist/src/blueprint.rs` and exported as `web/blueprint.json`;
`blueprint.js` is a layout engine and a state binding. If a fact about the 6502
ever appears in the JavaScript, it is in the wrong file.

Three measurements make the derivation possible, and each is worth knowing
before changing anything here:

1. **Names decompose.** ~300 node names are `stem` + `bit` (`sb0`, `alua7`), so
   the units and their widths fall out of the name table.
2. **The datapath is a real bit-slice.** For 29 of 34 wide units, bit index runs
   monotonically down the die while die X stays fixed. The five exceptions —
   `ir`, `notir`, `p`, `Pout`, `pipeUNK` — are exactly the control section,
   which is not bit-sliced and is not drawn.
3. **Every datapath connection is a switch under one named control line.** A
   pass transistor joining two named units *on the same bit row* is one bit of a
   bus path, and the name on its gate is the decode-PLA output that opens it.

Result: 16 units, 21 paths, 159 switches — the 6502 datapath, computed.

- **The control line is the edge, not the unit pair.** This is the load-bearing
  design choice. Keying by unit pair invents two edges where the silicon has
  one, because `sb0` and `dasb0` are the *same node*; keying by control puts all
  eight switches in one group. It also keeps genuine splits visible:
  `dpc20_ADDSB06` opens the adder onto SB for bits 0–6 and `dpc19_ADDSB7` does
  bit 7 alone — that is the shifter, and merging them would hide it.
- **Stems sharing any node are merged into one wire.** Without this, `dasb`'s
  *unshared* bits survive as a phantom unit and the accumulator draws as
  connected to a stub with nothing at the far end.
- **A narrow link survives if a wider link already joins the same pair.** The
  width filter exists to reject two wires that happen to touch, but
  `dpc19_ADDSB7` is a legitimate *single* switch. Dropping it left the diagram
  claiming the ALU reaches SB on seven bits and bit 7 goes nowhere.
- **Bus vs register is decided by connectivity, and the physical criterion is
  wrong.** "A bus is a net nothing drives statically" sounds better and was
  measured: it separates *dynamic from static* storage, not bus from register.
  It calls `a`/`x`/`y`/`s` buses (the 6502's registers are dynamic, with no
  static pulldown) and `adh` driven (it carries constant generators). Degree
  over distinct partners is what is actually used.
- **Rail order needs `row_offset`, not mean Y.** Every bus spans all eight rows,
  so their mean Y values are all mid-datapath and say nothing about which wire
  is above which. Measured against its *own* row, a bus has a consistent offset,
  and that is the stacking order.
- **Rows come from the bit index in the name, never from the centroid.** On
  `adh` the two disagree — its constant generators for `$01` stack access and
  vector fetches drag bits 2 and 3 out of order. `bit_index_runs_down_the_die`
  pins that single inversion so a second, real one cannot hide behind it.
- **`placeLabels()` must run after the SVG is visible.** `getBBox()` inside a
  `hidden` container measures zero, every box then "clears" every other box, and
  the collision pass silently does nothing. Same trap as sizing a canvas in a
  hidden panel. This shipped once and `_blueprint-test.html` caught it.
- **The service worker's offline navigation fallback now tries the requested
  page before `SHELL`.** With one entry point, falling back to `index.html` was
  right; with two, opening `blueprint.html` offline silently served the
  *explorer* — a wrong page that renders perfectly, which is the hardest kind of
  failure to notice.
- `web/programs.js` is shared by every page that runs the chip. It was inlined in
  `app.js`; two copies would drift, and "Fibonacci" meaning different things on
  two pages is exactly the difference nobody notices. It now also owns *which*
  program is selected — see the Programs section.

The Rust side is tested (`crates/v6502-netlist/tests/blueprint.rs`, 13 tests)
rather than snapshotted. The important one is
`every_switch_is_a_real_transistor_on_the_right_bit`, which re-resolves every
drawn switch through the netlist instead of taking the blueprint's word for it —
that is what makes the picture a derivation rather than an illustration.

**It states its own coverage: 159 of 3510 transistors.** The bus fabric is a
small slice of a chip that is **71% pulldowns and only 22% pass transistors**
(measured: 2493 / 783 / 234 vcc-connected, and an earlier version of this file
claimed 76% pass, which is close to the reverse), and the static gates, the
decode PLA, the timing chain and the pads are all outside what a bus diagram can
honestly show. An idealised view that hides how much it idealised is the same
failure as an archive that hides its gaps, so the number is on the page.

## The Decode table (`decode.html`, `decode.js`, `pla.rs`, `export-decode.rs`)

All 122 product terms of the decode PLA, with the opcodes that fire each one.
The structure comes from the netlist; **the firing is measured by running the
chip against all 256 opcodes**, three scenarios each.

The page runs no simulation — it is the result of 768 runs, which no single live
view could show at once.

- **Computing a term's opcode set from its gates is wrong, and was tried first.**
  Two independent reasons, both found by checking against the documented ISA:
  - **`irline3` is a derived line, not an IR bit.** `op-T0-jsr` constrains bits
    7..2 directly and leaves bits 1 and 0 to `irline3`, so a gate-reading model
    reports four opcodes where the chip decodes one. Following it means
    modelling the gate behind it, and the gate behind that.
  - **A term legitimately fires for undocumented opcodes.** `op-T0-lda` is high
    for sixteen: the eight documented `LDA` forms and the eight `LAX`/`LAS`
    ones. That is not over-matching — it is *why* `LAX` loads both A and X, the
    `LDA` row and the `LDX` row being high together. "Correcting" it against the
    datasheet would have deleted the most interesting thing on the page.
- **The die names 121 of the 122 terms**, and the names carry both the T-state
  and the instructions served (`op-T0-lda`, `op-T+-adc/sbc`). This is the single
  fact the page rests on, the same way the wiki rebuild rests on `action=edit`
  captures. 88 name a T-state; 33 are stage-independent (`op-implied`, `op-jsr`).
- **The one unnamed term is the `irline3` generator** — it tests IR bits 0 and 1,
  both low. Identified rather than left as an anonymous node.
- **An unfired term is a gap in the *experiment*, not a fact about the chip.**
  One run from power-on left `op-branch-done` never firing; a second scenario
  setting C and N was not enough either. It needs a taken branch that *also*
  crosses a page, because the term ends the page-crossing fixup — which is the
  answer to what it is for. Three scenarios now reach 122 of 122, and
  `deploy.sh` refuses to publish if any term goes unobserved, because a broken
  measurement run yields a well-formed file full of empty results.
- **The ISA cross-check is asymmetric, deliberately.** A term firing for *more*
  opcodes than the datasheet lists is expected and correct. Firing for *fewer*
  means a real instruction has been lost. `tests/decode.rs` asserts both
  directions; `_decode-test.html` re-checks it against the shipped JSON.
- Do not report "undocumented opcodes sharing a term with a documented one" as a
  statistic: the `irline3` generator fires for all 256, so it is trivially 105
  of 105 and says nothing.

**Term → control line.** The path is
`term → OR plane → a cclk pipeline latch → two or three inverters → the line`,
which is why a pulldown-only walk finds nothing: it cannot cross the latch.
`Pla::candidate_terms` follows pass transistors too, and refuses datapath wires
as intermediates — without that the walk escapes along the special bus and comes
back somewhere unrelated.

- **The netlist proposes; the measurement disposes.** A backward walk always
  finds *something*, and the number it finds is not evidence. Every edge must
  predict the 768 recorded runs, and 14 of the 46 lines fail that and ship as
  `unresolvedLines` rather than as guesses. `deploy.sh` enforces both the
  threshold and the declaration.
- **Two senses are needed, and the less obvious one is the more common.** A term
  can *drive* a line or *override* a line that is asserted by default.
  `dpc39_PCLPCL` ("PCL keeps its value") and `dpc7_SS` ("S keeps its value") are
  asserted by the **absence** of any term — the chip holds unless told
  otherwise. Fitting only the drive sense explained 30% of assertions; allowing
  both explains 93%. 21 of the fitted lines drive, 11 override.
- **Polarity is measured, not assumed.** Six lines idle high and assert low
  (`dpc18_#DAA`, `dpc22_#DSA` and friends). An early check counted their idle
  state as an assertion and reported a meaningless 17%; the aggregate was wrong,
  not the edges.
- **The lag is per line.** The pipeline latch puts one to two half-cycles between
  a term and its line, but the depth is not uniform — fitting one global lag
  understated the result. Fitted lags run 0–4, mostly 1.

## The Programs (`programs.html`, `programs-page.js`, `programs.js`, `asm.js`)

Every other page shows a 6502 in the middle of running something. This is the
something: seven programs as **assembly source**, assembled in the page,
annotated line by line, and executed on the same simulation the die view draws.

**The bytes are computed from the text on screen.** The programs used to be
arrays of hex with a comment beside each byte, which has one failure mode and it
is silent — the comment and the byte are two independent claims and nothing ever
checks that they still agree. Source removes the possibility rather than
promising to watch for it.

- **The assembler carries no opcode table of its own.** It inverts `disasm.js`'s,
  so the two are one table read in opposite directions. That is what makes the
  round trip in `_asm-test.html` evidence rather than a tautology: if the
  assembler had its own copy, agreeing with itself would prove nothing.
- **The three programs that predate the rewrite assemble to exactly the bytes
  that were typed here before**, and both `_asm-test.html` and
  `tools/check-programs.mjs` pin it against arrays written out longhand.
  Deriving the expectation from the source under test is how a test comes to
  prove nothing, so those arrays are duplicated on purpose.
- **Assembling is not the same as being right.** Each of the new programs is
  *run on the chip* until its answer appears in memory — `$2E + $14` reaching
  `$82` as `$42` at half-cycle 41, page `$0300` filling to its last byte at
  6137. A program can assemble perfectly and compute nothing.
- **Zero page is only chosen when the value is known during pass one.** `LDA foo`
  is two bytes if `foo` is below `$0100` and three if not, so the size depends on
  something a first pass may not know yet. A forward reference assembles
  absolute — three bytes that are always correct rather than two that are
  sometimes wrong — and `copy`'s `LDA text,X` is the case that exercises it.
- **A gap left by `.org` is filled, not skipped.** It is memory the chip fetches
  through; an image with holes in it is not an image. `counter` is 24 bytes
  because eight of them are the `$00`s between `$0208` and `$020F`.
- **Notes are anchored to labels, never to line numbers.** A note naming a label
  the program does not define is a page error and a deploy failure, so prose
  cannot quietly detach from the code it describes. Verified by renaming a label
  and watching both go red.
- **Every program loops rather than ending.** There is no operating system to
  return to and running off the end reaches `$00` — `BRK`, vectoring to `$0000`,
  which is another `BRK`. That exact bug was live on two pages of this site.
- **The Len column is a second opinion on the Bytes column, and the two never
  disagree.** Bytes is what the assembler emitted; Len is how far the program
  counter moved on the chip, from `timing.json`. Neither knows about the other,
  so agreement is evidence: across all seven programs and 62 instructions they
  match on every row that has both. A disagreement is drawn loud (`.pg-mismatch`)
  because it would be a real bug in one of them, and `_programs-test.html`
  asserts there are none. A `·` is an instruction that transfers control, where
  the distance to the next fetch is not a length, and the harness checks those
  are exactly the rows where the chip's measurement is null.
- **The cycle column is `timing.json`**, measured sync to sync, not a datasheet.
  Where an instruction can take longer — a taken branch, a page crossed — the
  shortest is shown, because the rest depends on values the page cannot know
  without running the program. The page says so.

### One program, every page

`selectedProgram()` in `programs.js` is the only place the choice is read:
`?program=N` first, then `localStorage`, then the first program. **A URL that
names a program wins over a stored preference**, because a link naming a program
is somebody asking for it, and a saved choice overruling them would be the page
arguing with whoever sent it.

- **The header's "Run it" call to action became the picker** (`program-nav.js`,
  `[data-program-nav]`), and inherited its job: choosing a program is how you
  start the chip on something. The hero button on the front page still says
  "Run it" and still runs it — which is also why the header's copy could go.
- **Pages that run the chip apply it in place; pages that do not only record
  it.** Decode, Timing and Trace are measured tables, so their picker says as
  much rather than implying something on screen just changed. The Primer
  reloads, because rebuilding five demos around a new chip in place would be a
  second boot path to get wrong.
- **Where two controls name the program, exactly one function changes it.** The
  Explorer, the Blueprint and the Exploded view each have a console field *and*
  the header picker; both route through one `choose()`, with a `fromNav` flag so
  reflecting a change cannot re-fire it. Two controls that each keep their own
  copy of a setting are two controls that will eventually disagree.
- Before this, every page defaulted to program 0 and forgot the choice on
  navigation — so comparing the Blueprint's view of a program with the
  Explorer's, which is the reason both pages exist, silently compared two
  different programs.

## Halfshot (`halfshot.html`, `halfshot.js`, `halfshot-codec.js`, `blueprint-draw.js`)

The chosen program on the chip, one photograph per half-cycle, walked like a
gallery. Every other page that runs the chip shows it *now*; this one records,
and keeps the level of every node at every step. Two pictures per frame, and
they are different kinds of picture:

- **The plate never moves.** The datapath is the Blueprint's own drawing, from
  `blueprint-draw.js`, with the frame's byte on every unit and every open switch
  lit; above it the address and data pins as lamps, the control pins as levels,
  the registers with the moved ones marked; below it a window of memory around
  the last access and everything the program has written so far. Anything a
  block diagram puts a name on, in a fixed place, showing what it holds.
- **The island is the transition.** The datapath switches whose control line
  changed between the previous frame and this one, one bit of each, drawn by
  `sch-draw.js` in the workbench's symbols with the wires either side lit by
  their level and each switch marked for which way it went. Under it, the
  things that happened at that edge and are not a switch: the memory access,
  the decode terms that arrived or dropped, the units whose value moved, the
  T-state change, and how many nodes changed level.

The strip along the top is one tick per frame grouped under the instruction
that fetched it, so "one diagram per half-cycle per op" is also how you get
around. Under it, **the manual's Figure 3.4 redrawn from the recording**: φ1,
φ2, RDY, SYNC and T0..T5 as a trace across the half-cycles either side of the
cursor (`createScope` from `demos.js`, which grew a windowed `set(list, at)`
for it). Back, Next, the arrow keys, Home/End and a click on a tick all move
the same cursor; running paces through the frames at the clock rate.
`?program=N&frame=K` deep-links.

- **This page carries its own program and clock selects, and the header
  carries none.** Its transport moves through a recording rather than driving a
  live chip, and Record and Reset belong beside Back and Next. The store behind
  run/pause and the rate is still `chip-controls.js` (`initClock()`, `setClock`,
  `subscribe`), so `?speed=` and the saved rate work as everywhere; the program
  select writes `setSelectedProgram`, so the site-wide choice travels both ways.
  The header simply has no `.nav-ctl` in `halfshot.html`.
- **Record is a toggle, and off means the chip moves and nothing is kept.**
  Running or stepping past the end of the recording with Record off calls
  `skip(n)`: the machine advances, `state.skipped` counts, the cursor stays on
  the last frame and the "Chip" line says where the chip is. Switching Record
  back on (`resume()`) takes one frame where the chip now is, with `gap` set to
  the count and a **fresh 64 KiB memory snapshot**, because the writes in the
  gap were never seen and `memAt()` would otherwise be wrong from there on. It
  starts from the latest snapshot at or before k, then applies the recorded
  writes. The strip marks the segment as after a gap, the head says how many,
  the file carries `gap` and `mem` on that frame, and the harness runs an
  independent chip straight to the post-gap half-cycle and compares the memory
  window cell by cell.
- **Reset power-cycles and records again from the start.** It is what the
  header's ⏻ would have done, and it lives beside the transport for the same
  reason the transport does.
- **The two clock phases are pins.** `clk1out` and `clk2out` joined `PINS`, so
  the plate reads them as levels and the trace draws them as such, and their
  non-overlap is a measurement the harness makes: at no frame in the batch are
  both high, each is high in half of them, and φ1 is the phase with `clk0` low.
- **The console must not change height from frame to frame, and three things
  made it.** The plate and the island sit in a two-column grid; the island's
  event list varies in length, and any variation in either column moved the
  whole page on every step. Fixes, all pinned by the harness comparing the
  console's height on the busiest frame and the quietest: the island's contents
  are `position: absolute; inset: 0; overflow-y: auto` inside a `position:
  relative` panel at ≥ 72rem, so the row is sized by the plate alone and the
  island scrolls inside it (in flow again on a phone); the register cards
  always render their `was` line, blank when nothing moved, so a card does not
  grow on the frames its value changed; and the head, the memory access line
  and the written-so-far line each have a floor and centre their contents,
  because a badge appearing on the baseline changed the line box by a pixel.
  **Measure per element**: a throwaway probe printing each block's height on
  six frames found all three in one pass, where the console's total said only
  that something moved.

- **`blueprint-draw.js` was extracted for this page**, exactly as `sch-draw.js`
  came out of `schematic.js`: two pages laying the accumulator out from two
  copies would put it in two places. `blueprint.js` keeps the page and imports
  the layout, the drawing, `placeLabels` and `unitValue`. Verified by
  `_blueprint-test.html` passing unchanged before and after.
- **Frame 0 is the first opcode fetch, not the reset.** `powerCycle()` runs the
  reset sequence itself, so the machine arrives at half-cycle 0 with `sync`
  high and `$0200` on the bus. There is therefore no reset segment on the
  strip, and the head says `1 of 4 in this instruction` from the start.
- **The memory access rides on the edge, and the rule is `cpu.rs`'s.** A read
  is serviced as `clk0` falls, a write as it rises, and R/W is tested after the
  drive. So a frame taken after the falling edge with R/W high is one in which
  memory was read at the address on the bus, and after the rising edge with
  R/W low one in which it was written. `_halfshot-test.html` re-runs the same
  program on a chip of its own and asserts every access is on the right edge and
  matches `peek()`; swapping the rule fails it on frame 1.
- **The recording grows by `BATCH` (256) when you step past the end, to
  `MAX_FRAMES` (4096).** A program here loops forever, so a recording has to stop
  somewhere, and both numbers are printed in the caption. 4096 frames of node
  levels is 7 MB in memory and fine.
- **The island is never empty, and that was measured against the prose.** The
  first draft said an empty island was the common case. The harness went to look
  for a quiet frame to assert on and found none: over 2000 half-cycles of each
  of the seven programs, between 3 and 10 of the 21 paths change at *every*
  edge, median 5 or 6, and the four that change most are always `ADLPCL`,
  `ADHPCH`, `DBADD` and `SBADD`: the program counter reloading from the address
  bus and the adder's two inputs, machinery that runs whether or not the
  instruction needs it. The prose now says that, the page computes the numbers
  from its own recording (`switchStats()`, printed under the island), and the
  harness recounts them and pins the top four. **The assertion the page could
  not satisfy was the finding**; a harness that had asserted only what the page
  showed would have confirmed the wrong sentence.
- **`halfshot-codec.js` is the file format, and it is a leaf.** The first frame
  in full as a packed bitset, every later frame as the nodes that went up and
  down, with the derived state kept beside each so the file reads without the
  netlist. `levelsAt(file, k)` replays it; the harness compares the replay
  against the recorded levels byte for byte on six frames including the last,
  and the check goes red when the down list is not applied. It imports nothing
  so the harness can load it without booting the page.
  - **The format is written down in the codec's header and in the file
    itself** (`encoding`, version 2), because the first person to read an
    export cold had to guess three things and guessed one of them wrong in a
    way that happened to decode: the bitset is bit *i* for node *i*, LSB-first
    within each byte, zero-padded to 216 bytes for 1725 nodes; a unit is a
    bare byte when all eight bits have a storage node and `[value, mask]` when
    not, so `p` is `[v, 0xDF]` and the reader who decoded it as
    `[true, complement]` got the right number by luck; the node numbering is
    visual6502's own. The harness now decodes frame 0 by hand rather than
    through the codec and pins all three, and `check-halfshot.mjs` does the
    same on a file after the fact.
  - **The file carries a `build` stamp** (`commit`, `committed`, `exported`),
    asked for by the same reader after a stale re-upload cost a round trip:
    "which build made this" is one field now. The page reads the deploy's
    build-info.json best-effort (null commit in development is a valid
    stamp), the codec stays a leaf by taking it through `meta`, the file
    stays version 2 because the field is optional, and `check-halfshot.mjs`
    validates the shape when present rather than requiring it of older
    files.
  - **The same reader found the rail bug**, which nothing on the site could
    have: see "One deliberate departure" under the simulation model. The
    export declared `rails.vcc: 657` and 657 toggled. Version 1 files carry
    the dip; the validator reports rather than fails it on those.
  - **A recording never ends on a phi1.** It was 257 frames (frame 0 plus a
    batch of 256), which ends on a lone phi1 that a reader pairing the phases
    trips over. Frame 0 now counts as one of the first batch and `record()`
    takes one more frame if the batch would end on phi1, so a fresh recording
    is 256 frames, h 0..255, and every growth ends on a completed cycle unless
    the cap intervenes. Pinned after the first batch, after growth, and after
    a gap.
  - **`tools/check-halfshot.mjs` validates an export cold**, from the bytes in
    it plus the published JSON when it is beside it: header, h contiguity
    across gaps, phase alternation, deltas naming only nodes at the other
    level and never a rail, rails pinned, units well formed, every access on
    its edge, every opcode fetch a read of `op` at `fetch`, reads against the
    program bytes, earlier writes and the post-gap image, and pins, units,
    switches and terms recomputed from the replayed levels. Nine corruptions
    (a rail dip, a bad delta, a lone phi1, a lying read, a p unit claiming bit
    5, changed program bytes, a shifted open string, a flipped pin, a shifted
    instruction) were each injected and each caught. `_halfshot-dump.html`
    exists because an export is a click on a blob URL and there was otherwise
    no way to obtain one headlessly.
- **The dangling-reference scan reads the quoted name inside `fetch(`.** The
  page's first draft fetched its three files through a helper taking a name,
  which the scan cannot see; it now calls `fetch('blueprint.json')` three times
  so that a missing hash rewrite is a build failure. And the scan then failed on
  the *comment* explaining this, which contained the string `fetch('...')`
  and was read as a reference to a file called `...`. Say it in words.
- **A grid child beside a taller sibling stretches its own auto rows.** The
  plate is a grid of four rows inside a two-column grid whose other column, the
  island, is taller; without `align-content: start` the extra height was shared
  out among the plate's rows and the register cards came out 110px tall. It
  looks like a padding mistake and is not one.
- **The console section is `.hs-wide` (100rem), the rest of the page the usual
  78rem.** The plate is the whole Blueprint drawing and at the site's column
  width it scrolled sideways on every screen, which is the opposite of a plate
  that stays put. Given two thirds of a wider section it fits without a
  scrollbar at 1500px.

## The Primer (`primer.html`, `primer.js`)

The page for the question every reader of this site eventually asks: *is there a
fixed set of inputs and outputs, and does the clock step the machine forward
based on the opcode?* Close enough to write software against, and not what the
silicon does. The page is that difference, one correction at a time — the pins,
two edges rather than one, what an opcode actually selects, that nothing counts
the cycles, and that there is no state separate from the wires.

It is meant to grow. The thing to preserve as it does:

- **No number is typed into the page.** Every figure is a `data-fact` slot filled
  from `schematic.json`, `decode.json` and `timing.json` — the same published
  files the other pages read. Prose is the part of this site most likely to go
  quietly wrong: it is written once against what was true that afternoon and
  nothing checks it afterwards. `_primer-test.html` asserts both halves — that
  every slot was filled, and that what went into it matches the JSON — and it
  also **scans the prose for stray digits**, so the next paragraph cannot
  reintroduce the problem by writing "122 terms" into a sentence.
- **A missing fact fails the page rather than blanking a word.** A number that
  silently does not appear reads as a design choice, not a fault.
- **The pin table is built from the die's own name table.** Which pins exist is
  derived; only the one-line *role* of each is authored, because the die says
  `rdy`, not "low stalls the chip on a read cycle". A row that does not resolve
  through the names is dropped rather than printed as hardware this chip does not
  have.
- **Every section ends by linking to the page that demonstrates it** — Trace for
  the half-cycles, Decode for the PLA, Timing for the chain. The primer explains;
  it does not become a fourth place that owns a fact.
- **Every section carries a runnable example**, built from `web/demos.js` — a
  shared toolkit rather than five one-off widgets, because a lamp strip that
  disagreed with another lamp strip about which end bit 7 is on is exactly the
  quiet difference this site exists to remove.
  - **One chip, five views of it.** They share a machine and a clock, so stepping
    in any of them steps all of them. That is the honest arrangement — they are
    five readings of one piece of silicon, not five simulations — and it is also
    the cheap one. Each transport paints from the chip rather than from whichever
    button was last pressed, or two of them disagree the moment you use the other.
  - **The scope is the one genuinely new primitive.** Every other page reports
    what is true *now*; "two edges, not one blip" is a claim about time, and a
    claim about time needs something that remembers. It samples once per
    half-cycle and draws the recording, with a divider every second sample — so
    the waveform is measured rather than illustrated, and the point being made is
    the thing you can count.
    - It records forwards only. Stepping back rewinds the chip, and growing a new
      sample for a half-cycle being *undone* would make it a history of the
      reader rather than of the chip; it clears instead.
  - **The chip is warmed before anyone looks** (`chip.warm(24)`). It comes out of
    a power cycle mid-reset, which is not what a page about fetching instructions
    wants on screen, and the scope at rest has nothing to show.
  - **Nothing runs off screen**, via one `IntersectionObserver` over the whole
    examples region plus `visibilitychange`.
  - **The examples cannot take the page down.** They boot after it, in their own
    try/catch, and a failure writes itself into the boxes rather than leaving
    five empty ones that look like a layout bug. The prose and its measurements
    are worth reading without them.
  - **The stray-digit scan exempts them, and the exemption is the rule stated
    precisely.** It polices what is *written into `primer.html`*, where a count
    would sit unchecked forever. A demo's own prose says things like "on bit 0" —
    a choice about what to watch, not a measurement that can go stale.
  - Two `\b` traps cost a round each here, both in the harness rather than the
    page: `textContent` runs a readout's label into its value and its value into
    the next paragraph, so `/\b\d+ cycles?\b/` never matches "took2
    cyclesNothing" at either end.

## The talk (`talk.html`, `talk.js`), and the claims it is checked against

Where the die data came from: the chip decapped in acid, photographed through a
microscope, the layers chemically stripped and re-shot, and the whole thing
vectorised by hand into the polygons every other page draws. The source is
Michael Steil's 27C3 talk, *Reverse Engineering the MOS 6502 CPU*, whose
subtitle is the number this simulation switches.

- **The page is deliberately two registers, and they are labelled.** The account
  of the process is history: it cannot be derived, it is written from the talk,
  and it carries the `Written, not measured` eyebrow. The verification table is
  the other half and none of it is authored. Mixing them would launder one into
  the other, which is the failure `block-notes.js` and `STEMS` are also kept
  apart to avoid.
- **The verdicts are computed, not written.** Each row pairs an authored `says`
  with a `holds(d)` that asks the same question of the published JSON, and the
  verdict comes from comparing them. A table where somebody typed "agrees" beside
  each row would be a claim about a claim. If the chip stops agreeing the page
  says so on its own.
- **One row differs, and that is the load-bearing assertion.** All-green is
  exactly what a broken comparison would produce, so `_talk-test.html` pins that
  exactly one row differs *and which one*. The talk says the decode ROM ignores
  the opcode's low two bits; on this die 48 of 122 product terms are gated by
  `ir0`/`ir1` directly. That is a simplification rather than an error, and the
  page says so: the mechanism he gives for `LAX` depends on those bits arriving.
- **`LAX` is the strongest agreement on the site.** `op-T0-lda` requires IR bit
  0, `op-T0-ldx/tax/tsx` requires bit 1, and neither constrains the other, so the
  eight opcodes with low bits `11` fire both rows and the chip loads A and X at
  once. That was derived here from the switch network and independently explained
  in the talk sixteen years earlier.
- **The harness re-derives everything itself** rather than importing `talk.js`.
  A harness that called the page's own functions would be asking the page whether
  the page is right.
- **The stray-digit scan applies, with two exemptions stated precisely.**
  `[data-history]` is exempt because years and headcounts cannot go stale, and
  `#tk-checks` because every word in it is generated from the JSON. The scan
  earned its place immediately: it caught "Twelve of the sixteen" typed into a
  note in `talk.js`, which is exactly the class of number that would sit
  unchallenged forever. That note derives both figures now.
- The page needs **no export of its own**: it reads the five files the other
  pages already publish, which is also what stops it disagreeing with them.
- **The verdict card is no longer in this file.** It moved to `claim-table.js`
  when `designer.js` wanted the same component; edit it there, and the CSS is
  `.claim-*` rather than `.tk-*`. See the designer section for why.

### `tests/interrupts.rs`: the BRK that gets lost

The one claim that could not be checked from a published file, because it is
about two things happening in the same moment. The 6502 has no interrupt
sequencer: predecode forces the instruction register to `$00`, which is `BRK`,
so IRQ, NMI and reset all run the BRK sequence and only the vector and the B flag
differ.

- **Measured, not asserted from the explanation.** Asserting IRQ at each
  half-cycle offset around a BRK's own opcode fetch and reading the stack gives a
  window: 3 to 6 half-cycles early, the chip pushes the address of the BRK itself
  with B clear, so the handler cannot tell a BRK happened. Earlier is an ordinary
  interrupt; 1 to 2 is too late to be sampled and the BRK survives.
- **Every offset is an offset from the fetch**, found by running until `sync`
  with the right address on the bus. A remembered half-cycle number would shift
  silently the first time reset timing moved.
- **Reset really does run the same sequence with the writes suppressed**: nothing
  reaches the stack page and S still moves by three. That is why this chip comes
  out of reset with whatever S it had minus three, and why the study view's stack
  panel refuses to report a depth.

## The published block diagram (`blockdiagram.html`, `blockdiagram.js`)

The figure every datasheet for this processor opens with, encoded as a dataset,
drawn from that dataset, and answered by the measurements. First page of the
menu's **Block diagram** group, which is its own group rather than an entry
under "The chip, drawn" because these are drawings *somebody else made* and this
site checks. The derived ones sit above it; reading the two together is the
point.

**It is deliberately not a facsimile, and that is a licence decision as well as
an editorial one.** The original plate is a copyrighted figure from a 1976
publication, and tracing it coordinate for coordinate would be a derivative of
it. What is encoded is the *factual content* -- which blocks a 6502 is said to
contain and which buses join them -- laid out by `blockdiagram.js`'s own rules,
in this site's palette rather than the plate's. How a chip is organised is not
anyone's to own; a particular drawing of it is. The credit section says so, and
`GEO` is the only geometry in the file.

- **The two halves of the figure resolve differently, and that is the design.**
  A datapath box is a claim about a *bus*: so many wires carrying a value,
  answered by resolving a stem and counting bits. A decode or timing box is a
  claim about a *region* -- a place where work happens -- and the only honest
  answer is how much silicon is filed there, from `blocks.rs`. Forcing the
  second through the first would have meant inventing a width for something
  that does not have one. `kind` on each row says which, the table branches on
  it, and so does the harness.
  - **The control column is drawn with no rails**, because nothing there is a
    bus: decode does not carry a value to the registers, it tells them what to
    do. Running a rail through it to make the picture symmetrical would be
    inventing one.
  - **One bracket stands for every control line into the datapath**, not a line
    per block: 46 wires fanning across the drawing is a picture of a mess, and
    the count belongs in words.
  - The control side is **four regions and 1113 transistors**, which is the
    quiet finding of adding it: the figure draws it as a small annex off to one
    side and the decode array alone is 749.
- **The pins and the data bus buffer are two more kinds of claim again.** The
  address and data buses resolve by width like the datapath's; the control,
  clock and power pins have no width at all and carry a list of node names,
  answered by how many this die actually names. `kind` and `section` are
  separate fields because they are separate questions -- `ab` and `db` are
  bus-shaped claims that belong to the *pins*, and a harness grouping by kind
  alone reported "14 datapath" for a figure with 12.
  - **It does not say "forty pins".** The package has forty, three are
    unconnected and ground arrives on two of them, so a die naming 36 signals
    is not disagreeing with a datasheet saying 40: they count different things.
    The page reports what it can see, which is the names.
    - **That count was 35 here for two commits, and it was arithmetic.** 40
      less 3 unconnected is 37 pins, and vss arriving twice makes 36 distinct
      signals. `_pinout-test.html` counts it from the table rather than from a
      sentence, which is how the slip surfaced.
- **The data bus buffer is the one box that is a journey rather than a place**,
  and it is drawn dashed to say so. Out is eight gates, one per bit, whose
  output is the pad. In is not those gates reversed: there are **zero** pass
  transistors joining a data pin to the internal bus, so nothing from memory
  reaches it directly. The route is `db0 -> #718 -> notidl0 -> idl0 -> #719 ->
  idb0` -- five steps, through the input data latch, arriving only when the
  decoder opens `dpc43_DL/DB`.
  - **A gate-only walk finds no route at all**, because the last two steps are
    switches, and would report a chip with no way to read memory. Both the page
    and `_blockdiagram-test.html` follow gates *and* switch channels, and the
    harness re-derives the whole route independently.
- **The dataset was checked against the primary source, and it was wrong.** It
  was first built from a second-hand tracing of the plate, and reading the
  figure itself found two errors in opposite directions: it had invented a
  **Control pipeline** box the figure does not draw, and was missing the
  **Clock generator** the figure does. Both are now in, marked for which side
  of the line they fall on. *Encode a claim from the thing making it, not from
  somebody's copy of it.*
- **The figure is a family portrait and says so in its own notes**, which turns
  the mismatches from errors into the point. Data bus enable is drawn and is not
  on this die: it belongs to the 6501. Set overflow and sync are on this die and
  are not drawn. The clock generator is drawn, and the figure's own note says it
  is absent on the 6501.
  - **`dbe` is why `.bd-missing` exists**, and until it was added that styling
    had never fired. A "drawn and marked rather than dropped" affordance that
    nothing ever triggers is a promise, not a feature.
  - **The clock generator resolves to signals but to no region**: its five named
    clocks are spread across three blocks, because `blocks.rs` files signals
    where the wiring puts them and nothing on this die groups a clock generator
    together. Reporting it as a missing region would have said the chip has no
    clock generator, which is false -- the designer page derives it in full.
- **The dataset carries only the claim**: a label, and the stem this die uses
  for the thing being claimed. Width, owning functional block, and whether the
  datapath derivation found the same unit independently are all read out of
  `schematic.json`, `blocks.json` and `blueprint.json`. A block that failed to
  resolve is **drawn and marked**, never dropped -- `.bd-missing` exists for a
  case that does not currently arise, which is the honest way round.
- **All twelve resolve, and one needs a translation**: the figure's input data
  latch is `DL` and this die calls it `idl`. That mapping is in the dataset and
  the harness pins it, because it is exactly the sort of thing that would
  otherwise look like a missing block.
- **2 of 3 agree, and the row that differs is the reason the page exists.** The
  figure hangs the datapath off a single internal data bus; this chip derives
  `sb` *and* `idb`, and the traffic between them runs through a pass transistor
  a box-and-line drawing has nowhere to put. That is the boundary of the form
  rather than an error, and the page says so. It is also the same finding the
  talk page arrived at from the other direction.
- **The bus the figure does not draw is dashed in the drawing** (`bd-rail-extra`),
  so the difference is visible before the caption explains it. `figure: false`
  in the `BUSES` dataset is what marks it.
- **`_blockdiagram-test.html` re-resolves every block itself** out of
  `schematic.json`, rather than importing the page's resolver, and compares
  widths row by row. It also pins that exactly one card differs and which one.
  - **Its stray-digit scan had to be whitespace-tolerant.** The licence sits at
    the end of a wrapped line, so a literal `CC BY-NC-SA 3.0` did not match and
    the version number read as a stray measurement. `\s+` between the two.

## The pinout (`pinout.html`, `pinout.js`)

The forty pins. Third page of the **Block diagram** group, and the one page on
the site whose *layout* is authored: a DIP has one shape, pin 1 at the top left,
counting down and back up. That is a fact about the part rather than a choice.

**The numbering is the only thing taken from a datasheet.** Which functional
block a pin belongs to, how far it reaches, and its direction are all read out
of the switch network.

- **Direction is derived, and that is the point of the page.** A pin is an
  output if a gate drives it, an input if it feeds gates, both if both. The data
  pins come out bidirectional with nobody saying so.
- **The subtlety that makes it worth deriving: a gate whose every pulldown leg
  is gated by `vss` can never conduct.** It is a pullup wearing a gate's
  clothes. **RDY and S.O. have exactly that** -- both inputs, held high by a
  permanently-off transistor -- and the naive rule reported both as *outputs*.
  Those are two of the seventeen vss-gated transistors this file already
  documents as physically correct and permanently off.
- **`_pinout-test.html` checks the directions twice, and the second check is
  unusual for this site.** Everywhere else an independent re-derivation settles
  it, because the question is whether the page agrees with the netlist. Here the
  page and a harness sharing the same naive driver rule would have agreed with
  each other *and both been wrong*, so the directions are also checked against a
  list of what a 6502's pins are known to do. **Re-derivation is not enough when
  the rule itself is what might be wrong.**
- **A rail is not a signal and the direction question does not apply.** Asked
  anyway, the rule calls ground an *input*: true of the wire, nonsense about the
  pin. VSS and VCC are marked `power` in the dataset and sit outside the
  measurement.
- **Forty pins is not forty signals.** Three are unconnected and ground arrives
  twice, so the die names **36**. Neither number is wrong; one counts legs on a
  package and the other counts wires on a chip.

## The die graph (`diegraph.html`, `diegraph.js`)

Every node drawn at its own centroid on the die, every edge a connection the
netlist already has. Second page of the **Block diagram** group.

**Nothing here is laid out, and that is the whole page.** Every other drawing on
this site chooses an arrangement: the schematic lays a cone out in columns, the
blueprint stacks buses as rails, the block diagram places boxes by rule. All
three are honest and all three are decisions. This one makes none. A chip is a
graph that was embedded in a plane by the people who drew it, and that embedding
is a measurement we hold rather than something to infer, learn or force-direct.

- **Positions come from `layout.bin`**, the same geometry the die view draws, so
  a cluster here is somewhere you can go and look at there. A node's centroid is
  the mean of its own vertices: crude for an L-shaped wire, right for the great
  majority. **1702 of 1725 nodes have one.**
- **The Y flip is the same single sign the die view's projection carries.**
  Without it the chip is drawn upside down against every other picture on the
  site, which is the kind of wrongness nobody notices until they compare two
  pages.
- **The rails are not drawn.** vss and vcc touch most of the chip; including
  them puts a star through the middle of the picture and says nothing.
- **Filtered by default: 586 named nodes, 1282 edges.** Full is 1544 nodes and
  3041 edges, and the extra 839 are gate outputs nobody needed to name. The
  density is the finding rather than a rendering problem: most of this chip is
  logic and the logic does not thin out anywhere, which is the same fact the
  blueprint's 159-of-3510 coverage and the block pages' static-logic result
  report from their own directions.
- **Switch edges are drawn apart from gate edges**, brighter and thicker. A pass
  transistor joins two wires without either causing the other; a gate input
  reaches the output it helps produce. Drawing them alike loses the only
  structural distinction in the picture, and it is what makes the datapath
  visible as long lines across an otherwise local graph.
- **The camera is a viewBox and nothing else.** The drawing is in die
  coordinates, so zoom is a smaller rectangle and pan is that rectangle moving.
  No transform to keep in step with a projection, which is why the pointer maths
  is two lines instead of the explorer's `screenToDie`.
- **`_diegraph-test.html` recomputes every centroid from `layout.bin` itself**
  and compares against where the circles actually are. That is the only
  assertion that tests the thesis: a drawing whose positions came from anywhere
  else would pass every count and fail that one.

## The designer (`designer.html`, `designer.js`)

The other account of this chip: one of the people who drew it in 1975, recalling
it in a 2015 interview, with the answerable parts re-asked of the silicon. Same
two labelled registers as the talk page and the same computed verdicts, and it
needs **no export of its own** for the same reason: it reads four of the files
the other pages already publish.

**The register is different, and that is the page rather than a caveat on it.**
A reverse engineer describes an artefact and the artefact can contradict him. A
designer describes *intent*, from memory, decades later. Intent cannot be
checked at all, so the page asks only the handful of statements with a number or
a structure attached, and says in the prose that it is not grading anybody.
**4 of 5 agree, and the one that differs is the only quantity in the set** — the
structural claims are all right and the transistor count is out by roughly a
factor of two. That asymmetry is the finding.

- **There is no 6501 on this die, so the headline claim cannot be measured as
  stated**, and every wording on the page respects that. The recollection is that
  the on-chip clock generator is the whole 6501/6502 difference and cost "about a
  dozen transistors". What is measurable is the generator on the chip we have.
  Saying otherwise would be claiming a comparison between two parts from one.
- **The verdict is a comparison, not a decision.** `holds` tests the measured
  count against `A_DOZEN = 15` -- twelve read as generously as that phrase can
  carry -- rather than returning a hardcoded false. If this chip ever measured
  that small the row flips on its own. The talk page's differing row does use a
  bare `false`, and this is the better pattern.

### The clock generator, derived for the first time

**44 transistors across 16 nodes, 1.3% of the die**, of which only **21** decide
anything: the other 23 are the four output stages, parallel banks that exist to
shift load. Nothing on this site had drawn this circuit before.

- **It is found by a rule, never by a list of node numbers.** Walk forward from
  the `clk0` pad through gate inputs; include the four clocks it ends at
  (`cclk`, `cp1`, `clk1out`, `clk2out`) but never expand them. A list would be
  authored, and would go stale silently.
- **The boundary clause is the whole rule, and the harness proves it by removing
  it.** `cclk` alone opens 243 switches, so an unbounded walk crosses into the
  control pipeline: bounded reaches 16 nodes and *zero* `dpc*` control lines,
  unbounded reaches 158 and 18. An invariant nothing can violate is not an
  invariant.
  - **That assertion was first written as a node-count multiple and it failed on
    correct behaviour.** The real blowup is 16 to 158, and the threshold picked
    was `> 10x`. A multiple is an arbitrary number that says nothing about
    whether the boundary is in the *right place*; "it reaches the pipeline and
    the bounded walk does not" is the claim actually being made.
- **Two transistors are the non-overlap.** Both gated by `cp1`, each pulling down
  one node in one of the two symmetric halves. That feedback is what holds each
  phase off until the other has gone, and it is the guarantee the whole change
  was made for. Asserted as a *shape* -- exactly two, one shared control, two
  distinct targets -- because "there is some feedback" would pass on noise.
- **Counting transistors from `schematic.json` needs the legs, not the
  terminals.** A gate's transistor count is `sum(len(leg)) + 1 if precharged`. A
  depletion pullup is a segdef flag on this die and not an entry in the
  transistor table, so it must *not* be added. Verified against real transistor
  IDs parsed from `transdefs.js`: both give 44 exactly.
  - **Counting "transistors with a terminal on the output node" undercounts, and
    it is silent.** It misses the middle of every series leg. It agreed for the
    clock generator, which has no series legs, and was wrong by a third for the
    decimal correction, whose two carry gates are AOI with four series legs each
    (15 against the true 21). A measurement that happens to agree on the first
    circuit you try is not validated.
- **`clk0`'s own two transistors are excluded**: they are gated by vss, can never
  switch, and belong to the pad rather than to the generator. This is the
  difference between the 46 the die reports on the chain and the 44 the circuit
  actually is.
- **`cclk` "gates 273 transistors" is NOT derivable from `schematic.json`**, and
  a `data-fact` slot claiming it shipped briefly saying 41. The published file
  gives gate legs and switches as two lists that overlap, and 41 + 243 is 284,
  not 273. The page reports **the 243 switches it opens**, which is exact from
  that file and makes the same point about load.

### `claim-table.js`, extracted

The verdict card was `renderChecks` inside `talk.js` until this page wanted the
same component, which is the moment `sch-draw.js` came out of `schematic.js` and
the reasoning is identical: two pages rendering a verdict from two copies would
eventually render it two different ways, and a reader comparing them would have
no way to tell which was lying. The CSS moved with it, `.tk-*` to `.claim-*` --
a second page inheriting the first page's prefix is how a component stops being
recognisable as one.

- **The refactor was safe to make because `_talk-test.html` asserts the rendered
  output**, including that exactly one row differs and which one. Run it before
  and after; that is what licenses touching a deployed page for a structural
  reason.
- **It also broke the production build in a way the dev server cannot show.**
  `talk.js` now has an import, and step 3k's comment said in as many words that
  it imported nothing. `build-web.py` has to emit `claim-table.js` and rewrite
  `'./claim-table.js'` in **both** pages, or the hashed bundle 404s at runtime
  while `web/` keeps working perfectly. Boot `dist/` before believing a build.

### Checked against the published table, 138 rows of it, or 144 asked twice

`tests/timing.rs` and `_timing-test.html` cross-check **33** documented opcodes
against figures typed in by hand. `tools/check-timing-vs-manual.py` checks
**138** against Appendix B of the MCS6500 family programming manual, and **144**
with `RESCAN=1`. That is a much stronger form of the same statement: the
measurement path consults no instruction table at all, so agreeing with a
published one is evidence rather than tautology.

- **The manual is not in this repository and is not redistributed by it.** The
  check reads whatever is in the gitignored `reference/`, exactly as the golden
  test reads a trace generated on demand, and **SKIPS when it is absent**.
  `REQUIRE_MANUAL=1` makes that a failure. Only facts come out of it -- opcode,
  bytes, cycles -- and only to verify our own numbers.
- **The row accounting must add up, and the checker exits non-zero if it does
  not.** It reports 150 rows in the table plus the 1 mode label that turned out
  to be a heading, how many were read as opcodes, and every row it skipped with
  the reason. **The first version reported only the
  rows it found AND failed to parse**, so 30 rows it never saw at all looked
  like a table that did not contain them: it announced "117 opcodes in the
  published table" when the table has 150. The bug was a fixed four-token
  search window for the mnemonic; the fix is to search up to the next mode
  label, which is the row's real boundary. **A coverage number that cannot be
  reconciled against a total is not a coverage number.**
- **134 cycle counts agree by default and 140 with `RESCAN=1`; the byte lengths
  are 133 and 139. Nothing disagrees in either mode.** Four are branches, and
  the four are the whole reason
  this is worth having rather than a worry. A published branch figure is the
  NOT-TAKEN case; a taken branch costs one more. Our run measured BCC, BEQ, BPL
  and BVC one higher, and those are exactly the four satisfied by a single
  consistent flag state (**N=0, V=0, C=0, Z=1**). The other four fell through.
  No exceptions, so the difference is about what was measured rather than about
  the chip, and the checker allows *only* that shape of difference: a branch,
  exactly one cycle high.
- **The scan splits some opcodes across two lines** -- `6D` arrives as `6` then
  `D` -- so the parser rejoins a pair of single hex characters when a plausible
  byte count follows.
- **The addressing-mode column is in the same parse and was checked too**, and
  every mismatch turned out to be the *mapping* being wrong rather than a
  finding. Six opcodes the manual calls implied do not fire `op-implied`: PHP,
  PLP, RTI, PHA, RTS and PLA all fire a stack term instead, so `op-implied`
  means "implied and not a stack operation". `JSR` is absolute in the manual and
  has its own path here rather than an ordinary absolute access. The die's sets
  are otherwise supersets of the manual's, which is the expected direction: a
  term fires for the undocumented opcodes that share its mode.

### Instruction length, measured rather than looked up

`timing.json` carries a `bytes` field per opcode, and like the cycle count it
consults no instruction table. It is **how far the program counter moved**: the
distance from an opcode's own fetch to the next one, both found by watching
`sync`.

- **238 of 256 opcodes have one.** The 18 that do not are fully accounted for:
  the 12 JAMs never reach another fetch, and BRK, JSR, RTI, RTS and both JMPs
  transfer control, so the distance to the next fetch says nothing about how
  long the instruction was. Those are `null` rather than a number, because a
  plausible figure beside an instruction that does not have one is worse than an
  admission.
- **Branches are measurable, and that is a property of the fixture.** The
  operands are all `$00`, so a branch offset of zero lands on the following byte
  whether it is taken or not. Either way the counter moved two.
- **113 agree with the published column and none disagree.**
- **The page shows it, and says when it cannot.** A jam keeps its existing
  sentence and claims no length; an instruction that transfers control says its
  length is not measurable this way and why. Only the 238 that have one print a
  number. The statbar reports how many lengths were measured, because a count of
  what is missing is part of a measurement rather than a footnote to it.
- **The negative test failed the first time, and that is the finding.**
  Corrupting `$A9` (LDA immediate) to three bytes did *not* make the checker
  complain, because `$A9` is one of the 33 rows the scan does not read. The
  proof-it-can-tell test had picked a blind spot. Repeated against `$01`, which
  the parser does read, it fails correctly and the tool exits 1. **A negative
  test has to be aimed at something the check actually covers, or it proves the
  opposite of what it looks like it proves.**
- **Coverage is 138 of the 150 real rows by default, 144 with `RESCAN=1`.** Getting from 118 to 138 was two structural
  fixes to the scan reader, neither of which looks at any data:
  - **A mnemonic is not always its own token.** The scan writes the accumulator
    forms as `ASL A` and the immediates as `LDA # Oper`, so an exact match
    dropped those rows wholesale -- which is why LDA immediate, one of the most
    used instructions on the chip, was in the blind spot. Matching a token that
    *begins* with a mnemonic recovers them.
  - **A lone `A` is also a valid hex digit**, so the numeric scan ate the
    accumulator operand and shifted every column by one. Stepping over it where
    the mode is `Accumulator` is positional, not data-dependent.
- **A handful of characters are repaired, and the rule is that the repair may
  never consult our own data.** A lowercase L and a capital I both read as a 1,
  so `Cl` is `C1`. Repairing an opcode by looking up what we know the chip to be
  would make the comparison circular: a manual corrected against ourselves would
  agree with us for free. The repairs are **reported**, because a repair that
  goes wrong makes a plausible row rather than an obviously broken one.
  - **One repair was removed for exactly that reason.** `IE` -> `1E` fixes the
    opcode correctly and then attaches the wrong figures to it, because the scan
    has run two rows' number columns together there. It was caught by the guard
    failing loudly rather than absorbing it, and each surviving repair was then
    audited on its own rather than trusted because the total was green.
- **The second pass is opt-in, and the default is the fast one.** Plain
  `check-timing-vs-manual.py` reads **138** rows in about four seconds and is
  what `deploy.sh` runs. `RESCAN=1` reads the pages the first pass could not
  resolve and gets to **144**, taking twenty seconds. Six rows out of a hundred
  and fifty is worth having deliberately and not worth paying for on every
  publish. Both modes report what they did not read.
- **A second, higher-resolution read recovers what the first one lost.** Where
  the primary extraction keeps an opcode but loses its figures, the page is
  rendered at 400 DPI and read again with a real OCR engine. The two passes are
  wrong in *different* places -- one reads a zero as `G`, the other loses the
  column entirely -- so **requiring them to agree on the opcode** validates a
  recovery without either of them ever consulting our measurements. It skips
  where tesseract is absent, degrading from 144 rows to 138 rather than failing.
- **The merge rule fabricated a row, and it hid where nothing would look.**
  Rejoining any two single characters into an opcode is far too loose: on a
  damaged line reading `2 2 3 3` it manufactured opcode `$22` out of a byte
  count and a cycle count and filed it under ASL. It went unnoticed because
  `$22` is a JAM in our own data, so the comparison skipped it -- **an invented
  row landing exactly where nothing would check it.** The rule now requires the
  second half to be a hex *letter*, which a byte or cycle count can never be.
  The row it was wrecking is now correctly flagged and then recovered.
- **The last six cannot be safely recovered, and trying it fabricated a row.**
  One is not a row at all: `ADC` has no accumulator addressing mode, and the
  word appears in its operation description. The other five are damaged in ways
  that leave nothing to read -- a footnote sitting where the figures belong, a
  row whose numbers are simply absent from both passes.
  - **Reading on into the following line looked like the fix and is a trap.** A
    row missing its figures is immediately followed by the *next* row, so
    concatenating them hands this row its neighbour's numbers: `ASL Zero Page`
    came back carrying `Zero Page,X`'s `$16 / 2 / 6`. The cross-pass agreement
    check threw it out, but only because the first pass happened to hold the
    real opcode. For `BRK`, `ROR` and `TXA` the first pass has no opcode at all,
    so nothing would have caught the same mistake there. It was removed.
  - **144 of 150 is the safe ceiling for this scan.** Getting further means
    guessing, or consulting our own measurements, and either one turns the
    oracle into a mirror.
- **Two smaller fixes kept from that attempt**: the re-read now rejoins a split
  hex opcode the way the first pass does, and it only looks at pages carrying
  the table's column headings. `BRK` was being sought on a page of prose that
  merely lists it, where a re-read finds a heading rather than a row.
- **The remaining rows are genuinely unreadable** -- a footnote interrupting
  a row, figures missing from the scan entirely -- and are reported as skipped
  rather than guessed at. `tests/timing.rs` and `_timing-test.html` still cover
  their own hand-typed set, which is why that set is worth keeping rather than
  superseded.

## The Timing table (`timing.html`, `timing.js`, `export-timing.rs`)

Every instruction's length, measured from one `sync` to the next. **Nothing in
the path consults an instruction table**, which is the whole point: the counts
are free to be wrong, so agreeing with the datasheet is evidence rather than
tautology. 33 documented opcodes are checked in `tests/timing.rs` and in
`_timing-test.html`; all 33 match.

The chain is a shift register of clocked latches — structurally the same stage
as the decode pipeline — and it is **active low**, like the control lines. An
instruction ends when a product term resets it, so a cycle count is not stored
anywhere; it is however many cycles elapsed before that happened.

Three results fell out of the measurement rather than being looked up:

- **Twelve opcodes never finish.** `$02 $12 $22 $32 $42 $52 $62 $72 $92 $B2 $D2
  $F2` — the JAM/KIL opcodes. The chain stops advancing and no further fetch
  happens. **They are recorded as unterminated, not timed out**: a timeout
  reported as a cycle count would put a plausible number beside twelve opcodes
  that do not have one.
- **Twelve undocumented opcodes take eight cycles**, one longer than anything
  documented, and they are exactly the indexed-indirect read-modify-write forms.
  Nothing was built for them; the chain takes that long to reach a term that
  stops it.
- Cycle counts span 2–8 over 244 terminating opcodes.

`deploy.sh` checks all of this: 256 opcodes present, at least 200 timed, exactly
12 jams, and the full 2–7 range represented. A broken measurement run produces a
well-formed file of plausible numbers, so the guard has to be specific.

**Which term ends an instruction** is reported as *arriving*: high in the final
cycle and **not high in any earlier one**. Listing everything high at the end
instead sweeps in the terms describing the instruction's class (`op-implied`,
`op-store`, `op-shift`), which were high throughout and end nothing.

- 161 of 244 end on their own `op-T0-…` term — `$20` on `op-T0-jsr`, `$48` on
  `op-T0-php/pha`. 62 have nothing arriving at all (RMW forms, `RTS`); another
  21 have something arriving that is not a T0 term. All three counts are on the
  page, because two thirds is the honest figure and "the terms that end
  instructions" would not be.
- **This is coincidence in time, not a traced wire, and the page says so.** The
  structural walk that resolved 32 control lines reaches only *four* product
  terms from the timing nodes, `clock2` gets zero, and none of the four are the
  ones observed arriving. That trace is too weak to corroborate anything, so it
  stays in the data and off the page rather than being dressed up as support.
- Term names are emitted into `timing.json` rather than shared by index with
  `decode.json`. Both index the same `Pla::rows` order, but coupling two
  published files by index alone mislabels everything the day that order moves.

## The Swarm (`swarm.html`, `swarm.js`, `export-gpu.rs`, `_swarm-test.html`)

The rung 2 kernel, in the visitor's own browser. `export-gpu` (a
`v6502-compiled` bin) writes `web/gpu.json`: the same WGSL the native
harness runs, its tables concatenated for the eight-buffer layout, and the
counts the params uniform wants. The page boots ONE machine honestly at
the switches (the wasm chip, running the painter program assembled in the
page by `asm.js`), expands its exported machine value to u32 lane planes,
and runs it thousands wide through WebGPU. Each cell of the wall is one
machine's screen page, one pixel per byte; the byte at `$FF`, poked per
lane through the kernel's copy-on-write memory before the first
half-cycle, is the LFSR tap set that makes every chip a different run,
and the pointer broadcasts a brush byte to `$FE` that every lane hears.

What the page is honest about, each stated on it:

- **Rung 2 is a throughput engine.** Each chip runs at a few hundred
  half-cycles a second while the wall runs millions; the page prints both
  live and points a single-chip appetite at the games console's rung 3.
- **Refusals by name**: no WebGPU, no adapter, an adapter whose limits
  cannot hold the kernel, a spent page pool (the wall STOPS rather than
  showing memory whose writes were dropped). The GPU host's whole setup
  runs under a validation error scope, so a binding mistake surfaces as a
  named refusal rather than a silent black wall.
- **The kernel fits any adapter.** Two lessons the headless run taught,
  both now emitted by `v6502-compiled`'s build: the five workgroup planes
  (34.5 KB) exceed the 32 KB workgroup-storage floor that Apple, AMD and
  software adapters share, so a `half_step_lite` variant keeps four
  planes on chip and the fifth in storage, chosen at run time by the
  adapter's limit; and the original sixteen storage buffers exceeded
  common `maxStorageBuffersPerShaderStage` caps, so the kernel now binds
  EIGHT buffers, the spec's own floor (planes share one, the six
  read-only tables share one, the atomics share one). Both variants are
  held to the CPU rung by the native parity test, on the real card.

`_swarm-test.html` checks the ground floor without a GPU: gpu.json's
shape, the painter assembling and booting, the plane expansion, the base
image, the refusals. Under `--enable-unsafe-webgpu
--use-webgpu-adapter=swiftshader` it also sets the host up on a real
WebGPU implementation (minutes per dispatch there, so the settle itself
stays with the native parity test and the wall's live check). The trap
that cost the most: **`--virtual-time-budget` gallops while the page
waits on real GPU work**, so a dump lands mid-setup looking like a hang;
the harness prints incrementally so a mid-run dump shows how far it got.
