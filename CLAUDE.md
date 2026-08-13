# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A transistor-level MOS 6502 simulator in Rust/WASM, being built into a visual
explorer for the chip. Nothing here models 6502 *behaviour* — the behaviour falls
out of simulating 3510 switches. Every register value is read back out of storage
nodes; every cycle count is emergent.

`extern/visual6502/` is a **git submodule** of [trebonian/visual6502](https://github.com/trebonian/visual6502),
kept **read-only** as the source of the die data and as the correctness oracle.
Do not edit it. It is a submodule rather than a copy so this repository does not
redistribute CC BY-NC-SA data — see Licensing at the end, which is not boilerplate.

## Status

Everything below is built, verified and live. Nothing is half-finished.

| | |
|---|---|
| Simulation | Complete. 49 tests, bit-exact against the original. |
| Renderer | WebGL2, 83,227 triangles, live state overlay, GPU picking. |
| Front end | Responsive page (phone → desktop), installable PWA, offline. |
| Lab | Four instructions followed opcode → decode PLA → bus → register. |
| Blueprint | The datapath as a block diagram, **derived** from switch topology. |
| Decode | All 122 PLA product terms + 32 of 46 control lines traced back to them. |
| Hosting | <https://6502.tinymachines.ai> — nginx + a oneshot systemd deploy. |
| Archive | <https://6502.tinymachines.ai/archive/> — visual6502.org, preserved. |
| Repository | <https://github.com/tinymachines/6502> — **public**. MIT code, NC-SA data. |

Known gaps, all deliberate:

- **Touch: pinch and pan verified on a device; tap slop is not.** Both of the
  verified ones were broken, and neither could have been caught here — see the
  pinch NaN and the `screenToDie` axis inversion under "Touch-specific
  behaviour" and "Renderer invariants". Both now have regression tests. The
  lesson is worth more than the fixes: **a headless check cannot reach a second
  contact point, and cannot tell you a direction feels wrong.** Ask for a device
  before believing touch works.
- **Mobile GPU performance unmeasured.** Every headless number here is
  SwiftShader software rasterisation (~2–5 fps), which says nothing about a real
  device.
- No CI. The tests and checks below are run by hand.
- **The full Wayback drip is mid-run** (`archive/tools/drip.py`): 24,442 URLs,
  ~2.5 GB, roughly 7,200 fetched as of this checkpoint. Measured rate is **~15
  URLs/min → ~27h** — the 1.5s delay is only half of it, the request itself
  costs about as much again. Resumable and safe to leave; it detaches from the
  session (PPID 1), so only a reboot stops it. `--status` says where it is;
  re-running the fetch command resumes, retrying only what failed.

## Commands

**Toolchain gotcha:** a stray `/usr/bin/rustc` (1.75) shadows rustup's shim in
`PATH`, and cargo 1.97 invoking it fails with `-Z unstable-options ... check-cfg`.
Prefix every session:

```bash
export PATH="$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin:$PATH"
```

```bash
cargo test --workspace              # 49 tests: netlist, functional, golden,
                                    # rewind, blueprint, pla, decode
cargo test -p v6502-sim --test golden      # differential vs the reference
cargo test -p v6502-sim --test functional  # vs the documented ISA
cargo clippy --workspace --all-targets
cargo run --release -p v6502-sim --example bench   # throughput
cargo run --release -p v6502-sim --example trace   # per-half-cycle state dump

# Regenerate the oracle (5 MB, gitignored; required by the golden test)
node tools/golden-trace/gen.js --steps 3000
# ...without it the golden test SKIPS. Set V6502_REQUIRE_GOLDEN=1 to make its
# absence a failure instead (use this in CI).

# Web app, development: no build step, no service worker. Serve web/ directly.
wasm-pack build crates/v6502-wasm --target web --out-dir ../../web/pkg
cargo run -p v6502-netlist --bin export-layout -- web/layout.bin
cargo run -p v6502-netlist --bin export-blueprint -- web/blueprint.json
cargo run --release -p v6502-sim --bin export-decode -- web/decode.json
python3 -m http.server 8777 --directory web        # http://localhost:8777/

# Web app, production shape: content-hashed bundle + service worker into dist/
python3 tools/build-web.py web dist

# Regenerate the PWA icons (only after changing the artwork)
python3 tools/make-icons.py web/icons

# Git metadata for the version footer. deploy.sh runs this; do it by hand when
# serving web/ directly, or the footer stays empty.
python3 tools/build-info.py web --kind simulator

# Publish. Does all of the above, verifies it, and swaps the live symlink.
sudo systemctl start 6502-deploy
journalctl -u 6502-deploy -n 40

# The preservation archive, deployed separately (see its own section below).
python3 archive/tools/build-archive.py && bash deploy/archive-deploy.sh

# Run the original for comparison
python3 -m http.server 8000 --directory extern/visual6502   # /expert.html
```

`web/pkg/`, `web/layout.bin`, `web/blueprint.json`, `web/decode.json`,
`web/build-info.json`, `dist/`, the golden trace
and everything under `archive/` except `urls/` and `tools/` are generated or
fetched, and gitignored. Regenerate after any change to the Rust crates or the
die data.

**Develop against `web/`, not `dist/`.** The hashed bundle exists for production
caching; iterating through it means rebuilding for every edit, and a service
worker in development will serve you yesterday's code.

### Verifying in a browser, headlessly

There is no browser automation configured (the Chrome extension was declined),
but Chrome is installed and headless WebGL works via SwiftShader. This is the
only way to check the front end, so it is worth knowing well.

```bash
CHROME="google-chrome --headless=new --no-sandbox --disable-dev-shm-usage \
  --enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader"

# Desktop
$CHROME --window-size=1600,1000 --virtual-time-budget=25000 \
  --screenshot=/tmp/shot.png "http://localhost:8777/index.html?steps=51"

# Live site (the public name resolves to the LAN address from inside)
$CHROME --host-resolver-rules="MAP 6502.tinymachines.ai <addr>" ...

# Mobile: viewport + DPR + UA. DPR matters -- everything renders at 1 by default
# and the canvas backing store is the thing most likely to break at 3.
$CHROME --window-size=390,844 --force-device-scale-factor=3 \
  --user-agent="Mozilla/5.0 (Linux; Android 14; Pixel 8) ... Mobile Safari/537.36" ...
```

Expect ~2–5 fps: that is software rasterisation, not the renderer.

**Three checks that catch what screenshots alone do not:**

1. **The state overlay.** A dead overlay still renders a perfect-looking die.
   Capture `?steps=0` and `?steps=51` and diff the canvas region — roughly a
   third of pixels should change. This is how the "node levels uploaded as 1
   instead of 255" bug was found; nothing else would have shown it.
2. **Offline.** Load once with `--user-data-dir=<dir>`, then load again with the
   same profile and the server unreachable (stop it, or point
   `--host-resolver-rules` at a dead IP such as `127.0.0.2` — same origin, so the
   worker's cache still applies). The app must render fully.
3. **Measurements.** Add `--dump-dom` and have the page write values into the DOM
   (e.g. `document.title`). This is how the canvas-sizing bug was diagnosed.

**Two headless artifacts that look exactly like catastrophic bugs:**

- A screenshot taken after a programmatic scroll to a `#hash`, with a sticky
  header, can come back **blank or with a huge blank band**. Re-capture without
  the hash before believing it.
- `--screenshot=/dev/null` logs an "Unsupported screenshot image file type"
  error. Harmless.

### Deep links

`?program=N&run=1&speed=N&steps=N&find=SIGNAL&panel=NAME&lab=ID&step=N` —
mirrors the spirit of the original's query parameters, and is how the app is
driven in headless checks. `?lab=adc&step=4` opens one moment of a walkthrough,
which is the only practical way to point someone at a specific half-cycle.

`blueprint.html` takes `?program=N&run=1&path=CONTROL` — e.g.
`blueprint.html?path=dpc23_SBAC` pins the accumulator's path to the special bus.

### Development harnesses in `web/`

Four pages prefixed `_` that are **never shipped** — `build-web.py` copies only
the files it names, so they cannot reach `dist/`. They exist because the front
end has no other test route and screenshots do not catch this class of bug.

```bash
_camera-test.html      # zoom limits and pan clamping, asserted
_resize-test.html      # resize the renderer, then read back pixels: is it drawn?
_handler-test.html     # drive every event handler; report anything that throws
_overflow-test.html?w=320   # what pushes the page wider than the viewport
_lab-probe.html        # per-half-cycle dump: T-states, decode lines, every bus
_lab-test.html         # every Lab claim, checked against the engine
_blueprint-test.html   # the block diagram: drawn, bound, and no label collisions
_decode-test.html      # the decode table, re-checked against the documented ISA
```

**Do not test the running app inside an iframe.** Headless throttles animation
frames in an iframe to nearly zero, so the canvas never redraws and *every*
scenario looks broken — an entire investigation can be spent on that artifact.
`_resize-test.html` therefore builds the renderer at top level and calls
`render()` synchronously; `_handler-test.html` does use an iframe, but only
dispatches events and watches for throws, which needs no frames at all.

Read the title with `--dump-dom`: each reports `ALL PASS` or `PAGE OK`.
`_lab-probe.html` is the one to run *before* writing anything about what the
chip does — see the Lab section below.

## Architecture

Three crates, split so the topology is shared and read-only while state is
per-instance and mutable.

| Crate | Role |
|---|---|
| `v6502-netlist` | Immutable topology: nodes, transistors, names. No state. |
| `v6502-sim` | The solver, the 6502 clock/bus layer, rewind. |
| `v6502-wasm` | `wasm-bindgen` surface consumed by `web/`. |

### `v6502-netlist`

`build.rs` parses `extern/visual6502/{segdefs,transdefs,nodenames}.js` with a
small tolerant JS-literal parser and emits `netlist.bin` (31 KiB) into `OUT_DIR`;
`lib.rs` embeds it with `include_bytes!`. Nothing generated is checked in and the
1.4 MB of JavaScript never ships.

Adjacency is **CSR** (flat index array + per-node offsets), not the reference's
array-of-arrays. Two adjacency lists per node: transistors it *gates*, and
`Terminal { transistor, other }` for transistors it is a *terminal* of — `other`
is precomputed to remove a branch from the innermost loop.

Facts: **1725 nodes, 3510 transistors, 846 names.**

### `v6502-sim`

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

### Invariants ported deliberately — do not "clean up"

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

### Timing and state

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

~28,500 half-cycles/s native (~14 kHz simulated 6502), against the reference
JavaScript's 302 half-cycles/s — **94× faster**.

Profile (callgrind): ~385k instructions per half-cycle, essentially all inside
`Engine::settle`, dominated by **gate fan-out** — a clock node gates hundreds of
transistors, and each toggle queues more work. ~900 node recalcs per half-cycle,
~15 settle rounds, average group size 2.0.

Optimisation ideas, none applied: the obvious one — skipping nodes already covered
by a group processed this round — is **not** safe, because applying a group
toggles transistors and can change connectivity before the later node is reached.

## The reference (`extern/visual6502/`)

Load order in its HTML *is* its dependency graph (`wires.js` reads
`nodenames['vss']` at top level). `chipsim.js` is the whole engine in ~180 lines;
`macros.js` is the 6502 layer; `expertWires.js`/`kioskWires.js` are the UI shells.
`expert-allinone.js` is an unreferenced concatenated bundle — ignore it.

### Data formats

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

## The renderer (`web/`)

Plain ES modules, no build step, no framework: `renderer.js` (WebGL2),
`app.js` (glue + UI), `disasm.js`, `lab.js`, `programs.js` (shared program list),
`blueprint.js` and `decode.js` (two further pages, see below), `index.html`,
`style.css`, plus
`site-nav.js` and `version-footer.js` which are **shared verbatim with the
archive** (`build-archive.py` copies them). A second copy of either would drift.

The design turns on one fact: **the layout never changes.** 83,227 triangles go
to the GPU once. What changes per frame is a 1725-byte node-level array uploaded
as a small R8 texture that the *vertex* shader samples by node ID. A frame is six
draw calls (one per layer) plus a 2 KB upload, at any zoom.

Passes: scene → 4× MSAA renderbuffer → blit-resolve → bright-pass at half res →
separable gaussian → composite with a filmic shoulder and vignette.

**Picking** reuses the original's trick on the GPU: a second pass renders node IDs
into an RGBA8 framebuffer (id low byte in R, high byte in G, layer in B, alpha as
"something is here") and `readPixels` reads one pixel. It is only re-rendered when
the *camera* moves — node IDs are geometry, so a running chip does not invalidate
it.

### The Lab (`lab.js`)

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

### The Blueprint (`blueprint.html`, `blueprint.js`, `blueprint.rs`)

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
- `web/programs.js` is shared by `app.js` and `blueprint.js`. It was inlined in
  `app.js`; two copies would drift, and "Fibonacci" meaning different things on
  two pages is exactly the difference nobody notices.

The Rust side is tested (`crates/v6502-netlist/tests/blueprint.rs`, 13 tests)
rather than snapshotted. The important one is
`every_switch_is_a_real_transistor_on_the_right_bit`, which re-resolves every
drawn switch through the netlist instead of taking the blueprint's word for it —
that is what makes the picture a derivation rather than an illustration.

**It states its own coverage: 159 of 3510 transistors.** The bus fabric is a
small slice of a chip that is 76% pass transistors, and the static gates, the
decode PLA, the timing chain and the pads are all outside what a bus diagram can
honestly show. An idealised view that hides how much it idealised is the same
failure as an archive that hides its gaps, so the number is on the page.

### The Decode table (`decode.html`, `decode.js`, `pla.rs`, `export-decode.rs`)

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

### Renderer invariants — each of these was a real bug

- **Node levels must be uploaded as 255, not 1.** The R8 texture is normalised, so
  a byte of `1` arrives at the shader as 1/255 and is invisibly identical to
  "low". The chip renders perfectly and is simply never live. `nodeLevelsPtr()`
  emits 255 for exactly this reason.
- **vss and vcc are excluded from the state overlay and from highlighting**
  (`setRailNodes`). Their polygons blanket the die, so colouring them by state
  floods the image, and tracing any driven signal reaches a rail and would light
  up the whole chip. The original avoided this implicitly by never storing
  geometry for the rails; we keep the geometry (it is most of the visible
  structure) and mute it instead. Rails are also excluded from zoom-to-fit.
- **Grid tracks need `minmax(0, 1fr)`.** A bare `1fr` takes its automatic minimum
  from content, so the tall sidebar pushed the stage past the viewport and the
  canvas sized itself to the overflow (1280×1280 in a 913px window).
- **`[hidden]` needs `!important`** here: the UA rule is specificity (0,1,0) and
  the `#boot`/`#app` rules declare `display`, so hiding them silently did nothing.
- **Frame the camera only after the canvas is visible.** It is created inside a
  hidden panel and measures 1×1 until then. `userFramed` makes this
  self-correcting rather than boot-order dependent.
- **`screenToDie` inverts the *projection*, not the raw die coordinates — both
  axes add.** The negative sign in `uScale.y` already flips the die for display,
  so in the image that reaches the screen die Y runs downward, exactly like
  screen Y. Subtracting on Y — on the reasonable-sounding theory that "die Y
  grows upward" — inverted vertical panning and made zoom drift away from the
  cursor instead of anchoring to it. `panByPixels` subtracts on both axes for
  the same reason: the die follows the pointer, so the camera moves opposite it.
  `_camera-test.html` pins this by mirroring the vertex shader and asserting the
  round trip; a test written in terms of `screenToDie` alone would pass happily
  with both directions inverted, which is how this shipped.
- **The camera is bounded, and the bounds are derived rather than stored.**
  `minScale`/`maxScale` are getters over `fitScale()`, because a stored copy goes
  stale on resize — which is exactly when a wrong minimum lets the die escape.
  `_clampCamera()` states its rule in terms of the *view rectangle*, not the
  camera centre, so one expression works both zoomed in (viewport smaller than
  the die) and zoomed out (larger). Without it, panning is unbounded arithmetic
  and a hard drag leaves a black screen with no way back but the keyboard.
  Asserted in `_camera-test.html`.
- **Render targets are size-capped and checked for completeness.** A framebuffer
  whose storage could not be allocated does not throw and does not warn — it
  silently draws nothing, so the failure arrives as a black canvas with no error
  anywhere, and typically only on the machine with the big monitor. Everywhere
  except fullscreen the canvas is bounded by the page's `max-width`; fullscreen
  on a 4K display at `devicePixelRatio` 2 asks for **7680×4320**, past the 8192
  limit here, past the 4096 limit on many GPUs, and over half a gigabyte once
  multisampled. `resize()` scales both axes by one factor (preserving aspect),
  drops MSAA above `MSAA_PIXEL_LIMIT` — an aliased chip beats no chip — and
  retries smaller if allocation still fails. `_resize-test.html` forces
  `maxTarget` down to exercise that path on any machine.
- **A canvas measuring ≤1px is not a viewport**, it is an element that has not
  been laid out yet (hidden panel, mid-transition into fullscreen). `resize()`
  ignores it once real targets exist; acting on it rebuilt every target at 1×1
  and clamped the camera into a 1×1 zoom range, silently discarding where the
  user was looking.
- **Disassembly comes from `lastFetchAddr`/`lastFetchOpcode`, not from IR.** IR
  holds the opcode, but PC has already advanced past its operands, so operands
  read relative to PC belong to the *next* instruction. The simulator latches each
  fetch at `sync` so batched stepping cannot miss one.

### Page shell, responsive layout and PWA

The app is a page, not a bare tool: sticky header, hero, the explorer in a
bordered "console" panel, then explanatory sections and a footer. The design
language is deliberately borrowed from `nominate.ai` — hard offset shadows (no
blur), 2px borders, mono eyebrows with a gradient rule, Inter 900 headings — in a
cyan/steel palette so it reads as a sibling rather than a copy. Tokens live at
the top of `style.css`; recolouring the whole app means editing `:root`.

Layout breakpoints:

| Width | Explorer layout |
|---|---|
| < 68rem | canvas above, panels behind a tab bar (`#panels[data-active]`) |
| ≥ 68rem | canvas beside a persistent sidebar; the tab bar is hidden and CSS ignores `data-active` |

Touch-specific behaviour that is easy to break:

- **`touch-action: none` on the canvas is mandatory.** Without it a drag scrolls
  the page instead of panning and the app is unusable on a phone.
- Pointer Events unify mouse/pen/touch, but touch adds a *second* contact, so
  live pointers are tracked in a `Map`: one pointer pans, two pinch-zoom about
  the midpoint and pan by the midpoint's movement.
- **Pinch state has exactly one constructor (`pinchOf`), and that matters.** It
  had two, spelled differently: seeding spread `midpoint()` in as `{x, y}` while
  the move handler read `.cx`/`.cy`. So the first move after a second finger
  landed computed `mid.x - undefined`, and NaN went into the camera — where it
  *stuck*, because NaN survives every comparison (`Math.max(lo, NaN)` is NaN).
  The die vanished permanently on the first pinch. This survived the whole
  project because two-finger gestures are the one path headless cannot
  synthesise; it took real hardware. `_handler-test.html` now drives a synthetic
  pinch through the real handlers and also asserts the invariant statically.
- **`_clampCamera` rejects a non-finite camera** rather than propagating it. It
  is the choke point every camera change passes through, so it is the right
  place to refuse one, and it turns a class of permanent blank screen into a
  single dropped frame.
- Tap slop is larger for touch (12px vs 4px) — a finger always moves a little,
  and a tap that registers as a drag never selects anything.
- The hover card is suppressed under `(hover: none)`; otherwise it sticks where
  you last tapped.
- Text inputs are 16px because iOS zooms the viewport on focus below that.
- A tap that selects a node also switches the panel tab to Trace on small
  screens, since the result would otherwise be behind a tab.

Layout gotchas already paid for, in narrowing order of subtlety:

- **A flex item defaults to `min-width: auto`,** so it refuses to shrink below
  its content — and `min-width: 0` on a *child* cannot rescue it. The program
  `<select>` overflowed the console at 320px until `min-width: 0` was set on the
  wrapping `.field`, not just the select. Suspect this for any "why won't this
  shrink" question.
- **Grid tracks need `minmax(0, 1fr)`**, not `1fr`, or the track takes its
  automatic minimum from content. This sized the canvas to 1280×1280 in a 913px
  window.
- **`[hidden]` needs `!important`** here, because the UA rule is specificity
  (0,1,0) and `#boot`/`#app` declare `display`.
- Test at **320px**, not just 390. Several things only break at the narrowest
  common phone width. Two did: the header's wordmark, CTA and menu together want
  ~330px against ~285px available, and the six transport buttons want 302px. The
  header's overflow *escapes* (nothing clips it) and scrolls the whole page; the
  transport's is clipped by `.console { overflow: hidden }`, so the last button
  is simply cut off and looks like a missing feature. Below 24rem the CTA is
  dropped and the transport tightened. `_overflow-test.html?w=320` names the
  culprit, which is otherwise very hard to attribute — the element that
  overflows is rarely the element at fault.
- **Fullscreen does not depend on the Fullscreen API.** iOS Safari implements it
  for video elements only, so `requestFullscreen` on a div is absent on iPhone;
  this used to be a bare try/catch, meaning the button did nothing and said
  nothing. It now tries the API, *verifies it actually took* (webkit's returns
  undefined, not a promise, so a resolved await proves nothing), and otherwise
  covers the viewport with `position: fixed`. Both paths set `.immersive`; only
  the fallback adds `.faux`.
  - **The CSS keys on a class, never `:fullscreen`.** An unknown pseudo-class
    invalidates the *whole* selector list, so `.console:fullscreen,
    .console.immersive { … }` would silently drop everything on a browser that
    does not know `:fullscreen`.
  - **`z-index` on the console cannot work, and this cost two rounds to see.**
    Every `.wrap` is `position: relative; z-index: 1`, so each section opens a
    stacking context and confines its descendants — the console's z-index only
    orders it *within* `#explorer`. Outside, what competes is `#explorer`'s own
    z-index of 1, which loses to the header (root, 30) and to every *later*
    `.wrap` sibling by document order. The symptom is page text appearing
    through the console, which reads exactly like a transparency bug and is not
    one. `body.no-scroll #explorer { z-index: 70 }` is the fix.
  - The fallback also needs an **opaque** background: the console is normally 92%
    and relies on a solid page behind it.
- **In fullscreen on a phone the panels are a drawer over the die**, collapsed to
  its handle by default (`[data-drawer]` on `.console`, `setDrawer()`). Sharing
  the height with a canvas is the wrong trade on a 390px screen — fullscreen
  there should mean the die. The stage is `position: absolute; inset: 0` in that
  layout, so opening, closing or changing tab cannot resize it.
  - This **replaced** a `--panel-lock` scheme that measured the tallest panel and
    pinned the container to it. That existed only because a tab change resized
    the stage and jumped the die; the drawer removes the cause, so the
    measurement was deleted rather than left to rot beside it.
  - Collapse hides `.panel` rather than translating by a measured offset, so the
    drawer shrinks to exactly its handle plus tab strip with no magic number to
    drift out of step.

PWA: `manifest.webmanifest` plus icons generated by `tools/make-icons.py` (kept
in the repo so they are reproducible, not mystery binaries). nginx has no
`webmanifest` MIME type, so the site config sets it with `default_type` in a
location that declares no `add_header` — see the header-inheritance trap above.

### Hashed bundle and the service worker

`web/` stays directly servable for development — no build step, no worker.
Production goes through `python3 tools/build-web.py web dist`, which content-hashes
every asset and emits `sw.js`. The deploy runs it and publishes `dist/`.

Hashing is **dependency-first**, because a change to a leaf has to ripple upward:

```
layout.bin ─┐
*_bg.wasm ──┴─> v6502_wasm.js ─┐
renderer.js ────────────────── ┼─> app.js ─┐
disasm.js ──────────────────── ┘           ├─> index.html   (never hashed)
style.css, icons ──> manifest.webmanifest ─┘
```

Three references would not rewrite themselves and are handled explicitly:

- **`new URL('v6502_wasm_bg.wasm', import.meta.url)`** inside the wasm-bindgen
  glue is a runtime URL, not a module specifier, so no bundler-style import
  rewriting would catch it.
- `app.js`'s three relative imports.
- `fetch('layout.bin')`.

`replace_once()` fails the build if any of these does not match exactly once. A
silent no-op here yields a bundle that 404s at runtime, which is far harder to
diagnose than a build that refuses to finish.

The worker is only safe *because* of the hashing: cache-first on a mutable URL
eventually pairs a new `.wasm` with an old `app.js`. Two deliberate choices:

- **No `skipWaiting()`.** A running page holds references to the current build's
  hashed URLs. Taking over mid-session and then dropping the old cache in
  `activate` would pull them out from under it. The new worker waits for every
  tab on the old one to close; `clients.claim()` in `activate` is safe precisely
  because activation already waited.
- **Navigations are network-first**, hashed assets cache-first. A deploy is
  picked up as soon as the user is online, and the cached shell is the offline
  fallback.

`index.html` and `sw.js` are never hashed and served `no-cache` — they are what
point at everything else, and a cached `sw.js` would pin an old build. Hashed
assets get `max-age=31536000, immutable`, which is now honest.

**nginx gotcha:** a `map` key containing `{` must be quoted, or the config parser
reads the brace as the start of a block and rejects the file.

Verify offline for real rather than trusting registration: load once with
`--user-data-dir=<dir>`, stop the server, load again with the same profile. The
app should render fully with the server down.

A `#hash` deep link needs re-applying after boot: the target does not exist while
`#app` is hidden, so the browser's initial scroll goes nowhere.

### The version footer

`tools/build-info.py` stamps git metadata into `build-info.json`;
`web/version-footer.js` renders `v0.14 @7e02172 · deployed 3m ago` into any
`[data-version-footer]` element. Both the simulator and the archive carry it, and
both stamp separately since they deploy separately. A dirty working tree gets a
trailing `+`, so a deploy from uncommitted changes says so.

- **The elapsed time is computed on the client, and that is the point.** This
  site is served from content-hashed, long-cached files precisely so pages are
  *not* regenerated; a relative time baked into HTML is wrong within the hour.
  Only ISO timestamps are stamped. It re-ticks every 30s so a tab left open does
  not keep claiming it shipped a minute ago.
- **`build-info.json` bypasses `emit()` in `build-web.py`**, so it never enters
  the service worker's precache. Everything else is immutable-by-hash and safe to
  cache forever; this is the one file whose whole job is to reflect the deploy
  that just happened, and a worker serving it cache-first would make the footer
  lie.
- **`import.meta.url` resolves `build-info.json`**, not a page-relative path. The
  archive nests pages two deep and ships its own stamp, so the script has to be
  self-locating.
- **No inline script.** The CSP is `script-src 'self'` with no `'unsafe-inline'`.
- Use a **literal `·`**, not `content:"\00b7"` — a short CSS escape is only
  unambiguous when what follows cannot be read as another hex digit, and the
  parser took the leading `\0` as NULL, rendering `␀b7`. The DOM check passed
  clean: the text was right and the escape lived in a `::before` rule, so only a
  screenshot could catch it.

### Geometry pipeline

`build.rs` triangulates all 8233 polygons with earcut at build time (0 degenerate)
and emits `layout.bin`: a header, then `x:u16, y:u16, node:u16` per vertex sorted
into contiguous per-layer runs, then transistor bounding boxes. 1.46 MiB, fetched
separately so it never bloats the `.wasm`.

Coordinates stay in raw die space (x 214..8983, y 179..9807). **The Y flip the
original baked into every `drawSeg` call lives in one sign in the projection.**

### Reference rendering, for comparison

The original stacked four canvases: static layout, a high-node overlay, highlight,
and a hidden hit buffer encoding the 12-bit node number into the high nibbles of
R, G, B. Zoom/pan was CSS sizing on the canvases rather than a transform, which is
where its 600/800 constants come from.

## Hosting — https://6502.tinymachines.ai

Live on this box. Entirely static; there is no application process.

| Piece | Where |
|---|---|
| Deploy script | `deploy/deploy.sh` |
| systemd unit | `deploy/6502-deploy.service` → `/etc/systemd/system/` |
| nginx site | `deploy/6502.tinymachines.ai.nginx` → `sites-available/` (symlinked) |
| Served from | `/var/www/6502.tinymachines.ai/current` (symlink into `releases/`) |

```bash
sudo systemctl start 6502-deploy      # rebuild + publish
journalctl -u 6502-deploy -n 40       # what it did
```

The deploy builds the wasm and geometry, sanity-checks the artefacts (including
`layout.bin`'s magic — a truncated blob still "loads" and then renders nothing),
publishes into `releases/<timestamp>/`, precompresses with `gzip -9`, and swaps
the `current` symlink atomically. Keeps 3 releases; roll back by repointing the
symlink. The unit is installed but **not enabled** — it is a deploy action, not
a boot service.

After editing anything in `deploy/`, copy it to the system location; the repo
copy is the source of truth but is not read live. **The nginx site installs as
`/etc/nginx/sites-available/6502.tinymachines.ai.nginx` — with the `.nginx`
suffix**, which is what `sites-enabled` symlinks to. Copying to the name without
it creates a second, unreferenced file: `nginx -t` passes, the reload succeeds,
and nothing changes. Check the symlink target rather than the directory
listing.

### Load-bearing details

- **Precompression is required, not an optimisation.** `gzip_types` is commented
  out in this deployment's `nginx.conf`, so runtime gzip covers only `text/html` — the
  1.5 MB `layout.bin` would ship raw. `gzip_static on` serves the `.gz` files the
  deploy writes. Result: 1.5 MB → 449 KB, wasm 107 KB → 50 KB.
- **CSP needs `'wasm-unsafe-eval'`** in `script-src`, or the browser refuses to
  instantiate the module and the page boots to a blank canvas. Everything else is
  `'self'`; there are no external resources.
- **No `add_header` inside any `location`.** nginx does not merge `add_header`
  across levels: a location containing *any* `add_header` discards every
  inherited one. Setting Cache-Control per-location silently dropped the CSP and
  HSTS from the HTML document. Cache-Control now comes from a `map` into a
  variable so every header is declared once at server level.
- Assets are not content-hashed, so everything revalidates (`max-age=60,
  must-revalidate`; HTML `no-cache`). Deploys take effect immediately.
- **The `immutable` map keys on the hash segment, not the extension.** It reads
  `\.[0-9a-f]{8}\.(?:js|css|wasm|bin|png|svg|json|webmanifest)$`. `json` is in
  that list for the derived blueprint and is safe *only* because the hash
  segment is required: `build-info.json` has none and keeps the short cache,
  which is the entire point of it. Matching on extension alone would make the
  version footer report whatever it said an hour ago.
- **`/archive/` is an `alias` beside `releases/`, not inside a release.** It is
  ~2.5 GB that changes only when something new is recovered, so copying it on
  every front-end deploy would be absurd. That location declares no `add_header`
  either, for the reason above; its Cache-Control comes from the same `map`, with
  a week for `/archive/(full|gallery/(thumb|view))/`. `autoindex` stays off: the
  collection is meant to be browsed through pages that carry attribution, not a
  bare directory listing. nginx follows the `full` symlink out of the alias root.

### DNS and TLS

The site is served from a self-hosted box. Point an A record at it, then issue a
certificate with `certbot certonly --webroot -w /var/www/html -d <host>`. If the
nameserver uses split-horizon views, the record has to be added to *every* view,
and `rndc reload <zone>` fails with "found in multiple views" — reload the whole
server instead.

Operator-specific details (addresses, zone paths, the local runbook) live in
`deploy/HOSTING.local.md`, which is deliberately not in version control.

### After any nginx or deploy change

Load the **live** URL headlessly, not a local server — see "Verifying in a
browser, headlessly" above for the invocation. That is the only thing that
exercises the real TLS, CSP, MIME types and cache headers together, and a CSP
mistake produces a blank canvas rather than an error.

Then confirm the headers directly, because a wrong one is invisible in a
screenshot:

```bash
curl -sS -D- -o /dev/null --resolve 6502.tinymachines.ai:443:<addr> \
  https://6502.tinymachines.ai/<path>
```

Expect `no-cache` on `/`, `index.html` and `sw.js`; `max-age=31536000, immutable`
on hashed assets; `application/manifest+json` on the manifest; and the CSP
present on *every* response, including assets.

## Repository

Public at <https://github.com/tinymachines/6502>, pushed as `isenbek`. `main` is
the simulator; `legacy-rag-agent` preserves the unrelated Python project that
previously occupied the repo (also still in `../6502-prev`).

```bash
git clone --recurse-submodules https://github.com/tinymachines/6502
git submodule update --init      # if cloned without --recurse-submodules
```

Before pushing anything, two things worth keeping true:

- **Do not commit host-specific detail.** Addresses, zone paths and the local
  runbook live in `deploy/HOSTING.local.md`, which is gitignored. The public docs
  keep the transferable engineering lessons only. This split exists because
  CLAUDE.md previously documented an internal LAN address and a security
  weakness on the host.
- **Nothing generated is committed** — `target/`, `dist/`, `web/pkg/`,
  `web/layout.bin`, the golden trace. A fresh clone must build; verify with a
  real `git clone` into a temp directory and `cargo test --workspace`, which is
  how the "test fails out of the box" bug was found.

## The preservation archive (`archive/`)

A mirror of visual6502.org, which is decaying. **Live at
<https://6502.tinymachines.ai/archive/>.** Deployed separately from the
simulator; see `archive/README.md` for the full account.

What is wrong with the source site, as of August 2026:

| | |
|---|---|
| Wiki | **HTTP 500 on every page.** MediaWiki is failing. 169 pages unreachable. |
| Die photography | **Serves fine, but nothing links to it.** 548 files, 2.3 GB, 41 chips. |
| JSSim, docs, `/sim/` | Still working. 36 files reachable by crawling. |

The wiki returning **500 rather than 404** suggests the pages are still on disk
behind a broken database — worth asking the maintainers before treating Wayback
as the only route. The photography is the subtler loss: every byte is served
correctly, but the wiki pages that linked to it are dead and the directory
listings are 403, so nothing on the open web points at it. The file list had to
be reconstructed from the Wayback CDX index even though the bytes come from the
live origin.

What is recovered: **127 wiki pages** rebuilt from wikitext (42 more linked to
Wayback), **83 wiki images**, **40 chips / 516 photographs / 2.2 GB**, and the
live site's other 71 files.

```bash
python3 archive/tools/wayback-index.py --refetch   # rebuild the URL manifests
bash     archive/tools/mirror-live.sh              # crawl what the site links
bash     archive/tools/harvest-site.sh             # the 2.3 GB nothing links to
python3  archive/tools/harvest-wiki.py             # the wiki, out of Wayback
python3  archive/tools/fill-gaps.py                # backfill what the origin lost
python3  archive/tools/build-archive.py            # -> archive/public/
bash     deploy/archive-deploy.sh                  # publish to /archive/

# The completionist pass: the entire Wayback index for the domain.
python3 archive/tools/drip.py --index              # 24,442 URLs into SQLite
python3 archive/tools/drip.py --delay 1.5          # ~27h, resumable, Ctrl-C safe
                                                   # (nohup it: survives the session)
python3 archive/tools/drip.py --status             # progress, ETA, failures
```

### The drip (`drip.py`) — currently mid-run

The targeted harvest took what was known to be worth having. The drip takes the
whole domain index — 24,442 URLs, ~2.5 GB, mostly MediaWiki navigation
permutations and some spam pages from an old compromise — on the principle that
the cheapest moment to collect something is before anyone has decided it matters.
Sorting comes later; collection comes first.

- State is **SQLite, one row per URL**, committed as it goes. A kill loses at
  most the request in flight. Failures stay pending with their error and attempt
  count, so a re-run retries only those.
- **Digest hardlinking**: CDX carries a content digest, so a URL whose bytes we
  already hold is linked rather than refetched. Only 2% here — these pages differ
  in small ways — but it is free and would matter on a duplicated corpus.
- **Query strings are kept in the on-disk path.** MediaWiki puts the entire page
  identity in the query string; dropping it collapses thousands of pages onto one
  file. Over-long names are truncated with a hash suffix.
- **Do not raise the rate limits.** The Internet Archive is a charity preserving
  this for everyone, and one request at a time with backoff on 429 is the deal.

Pulls **one snapshot per URL**, not full version history — that is a much larger
second pass. `blog.visual6502.org` is on Blogger and is not in this domain index;
it needs its own run.

### What makes the recovery work

**163 of 169 pages have archived `action=edit` captures, and MediaWiki puts page
source in a `<textarea>` on its edit form.** So the wiki rebuilds from *wikitext*
rather than from rendered HTML — re-renderable and convertible instead of merely
viewable. This is the single fact the whole rebuild rests on.

A naive `url=visual6502.org/wiki*` CDX query returns ~90k rows that are almost
entirely navigation: `Special:RecentChanges` in every permutation of
hideminor/hideliu/hidemyself/hideanons, login redirects carrying `returnto=`, and
thousands of oldid/diff pairs. Under 1 row in 100 is content.
`wayback-index.py` filters that to a few hundred URLs, one best snapshot each.

Snapshot URLs use the **`id_` modifier** (`/web/<ts>id_/<url>`), which returns the
originally archived bytes — no Wayback toolbar, no link rewriting to undo later.

### Recovery gaps, deliberately visible

- **39 `File:` pages have no source in any capture.** The wiki refused anonymous
  edits there, so the Archive captured a permission-denied form with an empty
  readonly textarea. This is permanent, not transient — `harvest-wiki.py` records
  them in `harvest-wiki-nosource.txt`, apart from real failures, so nobody
  re-runs them hoping for a different answer. They fall back to rendered HTML.
- **Nothing is known to be lost.** Two filenames looked like the one real gap —
  `6502_dc_sheet2-8-12-75.id.jpeg` and `6502_rb_sheet1-11-74.id.jpeg`, with
  description pages but no binary at any resolution. They are **red links**: the
  archived pages read "No file by this name exists" and Wayback has zero rows for
  either name at any status or date. The schematics survive under
  `6502_schematic_sheet{1-11-74,2-8-12-75}.id.jpeg` (2593×873, 2597×877).
  A MediaWiki `File:` page proves a filename was *referenced*, not that anything
  was stored under it — from a CDX index alone a red link and a deletion look
  identical. `wayback-index.py` now separates them using the rendered capture,
  so this needs `harvest-wiki.py` to have run first.
- The build marks these rather than hiding them: gold links are Wayback-only,
  struck-red links were never archived. An archive that hides its gaps is worth
  less than one that shows them.

### Invariants

- **`build-wiki.py` fails rather than emit a page without the attribution
  banner**, and `archive-deploy.sh` refuses to publish an `index.html` missing the
  licence or the authors' names. This is CC BY-NC-SA material; the banner *is*
  the licence compliance, not decoration.
- **Full-size image links point at our own mirror, not at visual6502.org.** An
  archive that sources originals from the site it is archiving stops working the
  moment that site does. This is not theoretical: `fill-gaps.py` found two Atari
  TIA scans that the origin now 404s and only the Archive still holds.
- **`archive/public/full` is a relative symlink** to the *whole*
  `../mirror/visual6502.org` tree, not just `images/`, so `mirror/` must be
  published as a *sibling* of `archive/`. The site's own per-chip pages live at
  `images/pages/*.html` and reference `../<chip>/photo.jpg` and `../../main.css`;
  serving the tree intact makes every relative link resolve as it did originally,
  with no rewriting to get wrong. `rsync -a` preserves the symlink rather than
  copying 2.3 GB through it.
- **Everything served must be reachable by clicking.** `File:` pages embed their
  image (their wikitext is only the description — MediaWiki supplied the picture),
  and `wiki/images.html` is a contact sheet of all 83 so the ones whose articles
  survive only as renderings still have a home. Reachable only as a thumbnail is a
  quieter version of not reachable at all.
- **The simulator links to the archive** (header nav and credit section), and the
  archive carries the **same header back** (`archive/tools/shell.py`). It did not
  at first, which reproduced the exact failure the archive exists to undo. The
  three builders each emit their own stylesheet, so without a shared header they
  grew three, and the archive read as three sites stapled together. The markup
  matches `web/index.html` exactly so `web/site-nav.js` drives the disclosure
  menu on both.
  - **Import it by name, not as a module.** `build-wiki.py` and
    `build-gallery.py` each define their own `shell()` function, which rebinds
    the module-level name and turns `shell.header` into an `AttributeError` at
    build time.
  - The **mirrored original pages under `full/` deliberately keep no header** —
    they are third-party archived content, and rewriting them would misrepresent
    what was captured.
- **`archive/public/` is not cleaned between builds.** A stale `site/` directory
  survived there from before the `full/` symlink existed: 17 MB that nothing
  linked to, which is precisely the orphaned-content failure being undone. Check
  for top-level entries no builder writes.
- **Nothing fetched is committed** — only `archive/urls/` (the manifests, which
  are ours) and the tools. Same reasoning as the `extern/` submodule: this repo
  points at NC-SA data rather than redistributing it.
- **Harvesting is deliberately slow** (`--wait`, `--limit-rate`, resumable).
  visual6502.org is a fragile fifteen-year-old server and the one way this
  exercise could do real harm is by knocking it over. Do not "optimise" the rate
  limits.
- The archive deploys **beside** `releases/`, not inside one: it is ~2.5 GB that
  changes only when something new is recovered, and copying that on every
  front-end deploy would be absurd.

## Licensing — read before shipping

See `NOTICE.md`. The short version: this project's code is MIT, but
`segdefs.js`/`transdefs.js` — the die data, which `netlist.bin` is derived from and
which is embedded in every artefact — are **CC BY-NC-SA 3.0**, attributed to Greg
James / visual6502.org. **NonCommercial and ShareAlike propagate to anything shipped.**
Surface this before any distribution or monetisation decision; do not silently
relicense.
