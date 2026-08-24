# The Tracer and the chip map

The whole circuit on one screen, and the whole chip as one schematic: twenty-five kinds of container, the partition over them, and the arc that got there. Split out of `CLAUDE.md`.

## The Tracer (`tracer.html`, `tracer.js`, `die-centroids.js`)

The whole circuit on one screen, lit half-cycle by half-cycle, beside the code
that is running. Asked for as "a workbench with the code tracer in it, showing
on each half-cycle ALL of the nodes impacted, the address latches setting, the
data buses being set, with the entire circuit on the screen." One drawing on
the site already had the entire circuit and no invented layout, the die graph;
this is that graph with a clock.

- **It is the die graph, not a laid-out schematic, and that is the design.**
  A schematic of 1160 gates and 873 switches would need a whole-chip layout
  engine and would still be an arrangement somebody chose. Every node here sits
  at its own centroid on the die, so the address latches are where the address
  latches are and the bits of a bus run down the chip; and because a node's
  place never changes, lighting it costs a class and nothing else. `centroids()`
  moved out of `diegraph.js` into `die-centroids.js` the moment a second page
  wanted it, for the reason every other shared module exists.
- **Every mark is a comparison of two readings of the chip, taken by the page.**
  A ring is a node whose level changed since the last paint, a fainter ring one
  that changed at the paint before (so a wave reads as motion rather than as
  flicker); a flashed gate edge is one whose output moved; a bright switch edge
  is one whose control is high, and it is marked when the control just moved.
  Only what changed is touched per paint: the previous change set is
  un-marked, the new one marked, and the fill class of exactly the changed
  nodes flipped. `_tracer-test.html` runs a chip of its own to the same
  half-cycle and recomputes all four sets; a page that lit the right *number*
  of things would fail it.
- **The block regions are a rule, not hulls, and the hull was measured first.**
  `block-regions.js` (a leaf) draws each of the twelve functional blocks as
  everything within `REGION_R` (300) die units of one of its member nodes, as
  a distance field on a `REGION_CELL` (50) grid traced with marching squares:
  outer loops and holes, `evenodd`, one path per block in its own hue behind
  the graph, labelled on its largest piece (a label that falls in a hole or
  outside a C-shape snaps to the nearest member). Computed once from the
  centroids and `nodeBlock`, because the region is a fact about the die and
  not about which nodes the current mode draws; ids 1..12, the residue (0) and
  the static logic (13) being the background the blocks sit in, and the pads
  come out as the ring they are.
  - **A convex hull per block was measured before anything was drawn and
    rejected**: the control pipeline's hull is 45% of the die, and the address
    latches' hull contains every node of the ALU and the program counter,
    because the datapath blocks are interleaved bit-slices. A hull claims the
    neighbour's silicon.
  - **The regions overlap, and the caption prints it**: 87 pieces across 12
    blocks, and 603 of the 1024 block nodes (59%) sit inside another block's
    region too. That is "affiliation is not location" drawn. R was chosen from
    measured neighbour spacing (median 75..180 inside the datapath blocks; the
    program counter is one piece at 300, the registers two, the timing chain,
    whose 25 nodes really are spread, a dozen).
  - **Two marching-squares bugs, both found by running a single disc through
    it**: cases 13 and 14 picked the wrong edges (the orientation check passed
    because it only tested which side was inside, not which edges cross; a
    disc came out as half a circle plus fragments), and chaining by rounded
    coordinates merged two crossings a hair apart on different edges (fixed
    by chaining on *edge identity*). A sample exactly on the iso-line is
    nudged inside. Test a geometry routine on the shape whose answer you know.
  - **`_tracer-test.html` checks the rule, not the module**: every member node
    inside its block's path by the SVG's own `isPointInFill`, a 60x60 lattice
    of sample points agreeing with "within R of a member" wherever more than
    1.5 cells from the line (42,096 points, 0 disagree), the caption's overlap
    count recounted with the hit test, the toggle, and the label hiding once
    node labels arrive at `LABEL_ZOOM`.
  - `?regions=0` hides them; the "block regions" button toggles. Region
    labels hide past `LABEL_ZOOM` because by then the reader is inside one.
  - **A click on a region selects the block, and the overlap is resolved by
    the rule that drew them.** The path under the pointer is only the one
    drawn last there, so `blockAt()` takes the blocks whose region contains
    the die point and picks the one with the nearest member node. `selectBlock`
    brightens the region, steps every non-member node back (`sel-out`), keeps
    an edge with either end in the block because that edge is its boundary,
    marks the block's group in the moved list, and paints a block card
    (members, drawn, moved at this half-cycle, pieces, % of the die, a link to
    its page by `SLUGS`). Clicking the selected block again, or off every
    region, clears; `draw()` re-applies a selection after rebuilding.
    `?block=<slug>` selects and frames it, the slug being the block pages'.
  - **The harness clicks for real**: `elementFromPoint` at the screen point of
    a lattice point inside exactly one region and clear of every node, then
    at one inside two, asserting the nearest-member block won. Two things it
    had to learn: the document would not scroll headlessly, so the harness
    iframe is made 2600px tall for the clicks and put back; and the stepping
    check moves the chip, so it runs last, because the ring assertions after
    it assume the change set is (40, 41).
- **The buses and latches are capsules inside the regions, and the set is a
  stated rule, not a list.** A stem is letters only (no `#`, `~`, no ALU
  product like `(AxB)`), not a `not…` complement, with bit 0 named and at
  least seven of bits 0..7 named: the seven is there for exactly one reason,
  `p` has no bit 5. Measured, that is 24 stems (`a ab abh abl adh adl alu alua
  alub db dor idb idl ir p pch pchp pcl pclp pd s sb x y`), and the rule was
  tightened twice against what it let through: `Pout`, `dasb` and `pipeUNK`
  qualified under "six of eight" and none of them is a bus. Each capsule is
  everything within `STEM_R` (220) of one of its bits (bits sit ~400 apart
  down the datapath, so a byte is one capsule), drawn by the same
  `blockRegions()` with a node-to-stem index, named above its top, in the
  watch colour. Clicking selects the stem through `applySelection`, the one
  path both kinds of selection share; a capsule wins over the block region it
  sits in, being the more specific claim; the card reads the byte now, the
  bits that moved, the pieces, the block(s) its bits are filed under, and
  offers `watch`/`unwatch`, which edits the watch list. One selection at a
  time: a stem clears a block and a block a stem. `?bus=STEM` deep-links.
  - **The harness re-derives the 24 from the names**, checks every bit is in
    its capsule by `isPointInFill`, clicks a lattice point that is inside one
    capsule *and* a block region and asserts the bus was selected, compares
    the card's byte with its own chip, and round-trips the watch button.
