# The Schematic workbench and the functional block pages

Gate recognition from the switch network, the study view, and one page per block. Split out of `CLAUDE.md`.

## The Schematic (`schematic.html`, `schematic.js`, `schematic.rs`)

The chip as a circuit. Pick any named signal, see the gates that make it, walk
backwards. Every symbol is recognised from the switch network; nothing is drawn
by hand.

**NMOS builds logic exactly one way, and that is the whole recognition rule.** A
pullup holds a node high, a pulldown network to vss can beat it, so the output
is low when the network conducts — every static gate is an inverted sum of
products. Parallel transistors are the ORs, series are the ANDs. There is no AND
gate and no OR gate anywhere on this die. Result: 534 inverters, 354 NORs (2–9
inputs), 39 NANDs, 91 AOI, and **exactly one node that fails to resolve** (a
series chain three deep).

- **Keying on pullups alone misses the interesting half.** `dpc3_SBX`,
  `dpc23_SBAC` and `sync` have no pullup flag, so the first version rendered
  every control line as a dead end. They are **precharged**: a clocked
  transistor pulls them to vcc and the pulldown network discharges them or
  leaves them holding charge. 142 nodes work this way — the same dynamic storage
  the engine models as `ChargedHigh`, and the reason the 6502 has a *minimum*
  clock. The PLA's product terms, by contrast, really are static.
- **A switch's control line rides on the edge and is never expanded.** `cclk`
  gates 273 transistors; following controls pulls the whole clock tree in within
  two levels and buries the signal that was asked about. A gate's *inputs* are
  expanded, and must be — they are the circuit. A test asserting "no control
  line is ever a node" conflates the two and fails on correct behaviour.
- **A node with fan-out is a signal, never a gate's internal junction.** Two
  switches in a row really do pull an output down, so a chain reads as one gate
  with a series leg — electrically true wherever it fires, and the wrong reading
  unless the middle node is a junction. `alua` sits between `sb` and ground
  (`SBADD` in, `0ADD` down), was read as a series leg of `sb`, and had both its
  transistors swallowed: the ALU's A input rendered with **no circuit at all**.
  Found by clicking through islands and hitting a dead end, not by a test.
  Requiring the middle node to gate nothing fixed it — and removed the last of
  the shared pulldowns, which were the same artefact.
- **Count absorbed transistors as a set.** It mattered when gates could share a
  pulldown: the sum came to 3517 against a die of 3510. They no longer can, and
  the set count stays because a total larger than the chip is the cheapest way
  to notice a recurrence.
- **The drawing must contain everything the caption counts.** Switches whose far
  side is a power rail were silently skipped while the caption went on reporting
  five of them — a convincing circuit with pieces missing.
  `_schematic-test.html` compares the caption against the DOM for exactly this.

**A shader that compiles headlessly can still be invalid.** `packed` is a
reserved word in GLSL ES. SwiftShader accepted it, so the exploded view's vertex
shader shipped and failed on real hardware with *"illegal use of a reserved
word"* — every headless check green, the page blank on a real GPU. This is the
same shape as the pinch NaN: a class of bug the software rasteriser cannot
report. `_exploded-test.html` now scans every `#version 300 es` string in
`exploded-gl.js` and `renderer.js` for reserved words, because a driver cannot
be relied on to do it here. Verified by reintroducing the bug and watching that
one assertion go red.

Related trap, hit while fixing it: **a shader lives inside a JS template
literal, so a backtick in a GLSL comment ends the string.** Writing `` `packed` ``
in the explanatory comment broke the module outright.

- **Every drawn thing has a box, and placement asks whether the box is free.**
  The first version spaced columns by a constant and put each element at the
  mean of its inputs' rows, which piles a dozen switches on one spot whenever
  their inputs share a row -- `sb0` has forty switches on it. Columns are now as
  wide as their widest label, and elements are pushed apart within their column
  and re-centred so the group does not drift. `_schematic-test.html` measures
  the rendered boxes with `getBBox` and asserts no two intersect, on a compact
  cone and on a dense one.
- **The shift into positive space is baked into the coordinates**, not applied
  as a wrapper `transform`. A transform would leave the raw `y` values negative
  while looking correct, and the harness checks those to catch labels drawn
  outside the viewBox.
- **The archive's nav links out to `/schematic`.** `shell.header()` prefixes
  every href with the caller's `root` (`../` from a wiki page), so absolute
  hrefs are exempted -- otherwise the link resolves differently depending on how
  deep the page is.

### Fullscreen is the study view

Fullscreen on this page is **not the page with its chrome hidden**. It is a
workbench: the same view the page was showing, with everything else gone and room
to walk. Clicking a signal follows it, which is the whole activity.

**It arrives showing what the page was showing** — same signal, same depth, same
direction. It used to drop to a single level on the way in and put the reader's
depth back on the way out, which made sense when the mode showed one cone with
nothing else on screen. It is a bench now, and arriving to *less* than the page
was already showing is a jolt with nothing to recommend it. The depth control
comes along too, in the Walk drawer, because the page's own slider is out of
sight in this mode and a setting you can see but not change is worse than one you
cannot see.

- `setDepth()` is the only place depth changes and `paintDepth()` the only place
  it is displayed, so the page's slider and the study view's own cannot disagree
  about it.
- **Centring is `viewBox` plus `width/height: 100%`** and nothing else —
  `preserveAspectRatio` scales and centres for free. No code measures anything.
- **The stage is two levels down** (`.console > #sch-main > .sch-stage`), so
  growing it needs the middle element to grow too. Without that the stage
  collapses to its content and the drawing sits at the top of an empty screen —
  which looked centred on a desktop only because the drawing filled the width,
  and was obvious the moment it was seen on a phone.
- **The walk runs both ways.** Backward asks what produces a value (the gate
  driving it, the wires a switch could bring to it); forward asks what it
  changes (the gates it feeds, the switches it opens). Pass transistors appear
  in both, deliberately — a pass transistor conducts both ways, and the parts
  that have a direction are the gate and the control line.
  - **Forward mirrors the layout** rather than reusing it. Causality has to read
    the same way round in both, so the anchored end holds the subject and the
    rest grows away from it: every x is negated and the pills anchor from the
    other edge. Pill geometry is stored per node (`boxL`, `boxR`, `wireIn`,
    `wireOut`) rather than recomputed at each use, so the two ends cannot
    disagree about which edge is which.
  - **Fan-out is capped at 16, and the cap is stated in the caption.** The
    median forward fan-out is 1 and only 19 of 707 signals exceed 20 — but
    `cclk` opens 273 switches. Showing sixteen of those silently would be a
    claim about the chip rather than a limit of the page.
- **The walk stays on the bench, as one drawing.** Following a signal extends
  what is drawn rather than replacing it — but the steps are **merged**, not laid
  out side by side. Each step is a cone and the cones overlap, so drawing each
  one separately put a second copy of every shared signal on the bench, which is
  worse than either alternative: tracing a value, a reader found two `#844`s and
  no way to tell which was which. `merge()` unions them and every node is drawn
  exactly once.
  - **A node's column is where it first appeared**, measured from the signal the
    walk began on. That is what keeps the arrangement stable as it grows —
    columns mean "how far back from where I started", they are assigned once, and
    a later step reaching an already-placed signal joins to it where it is rather
    than moving it. It also survives **feedback**, which a strict topological
    layering would not, and this chip is full of it.
  - **A switch reached from its far side is the same transistor**, so elements
    are keyed by the pair they join rather than by which end was expanded first.
    Without that, walking both ends of a pass transistor drew it twice.
  - **Columns are ordered by the average row of what they connect to** in the
    column before. One merged drawing has far more wires to cross than a single
    cone ever did, and insertion order crossed them for no reason.
  - **`_solo-test.html` asserts no signal is drawn twice, and proves the check
    can tell** by cloning a pill and watching the assertion fire. An invariant
    nothing could violate is not an invariant.
  - **The study view's coordinate space is fixed** (`WORKBENCH`, 1200x800) and
    only the camera moves in it. The drawing reflows as it grows — that is what
    merging means — but the space it grows in does not, so a redraw cannot move
    the world under the camera.
  - **Adding a step does not re-frame.** It never rescales, and it pans only when
    it has to: `ensureVisible()` nudges the signal just walked to into view by
    the least it can. The initial framing is capped at 2× (`MAX_FIT`), or a
    four-signal cone fills the screen with one hand-sized inverter.
  - **A pill is the readout for zoom.** Every pill is a constant 22 units tall,
    so its height on screen *is* the effective scale, which is what the harness
    measures rather than reasoning about the transform.
  - **`0` fits the whole walk**, and therefore no longer means k = 1 — with a
    fixed bench it can even magnify. `MIN_K` had to drop from 0.4 to 0.05.
  - **The card marks the subject**, not a region. There are no islands to shade
    any more; that was the price of the duplicates.
  - **The bench is dotted, and the dots are inside the camera group.** Zoom is
    invisible on an empty field: a circuit drawn twice as large on black looks
    like a circuit, not like a closer one. Two grids an order of magnitude apart
    (40 and 200 units) mean one of them is always at a useful density.
  - **The camera listens on the stage, not on the drawing.** An `<svg>` only
    hit-tests where it has been painted, and a bench is mostly empty space — so a
    finger landing between two parts of the drawing reached nothing and the pinch
    never started, which on a phone is most pinches. `touch-action: none` had to
    move with it.
  - Flipping direction or changing depth starts the walk again: both axes of the
    layout mirror. Going *back* to a signal still on the walk truncates to it
    instead — un-walking, which is what back means here.
- **The study view has its own clock**, because the point of pinning to one
  island is watching an edge happen on it. Back / run / step plus arrow keys and
  space, with a readout of half-cycle, phase, T-state and `sync`.
  - **Running is paced in wall-clock time, not in frames.** The page loop does
    eight half-cycles per animation frame — about 480/s, which is fine for
    watching a die light up and useless for watching six wires change. The study
    view runs at 4/s.
  - **A discrete step applies immediately rather than waiting for a frame.**
    That is a real responsiveness bug on its own, and it is invisible until the
    page is driven somewhere animation frames are throttled — which is exactly
    what an iframe does, and how it was found.
  - Rewind is keyframed and bounded, so the earliest reachable half-cycle is not
    necessarily zero. A refusal at the start of history is normal.
- **The walk has a history, and `{root, dir, depth}` is all of it.** That triple
  is also the whole deep link, so an entry in the stack *is* a URL. `[` and `]`
  go back and forward; the arrows belong to the clock. Two things are
  deliberately not recorded, both via `withoutHistory()`: restoring an entry,
  and fullscreen forcing depth to 1. Neither is somewhere the reader chose to
  go. Consecutive depth changes coalesce, because the slider fires once per
  integer and a drag from 3 to 6 is one navigation.
- **The camera rides on a wrapper group, not on the viewBox.** `viewBox` plus
  `width/height: 100%` is what centres the drawing, and rewriting it to zoom
  would fight that; a transform on a `<g>` leaves `preserveAspectRatio` alone
  and keeps `getScreenCTM()` a correct screen-to-drawing map. `touch-action:
  none` is scoped to `.solo` — on the page proper the drawing sits in a
  scrolling stage, and claiming the touch stream there stops a phone scrolling
  the page at all.
  - **"Did the scale go up" is not a test of a pinch.** Injecting the explorer's
    exact bug — pinch state written with one spelling and read with another —
    leaves the zoom working, because `new DOMPoint(undefined, undefined)` is
    `(0, 0)` and not NaN: the gesture anchors on the corner of the screen and
    still scales by the right ratio. The assertion that fails is that the
    drawing point under the fingers is still under the fingers.
  - A drag that ends on a signal pans rather than selecting it (slop 12px touch,
    4px mouse), and that is asserted too — without it, every touch on a pill
    re-roots.

### The console, and what it found