- **The static logic is clustered two ways at once, because one way is not
  enough.** The 674 gate outputs in no block have no natural spatial scale:
  neighbour spacing is a median 110 die units, and union-find at 2R gives 375
  pieces at R=60, 192 at 100 with a giant of 136, and one mass of 462 at 200.
  Any single R is arbitrary. So a cluster is: the gates that **drive the same
  block** (`blocks.json`'s `nodeDrives`, the attribution the block pages use,
  fetched here for the first time and cross-checked against `schematic.json`'s
  masked `nodeBlock` at boot), then **within 2 x CLUSTER_R (120)** of each
  other. Measured: 266 groups, 163 of them single gates, so **103 clusters of
  two or more**; the largest is the control pipeline's drivers at 127. A gate
  on its own is not a cluster and is not drawn; the caption counts them. Ids
  are the lowest node number in the cluster, which `?cluster=N` uses (N is any
  node in it). Dashed outline tinted by the driven block (lavender for "no
  single block"), a count label only past `LABEL_ZOOM`. Click priority is
  capsule, then cluster, then block region: most specific wins.
  - `_tracer-test.html` re-derives the 103 node for node from `blocks.json`
    and the centroids, hit-tests all 511 gates into their outlines, clicks a
    point inside one cluster and a block region and no capsule, and checks
    the card's high and moved counts against its own chip.
- **The decode terms cluster by stage, and a stage cluster is a set, not a
  place.** The 122 product terms (`nodeRole` 1) lie in a row along the PLA a
  median 49 die units apart, and the stages are interleaved along it (82 runs
  of alternating stage in 122), so no radius separates them spatially; the
  grouping is what the die's names carry: `op-T0-…`, `op-T2-…` .. `op-T5-…`,
  `op-T+-…`, and a name with no T-state serving any stage. Measured: T0 33,
  T2 17, T3 10, T4 9, T5 8, T+ 11, any 33, and the one unnamed term (the
  `irline3` generator) left out and counted. Drawn as beads (`TERM_R` 70,
  cell 25) coloured by stage (`STAGE_COLOR`, presentation), T0's beads coming
  out as 21 pieces, which is the interleaving made visible. Clicking selects
  the stage's terms as a set; the card lists which are high now as pills that
  fly to the term, which is the decoder's answer to "what is the chip doing".
  `?stage=T0` deep-links; priority is capsule, stage bead, gate cluster,
  block region.
  - **The harness's card check passed vacuously first**: no T0 term is high at
    half-cycle 41, so an empty list matched an empty list. It now also checks
    the stage with the most terms high and requires the list non-empty. A
    check that can pass on nothing has to be made to see something.
- **The control lines cluster by what they operate**: the block holding most
  of the transistors each line gates (`blocks.json`'s `transistorGate` and
  `transistorBlock`, ties to the lower id). Measured: program counter 9, ALU
  14, registers 9, address latches 8, data bus 3, and 3 (`#IPC`, `#DSA`,
  `PCLC`) whose transistors are mostly static gates and file with the static
  logic. Their centroids sit mid-datapath beside what they drive, so each
  group runs together at `CONTROL_R` (150) as a dotted outline in the unit's
  hue; the card lists the lines high now (as pills) and counts the switches
  they hold open, checked against the harness chip. A control cluster wins
  over the capsule it sits in, being smaller; `?control=<slug>` deep-links.
  Click priority overall: control, capsule, stage bead, gate cluster, block.
  - **A first estimate of the grouping, made by reading switch endpoints in a
    throwaway script, got the numbers wrong** (registers 8, ALU 12, PC 10):
    the page files by `transistorBlock`, which also counts a line's pulldown
    transistors in gates. The harness agreed with the page line for line and
    the comment was corrected to the measurement; the assertion that named
    "twelve" was replaced by "the ALU has the most", which is the claim.
  - **High-list pills carry `tc-hi`** so a harness can tell them from the
    moved-list pills, which also carry `up`; selecting `.tc-node.up` found
    each high-and-moved line twice.
- **Any container collapses into one node, and the one liberty with position
  is stated.** `state.collapsed` is a set of keys (`block:8`, `stem:sb`,
  `cluster:12`, `stage:T0`, `control:8`); `applyCollapse()` hides the members
  and the edges among them, puts one node at the **mean of the members'
  centroids** (still a measurement, the only place this page averages
  positions), and gathers every boundary-crossing edge into one `.tc-bundle`
  per far end, as wide as its count. `paintCollapse()` lights the node by the
  share of members high, rings it if any changed, and flashes a bundle whose
  edge fired or toggled. A node in more than one collapsed container goes to
  the most specific (`KINDS`, the click order), so a capsule folded inside a
  folded block keeps its own node and the block's stands for the rest; the
  harness pins `ALU · 128` + `alu · 8`. Every card carries `collapse`/`expand`
  (`collapseButton()` reads `selectedKey()`), `c` toggles the selection,
  "collapse the blocks" and "expand all" are in the view controls, clicking a
  collapsed node selects what it stands for, and `?collapse=blocks,stage:T0`
  deep-links. Elements are hidden by class (`hid`) and kept, so expanding is
  a class removal and a rebuild of supers and bundles, not a redraw.
  - **The harness checks by class, not computed display**, because its page
    runs with `only=1`, which hides most nodes for its own reason; a first
    version read `display: none` and reported 2174 edges wrong. And a
    `fillOpacity` written as `0.60` reads back as `0.6`: compare numbers.
- **The pins are containers too, grouped by the direction the pinout page
  measures**, and that meant an extraction first: `PACKAGE`, `direction()`
  and the `driver`/`feeds`/`chan` derivation moved out of `pinout.js` into
  `pins.js`, shared by both pages, because a second copy of the direction rule
  that dropped its one subtlety (a gate whose every leg is gated by vss is a
  pullup in a gate's clothes) would call RDY and S.O. outputs. `_pinout-test`
  passed unchanged before and after. On the tracer: 6 inputs, 20 outputs, 8
  bidirectional (the data pads, with nobody saying so), halos of `PIN_R` (300)
  on each pad in the direction's hue, a set around the ring like the stage
  beads; `PIN_R` exceeds `STEM_R` on purpose so a data or address pad's halo
  reaches past the capsule over the same pads and can be clicked at the
  pad's edge. The card lists every pin with its level and marks the ones that
  moved. `pins:input` etc. collapse like everything else (the mean of a set
  around the ring lands mid-die, which is the rule and is stated). Priority:
  control, capsule, stage, cluster, pins, block. `?pin=input` deep-links.
- **The timing chain is a container as the cells that compute each T-state,
  derived, and not the block of that name.** The `Timing chain` block is 25
  names spread into a dozen region pieces, and the chain's own latches are
  filed in the control pipeline; asked to cluster it, the honest answer was
  to derive what the chain *is*. `chain-cells.js` (a leaf) takes
  `schematic.json` and `timing.json`'s `stages` (the six outputs the T-state
  readout reads, in order) and walks back from each through gate inputs and
  switch channels (a dynamic latch's data is the far side of its clock switch;
  cp1 and cclk ride on the edges and are never expanded) inside the timing
  chain, the control pipeline and the static logic, stopping at a node that
  reads anything from outside; each node goes to the stage that reaches it
  soonest, a tie is shared, and so is anything three or more stages read.
  Measured: **T0 21, T1 3, T2 8, T3 5, T4 5, T5 5, shared 4** (`notRdy0`,
  `#16`, `#1357`, `#223`), 59 nodes reached, and the reach converges on its
  own at any depth of 8 or more, so the cap is a runaway guard.
  - **T2..T5 come out as the same five nodes each, which is the shift
    register read off the wires**: the output inverter, the NOR behind it,
    the cclk half-latch the die calls `pipeTnout`, a dynamic node loaded
    through cp1, and an AOI reading `ready AND pipeT(n-1)out` OR `not-ready
    AND pipeTnout`: shift if RDY, hold if not. The card reports "reads
    pipeT2out of T2", so the order is shown rather than asserted. T0 is the
    largest because it is the state the chain is reset *into*, so its cell is
    the end-of-instruction logic up to the boundary; T2 takes the SYNC latch
    it loads from; `#862`, the readout's hidden T1, lands in T2 and its data
    in T0, which is the rule being a rule and is visible on the cards.
  - **`schematic.json`'s switches are `[control, a, b]`.** The first
    measurement read them as `[a, b, control]`, so cp1 appeared as a
    *channel end* of a hundred latches and the chain walk went nowhere; the
    tell was a dynamic node with "no switches" whose transistor was plainly
    in `transdefs.js`. Check the shape against a row you can decode by hand.
  - **Active low, and the card reads the chip's own readout.** A cell says
    *active* when `timingStates()` names it; `_tracer-test.html` asserts on
    its own chip that the readout names a state exactly when that cell's
    output is low, and that the six cards agree, requiring at least one active
    so the check cannot pass on all-idle. Beads at `CHAIN_R` (80), long-dashed,
    in the stage's hue (T1 wears T+, shared grey), named by the output
    (`clock1`, `t3`); `chain:T3` / `chain:shared` keys, `?chain=T4`,
    `?cells=0`, priority control, chain, capsule, stage, cluster, pins, block.
  - **The harness re-derives the rule itself** from the two files and
    compares node for node, then pins the structure by name (five-node cells
    holding their own `pipeTnout`, each reading the previous one, `notRdy0`
    shared), clicks a bead, collapses T3, and deep-links T4.
- **The clock generator is a container, from the same walk the designer page
  runs.** `clockGen()` moved out of `designer.js` into `clock-gen.js` (a leaf)
  the moment the tracer wanted it, for the reason `pins.js` exists: two pages
  deriving "the clock generator" from two copies would eventually disagree
  about which 44 transistors it is. `_designer-test.html` passed unchanged
  before and after. One container, `clock:gen`, a bright outline at `CLOCK_R`
  (150) around the 16 nodes; `cp1` and `cclk` sit mid-die in it because those
  nets span the chip and a centroid is a centroid. The card reads the four
  clocks' levels off the chip, states the 44 / 21 / 23 / 1.3% and the two
  interlock transistors, and counts what moved: **all 16 nodes move at every
  half-cycle**, which is what a clock generator is and the harness pins.
  `?clock=1`, `?clockgen=0`; priority control, clock, chain, capsule, stage,
  cluster, pins, block.

- **The interrupt logic is a container as what each pin reaches, and the
  pins give it its structure.** `interrupt-paths.js` (a leaf) walks forward
  from `irq`, `nmi` and `res` through gate inputs and switch channels inside
  the interrupts block and the static logic, stopping where a node feeds
  anything outside (where detection ends and action begins: `INTG` feeds the
  timing chain, `Reset0` the control pipeline). One pin's reach is its path;
  two pins' is shared. Measured: **irq 6** (receiver to `IRQP`), **nmi 20**
  (receiver, `NMIP`, the edge detect and `NMIL`, `#NMIG`, and
  `pipeVectorA2`), **res 6** (to `Reset0`), **shared 4** (`#480 #629 #760
  INTG`), converging by depth 12. The vector selection is not reached from
  any pin (the BRK sequence drives it) and is grouped by the die's names
  (`VEC0 VEC1 #VEC pipe#VEC pipeVectorA0 pipeVectorA1`), said to be a reading
  of names; **22 of the block's 40 members are in none**, `brk-done` and the
  branch logic the seed table filed as interrupts among them, and the card
  counts them.
  - **`pipeVectorA2` on the NMI path is a finding, not a leak**: bit 2 is
    the one address bit by which `$FFFA` differs from `$FFFE`, and the rule
    found it without being told. Reset's bit (1) is not reached because
    Reset's effect runs through the control pipeline, outside the home.
  - **Min-depth ownership was wrong here and right for the chain.** With
    three sources, the common path (`#480..INTG`) went to `irq` because it
    reached it first; "reached from more than one pin is shared" is the rule.
    A chain of stages needs the depth rule because every later stage reaches
    every earlier one.
  - Double-ringed beads at `INTR_R` (90), one hue per group; `intr:nmi`
    keys, `?intr=vector`, `?interrupts=0`; priority control, clock, intr,
    chain, capsule, stage, cluster, pins, block. The harness re-derives the
    five groups and pins the names above, checks each pin card against the
    harness chip's level and the vector card's three address bits, clicks,
    collapses and deep-links. **Adding a kind that outranks an older one
    moves the older kind's click spot**: the chain's T4 click landed on an
    NMI bead until its spot search excluded every outranking outline.

- **The branch logic is a container split where the wiring splits it.**
  `branch-logic.js` (a leaf) takes the bounded backward cones of every node
  the die gave a branch word (`branch`, `BRtaken`, `T2BR`) inside the
  interrupts block and the static logic (boundary: a node reading anything
  from outside, which is the instruction register, the flags, the data bus
  and the adder), and the union falls into connected components: **three**,
  and that is the measurement. `taken` 9 (`#BRtaken`, an AOI that is `ir5`
  XNOR `#620`, a NOR of four gates each pairing one flag `p0 p1 p6 p7` with
  the decode of opcode bits 6/7: the flag multiplexer written in switches),
  `direction` 8 (`nnT2BR`, `branch-back` reading the offset's sign `DBNeg`
  at T2 of a branch, the `.phi1` latches), `cross` 2
  (`short-circuit-branch-add` and its cp1 latch). The labels are a reading;
  the split is not. Converges by depth 4.
  - **`cross` is its own piece for a structural reason, not an accident:**
    it hangs off the direction latches only through the *controls* of its
    own switches (`=#alucout when #1446`, `=##alucout when
    branch-back.phi1`), and controls ride on edges and are never expanded.
    It reads the adder's carry or its complement when the branch is
    backward, and feeds `dpc36_#IPC` and `#959`, the timing chain's reset: a
    branch that crosses no page ends early, and that is the wire it ends on.
  - **`reads` and `feeds` are measured per piece** (nodes outside it that
    members read, and that members drive) and are on the card: taken reads
    `notir5`, the `#op-branch-bit6/7` decodes and the flags' pipeline copies
    and feeds `#586` (behind `pipeIPCrelated`); direction reads `DBNeg`,
    `op-T2-branch`, `pipeUNK01` and also feeds `#586`. The harness pins all
    of it, checks the card's pills (nodes, reads, feeds) against its chip's
    levels, clicks, collapses and deep-links.
  - Dash-dot beads at `BRANCH_R` (90); `branch:taken` keys, `?branch=cross`,
    `?branches=0`; priority control, clock, intr, branch, chain, capsule,
    stage, cluster, pins, block. **The tracer's stray-digit scan fired on
    "bit 5 ... bits 6 and 7"** in the new prose: bit indices, not counts,
    but the scan cannot tell and the exemption is `.mono`, so the prose says
    "the polarity bit (`ir5`) against the flag its top two bits select".

- **The decimal correction is a container as everything its names are wired
  into.** The designer page counts it by five names (21 transistors);
  `decimal-correction.js` (a leaf) walks both ways from every decimal-named
  node (`dpc18_#DAA`, `dpc22_#DSA`, `DC34`, `DC78`, `DC78.phi2`, the `DA-*`
  family in the ALU: eleven) with **the static logic as home and the seeds
  as roots**, boundary rule as elsewhere. **51 nodes, one piece, 96
  transistors**, converging by depth 6. Its measured `feeds` are the whole
  mechanism: `#C34` and `notalucout` (the carries the detectors inject) and
  `dasb1..3`, `dasb5..7` (the adjusted special bus `dpc23_SBAC` opens onto A:
  +6 in each nibble); its `reads` are the adder's products, the D flag's
  pipeline copy (`pipeUNK22`) and the `sbc` decode. The card sorts the nodes
  by which walk found them: detect 16, enable 10, adjust 25.
  - **Seeds must be roots, not home.** Counting them as home let the walk
    take one more step and pick up `#936` and `#647`, the adder's own
    NOT(A.B) gates for bits 1 and 5, which the detectors read but which are
    the adder's: the tell was the circuit "feeding" `AxB1`, `AxB5`, `#C12`,
    `#C56`. With the home the static logic alone they stay in `reads`, where
    they belong, and the harness pins that.
  - One orange outline at `DECIMAL_R` (120), running down two columns
    through the ALU's bit slices; `decimal:bcd`, `?bcd=1`, `?decimal=0`;
    priority control, clock, intr, branch, decimal, chain, capsule, stage,
    cluster, pins, block. The harness re-derives the walk, pins feeds and
    reads by name, counts 21 and 96 by the same rule, checks every pill on
    the card against its chip, clicks (through the `alu` capsule under it),
    collapses, deep-links. **The harness's boot wait had to grow**: eleven
    kinds derived at boot pushed the page past the 20 s it allowed.

- **The registers are containers as the die builds them, S, A, X and Y by one
  rule, and the lines that move each.** `register-logic.js` (a leaf; written
  for the stack pointer, and the rule never mentioned S): a register is the
  closure of its stem's eight bits over unnamed and own-named nodes (`nots0`,
  `notx0`), never a rail, never another named wire, so it stops at the buses.
  **S 32 (four a bit), A 24, X 24, Y 24**; what each meets outside is its
  buses: S `sb`+`adl`, X and Y `sb` alone, A `sb`, the adjusted `dasb1..3`,
  `dasb5..7` and `idb`. The lines are the controls of those switches less the
  clocks (a node controlling forty or more switches: `cclk` 243, `cp1` 96),
  each with its bounded backward cone in the control pipeline and the static
  logic, **clocks never expanded** (`dpc7_SS` reads `cclk` as a gate input).
  S: `SS SBS SSB SADL`; A: `SBAC ACDB ACSB`; X: `SBX XSB`; Y: `SBY YSB`, eight
  switches each on its register. What each reads is the instruction set in
  the wires: SADL from `op-T0-jsr` and `op-T2-stack`, SSB from `op-T0-tsx`,
  SS and SBS from `op-T0-txs`, SBAC from LDA/PLA/TXA/TYA and the ALU's T+
  terms, ACDB from `op-sta/cmp` and PHA, ACSB from TAX/TAY/ANDS/shifts, SBX
  from LDX, SBY from LDY.
  - **The first closure said "without leaving the Registers block" and found
    A as its eight bits alone**: A's latch nodes (`a → #5 → #146 → a` on
    `cclk`, no hold line) are filed in three blocks. The block-free rule
    gives S the same 32 and reads A.
  - **Sharing has to be split out across every register at once.** `#1247`
    is in the cone of all nine lines and `#43` in the load lines of all four
    (with S's hold): common control logic belonging to no register, their own
    beads (`shared.<ids>`). The per-register split left them in two beads and
    the harness's "every node inside its bead" reported six outside.
  - Kind `regs`, ids `s`, `s.SS`, `a.ACDB`, `shared.<ids>`; `?reg=a.ACDB`
    (`?stack=reg` and `?stack=SADL` kept as the old spelling), `?registers=0`.
    Square-dotted beads at `REGS_R` (90), one hue per register. **The
    registers outrank everything on click and are drawn last**: their beads
    sit over the capsule and the Registers' control outline, and the first
    run selected the register while `elementFromPoint` returned the capsule;
    z-order has to agree with click priority. The control cluster's click
    spot keeps clear of them. A register card reads its byte off the chip; a
    line card says whether its eight switches are open and what it is made
    from. The harness re-derives all four, the lines, the cones, the global
    sharing, pins the reads by name, checks every card against its chip,
    clicks, collapses, deep-links.
- **The program counter's incrementer is a container as what lies between
  the counter and its next value.** `pc-increment.js` (a leaf): roots are the
  sixteen outputs `#pclp0..7`, `#pchp0..7` (the prime latches are their
  inverses) and the three named lines `dpc36_#IPC`, `dpc34_PCLC`,
  `dpc35_PCHC`; stops are the counter's storage (`pcl pch pclp pchp`); home
  is the static logic and the Program counter block less the stops (bit 0's
  gates are static, bits 1..7's are unnamed nodes filed in the PC block).
  Backward cones, boundary rule. **86 nodes, one piece**; it reads exactly
  the sixteen counter bits plus the enable's inputs (`#1570`, the branch
  logic's page short circuit; `#1472` and `notRdy0`; `pipeIPCrelated`;
  `ONEBYTE`) and feeds exactly the sixteen prime latches; bit 7's cone runs
  **nine deep**, which is the ripple carry. Parts for the card: enable 3 (the
  `#IPC` cone), low 41 (the `#pclp` cones and `PCLC`), high 42. One red
  outline at `INCR_R` (110), `incr:pc`, `?incr=1`, `?incrementer=0`,
  priority after decimal and before the chain. The harness re-derives the
  walk, pins reads and feeds by name and the depth, checks the card (PC off
  the chip, every pill's level) against its chip, clicks, collapses,
  deep-links. **The deep-link frames' boot wait had to grow too** (20 s to
  100 s of virtual time): thirteen kinds derived at boot.

- **The status register and the flag logic are a container per flag, with
  the shared enables and the Pout bits as their own.** `flag-logic.js` (a
  leaf): roots are `p0..p7` (no bit 5), home the Status register block, the
  static logic and the control pipeline, clocks and the `p`/`Pout` bits never
  entered; backward cones with the boundary rule applied to every node
  **except the bit's own gate** (the node its `cp1` switch joins it to: an
  AOI whose legs are source AND enable | `idb_n` AND load | set-or-clear AND
  enable | own copy AND hold), which is always expanded. One flag's reach is
  its logic, two flags' is shared. Measured: **C 14, Z 11, I 9, D 9, B 2, V
  24, N 7, shared 3** (`#270 #503`, the `ir5` polarity of the set/clear
  pairs; `#781`, the PLP/RTI load), **out 6** (`Pout` by name, each the
  inverse of a flag's pipeline copy onto `idb` under `H1x1`), converging by
  depth 8. What each reads is the mechanism: C `#alucout`, `idb0`,
  `#op-set-C`, `op-SRS`, `op-T0-clc/sec`; Z all eight `idb` bits through
  `DBZ`; N `idb7` through `DBNeg`; V `aluvout`, the `so` pin, `op-clv`, BIT;
  I `brk-done` and `op-T0-cli/sei`. **B is not a stored bit**: `p4` is an
  inverter of `D1x1`, the timing chain's BRK-against-interrupt distinction,
  read fresh each time P is pushed.
  - **Two wrong cuts, both measured before the right one.** The plain
    boundary rule (a node reading anything outside is kept, not expanded)
    gave C as *one* node: the flag AOIs are exactly where the outside
    arrives (the carry, the bus, `ir5`). No cut at all ran eighteen deep into
    the control pipeline's own sequencing (`#440`, the store-data latch) and
    the shared set grew with the cap (11, 18, 25, 34). "Always expand the
    bit's own gate, then the usual rule" converges at 8.
  - Ringed beads at `FLAGS_R` (90), one hue per flag; `flags:V`, `?flag=B`,
    `?flags=0`; priority regs, flags, control, .... A flag card reads its bit
    off P (`$35`, `nv-BdIzC`) and names what it reads; the harness
    re-derives the nine groups, pins the reads by name and B's inverter,
    checks every card's bit against its chip, clicks, collapses, deep-links.
    **Adding a kind moved the branch click spot under an edge line**, so
    that spot search now frames each candidate and checks the element under
    the pointer is the bead before clicking.

- **The address latches are a container per half, per load line, and per
  constant generator.** `address-latches.js` (a leaf). **The register recipe
  misreads this block and the misreading is the structure**: the latch nodes
  are themselves switch controls (`abl_n` gates the pull-up of its own pad
  driver), so every node came out as a "line" and the closure ran into the
  drivers. Read on its own terms, one bit is a chain of seven: the bus bit's
  inverter, a node under `cp1`, the latch input `#ABL_n` under `ADL/ABL`, its
  inverse `abl_n`, an output latch under `cclk`, and the two static nodes of
  the pad's push-pull driver. Each half is the closure of its bits over
  unnamed and own-named nodes both ways: **56 each**, reading exactly
  `adl0..7`/`adh0..7` and feeding exactly `ab0..7`/`ab8..15`. The load lines
  are the controls of the half's switches less the clocks: `ADL/ABL` (cone
  18, reaching the store-data pipeline latches `#440` and `#1258`: the low
  latch does not reload during a store's data cycles) and `ADH/ABH` (cone 5).
  The constants are the die's `0/ADL0..2` (inverters of `pipeVectorA0..2`:
  how `$FFFA..$FFFF` gets on the bus; cone 4) and `dpc28_0ADH0`,
  `dpc29_0ADH17` (the high byte forced to `$00`/`$01`; cone 8, reading
  exactly `op-T2-stack-access`, `op-T2-zp/zp-idx`, `op-T2-ind`). Converges by
  depth 12.
  - Kind `alat`, ids `abl`, `abh`, `ADL/ABL`, `ADH/ABH`, `low`, `high`;
    `?alat=ADH/ABH`, `?addrlatch=0`; priority regs, flags, alat, control, ....
    A half's card reads the byte it holds off the pins (AB); a line's says
    whether its eight switches are open and what it is made from. The
    harness re-derives halves, lines, cones and constants, pins reads and
    feeds by name, checks the cards against its chip, clicks (framing
    candidates and checking the element under the pointer, as the branch
    click does), collapses, deep-links.