The study view's controls are **one draggable panel**, not three clusters nailed
to three corners. On a screen whose entire content is one drawing the controls
are the only thing that can be in the way, and *where* they are in the way
depends on the drawing — which changes with every signal followed.

**The mechanics live in `solo-palette.js`, shared with the tracer** since the
tracer wanted the same console: `createPalette()` owns the drag, the clamp,
the drawer and the tab, and reports every change through `onChange` so each
page saves its own configuration under its own key (the schematic's carries the
walk beside it). The page keeps only its panels and `pal`, the one holder of
where the console is. The extraction was verified by `_solo-test.html`,
`_persist-test.html` and `_ports-test.html` passing unchanged, which is the
only thing that makes a refactor of a live page defensible. Everything below
about how the console behaves still holds; it is just written once now.

It is a **vertical strip of icons** with a **drawer** beside it. The strip is
what remains when the drawer is shut, so what lives on it is what has to survive
that: the five drawers (**Signal**, **Walk**, **I/O**, **Memory**, **Stack**),
the transport, and the way out. Pressing the icon that is already open shuts the
drawer, which is the only way back to a bench with nothing on it. Everything
else — the clock, history, fit — rides in the drawer's header.

- **Direction is in the Walk drawer, not on the strip**, because "what makes it"
  and "what it drives" is a labelled choice; any arrow glyph for it would be a
  guess, and the one that fits best (`⇄`) already means I/O.

- **Each panel is built once and painted every frame**, and the split is
  load-bearing: rebuilding the markup per frame would blow away the address field
  the reader is typing into. Every painter also compares what it is about to
  write against what is there, so a stopped chip does no DOM work.
- **Its controls repaint on the action, not on the next frame** — the same
  responsiveness bug the clock already had, and invisible until the page is
  driven somewhere frames are throttled.
- **The whole configuration is saved and restored** — where the console was put,
  which drawer was open, and the walk that was on the bench. That is not a
  convenience: a tablet's own gesture can drop the reader out of fullscreen
  without asking, and the browser owns that gesture, so it cannot be prevented
  from here. Making it *cost nothing* is the available answer.
  - **The saved walk is only reinstated when it ends where the reader now is.**
    A deep link, or any other subject, wins — restoring somebody else's islands
    around a signal that was asked for by name would be the page overruling the
    URL. It is stored with the direction it was drawn in, because the layout
    mirrors.
  - **The configuration is read once up front, and nothing is written while the
    mode is switching.** Both halves cost a round.
    - Reading late finds what the first render just wrote: rendering happens
      before the console is opened, so the default tab overwrote the saved one a
      moment before it was wanted.
    - Writing during the switch is worse, and is what a reader hit on a tablet.
      *Leaving* restores the reader's depth; `setDepth` starts the walk again
      because every column changes size; and it does that while `state.solo` is
      still true — so the render it triggered **saved a one-step walk over the
      saved one on the way out**. The walk was gone before anyone came back for
      it. `saveConfig()` now refuses while `state.quiet` is raised.
    - The harness could not have caught it: every check in `_persist-test.html`
      began with a fresh page load, so nothing ever *left* the study view. It now
      goes out and back in without a reload, which is the path every reader
      actually takes.
  - **`_solo-test.html` clears the key before it starts.** A persisted setting is
    a hidden input to every assertion after it, which is why the tab and the
    drawer were deliberately *not* saved when the console was first built. Saving
    them is what the reader asked for; the harness had to become deterministic
    instead.
- **A drag that starts on a strip button is still a drag.** Refusing to move when
  the press landed on a control made a 2.5rem-wide panel hard to grab, and had a
  worse consequence: the press still reached the button, so dragging from the
  exit icon left the study view on release. Anything on the strip drags now, and
  a press that turned into a drag has its click swallowed in the capture phase.
  - **The suppression must not latch.** A drag ending off a button produces no
    click at all, so a flag left raised eats the *next* real press. It is cleared
    on a zero timeout after release — late enough for the click it was raised
    for, early enough for everything else.
- **The immersive surface claims the touch stream as a whole**, not just the
  drawing, and `overscroll-behavior: contain` stops the drawer's own scrolling
  from chaining out to the document at its end.
- **On a touch device the fallback fullscreen is used deliberately, in
  preference to the real one.** iPadOS dismisses a fullscreen element on a
  downward swipe — the gesture it uses for video — and a reader panning a drawing
  performs that by accident several times a minute. No page can prevent it: the
  gesture belongs to the browser. The fallback has none, being only a fixed
  element that covers the viewport, so `fullscreen.js` skips the API when
  `(pointer: coarse)` or `(hover: none)` matches. The cost is the browser's own
  chrome staying on screen, which is the smaller loss. `_solo-test.html` drives
  both branches with `matchMedia` stubbed and a spy on `requestFullscreen`.
  - The spy has to go **on the element**, not on the prototype: that harness sets
    `con.requestFullscreen = undefined` at the top to force the fallback, and an
    own property shadows anything installed on the prototype later.
- **Position is clamped against the stage and re-clamped on resize and whenever
  the drawer opens or shuts.** A panel dragged to the bottom of a tall window and reopened on a
  phone would otherwise be gone with no way back but clearing storage. Position
  persists; the tab and the collapsed state deliberately do not, because a
  persisted UI state is a hidden input to every later assertion.
- Dragging watches the window rather than capturing the pointer, for the same
  reason the camera does: `setPointerCapture` retargets the click, and the
  buttons in the grip are the ones that leave the mode.

**Adding a memory readout found a bug three pages old.** `schematic.js` and
`exploded.js` loaded a program at `$0200` and never pointed the reset vector at
it, so both chips reset to `$0000`, read `$00` — a `BRK` — and ran a BRK loop
against themselves forever, climbing down the stack. Every gate lit up
convincingly the whole time. Nothing on either page could have said otherwise
until something showed what the chip was *reading*. `app.js`, `lab.js`,
`trace.js` and `blueprint.js` all set it; those two were the omission.

Two things the panels are careful not to claim:

- **The stack panel reports no depth.** `$FF - S` looks like the number of bytes
  on the stack and is an assumption: the 6502 does not reset its stack pointer —
  reset decrements it by three and nothing else — so out of a power-on S holds
  whatever its storage nodes came up as. The panel shows S, where a push goes,
  where a pull comes from, and the bytes above it in pull order. It also lists
  **top first**, because the stack grows downward and listing from `$01FF` down
  reads as a stack upside down (which is how it was written first).
- **The pin buttons show the level, not an interpretation of it.** Four of the
  five are active low, so 0 means asserted — but `so` comes out of reset *low*
  (`Cpu::reset` drives it there, as the reference does), and a button calling
  that "asserted" would be reporting a polarity it assumed in place of a level it
  measured.

- **The pin test runs last in `_solo-test.html`, and that is not tidiness.**
  Pulling IRQ low with no handler installed vectors through `$FFFE` to `$0000`,
  which is a `BRK`, which vectors to itself — so the chip ends the test climbing
  down the stack forever. That is the silicon being right, and it wrecks every
  assertion about memory or the stack made after it. The BRK loop is then used as
  the evidence that the button reached the silicon rather than only the DOM.
- **`_solo-shot.html` exists because fullscreen needs a click.** There is no deep
  link into the study view, so without a harness that enters it and walks a few
  signals, the one mode most likely to be wrong is the one that cannot be
  photographed headlessly.

- **`_solo-test.html` drives the real page in an iframe**, deliberately. A
  hand-written stub was tried first and failed on its own inaccuracy: it nested
  `.console-bar` inside `#sch-main`, where the page has it as a direct child, so
  a `>` selector that works in production did not match in the test. The
  iframe rule is about animation frames, and the layout assertions do not depend
  on one — but the clock assertions did, and failed until the page was made to
  update on the action instead of on the next frame. The rule is real; the
  exemption has to be argued per assertion, not per file.
- **`_schematic-test.html` no longer carries a copy of the markup.** Its stub
  drifted from the page six times — each time the page gained an element, `boot`
  threw there first, and the fix was to hand-copy the element across. It now
  lifts `#sch-stats` and `.console` out of `schematic.html` at load and imports
  the module dynamically afterwards, so it cannot drift again. What is left is
  the reason the stub existed: this harness needs the elements at *top level*,
  because it measures geometry with `getBBox`.

### Pinning the chip's I/O, and colouring by block

Two additions that answer "where does this wire sit in the chip", from opposite
ends: one shows how far it is from the outside world, the other which part of
the die it belongs to.

**The pin chain is a search, not a deeper cone, and the measurement is why.**
Measured over `schematic.json`, the median named signal is **eight** hops from
the nearest pin, p90 is ten, and the depth control stops at six. Pins drawn by
growing the cone would therefore sit disconnected on almost every walk — a rail
of pills wired to nothing, which is decoration. `pinChain()` runs a
breadth-first search under exactly `cone()`'s neighbour rules instead, and the
pin lands at a column the walk cannot reach on its own and stays there. Anything
the walk later discovers between the two lands in the columns between them,
which is the point: the ends are fixed and the middle fills in.

- **`null` is an answer, not a gap.** Every named signal reaches an input pin
  going backward — all 705. But **97 of 705 never reach an output pin forward**,
  `dpc3_SBX` among them, and that is correct: a control line's forward reach
  ends at the switches it opens, because opening a switch is not driving a value
  through it. The caption says "no path to a chip output from here" rather than
  drawing nothing, which would read as a broken feature.
- **The pad ring is written out rather than taken from the `Pads & I/O` block.**
  That block is a *region of the die* and holds the drivers and receivers too;
  what is wanted is the twenty-eight places the chip meets the outside world.
  `db0-7` is in both lists because it genuinely is both.
- **Off by default**, and persisted with the rest of the console configuration.
  It adds eight or so elements, which is a lot to arrive to uninvited.
  `setPinIO()` is the only place it changes and `paintPinIO()` the only place it
  is shown — two checkboxes, the same arrangement depth already has. It does
  *not* reset the walk: the pin is an anchor added to what is on the bench, not
  a change to how big each step is.
- **The bug it shipped with is the instructive part.** The search seeded its
  parent map with `null` for the root, then dereferenced it while reconstructing
  the path — one iteration *after* the last useful one. So it threw only when a
  chain was actually found, the exception escaped `render()`, and the page went
  on showing the **previous drawing**. That reads as "the toggle does nothing",
  not as a crash, and it is the third time this project has been bitten by a
  throw inside a refresh leaving plausible stale output on screen.

**`_pinio-test.html` re-runs the search itself**, straight out of
`schematic.json`, and compares hop counts with what the page reports. Asserting
only "a pin appeared" would pass on a chain that wandered through the clock tree
and came back; an independent search is what makes the drawing a measurement.
All seven cases agree — `idb0` 5, `sb0` 6, `a0` 7, `pcl0` 6, `abl0` 2 forward,
and `dpc3_SBX` unreachable. Verified by reintroducing the null seed and watching
it go red.

- **The witness for a stale render is the caption, not the node count.** A short
  chain can already be on the bench — `abl0` reaches `ab0` in two hops, both
  already drawn — so requiring the drawing to grow reports a working case as a
  failure. It did, first time out.
- **Scope diagram queries to `#sch-svg`.** The key draws its sample symbols with
  the same `.sch-node` class and no block of their own, so an unscoped
  `querySelectorAll` counts them and the region key looks short by exactly one.

**The block colour follows the exploded view, from one file.** `BLOCK_COLOR`
moved out of `exploded-gl.js` into `block-palette.js`, because the schematic
draws the same blocks in SVG and cannot import a WebGL renderer to find out what
colour they are — and a second copy would drift, leaving two pages disagreeing
about what colour the ALU is.

- **It is a CSS custom property, not a `stroke`.** An inline stroke would
  outrank the `.root` and `:hover` rules and quietly kill both.
- **The key lists only the blocks on screen.** A fixed list of thirteen would be
  mostly irrelevant on any given walk, and a key you have to search is not a key.