- **The ALU and its adder are a container per bit slice, plus inputs, ends
  and line groups.** `alu-slices.js` (a leaf). The die names the adder bit by
  bit (`#A.B_n`, `A+B_n`, `#(AxB)_n`/`AxB_n`, the sum `#(AxBxC)_n`, carries
  alternating in polarity, `#aluresult_n`, `alu_n`/`notalu_n`), which is what
  makes slices derivable: from each `alu_n` backward inside the ALU and the
  static logic, stops at `alua`/`alub`, the decimal nodes (their own
  container) and the carry ends, boundary rule beyond, min-depth ownership,
  ties shared. **10 or 11 nodes a slice**, the carry *into* a bit filing
  with that bit (it is what its sum reads), and the seven generate terms
  `#A.B1..7` shared (each read by its bit's XOR and the next bit's carry at
  the same depth). Inputs by the register closure: **A 8, B 16** (an
  inverter a bit for `nDBADD`, the inverted data bus that makes SBC), with
  `SBADD`/`0ADD` and `DBADD`/`nDBADD`/`ADLADD`. Ends by name with cones:
  `cin` 18, `cout` 7 (feeds the C flag's gate `#1082`), `vout` 4. The
  thirteen lines as `in` 26 / `fn` 25 / `out` 58 with their cones: the block
  page's five-five-three, here with what makes each. One owner per node,
  later groups yielding to earlier (`#604` cin over in; `#748` bit 7 over
  cout). Converges by depth 12.
  - **`/$^/` matches the empty string.** The line cones first came out as
    the lines alone because that "never" regex made every unnamed node a
    stop. `/(?!)/` is never.
  - Kind `alu`, ids `bit0..bit7`, `shared`, `a`, `b`, `cin`, `cout`, `vout`,
    `in`, `fn`, `out`; `?alu=bit3`, `?adder=0`; priority after decimal (which
    overlaps it heavily and is **drawn above it**, z-order agreeing with
    click priority), before the incrementer. A slice card reads its bit and
    the whole ALU byte off the chip; an input's card its byte; a line group's
    which lines are high. The harness re-derives slices, shared, inputs,
    ends and line groups, pins bit 3's names and the `#A.B` set, checks the
    cards against its chip, clicks (framed candidates), collapses,
    deep-links.

- **The data latch, the data output register, the internal data bus and the
  read/write control are a container each.** `data-bus.js` (a leaf). `idl` is
  the register closure of `idl0..7`: **32, four a bit** (the pad's inverter,
  `notidl` under `cclk`, `idl`, and a latched copy under `cp1` filed in the
  Address latches block that `DL/DB`, `DL/ADL`, `DL/ADH` open onto the
  buses), reading exactly the `db` pads. `dor` is **48, six a bit** (`notdor`
  loaded from the bus under `cp1`, `dor`, the pad's push-pull driver), reading
  exactly `idb0..7` and `RnWstretched`, feeding exactly the pads, with no
  line of its own. `idb` is its eight bits alone (**its closure reaches 369
  nodes**, because a bus touches everything) with the seven lines that hold
  a switch on a bit (`DL/DB SBDB ACDB PCLDB PCHDB DBADD H1x1`); the three
  that are nobody else's get cones here (`SBDB` 5, `PCLDB` 7, `PCHDB` 5),
  the latch's three too (`DL/DB` 5, `DL/ADL` 5, `DL/ADH` 17: it reaches the
  timing chain's T0 cell, the high byte of a fetched address landing at T0).
  The R/W control is the cones of `rw`, `notRnWprepad`, `RnWstretched`, `#WR`
  inside the pads, the static logic and the pipeline: **31**, reading
  `pipe#WR.phi2`, the store terms through the store-data latches, `notRdy0`
  and `C1x5Reset`: a write needs the chip ready and not in reset, read off
  the wires. Converges by depth 12; one owner per node.
  - Kind `dbus`, ids `idl dor idb rw DL/DB DL/ADL DL/ADH SBDB PCLDB PCHDB`;
    `?dbus=SBDB`, `?databus=0`; priority after the address latches, before
    the control clusters. Cards read the latch and register bytes, the bus
    byte and the R/W pin off the chip. The harness re-derives closures, line
    cones and the R/W union, pins reads and feeds by name, checks the cards
    against its chip, clicks, collapses, deep-links.
  - **The View drawer grew past the strip and the study-view drag test
    caught it**: with eighteen toggles the console's drag up by 200px came
    back 165, clamped against a drawer taller than the room. The drawer now
    carries the Ports drawer's cap (`--sp-strip-h`) and scrolls.

- **The instruction register and predecode are a container per stage of an
  opcode's arrival.** `ir-predecode.js` (a leaf): two closures over the
  Instruction register block's unnamed nodes and own names, from `pd0..7`
  (own `pd_n`, `pd_n.clearIR`) and from `ir0..7` (own `ir_n`, `notir_n`).
  What only the first reaches is the **predecode latch, 24, three a bit**
  (the pad's inverter, `pd`, `pd.clearIR`), reading exactly the `db` pads and
  `clearIR`; what only the second reaches is the **register, 16**; what both
  reach is the **load path, 24, three a bit** (the inverter of `pd.clearIR`,
  the node under `fetch`, the register bit's input that `notir` recirculates
  into under `cclk`). The closures are kept to the block: over the static
  logic the register's leaks through `#1133` into the flag logic (348). The
  **predecoder** is the cones of the five `PD-*` terms and `ONEBYTE` (7
  nodes once the load path has its inverters), reading the predecode byte
  and feeding `#TWOCYCLE` (the T0 cell) and `#1275` (the PC increment
  enable): where a one-byte instruction stops the counter and a two-cycle
  one shortens the chain. `irline3` (with `#1133`, reading `ir0` and `ir1`),
  `clearIR` (a NAND of `fetch` and `D1x1`, feeding all eight `pd.clearIR`:
  an interrupt is BRK) and `fetch` (reading `notRdy0`) each a group. **The
  register feeds all 122 product terms directly and `irline3` 63 of them
  again**, measured by role on the page and pinned by the harness.
  - Kind `irp`, ids `pd load ir pre irline3 clear fetch`; `?ir=pre`,
    `?instreg=0`; priority after the data bus, before the control clusters.
    Cards read the predecode and the register off the chip (and the register
    card checks the bits against the chip's IR readout), say whether `fetch`
    is open, count the predecoder's high terms. The harness re-derives the
    closures and cones, pins the names, the 122 and the 63, checks the cards
    against its chip, clicks, collapses, deep-links.

- **The special bus is a container as its bits, its adjusted copy, and its
  thirteen lines by measured direction.** `special-bus.js` (a leaf). `sb0..7`
  are pure bus bits: no gate drives them, `cclk` precharges them to vcc
  through eight switches, everything else arrives through a switch. Thirteen
  lines hold a switch on every bit (`ADDSB7` on bit 7 alone: the shifter),
  and **each line's direction is read off the far side of its switches**,
  never off its name: a far node driven by a static gate is a source (the
  line brings a value ONTO the bus: `YSB XSB SSB ACSB ADDSB06 ADDSB7`), a
  far latch or precharged bus is a sink (OFF: `SBY SBX SBS SBAC SBADD
  SBADH`), a far bus is the link (`SBDB`). That the derived directions spell
  out exactly what a 6502's names claim is the evidence, and the harness
  pins both the rule's output and the known answer. `dasb` is the six
  adjusted bits plus the six inverters whose only input is an `sb` bit (12;
  no bits 0 and 4 because +6 never changes them); `SBADH`, the one line
  nobody else cones, comes with its cone (7, reading `#op-branch-done` and
  `#op-T3-branch`: the page fix of a taken branch).
  - Kind `sbus`, ids `sb dasb onto off link SBADH`; `?sb=dasb`,
    `?specialbus=0`; priority after the IR. The bus card reads `$` off the
    bits and shows every line with a direction arrow and its level; the
    adjusted card computes the byte A would load (sb0, sb4 direct, dasb for
    the rest). The harness re-derives the directions and the adjusted set,
    pins them against the known 6502 answer, checks the cards, clicks,
    collapses, deep-links.
  - **The click test could not use the bus's own beads**: `sb` is in the
    default watch, and the watch's rings and polyline are deliberately drawn
    above every region, so no point over those beads ever has the bead as
    its topmost element. The adjusted beads are the click.

- **The store-data pipeline is a container per stage: the detect, SD1, SD2.**
  `store-pipeline.js` (a leaf). The die does not name these; the simulator's
  own timing readout does (SD1 is node 440, SD2 node 1258, active high, the
  trailing field of the fixed-width trace), and their cones had turned up at
  the boundary of half the other containers. Bounded backward cones in the
  control pipeline and the static logic, one owner per node in the order
  sd1, sd2, detect, reads/feeds recomputed on the final sets (sd2's cone
  crosses into sd1 through `#504` reading `#440`). Measured: **detect 4**
  (`#191`, a NOR of `#347`, the five data-cycle terms one per addressing
  mode, `notRdy0` and `#790`, the RMW classes; it also makes `op-rmw`),
  **sd1 4** (the detect under `cclk`, an AOI that holds when not ready,
  `#24` under `cp1`, `#440`), **sd2 7** (SD1 delayed one cycle when ready).
  What they feed is why a store works: `#WR` (both), the `ADL/ABL` hold
  `#104` (the address stands still through the data cycles), the RMW shift
  gating (`#905`, `#366` into `op-SRS`), the carry-in choice (`#1107`), the
  C flag's shift path (`#op-set-C` reads SD2).
  - **The harness's oracle is the chip's own readout**: over 600 half-cycles
    of an `INC $F0; JMP` loop the trace's trailing field and the two node
    levels agree 600 of 600, with 152 half-cycles in store data. Two
    findings on the way: the first draft read the *bracket*, which is the
    hidden T-state, not SD; and **Fibonacci ran 600 half-cycles with the
    field at "..." throughout: a plain store never sets SD**. The detect
    reads the `mem` data-cycle terms and the RMW classes, so SD marks the
    modify cycles, not every store.
  - Kind `sdp`, ids `sd1 sd2 detect`; `?sd=detect`, `?storepipe=0`; priority
    after the special bus. **The click test uses the detect**: a probe
    measured every point over SD1 and SD2 covered by the address latches'
    ADL/ABL cone beads, which outrank them and correctly so (that cone reads
    these latches). The cards read each latch's level off the chip and name
    what it feeds.

- **The ready logic is a container per stage: the receiver, the master, the
  copies.** `ready-logic.js` (a leaf). Ready had turned up as a read at the
  boundary of nearly every container before it; this is the wire itself.
  `in` (4: `#944`, `pipeUNK37`, `#198` and the precharge `#424`) is the
  master's backward cone with the copies excluded, home the static logic,
  the control pipeline and the timing chain: **the pads are outside the
  home**, so the pin's latch `#1449` and the write control's `#759` land in
  `reads` (the first draft had Pads in the home and swallowed the whole
  write control through `#759`). That `#944` NORs the pin with `#759` is
  the famous rule in one gate: **a low RDY never stalls a write cycle**.
  `master` is `notRdy0` alone, one dynamic node, active low, read by **35**
  consumers. `copies` (8) are the five `cp1` channel partners and the
  `cclk` delay chain: ready on the other phase and a cycle late. Copies are
  built **before** the receiver's cone, which sees them as back-channel
  neighbours of the master and would otherwise claim them.
  - **The harness stalls the chip for real**: `setRdy(false)` on its own
    chip raises `notRdy0`, the T-state holds for twelve half-cycles, and
    `setRdy(true)` moves on. That is the wire doing the thing its whole
    fan-out exists for, driven from the pin rather than asserted.
  - Kind `rdy`, ids `in master copies`; `?rdy=master`, `?ready=0`; priority
    after the store pipeline. The receiver's card reads the pin, the
    master's says stalled or ready off the chip, the copies' names what
    they feed. Twenty-second container kind.

- **The last three: the PC's own storage, the pipeline latch file, and the
  SYNC generator**, in one leaf, `pc-pipe-sync.js`, with one generic
  `makeKind()` helper in `tracer.js` (list, regions, draw, hit test) since
  the per-kind boilerplate had become the same page three times over.
  - **PC storage** (kind `pcr`): the counter pair `pcl`/`pch` is sixteen
    pure bits (no gate drives them), the prime pair `pclp`/`pchp` sixteen
    inverters of the incrementer's outputs; six line cones: `PCLPCL` 8,
    `ADLPCL` 4, `PCLADL` 5, `PCHPCH` 6, `ADHPCH` 4, `PCHADH` 7. **The high
    pair's cones read `#862` (the hidden T1) and `nnT2BR`**: a taken branch
    reloads PCH a cycle after PCL. `?pc=pclp`, `?pcreg=0`.
  - **The pipe latch file** (kind `pipe`): every node the die names `pipe*`
    is a latch under `cclk`, all 52, and that uniformity is the finding: the
    file where the decoder's phase-1 answers are re-timed onto phase 2. Two
    groups, 15 named, 37 `pipeUNK`. `?pipes=unk`, `?pipes=0` off.
  - **The SYNC generator** (kind `sync`): four nodes (the push-pull pad,
    `#417`/`#317`, the inverter `#445`) reading **exactly one wire**,
    `#862`: SYNC is the hidden T1, inverted twice and sent off chip. The
    harness pins the four and the one, and checks the pad against the
    chip's own `sync()` over 200 half-cycles, 200 of 200. `?syncgen=1`.
  - Priority after ready, before the control clusters, **drawn above the
    incrementer** they outrank (z-order = click priority, again). Adding
    three kinds at once moved older click spots under new beads twice: the
    exclusion lists in `_tracer-test.html` now include the register beads
    and the three new classes wherever a lower kind hunts for ground.

## The chip map (`chipmap.html`, `chipmap.js`, `chip-groups.js`)

The whole chip as one schematic: every derived container a box, the wiring
between them bundled, the layout derived. Asked for as the final act once the
clustering arc was complete: a schematic of 1160 gates would need a layout
somebody chose, and at the container level it stops being true.

- **`chip-groups.js` is the partition, and it is the tracer's containers made
  disjoint.** The same leaf modules, applied in the tracer's own click order,
  the first container to reach a node keeping it; the registers' global
  sharing rule kept as is. One stated exception: **the control-line clusters
  move to the end of the containers.** The tracer ranks them high because its
  priority is about what a click should hit and a control outline is small on
  screen; ownership is about which claim is more specific, and "the lines no
  derivation explains, grouped by what they operate" is a catch-all. Left
  where the tracer has it, it took `dpc18_#DAA` and `dpc22_#DSA` away from
  the decimal correction's own walk, which the harness caught. Moved last it
  comes out **empty**, and that is a finding rather than dead code: once
  every derivation has claimed its own lines, no block has two unexplained
  control lines left to cluster. What no container claims groups by the
  block it is filed in, and the static logic by `nodeDrives`. Measured:
  **132 groups over 23 kinds, covering all 1547 nodes exactly once** (the
  universe is every node the netlist touches, rails out). The order decides real things and the page's prose names them: the
  pipe latch file outranks the chain (the `pipeTnout` latches file with the
  file, the chain keeps its combinational cells); the address latches outrank
  the store pipeline (SD1 files with the `ADL/ABL` cone that reads it).
- **Both layout axes are measurements.** A column is the median, over a
  group's nodes, of each node's BFS distance from the input and bidirectional
  pins (gate inputs to outputs, both ways through a switch channel: the pin
  chains' neighbour rules). 15 columns; the two inert structures the pins
  never reach are the last, stated in the caption. Within a column, order is
  the median die Y from `layout.bin`. The harness recomputes every group's
  column and every bundle's counts from the raw arrays and compares.
- **A line is a bundle and nothing is thresholded away**: 534 bundles carrying
  1644 gate edges and 310 switches between groups (922 and 313 stay inside
  one; the caption counts both). Switch bundles brighter, as everywhere. A
  one-edge bundle is simply faint (`--bw` sets opacity by weight, via the
  CSSOM).
- **Live off the running chip**: a box fills with the share of members high
  (`--hi` via `style.setProperty`), rings when a member changed; a switch
  bundle brightens while a control holds it open, a gate bundle flashes when
  an output moved. Header transport and picker, the block pages' exact
  arrangement, repaint on the action.
- **Clicking a box is the walk**: the card lists the heaviest bundles as pills
  that select the far end, reads a byte where the group's id is a stem with
  eight named bits, and links to the same container on the tracer
  (`tracer?chain=T3` and so on), where the identical node set sits at its die
  positions. `?sel=kind:id` deep-links. The camera is the die graph's:
  a viewBox, wheel, drag, one `pinchOf`.
- **The pins groups are the measured directions less the pads a container
  already names**: the sync pad is the SYNC generator's, the clock outputs
  the clock generator's, `rw` the read/write control's. The harness asserts
  the subtraction lands only in those containers, never loses a pad.
- **`.statbar` takes plain strings**; b/span pairs run together there, which
  bit this page first and was already documented against.
- The hero types no counts: the statbar and caption carry the numbers, filled
  from the derivation, so the prose cannot go stale when a derivation moves.
- **The boxes open into node grids, and a square is a switch-holder.** The
  default view (`?nodes=0` folds it, the Nodes button toggles) draws every
  member of every container snapped to a grid inside its box: 1547 glyphs, a
  square for the 183 nodes that hold at least one switch (filled while its
  switches conduct, empty while they are open circuit) and a dot for the
  rest, lit while high and ringed when it changed at the last half-cycle.
  The order on the grid is stated: a name carrying a bit index sorts by stem
  then bit, so a byte reads left to right from bit 0; other names follow
  alphabetically; the unnamed come last in die order. Clicking a glyph
  selects its group and names the node on the card, with what its switches
  are doing right now. Box heights grow to hold the grid, so the layout is
  rebuilt on toggle (`rebuild()`); glyph state updates are delta-only, the
  tracer's arrangement. The harness re-derives the square set from
  `sch.switches`, asserts the glyphs are exactly the universe, checks the
  snap arithmetic and the a0..a7 order, compares a sampled square and dot
  against its own chip, and pins that the ringed glyphs are exactly the
  changed nodes after one paired step.
- **The boxes drag, and the reader's arrangement is theirs.** A drag that
  starts on a box moves the box (empty ground still pans, the click slop
  still selects); the offset snaps to the node grid's own cell on release,
  every bundle it anchors follows live, and the arrangement persists under
  `v6502.chipmap.layout`. **Tidy** gives the derived layout back in one press
  and forgets it. The page's prose says the split out loud: the derived
  layout stays the page's claim, a moved box is the reader's. The harness
  drives a real pointer drag, checks the snap arithmetic and the bundle
  endpoints, reloads to see it kept, and clears the key first because a
  persisted arrangement is a hidden input to every assertion after it.
  - **Save and Load move the arrangement as a file**: one object, a container
    key to its `[dx, dy]` in drawing units, nothing else (`layoutJSON()`, the
    same shape as the localStorage key). Load validates rather than trusts: an
    unknown key or a malformed offset is skipped and counted in the note
    beside the buttons, an offset is snapped to the cell, and a file that is
    not a layout applies nothing and says so. The harness loads through the
    REAL file input via a `DataTransfer`, because a load path tested by
    calling the function would never notice the input unwired; it saves a
    dragged arrangement, tidies, loads it back with two junk entries mixed
    in, and asserts the box returns to the saved offset with exactly the junk
    skipped. Both buttons ride into the View drawer in fullscreen.
  - **Scramble and Optimize are the arrangement as physics.** Scramble throws
    every box somewhere else through a SEEDED PRNG (mulberry32 from 0x6502),
    so a fresh page's first throw is always the same throw, and the harness
    holds the prose to that. Optimize is Fruchterman-Reingold over the boxes:
    every pair repels (backed off by the boxes' own radii), every bundle
    pulls its ends together scaled by `sqrt(weight/maxWeight)`, the step
    cools by 1.5% a step for 400 steps, clamped to the canvas, snapped and
    saved on settle. **It runs in setTimeout chunks, not animation frames**,
    both so the untangling is watchable and so it still runs in an iframe,
    where the harness lives. The measured claim is the STRETCH (the sum over
    bundles of weight times centre distance), reported before and after in
    the note; typical: a scramble at ~2300k settles near ~800k. The harness
    recomputes the stretch itself from the transforms and asserts the settle
    beat the scramble, everything snapped and finite, Tidy still restoring.
    A pointerdown on a box stops the optimizer: the reader's hand wins.
    - **The run is unwalled, and the walls were measured to cost energy**:
      clamped to the canvas the same seed settled at ~990k, free it settles
      near ~800k. Pairwise forces are equal and opposite, so the centroid
      stays put on its own; the camera follows the cloud each chunk and Fit
      frames the content (`contentBox()`), wherever it went, negative
      coordinates included: the harness assertion written for the walled
      world required `cx > 0` and failed on correct behaviour.
    - **One weak force remains, and it is load-bearing: gravity toward the
      cloud's own centroid**, proportional to distance. A container with no
      bundles at all feels pure repulsion and accelerates away for as long
      as the cooling lets it; measured before the gravity existed, one
      reached 31,000 units out. Wired boxes get 0.08 of it; a bundleless box
      has only gravity to answer to and gets 0.6. The harness pins the free
      cloud under 6000 units across, an order of magnitude inside the bug.
    - **Boxes never settle overlapping.** One light separation pass per
      iteration keeps the core honest while the springs work; the settle
      relaxes intersecting pairs apart along the smaller penetration axis
      until none remain, with a clearance one unit wider than the snap can
      steal back, so a settled arrangement can touch but never stack. The
      separation runs ONLY when the optimizer was actually running: a reader
      grabbing a box in their own overlapping arrangement must not have the
      neighbours shoved aside by the grab.
    - **The page carries a key and a solved-ness section** (`#colours`,
      `#solved`): the key is drawn with the drawing's own classes so it
      cannot drift, its sample values live in `.cm-key`-scoped CSS because an
      inline `style=` attribute is exactly what the live CSP refuses, and the
      harness asserts both. **The key's samples share the drawing's classes
      on purpose, so every harness query about the drawing is scoped to
      `#cm-svg`**: unscoped, the box count came back 134 for 132 groups,
      which is the schematic key's own documented trap replayed.
    - **The force balance was tuned against measurements, not taste**: with
      the attraction floor at 0.15 the crowd pressure of 132 mutually
      repelling boxes stretched the weakly-wired tail to ~8000 units; the
      floor is 0.35 and the whole attraction 2.5x, which rounds the cloud
      and beats the walled stretch at the same time.
  - **A fixed sleep after a file-input change is a flake under a virtual-time
    budget**: `file.text()` resolves on real IO, and virtual time
    fast-forwards straight past a `sleep(200)`. One green run, then one red.
    Poll for the note the action writes instead.
- **Fullscreen is the workbench's study view, floating console included**,
  from the same two shared modules as the tracer (`fullscreen.js`,
  `solo-palette.js`), so a phone gets the same fallback and Escape leaves the
  same way. Three drawers that BORROW the page's own elements (the card; the
  tour's start button and panel; the view controls: Nodes, Tidy, Fit, zoom),
  the transport on the strip driving the one store, the clock select and the
  half-cycle readout in the drawer head, configuration under
  `v6502.chipmap.console`. `?full=1` clicks the button rather than calling
  the API. Borrowed into a drawer, the tour's two-column grid collapses to
  one (`.sp-panel .cmt-cols`).
- **The tour: one instruction, container by container** (`chipmap-tour.js`,
  the button on the map's own console bar, `?tour=adc&tstep=N`). ADC, because
  it is the site's star witness. The authored half is its own file and
  labelled, written from `_tour-probe.html`'s per-half-cycle dump of the
  tour's exact program; every claim rides beside a check function the page
  evaluates live on the running chip (`readerOf`, shared with the harness so
  a claim cannot mean two things), and the moved list under the prose is the
  change set grouped by the partition, measured per edge. The measured story:
  the opcode lands and `op-T0-adc/sbc` fires at +2; the operands load under
  `DBADD`/`SBADD` at +4 with `op-T+-adc/sbc` high while sync is already high
  for the next fetch; **at +5 the adder holds `$42` and A still reads `$40`**
  (the subject is `regs:a`, so the card's byte is the accumulator's own
  storage saying so); at +6 `SBAC` writes it back while IR already holds the
  JMP.
  - **It takes over the chip the way the Lab does**: replaces the program,
    power-cycles, runs to the instruction's own fetch found by `sync` and the
    assembler's label, and never starts on its own. Leaving reloads the
    site's program and puts the camera home. Choosing a program leaves the
    tour.
  - **Every landing shows what the last half-cycle changed**: `tourGoTo` runs
    to N-1, snapshots, steps once, paints, which is the tracer's `?step=`
    rule; without it the first paint said "nothing moved at this edge".
  - **The panel reads the machine, never counts its own clicks**, so the
    header transport keeps working during the tour: an offset between
    authored steps says "off the path" and Back/Next rejoin. The harness had
    to step the header TWICE to leave the path, because from +5 one
    half-cycle lands on +6, which is authored.
  - Each step selects its subject group and frames it with its heaviest
    partners (`frameGroups`, capped and held to the home aspect).
- `_chipmap-test.html`: the partition complete and disjoint against its own
  universe, the ownership joints by name, stages and pins re-derived in full,
  every bundle recounted, every column recomputed, boxes non-intersecting,
  the live fill against a chip of its own, click, pill walk, clear, deep
  link. `_csp-test` covers `chipmap` and its `?sel=` deep link.