- Membership is `blocks.rs`'s measurement — the same answer the signal panel
  reports as its region. The hue is only a second way of saying it, so the key
  is not tagged `measured`: the colour is presentation, the block is not.
- `exploded-gl.js` names the palette's path **once**, and the comment says why:
  `build-web.py` rewrites it with `replace_once`, whose entire value is failing
  when there is more than one.

### The address, on the drawing

The panel carries an **Address** row, `<container>:<class>:<slot>`, which is
`docs/atlas.md`'s rubric applied to whatever is selected. It is the answer to
the thing the drawing could not previously say: an unnamed node was `#602` and
nothing else, and it is now `regs:x.XSB:inv:#602` -- an inverter in the X
register's XSB load line.

- **The class and the slot are free; the container is not.** Both come out of
  `schematic.json`, which is already loaded, so they are on the first paint.
  The container needs `groups.json` (320 KB, 48 KB gzipped), fetched **in the
  background after the page is up** and applied in place when it lands. If it
  never lands the row shows the class and the slot and says the container is
  still loading, because a partial address that says so beats a spinner.
- **The address goes in an SVG `<title>`, never in the label.** Pill width is
  measured from the label text and column width from the pills, so putting
  `logic:4:nor2:#602` where `#602` was would relayout the entire drawing.
  `createDraw` takes an optional `addressOf` in a second argument, so
  `block.js` and `halfshot.js` are untouched.
- **`groups.json` was in no build until now**, because no page had ever
  fetched it -- it existed for the exporter and the API. `build-web.py` emits
  and rewrites it now. The failure it would otherwise have caused is the quiet
  kind: the fetch is backgrounded and caught, so production would have shown
  class-and-slot forever while `web/` worked perfectly. **Boot `dist/` before
  believing a build**, for the third time in this file.
- **The harness matches the address's SHAPE, not "the next non-whitespace
  run".** `textContent` runs one panel row into the next row's label, so a
  greedy match returns `regs:x.SBX:dyn3:#1186Role`. Same trap the primer's
  stray-digit scan documents. Mutation-proved: dropping the container half
  fails exactly the two assertions about it.

### Explaining it to a reader

The page carries a **key** drawn with the same primitives as the diagram (so a
symbol cannot drift from what it documents) and a **signal panel** that answers
"what is this wire".

- **Nearly all of the panel is derived, and the derived lines are labelled
  `measured`.** Region comes from `blocks.rs`, the driving gate and its
  precharge from `schematic.rs`, fan-out from the netlist, and the *path a
  control line opens* from `blueprint.rs` — so `dpc3_SBX` reports "opens `sb`
  (special bus) → `x` (X index register), on all 8 bits" without anyone
  asserting that S-B-X stands for anything.
- **One authored table remains**, `STEMS` in `schematic.js`: what `sb`, `idb`,
  `alua` and friends are called. That is a reading of the names rather than a
  measurement, so it is kept small, kept separate, and deliberately *not* given
  the `measured` tag.
- Those facts ride in `schematic.json` rather than being fetched from
  `blocks.json` and `decode.json` at runtime: three files indexed by node number
  is three chances for the numbering to disagree.
- An unnamed node still gets an explanation. Most gate outputs are unnamed
  because nobody needed to refer to them, and an empty panel reads as a bug.

### The bit slice is a lie

The expected win was collapsing eight identical bit slices into one. It does not
exist. Iterative structural refinement over the whole netlist — pure graph shape,
no names — **diverges**: 787 nodes share a class after one round, 29 after six,
and every bit of every bus lands in its own class. Comparing cones says the same
thing with names attached: `sb7` is opened by `dpc19_ADDSB7` where `sb0..6`
share `dpc20_ADDSB06`, because bit 7 is the shifter; `adh` carries constant
generators on two bits only; the carry chain links each bit to its neighbour.

**The datapath is geometrically regular and electrically irregular.** Blueprint
measures the geometric regularity (bit index runs down the die); this measures
the electrical irregularity. Drawing one slice and writing "×8" would have
hidden precisely the parts that make the chip work.

## The functional block pages (`block.html`, `block.js`, `block-notes.js`)

One page per functional block: what crosses its boundary, the circuit inside it,
and what it does when the chip runs. The exploded view says how big each block
is; this is what happens when you climb inside one.

**One document serves all twelve**, chosen by `?b=<slug>`, and with no `b` it is
the directory of them. Twelve near-identical files would be twelve chances for
one of them to drift, which is the failure this project keeps finding.

- **The drawing engine is shared with the workbench** (`sch-draw.js`), extracted
  from `schematic.js` the moment a second page wanted to draw the same circuit.
  Same reasoning as `block-palette.js`, and the stake is higher: two pages
  drawing an NMOS gate from two copies would eventually draw it two different
  ways, and a reader comparing them would have no way to tell which was lying.
  It takes a *cone* -- `{root, levels, elements, dir}` -- and knows nothing about
  how those levels were arrived at, which is exactly why two pages that walk
  differently can share it.
- **The boundary is four relations, not one.** A gate input arriving from
  outside is the block being told something; an inside signal read outside is the
  block telling somebody else; a pass transistor joins two wires without either
  causing the other; and a control line reaching in is the decoder operating
  machinery it does not own. Collapsing those into "connections" would throw away
  the only thing the panel is for. The four counts deliberately do not sum to a
  total, because a signal can cross more than one way, and the page says so.
- **Ports collapse by stem, and that is what makes the interface readable.**
  `ab0..ab15` is one port sixteen wide, not sixteen ports. Measured: 196 ports
  become 95 on the data bus, 149 become 71 on the address latches.
  - **Unnamed nodes are not a bus.** Splitting trailing digits off `#1446` gives
    a stem of `#`, so fifteen unrelated anonymous gate outputs collapsed into one
    port labelled `# x15` -- a bus that does not exist. They group by the block
    they come from instead, which is the only thing about them worth knowing.
- **A functional block is not a closed circuit, and the first version of this
  page proved it.** Stopping the walk at `inside` alone, almost every block came
  out two or three signals deep. That is not a bug in the walk: a block's gates
  are built out of the static logic the blocks are embedded in, which no block
  claimed because growth refuses to cross a rail. Twenty of those gates make the
  ALU's; 191 make the control pipeline's. The walk follows `blocks.rs`'s existing
  attribution of each static gate to the block it drives.
  - **It is a second category, not folded into membership**, because it is a
    weaker claim. Affiliation is not location: a quarter of the attributions sit
    more than 3000 die units from what they drive. There is no floorplan to get
    wrong in a schematic, but the pills still say which they are -- member,
    attributed gate, or port -- and the caption counts the three separately.
- **Both node-indexed files are read, and checked rather than trusted.** The
  circuit needs `schematic.json` and the attribution needs `blocks.json`'s
  `nodeDrives`, which is the coupling this file warns about elsewhere. So the
  page compares all 1725 entries at boot, masked, because `blocks.json` carries
  `was_seeded` in bit 7 and `schematic.json` does not. A verified coupling is a
  stronger position than avoiding the second file would have been.
- **The default signal is measured, and global fan-out is the wrong measure.**
  It picked signals whose connections nearly all leave, so a page opened one step
  deep against a wall of ports and the timing chain arrived showing a single
  signal. What makes a good place to stand is how much of the block you can see
  from there, which is a count of the elements *filed here* that touch it.
- **`bounds` is `(xmin, xmax, ymin, ymax)`, not `(x0, y0, x1, y1)`.** Read the
  wrong way round the ALU's extent came out as `-1402 x 759`, and only the minus
  sign said so -- on a block where both differences happened to be positive it
  would have been wrong and silent. Pinned in `_block-test.html` against
  `blocks.json`, and the sign is asserted separately.
- **The authored half is `block-notes.js` and is labelled as authored.** Slugs,
  a reading of what the block does, and the labs. Kept small and separate for the
  same reason `STEMS` is, and deliberately not given the `measured` tag: mixing a
  person's reading in with the measurements launders one into the other. The
  stray-digit scan from the primer applies to it, so a count cannot be typed into
  a sentence there and sit unchallenged.
- **A block with no notes still has a page.** The derived half stands on its own
  and the authored sections are simply not rendered -- a heading over an apology
  is worse than no heading. So adding a block to `blocks.rs` cannot break this
  file, and this file being incomplete cannot break a page.
- **`DOES` is one paragraph per block, above its interface, and it replaced a
  generic one.** The interface section used to open with a `Measured` eyebrow, a
  heading, and a paragraph explaining what a block boundary is. All three were
  identical on twelve pages, and a reader who has navigated to the program
  counter wants the program counter. The four boundary relations are named and
  described on the panel itself, which is where they belong, so nothing was
  lost by deleting the explanation of them.
  - **The section-level `Measured` eyebrow had to go with it**, and that is
    correctness rather than tidying: the paragraph is authored and the console
    under it is derived, so a heading claiming the whole section is measured
    would be the exact laundering this file is kept separate to prevent. The
    console keeps its own `interface · derived` tag, which is the real claim.
  - **It is exported separately rather than folded into `NOTES`.** Eleven blocks
    would otherwise need a near-empty `NOTES` entry each, and `block.js` already
    guards every optional field on that object.
  - **It is drawn as a quote block, and the tint is an argument.** The paragraph
    is authored and the console beneath it is derived, so giving the two
    different surfaces says so at a glance rather than leaving it to a caption.
    `.bk-does` is the rule.
  - **Its spacing had to be fixed, and it was 72 against 0.** The paragraph
    inherited the box of the heading and lede it replaced: `.sec` supplies a
    generous pad above and *exactly none* below, and `p` carries `margin: 0`, so
    the text sat flush on the console. Measured before touching it, rather than
    guessed at from the rules, because the gap above comes from one element and
    the gap below from another.

### `--sec-gap`, and why the fix is a token

The bottom margin has to equal `.sec`'s top padding, which is
`clamp(2.5rem, 7vw, 4.5rem)`. **A copy of that expression would only be equal at
the width it was eyeballed at**, so the value moved to `--sec-gap` on `:root`
and both rules now name it. One definition, and the two buffers cannot drift
apart at some width nobody photographed.

- **No overflow or fit harness can catch this class of mistake, and it is worth
  knowing why.** A `var()` naming a token that does not exist drops the whole
  declaration silently, so a mistyped `--sec-gap` would leave every `.sec` on
  every page with *no* padding. That page is cramped, not wider, so
  `_overflow-test.html` still reports PAGE OK and `_navfit-test.html` still
  fits. The check that answers it is computed `padding-top` per page, which is
  the `:root`-vs-`var()` diff this file already recommends, run as a throwaway
  probe rather than kept.
  - **`_block-test.html` had to be extended for it, and this is the trap.** The
    stray-digit scan walked `NOTES[*].sections[].body` only, so a new prose
    field would have been the only prose on the page that nothing checked.
    Adding a field to `block-notes.js` means adding it to that scan. The harness
    also now asserts all twelve have one: the old paragraph was generic and
    therefore always present, so "there is prose above the interface" stopped
    being free the moment it became per-block.

### The ports are switches, and the block is always drawn whole

The circuit view used to be a cone from one chosen signal, so a reader had to
pick somewhere to stand before they could see anything and what they got
depended on where they picked. It now draws **the whole block** and nothing
else, and each port pill is a switch that brings that wire in.

- **The block is a better bound than a radius.** It is what the page is about,
  `blocks.rs` already measured where it stops, and the picture no longer changes
  shape depending on where you clicked. There is no depth over it: `blockCone`
  walks until the block is exhausted, and `MAX_LEVELS` is a runaway guard rather
  than a design choice.
- **Seeds are measured, not chosen.** Backward reads "what makes each value", so
  it starts from what the block hands out (`drivesOut`) and works inward.
  Forward starts from what the block is handed.
- **Walking back from the outputs does not reach the whole block**, and "the
  block is lit" has to mean all of it. On the program counter that left **8 of
  64** signals undrawn: a member can drive nothing that leaves, or sit behind
  feedback the backward walk never enters. Whatever is unreached is seeded as a
  fresh column and the walk continues. Pinned per block against `blocks.json`.
- **The depth slider became "port reach"**, because the only distance left to
  choose is how far a port the reader *switched on* is followed outward. One is
  the default and means the boundary pill it has always been. Following a lit
  port further is not the page annexing a neighbour: it is a wire somebody
  explicitly asked for.

**The bookkeeping is per pill, and the drawing takes the union.** A signal can
cross the boundary more than one way, so the same wire has a pill under two
headings. Clicking `Told` must never silently flip a pill under `Joined` that
nobody touched, so toggle state belongs to the pill; `state.litNodes` is the
union, and that is what the walk reads.

- **`shown` is a fact about the drawing, not about the toggles**, which is why
  `paintPorts()` runs at the *end* of `drawCircuit()` and reads `state.drawn`
  out of the layout's own placement. Two kinds of pill get marked: one whose
  wires another heading already asked for, and one whose wires were always on
  screen anyway. The second was a surprise and is the more useful: `ports()`
  lists **attributed static-logic gates** on the boundary, but the drawing has
  always treated them as part of the block. Pressing one correctly did nothing,
  and a switch that visibly does nothing reads as broken.
- **A partial overlap is not `shown`.** Every wire the pill stands for has to be
  on screen, or the marking would be a lie about the half that is missing.
- **Pill keys are positional (`${group}:${index}`), not `${group}:${stem}`.**
  Unnamed nodes are deliberately grouped by originating block rather than by
  stem, because `#1446` and `#1451` are not a bus, so one heading legitimately
  holds several pills all labelled `unnamed`. A stem key collided between them
  and one click lit two. **The harness caught it**, which is the whole argument
  for having written the overlap assertion before believing the feature worked.
- **The harness matches pills by their WIRES, not by their stem.** Two pills can
  share a stem and stand for different signals: stems have their digits
  stripped, and `Joined` lists the far side of a switch where `Operated by`
  lists the gate. Grouping by stem found a "pair" that was two unrelated wires,
  and the `shown` assertion failed against correct behaviour. The pill's
  `title` is the list of wire names, which is what makes it checkable from
  outside the page. It also **searches for a block that has an overlap** rather
  than assuming one: the program counter has none, and a rule asserted where it
  cannot fire is a test that passes by not running.

### The block circuit is live, and the header transport drives it

The block page runs the chosen program on its one machine and the circuit
drawing is painted from it: a signal that is high right now is lit, a switch
whose control line is high is drawn open, with the workbench's own classes and
stylesheet because the drawing comes from the same `sch-draw.js`. Wired like
every other chip page: `setupChipNav` with step/back/reset, `setupProgramNav`
with an in-place reload, `halfCyclesFor` pacing the frame loop, and the reset
vector set, because two pages of this site once ran a BRK loop against
themselves for want of it. A discrete step repaints on the action, not the
next frame (the fifth appearance of that bug class, avoided rather than hit).
**The directory (`block` with no `?b=`) draws no circuit and keeps the
transport slot empty**, the way the measurement pages do; `_chipnav-test.html`
asserts both directions, and `_block-test.html` asserts the drawing arrives
lit and that twelve half-cycles of header stepping change what is lit.

### `block-cone.js`: where a block stops, computed once

The boundary and the block's own drawing moved out of `block.js` when the
workbench wanted the same block on its bench. Same reasoning as `sch-draw.js`
and `block-palette.js`, and a higher stake than either: this is the code that
decides which wires are **ports**, and two pages answering that from two copies
would eventually disagree, with no way for a reader comparing them to tell which
was lying.

It owns no state and touches no DOM. Each page passes its own already-built
indexes in through a context, and gets back `ports`, `byStem`, `seeds` and
`cone`. `block.js` keeps thin delegations (`const inside = (n) =>
state.view.inside(n)`) so the rest of that file reads as it did.

**The extraction was verified by `_block-test.html` passing unchanged**, which
is the only thing that makes a refactor of a live page defensible.

### "Open in the workbench" opens the workbench

The button had always just landed on the schematic page, and the reason is worth
recording: it built `?find=`, and `schematic.js` has only ever read `?signal=`.
It looked like it did nothing because it very nearly did.

It now carries the **signal, the block, and which ports are switched on**
(`schematic?signal=…&block=<slug>&solo=1&ports=feedsIn:1,joined:3`), and the
bench opens showing what the block page was showing.

- **The block goes down first in `merge()`**, so it holds the base columns and
  anything the reader then walks to is layered on top. First appearance still
  wins, so a signal already in the block joins where it is rather than moving --
  the same rule the walk already followed, which is what keeps the drawing
  stable as it grows.
- **`?solo=1` clicks the button rather than calling the API.** A page load
  carries no user activation, so a real `requestFullscreen` would be refused --
  and `setupFullscreen` already verifies the request took and covers the
  viewport itself when it did not. Going through the button gets the fallback
  for free instead of reimplementing it.
- **`blocks.json` is fetched only when `?block=` is present.** The schematic
  page proper is a walk rather than a block and has never needed that file, so
  charging every visit for it would be a cost with no reader behind it. The two
  node-indexed files are compared at load rather than trusted, exactly as
  `block.html` does it.
- **A block that fails to load must not take the page down.** It is an extra the
  URL asked for, not the page itself, so it boots after `#sch-main` is shown and
  reports into the caption.
- **The Ports icon is hidden when no block is on the bench.** An icon that opens
  "nothing is loaded" is an apology rather than a control -- same reasoning as
  `.nav-chip:empty` on the measurement pages. `_solo-test.html` asserts *exactly
  the ports one* is hidden rather than counting visible icons, so the count
  cannot drift for some other reason.
- **`shown` is read from the bench, not from the toggles**: `render()` records
  what `merge()` actually placed, and the pill marking is computed from that.
- **Three import rewrites, not one.** `schematic.js` gained `block-cone.js`,
  `block-notes.js` *and* a `blocks.json` fetch. Miss any and the hashed bundle
  404s at runtime while `web/` goes on working perfectly. Boot `dist/` before
  believing a build; this is the second time in one sitting.

### Every levels slider starts at 1

`sch-depth` and the study view's copy of it defaulted to three, and `state.depth`
with them. The walk *merges* as you follow signals, so arriving at three levels
means arriving at a wall of gates nobody asked for; starting at one and clicking
outward is how the bench is actually used. `bk-depth` was already one.

- **`_schematic-test.html` went red on this, correctly.** Its "a dense cone
  still draws every element" assertion leaned on the page defaulting to three,
  and reported two elements for a signal with forty switches on it. It sets the
  depth itself now: a test about density that depends on somebody else's default
  is testing the default. Fixed, it reports 56.

### The Ports drawer: capped, scrolling, and filtered

The data bus has 174 ports collapsing to 40 pills, which grew the drawer past
the console it belongs to. It is now capped to the height of the strip beside
it, scrolls inside that, and carries a filter pinned to its top.

- **`--sp-strip-h` is measured, because CSS cannot say "no taller than my
  sibling".** Same reasoning as `site-nav.js` measuring the header, and it needs
  a `ResizeObserver` for the same reason too: the Ports icon is revealed only
  once a block has loaded, so the strip gets taller *after* boot and measuring
  on open alone caches the wrong height.
- **`max-height: min(100%, var(--sp-strip-h))` clamps nothing, and it is not
  obvious.** The percentage resolves against the palette, whose height is `auto`
  and therefore set *by this very drawer* -- a circular reference that leaves
  the percentage indefinite. It applied cleanly in the computed style and the
  drawer stayed 629px against a 479px strip. Dropping the `100%` term fixes it;
  the palette already caps itself against the stage.
- **The filter matches the stem AND every wire name behind it**, so `pcl` finds
  the bus and `dpc39` finds the pill whose bus contains it. A group with no
  survivors is hidden with its heading: a heading over nothing reads as a group
  that was emptied rather than one that was filtered out.
- **A switched-on pill is exempt from the filter.** Hiding one would leave a
  wire on the bench with no way to reach the switch that put it there.
- **"all nodes" lights every port at once, and it acts on what is on screen.**
  With a filter running it says `all shown` and switches on only the visible
  set: lighting wires the reader cannot see would be a control doing more than
  it appears to. It is **one** button rather than an all/none pair, because with
  the label reading the current state there is only ever one useful thing to
  press, and a pair would put a dead control beside a live one at both ends.
  Measured on the four heaviest blocks: address latches 108 signals to 192,
  control pipeline 335 to 386, decode PLA 159 to 181, ALU 188 to 216, all
  drawing and clearing cleanly.
- **The repaint-on-action bug, for the fourth time.** The pill's `on` class was
  applied by the frame loop, and animation frames are throttled to nearly zero
  in an iframe, so the wire appeared on the bench while its switch still looked
  off. `state.panel()` is called from the click handler now. It is a real
  responsiveness bug wherever frames are scarce, not only in a harness.
- **Two of `_ports-test.html`'s assertions were worthless as first written.**
  They measured the drawer *after* the filter had cut the list to one pill, so
  it was 282px against a 479px strip with nothing to scroll, and both passed
  without exercising the cap they exist for. Restoring the full list first is
  what found the `min(100%, …)` problem above. **Measure the thing under the
  condition it is supposed to hold under.**

### `web/block.js` contained a raw NUL byte, and grep silently skipped it

`const key = \`${stem}\0${block}\`` was written with a **literal** NUL rather
than an escape. The composite key is a sound idiom -- a NUL cannot occur in a
stem or a block name, so it is a safe separator -- but as a raw byte it made
`file` report the source as `data`, and any grep with a binary-file guard
returned **no matches at all** for a symbol plainly present. That reads exactly
like "the code is not there", and it cost a detour before it was noticed by
`head` and `grep` disagreeing about the same file.

It is `\u0000` now, which is byte-identical at runtime and leaves the file as
text. Two lessons worth keeping:

- **`head` showing a line that `grep` cannot find is an instrument failure, not
  a fact about the code.** Control for it with `command grep`, which bypasses
  the shell wrapper, or with python.
- Prefer an escape to a raw control character in source, even where the raw one
  is legal. The cost is invisible until tooling quietly disagrees with itself.
- **A lab is offsets from an instruction's own opcode fetch**, found by running
  until `sync && lastFetchAddr == at`, never a remembered half-cycle number:
  reset timing moving would shift every step by the same amount and the page
  would go on looking exactly as convincing. The prose is written from
  `_block-probe.html`, and `_block-test.html` re-checks it against the engine.
- **A lab's checks are functions, not expression strings.** The CSP is
  `script-src 'self'` with no `'unsafe-eval'`, so a string would need a parser
  written in the page, and a parser there is a second thing that can be wrong
  about arithmetic.
- **`_block-test.html` re-derives the interface from `schematic.json` itself**
  and compares, rather than asserting that some ports appeared -- which would
  pass on a boundary computed the wrong way round. It drives all twelve, because
  the point of one document serving twelve is that the twelfth cannot quietly
  differ from the first. All three implementations of the port counts (the
  throwaway measurement script, the harness, and the page) agree.
- `deploy.sh` refuses to publish if a functional block has no slug or two share
  one. Renaming a block in `blocks.rs` otherwise yields a well-formed
  `blocks.json` and a menu entry pointing at nothing.

**What the ALU page found, and it is the argument for the whole section.** The
control lines gating switches into that block come out as five ways in
(`SBADD`, `DBADD`, `nDBADD`, `ADLADD`, `0ADD`), five functions (`ANDS`, `EORS`,
`ORS`, `SUMS`, `SRS`) and three ways out (`ADDSB06`, `ADDSB7`, `ADDADL`), each
gating exactly eight switches, one per bit -- except the output pair, which
splits 7 and 1, and that split is the shifter. None of that was authored: it is
what `schematic.json` says when you ask which controls reach into block 8.
