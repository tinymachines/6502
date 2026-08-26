# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**This file is the operating guide, not the engineering log.** The log -- what each
page claims, how it derives it, and every trap it cost -- lives in `docs/notes/`,
indexed at the end of this file and in `docs/README.md`. Read the note for the
area you are about to touch before touching it: nearly every rule in there was
written after something shipped wrong.

## What this is

A transistor-level MOS 6502 simulator in Rust/WASM, being built into a visual
explorer for the chip. Nothing here models 6502 *behaviour* -- the behaviour falls
out of simulating 3510 switches. Every register value is read back out of storage
nodes; every cycle count is emergent.

`extern/visual6502/` is a **git submodule** of [trebonian/visual6502](https://github.com/trebonian/visual6502),
kept **read-only** as the source of the die data and as the correctness oracle.
Do not edit it. It is a submodule rather than a copy so this repository does not
redistribute CC BY-NC-SA data -- see Licensing at the end, which is not boilerplate.

## Status

Everything below is built, verified and live. Nothing is half-finished.

| | |
|---|---|
| Simulation | Complete. 84 tests, bit-exact against the original. |
| Library | `halfphi`, extracted and published. Loads the 6502, the 6800 and the Z80. Kept in step by `tools/check-halfphi.mjs`, which the deploy runs. |
| Renderer | WebGL2, 83,227 triangles, live state overlay, GPU picking. |
| Front end | Responsive page (phone to desktop), installable PWA, offline. One header owning program, transport and clock across every page. |
| Programs | Seven programs as **source**, assembled in the page, annotated, run on the chip. One choice, shared by every page. |
| Reading pages | Primer, Lab, Trace, Programs, Halfshot, Timing, Decode, talk, designer, block diagram, pinout. See `docs/notes/pages.md`. |
| Drawings | Explorer (the die), Exploded, Schematic workbench, Blueprint, die graph, Blocks (twelve pages), Tracer, Chip map. See `docs/notes/tracer-and-chipmap.md` and `docs/notes/schematic-and-blocks.md`. |
| Clustering | 25 kinds of container on the tracer; the chip map makes them disjoint into **132 groups over 23 kinds covering all 1547 nodes once**, 534 counted bundles, live off the running chip. The arc is complete. |
| Schematic | 1160 gates recognised from the switch network; one node fails to resolve. |
| Decode | All 122 PLA product terms + 32 of 46 control lines traced back to them. |
| Timing | Every instruction's length, measured sync to sync, and what ends it. |
| Hosting | <https://6502.tinymachines.ai> -- nginx + a oneshot systemd deploy. |
| Backup | The registry replicates continuously to `/mnt/backup/6502-registry` (Litestream, `deploy/litestream.yml`). Restore proven twice. Survives a disk, not a fire: same machine, and off-box is a second destination in the same file whenever there is somewhere to put it. |
| Service | `halfwave`, the stateless engine binary, plus a FastAPI reference implementation in `service/`. Live at `/api/`. Proven bit-exact across serialize/resume hops. |
| Atlas | The chip map's own derivation over HTTP: 132 groups, the 135 overlapping containers behind it, the hierarchy, the wiring, a bounded neighbour walk. One module, shared with the pages. |
| Games | <https://games.tinymachines.ai> -- Die Runner: a console on the API. Cartridges are one gzipped file carrying the ROM, its tiles and the contract. See `games/README.md`. |
| Registry | Builders, their pages and the ROMs on them. The one stateful thing here: one SQLite file beside the checkout. |
| MCP | `POST /api/mcp`, hand-written JSON-RPC, no session and no SSE. Five coarse tools. |
| Archive | <https://6502.tinymachines.ai/archive/> -- visual6502.org, preserved. Full Wayback sweep complete: 24,429 URLs, 3.01 GB. |
| Derived docs | `docs/atlas.md` (the address rubric, 8365 addresses), `docs/idioms.md`, `docs/walk-snake.md`, `docs/atlas-matrix.svg`. |
| Repository | <https://github.com/tinymachines/6502> -- **public**. MIT code, NC-SA data. |

Known gaps, all deliberate:

- **Touch: pinch and pan verified on a device; tap slop is not.** Both verified
  ones were broken, and neither could have been caught here (the pinch NaN and
  the `screenToDie` axis inversion). Both now have regression tests. The lesson
  is worth more than the fixes: **a headless check cannot reach a second contact
  point, and cannot tell you a direction feels wrong.** Ask for a device before
  believing touch works.
- **Mobile GPU performance unmeasured.** Every headless number here is
  SwiftShader software rasterisation (~2-5 fps), which says nothing about a real
  device.
- No CI. The tests and checks under Commands are run by hand.
- **The header transport is verified headlessly, never on a device.** What is
  checked is that the state is right at each step, not that a 1 Hz blink *looks*
  like a blink. Same class of gap as tap slop.
- **The menu's desktop inline row is gone, deliberately.** One organized panel at
  every width. The alternative worth keeping in mind is a short inline row of
  primaries generated from the same list, so the two cannot drift.
- **No `screenshots` in the manifest**, so desktop Chrome shows its small install
  dialog rather than the rich one. It would need a browser at deploy time.
- **The trace shows one bit at a time and says so.** The eight are different
  circuits; showing all eight at once needs a different presentation.
- **Eleven of the twelve block pages have no *labs*.** All twelve say what they
  do in one authored paragraph; only the ALU carries the deeper reading. A lab
  has to be written from `_block-probe.html` against a dump of what the chip
  actually did, and a plausible-sounding walkthrough on eleven pages would be
  worse than eleven pages that are honestly all measurement.
- **The trace's preamble is fixed** (`LDA #$41 / LDX #$02 / LDY #$03 / CLC`).
  Tracing against a *chosen* starting state would need an editor.
- **The Wayback drip is complete**: 24,442 indexed, 24,429 fetched, 13
  permanently failed (9 x 404, 4 x 500, server-side, not retryable), 3.01 GB.
  Not covered: full version history per URL (one snapshot each), and
  `blog.visual6502.org` -- which turns out to be archived anyway, 173 MB under
  `archive/wayback/files/`, see `docs/notes/derivations.md`.
## Commands

**Toolchain gotcha:** a stray `/usr/bin/rustc` (1.75) shadows rustup's shim in
`PATH`, and cargo 1.97 invoking it fails with `-Z unstable-options ... check-cfg`.
Prefix every session:

```bash
export PATH="$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin:$PATH"
```

**The same trap again, with node, and it cost a deploy.** `/usr/bin/node` here is
**v12**, which cannot parse `??`. That is invisible interactively — the shell
picks up nvm's v24 — but `deploy.sh` runs under systemd, whose `PATH` is
`/usr/local/sbin:…:/snap/bin` and nothing else. The program check died on a
`SyntaxError` pointing at a line of perfectly good JavaScript. `deploy.sh` now
resolves a node ≥ 16 itself (trying `$NODE`, then `PATH`, then `~/.nvm`) and
says which one it found if it cannot. **Anything the deploy shells out to is
running under systemd's environment, not yours** — check the version, do not
assume the binary.

`deploy/deploy.sh` runs `cargo test --workspace` (chips and golden required
where the oracle exists) and `pytest service/` before it builds anything, and
writes the counts into `build-info.json` beside the commit. A release that
carries no `tests` key was made by hand.

```bash
cargo test --workspace              # 91 tests: netlist, functional, golden,
                                    # rewind, state, blueprint, pla, decode,
                                    # blocks, interrupts
cargo test -p v6502-sim --test golden      # differential vs the reference
cargo test -p halfphi --test chips         # the 6502, the 6800 and the Z80,
                                           # through identical calls. SKIPS without
                                           # extern/; HALFPHI_REQUIRE_CHIPS=1 to
                                           # make its absence a failure.
cargo test -p v6502-sim --test functional  # vs the documented ISA
cargo clippy --workspace --all-targets
cargo run --release -p v6502-sim --example bench   # throughput
cargo run --release -p v6502-sim --example trace   # per-half-cycle state dump
cargo run --release -p v6502-sim --example activity # how much of the chip moves
# What the solver LOOKS AT, joined against the chip atlas. A recalc is a search:
# build_group walks out from one seed. Behind halfphi's `probe` feature, which
# is off by default and costs nothing when off.
cargo run --release -p v6502-sim --features probe \
    --example search-profile -- 120 > /tmp/searches.json
python3 tools/export-atlas-doc.py --json /tmp/addr.json
python3 tools/analyse-searches.py /tmp/searches.json /tmp/addr.json
                                    # per half-cycle. Run this before designing
                                    # anything that wants to draw "what changed".

# 6502 as a service: the stateless engine, and its HTTP reference implementation
cargo build --release -p v6502-sim --bin halfwave   # the warm engine process
cargo test -p v6502-sim --test state                # snapshot/restore, bit-exact
python3 -m pytest service/ -q                       # 174 tests: the service end to
                                                    # end, the chip atlas (52),
                                                    # cartridges (27), MCP (17).
                                                    # Atlas SKIPS without groups.json.
uvicorn app:app --app-dir service --port 6510       # run it. NOT 6502: the live
                                                    # 6502-api service holds that
                                                    # port on this box, so uvicorn
                                                    # fails to bind and every request
                                                    # goes to PRODUCTION while looking
                                                    # local. `ss -ltn` before believing
                                                    # a local server is yours.

# Cartridges, end to end: mint from the tree, then play it in a browser.
python3 games/tools/mint.py --api http://127.0.0.1:6510
python3 games/tools/cart-test.py                    # see its header for the setup

# Regenerate the oracle (5 MB, gitignored; required by the golden test)
node tools/golden-trace/gen.js --steps 3000
# ...without it the golden test SKIPS. Set V6502_REQUIRE_GOLDEN=1 to make its
# absence a failure instead (use this in CI).

# The data-free wasm build ships no die data. Fast: it reads the dependency
# tree, and checks a built bundle only if one is lying around.
python3 tools/check-wasm-nodata.py
wasm-pack build crates/v6502-wasm --target nodejs --out-dir /tmp/pkg-nodata \
  -- --no-default-features

# One engine, two ways in: a machine crossing between the browser and the API.
# SKIPS without a nodejs-target build; REQUIRE_WASM=1 makes that a failure.
wasm-pack build crates/v6502-wasm --target nodejs --out-dir /tmp/pkg-node
python3 tools/check-wasm-parity.py

# Web app, development: no build step, no service worker. Serve web/ directly.
wasm-pack build crates/v6502-wasm --target web --out-dir ../../web/pkg
cargo run -p v6502-netlist --bin export-layout -- web/layout.bin
cargo run -p v6502-netlist --bin export-blueprint -- web/blueprint.json
cargo run -p v6502-netlist --bin export-blocks -- web/blocks.json
cargo run -p v6502-netlist --bin export-schematic -- web/schematic.json
cargo run -p v6502-netlist --bin export-graph -- web/graph.json
node tools/export-groups.mjs                       # web/groups.json
# (the chip atlas: chip-groups.js run outside a browser, so the API serves the
#  same partition the chip map draws. Needs schematic/blocks/timing/graph.json.
#  Refuses to write a file that fails its own checks.)
# (graph.json is the chip as ONE node-and-edge file: every node with its name,
#  block, role, pullup and centroid; all 3510 transistors as {gate, c1, c2};
#  and the interpreted gate and switch edges the pages draw. Hand it to anyone
#  who wants the network without learning the gate/switch encoding.)
cargo run --release -p v6502-sim --bin export-decode -- web/decode.json
cargo run --release -p v6502-sim --bin export-timing -- web/timing.json
# (primer.html and programs.html need no export of their own: the primer reads
#  schematic/decode/timing.json, and the programs are assembled in the page)
python3 tools/serve.py web 8777                    # http://localhost:8777/
# (block.html needs no export of its own: it reads schematic.json and
#  blocks.json, the two files the exploded view and the workbench already use)

# The programs, checked without a browser: they assemble, they round-trip
# through the disassembler's table, and the three that predate the rewrite are
# byte-identical to what they shipped with. deploy.sh runs this and refuses to
# publish if it fails. (Whether they COMPUTE what they claim needs the chip --
# that is web/_asm-test.html.)
node tools/check-programs.mjs

# halfphi lives in two repositories. This diffs the five shared files against the
# published checkout and deploy.sh refuses to publish on a difference. SKIPS
# without a sibling clone; REQUIRE_HALFPHI=1 insists, HALFPHI=<path> names one,
# --fix copies this repo's copy over the published one.
node tools/check-halfphi.mjs

# Every measured cycle count and byte length against the published instruction
# table: 138 of its 150 rows in about four seconds, against the 33 the
# hand-typed checks cover. RESCAN=1 re-reads the pages the first pass could not
# resolve and reaches 144, taking twenty seconds. SKIPS without the manual in
# reference/ (gitignored, not redistributed); REQUIRE_MANUAL=1 makes its absence
# a failure. deploy.sh runs the fast path.
python3 tools/check-timing-vs-manual.py
RESCAN=1 python3 tools/check-timing-vs-manual.py

# The 44 datapath control lines against the visual6502 wiki's own claims: the
# clock phase each is effective in, measured over four programs, and the
# three-way Balazs/Hanson/JSSim name table. 37 of 37 agree. SKIPS without the
# archive or a halfwave build; REQUIRE_DPC=1 insists; MUTATE=1 swaps the two
# clocks and MUST go red. deploy.sh runs it.
cargo build --release -p v6502-sim --bin halfwave
python3 tools/check-dpc-vs-wiki.py
MUTATE=1 python3 tools/check-dpc-vs-wiki.py     # the proof it can fail

# The address rubric and an entry per container -> docs/atlas.md. Derives all
# 8365 addresses, checks them, and refuses to write a document whose table
# fails. Reads the four web/*.json exports; run it after regenerating those.
python3 tools/export-atlas-doc.py
python3 tools/export-atlas-matrix.py            # -> docs/atlas-matrix.svg
python3 tools/export-idioms.py                 # -> docs/idioms.md
# (the whole chip as a 132 x 132 container matrix, ordered by measured hop
#  distance from the pins. DIRECTED: cell (row a, col b) is the gate edges by
#  which a drives b, so a pair bright in both triangles is feedback. 534 of
#  8646 possible pairs wired, 6.2%. `docs/README.md` indexes all of this.)

# A halfshot export, checked cold: header, deltas replayed, rails pinned, every
# access on its edge, reads against the program bytes and earlier writes, and
# (with the JSON beside it) pins, units, switches and terms recomputed from the
# levels. Exit 1 on any failure. Get an export without a browser click from
# web/_halfshot-dump.html (see the harness list).
node tools/check-halfshot.mjs halfshot-fibonacci-256.json

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

# ...or the orchestrator, which is the one to reach for. It does NOT duplicate
# the build: it runs the same unit, then restarts the API (which holds
# groups.json in memory, so a deploy that moved it is not live until this
# happens), then checks what actually landed.
scripts/deploy.sh                 # the site, then the API, then verify
scripts/deploy.sh --verify        # check what is live, publish nothing
scripts/deploy.sh --dry-run       # print the steps, run none
scripts/deploy.sh all             # site, api, archive, games, lab

# The preservation archive, deployed separately (docs/notes/archive.md).
python3 archive/tools/build-archive.py && bash deploy/archive-deploy.sh

# Run the original for comparison
python3 -m http.server 8000 --directory extern/visual6502   # /expert.html
```

`web/pkg/`, `web/layout.bin`, `web/blueprint.json`, `web/blocks.json`,
`web/schematic.json`, `web/graph.json`, `web/groups.json`, `web/decode.json`,
`web/timing.json`, `web/build-info.json`, `dist/`, the golden trace and
everything under `archive/` except `urls/` and `tools/` are generated or
fetched, and gitignored. Regenerate after any change to the Rust crates or the
die data.

**Serve `web/` with `tools/serve.py`, not `python3 -m http.server`.** The nav
links point at bare paths (`/schematic`), which nginx resolves with
`try_files $uri $uri.html $uri/`. The stock server does not, so every nav link
404s and the site looks broken while every page is still present. `serve.py`
mirrors the same three-step lookup in the same order, because a page has to beat
a same-named directory. **It also sends the live Content Security Policy**, read
out of `deploy/6502.tinymachines.ai.nginx` at startup so the two cannot drift, on
every response except the `_*` harness documents; it adds `report-uri
/__csp-report` and keeps the reports in memory, readable at `GET /__csp-reports`
(`?clear=1` empties them), which is what `_csp-test.html` polls. The harnesses
are exempt because their own inline module could not run under `script-src
'self'`; the pages they frame are not.

**Develop against `web/`, not `dist/`.** The hashed bundle exists for production
caching; iterating through it means rebuilding for every edit, and a service
worker in development will serve you yesterday's code. **But boot `dist/` before
believing a build** -- three times now a new import or `fetch()` has 404'd only
in the hashed bundle while `web/` worked perfectly.

### Verifying in a browser, headlessly

There is no browser automation configured (the Chrome extension was declined),
but Chrome is installed and headless WebGL works via SwiftShader. This is the
only way to check the front end, so it is worth knowing well.

```bash
CHROME="/snap/bin/chromium --headless=new --no-sandbox --disable-dev-shm-usage \
  --enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader"

# Desktop
$CHROME --window-size=1600,1000 --virtual-time-budget=25000 \
  --screenshot=$HOME/shot.png "http://localhost:8777/index.html?steps=51"

# Live site (the public name resolves to the LAN address from inside)
$CHROME --host-resolver-rules="MAP 6502.tinymachines.ai <addr>" ...

# Mobile: viewport + DPR + UA. DPR matters -- everything renders at 1 by default
# and the canvas backing store is the thing most likely to break at 3.
$CHROME --window-size=390,844 --force-device-scale-factor=3 \
  --user-agent="Mozilla/5.0 (Linux; Android 14; Pixel 8) ... Mobile Safari/537.36" ...
```

Expect ~2-5 fps: that is software rasterisation, not the renderer.

**`google-chrome` headless hangs on this box; use snap `chromium`.** As of Chrome
149 here, *any* headless load with `--dump-dom` or `--screenshot` never returns,
including on a three-line static file, and `timeout` kills it with no output.
That reads exactly like a page that failed to boot, and it was mistaken for one.
`--version` still works, which makes it look healthy. Its one limit is
confinement: **snap `chromium` cannot write a screenshot outside `$HOME`**, and
fails with "No such file or directory" on a path that plainly exists.

**`pkill -f <pattern>` will kill this shell.** The pattern matches the *full
command line* of the bash process running it, which contains that text, so the
shell dies first. It surfaces as an inexplicable exit code 144 and no output. The
bracket trick does not help. List with `ps -eo pid,comm` and kill by pid.

**Three checks that catch what screenshots alone do not:**

1. **The state overlay.** A dead overlay still renders a perfect-looking die.
   Capture `?steps=0` and `?steps=51` and diff the canvas region -- roughly a
   third of pixels should change. This is how "node levels uploaded as 1 instead
   of 255" was found; nothing else would have shown it.
2. **Offline.** Warm a `--user-data-dir` under a *remappable hostname*, then
   point `--host-resolver-rules` at a dead IP (`127.0.0.2`, same origin, so the
   worker's cache still applies). The app must render fully. Do not test offline
   by stopping the server: a persistent profile often stops `--dump-dom` and
   `--screenshot` returning at all, which is indistinguishable from a page that
   failed to render offline.
3. **Measurements.** Add `--dump-dom` and have the page write values into the DOM
   (e.g. `document.title`). Every `_*` harness reports `ALL PASS` or `PAGE OK`
   this way. This is how the canvas-sizing bug was diagnosed.

**Four headless artifacts that look exactly like catastrophic bugs:**

- A screenshot taken after a programmatic scroll to a `#hash`, with a sticky
  header, can come back **blank or with a huge blank band**. Re-capture without
  the hash before believing it.
- `--screenshot=/dev/null` logs "Unsupported screenshot image file type".
  Harmless.
- **`--window-size` below roughly 500px does not narrow the layout, only the
  photograph.** A 390px screenshot of the header came back broken while an iframe
  at a real 390px viewport showed everything fitting. **Measure narrow layouts in
  an iframe** (`_navfit-test.html`, `_overflow-test.html`); to *photograph* one,
  put the page in a 390px iframe and screenshot the host.
- **The bottom 87px of every screenshot is unpainted white.** `--window-size` is
  the *window*; the viewport is 87px shorter. It is exactly 87 at every size, so
  a fixed footer sits entirely inside it and looks like it failed to render. Add
  87 to the height and crop at `h - 87`. The same band appears on the live site,
  whose footer is not fixed at all, which is what proved it was the camera.

**Check what is actually listening before believing a result.** A stale
`python3 -m http.server` from an earlier session held a port and answered every
request from an old `dist/`; the new server's bind failure was in a log nobody
read. The tell was the page title being one revision behind. `ss -ltn` first.

**Do not test the running app inside an iframe.** Headless throttles animation
frames in an iframe to nearly zero, so the canvas never redraws and *every*
scenario looks broken. Harnesses that only dispatch events and watch for throws
are fine there; anything that needs a frame is not.

### Deep links

`?program=N&run=1&speed=N&steps=N&find=SIGNAL&panel=NAME&lab=ID&step=N` -- how
the app is driven in headless checks. `?program=N` is honoured by every page and
outranks the saved choice. `?speed=` is the **simulated clock in Hz** (0 for
max), not a frame multiplier. Page-specific parameters are listed in the notes
for each page.

### Development harnesses in `web/`

Thirty-three harnesses plus three probes, all prefixed `_` and **never shipped**
(`build-web.py` copies only the files it names, so they cannot reach `dist/`).
They exist because the front end has no other test route and screenshots do not
catch this class of bug. Read the title with `--dump-dom`: each reports
`ALL PASS` or `PAGE OK`. `ls web/_*.html` is the current list; what each covers
is in the note for its page. Three worth knowing by name:

- `_lab-probe.html`, `_block-probe.html`, `_tour-probe.html` -- per-half-cycle
  dumps. **Run the probe before writing anything about what the chip does.**
- `_csp-test.html` -- every page, with its deep links, booted under the LIVE
  Content Security Policy. Two pages had shipped violations for the life of the
  site before it existed.
- `_overflow-test.html?w=320&page=trace` -- what pushes a page wider than the
  viewport. Its "elements past the edge" list is informational, not causal.
## Architecture

Four crates, split so the topology is shared and read-only while state is
per-instance and mutable.

| Crate | Role |
|---|---|
| `halfphi` | Chip-agnostic: the die-data parser, the netlist, the solver. **Names no chip.** Embeds no die data, and is MIT for that reason. |
| `v6502-netlist` | The 6502's die data (`netlist.bin`, 31 KiB, built by `build.rs`, embedded with `include_bytes!`), and the analyses seeded from its names. Carries the CC BY-NC-SA obligations. |
| `v6502-sim` | The 6502 clock/bus layer, timing chain, rewind, state codec, `halfwave`. |
| `v6502-wasm` | `wasm-bindgen` surface consumed by `web/`. Builds two ways: with die data (117 KB, NC-SA) and `--no-default-features` (85 KB, MIT, takes a netlist at runtime). |

Facts: **1725 nodes, 3510 transistors, 846 names.** Adjacency is **CSR**, not the
reference's array-of-arrays, with two lists per node (transistors it gates, and
terminals it is an end of, with `other` precomputed).

**The `halfphi` split is a licence boundary as much as a design one**, and
`tools/check-halfphi.mjs` is what keeps the two repositories honest: the five
shared files were byte-identical the day of the split and drifted on whitespace
within minutes. `deploy.sh` refuses to publish on a difference. Nothing in
`halfphi/src` may name a chip. Full account in `docs/notes/engine.md`.

### The simulation model

A node's level is not a property of the node but of the **group** of nodes
currently shorted together through conducting transistors. Settling = rebuild
groups, resolve, propagate, repeat to a fixed point (capped at 100 rounds, like
the reference). Group resolution takes the **maximum** of `Drive`:

```
Floating < ChargedHigh < PullDown < PullUp < Vcc < Vss
```

`ChargedHigh` is a group with no driver that still contains a node holding charge
-- this is how the 6502's dynamic logic retains state between clock phases. There
is no decay or capacitance ratio; the two-phase clock never floats a node long
enough to need it.

The reference resolves by *first match in traversal order*, not by maximum. These
differ only when a group contains both a pullup and a pulldown.
`Stats::contested_groups` counts that case; it is **0** across all tests -- but if
it ever goes nonzero, that is the first thing to suspect.

`half_cycle` is the fundamental unit -- the chip does work on both clock edges.
Bus reads are serviced as `clk0` falls, writes as it rises.

**The 6502 overlaps the tail of one instruction with the next opcode fetch.** An
ALU result is *not* in the accumulator when `sync` rises: it sits in the ALU hold
register and transfers during the following cycle. Tests asserting on register
contents must step one extra cycle (`run_to_writeback` in `tests/functional.rs`).
This is real silicon behaviour that behavioural emulators hide, and it is the
thing this whole project exists to show.

`reset()` is a **warm** reset, faithful to the reference's `initChip()`: node pull
state carries over. Use `power_cycle()` for reproducible runs.

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

## Verification

Two independent oracles. Both must pass; either alone is insufficient.

1. **`tests/golden.rs`** -- diffs against the original JavaScript engine running
   headlessly (`tools/golden-trace/gen.js`), comparing the level of **all 1725
   nodes at every half-cycle**, plus registers and bus. Matching registers alone
   would only show agreement about the 6502; matching every node shows agreement
   about the silicon. Bit-exact over 3000 half-cycles. If you change the test
   program in `gen.js`, regenerate the golden file.
2. **`tests/functional.rs`** -- the documented ISA: datasheet cycle counts
   (including page-crossing and branch penalties), the RMW double-write, JSR/RTS
   stack layout, ADC/SBC flags, BCD. A shared misreading of the die data would
   pass the golden test but fail these.

Three further oracles, none of which consults our own numbers:
`tools/check-timing-vs-manual.py` (138 of the published manual's 150 rows, 144
with `RESCAN=1`; nothing disagrees), `tools/check-dpc-vs-wiki.py` (37 of 37
clock-phase claims from the archived wiki; `MUTATE=1` must go red), and
`tools/check-halfshot.mjs` (an export validated cold). See
`docs/notes/derivations.md`.

**A bit-exact golden test is only as wide as its encoding.** Every node, every
half-cycle, and still blind to the two rails by construction -- which is how the
rail-write bug survived until a reader read an export. When something reads a
value out that the tests only ever *mask*, expect the mask to be hiding
something.

## Performance

**~25,800 half-cycles/s native (~12.9 kHz simulated 6502)**, against the
reference JavaScript's 302: **85x faster**. A real 6502 runs at 1 to 2 MHz, so
this is 77x to 155x slower than the part.

**It is not memory-bound, and that was measured after the opposite was guessed.**
IPC 2.04, L1 dcache miss 1.28%, 99.6% of time in `Engine::settle`, fully inlined,
no line over 3.4%. The netlist is 31 KiB and stays in cache. There is no
micro-optimisation to find.

**The lever is the recalc-to-change ratio: 922 recalcs per half-cycle against 186
nodes that change level.** But the 80% waste is **not** redundancy, and that
closes the door on caching: **82.6% of searches are the first look at that node
this half-cycle**, and only **7.0% are both memoisable and worthless** -- the
ceiling for any cache keyed by seed, before its own bookkeeping. A global-epoch
pre-filter was built, proved bit-exact, and reverted for firing 0.63% of the
time. Full measurements, including what the searches say about the bus
architecture, in `docs/notes/engine.md`.

- **The workload does not matter.** The seven programs spread about 1.09x against
  a noise floor of 1.18x, and which one looks slowest changes between runs.
- **Timed columns need repeats; counted columns do not.** `hc/s` is best-of-N
  because noise only ever slows a run down. Recalcs and changed nodes are
  counters and come back bit-identical.
- **Throughput and latency are different problems.** One machine is bounded by
  the above; machines per second is bounded by cores, and there are six physical.

## House style for shipped text

Two rules, both about the same thing: the page should read as a measurement
report rather than as a pitch.

- **No em dashes in anything shipped.** Not in prose, not in a `title=`, not as
  a placeholder in a readout. Use a colon where the second half explains the
  first, a comma where it qualifies, brackets where it is an aside, and a real
  word (`none`, `any`, `??`) where a readout has nothing to show. Code comments
  use `--`, which is the existing style throughout. `grep -c '—' web/*.js
  web/*.html` should print nothing but zeroes.
- **Headings state a fact, not a promise.** "Coverage of the 3510 transistors",
  not "What this accounts for."; "Twelve opcodes never finish", not "∞ is a
  measurement too." Section headings carry no trailing full stop; the hero `h1`
  on each page is the one exception, because it is a sentence.

The same discipline the numbers already follow: prose is the part of this site
most likely to go quietly wrong, because nothing checks it afterwards. The
primer's stray-digit scan exists for exactly that reason.


## Traps this project keeps re-learning

Each of these has cost at least one round, most of them more than one. The full
story of each is in the note for its area.

**Instruments lie before the code does.**

- **Check what is listening, and which binary is running, before believing a
  result.** A stale server on the port, a `/usr/bin/node` that is v12, a
  `/usr/bin/rustc` that is 1.75 -- all three have produced confident wrong
  conclusions. Anything the deploy shells out to runs under **systemd's**
  environment, not yours.
- **`head` showing a line that `grep` cannot find is an instrument failure, not
  a fact about the code.** A raw NUL byte in a source file makes `file` report
  `data` and every binary-guarded grep return no matches. Prefer an escape to a
  literal control character in source.
- **`--virtual-time-budget` fast-forwards timers, not synchronous CPU.** And a
  fixed sleep after a real-IO promise is a flake under it: poll for the effect
  the action writes.
- **Check the type of a field before formatting it.** halfwave's `rw` is
  `"read"`/`"write"`, so `if o["rw"]` is always true; `tstates` is a string, so
  joining it splits `T2` into `T,2`. Both produced plausible wrong output.
- **A `#` in a URL starts the fragment.** `?signal=#WR` was truncated, the page
  fell back to its default, and the figure looked entirely plausible. Encode the
  value, and check the result names what you asked for.

**A test that cannot fail is not a test.**

- **A fix is not justified until the test fails without it.** Two earlier
  versions of one assertion passed with and without the fix and were worthless.
- **Mutate to prove the check can tell.** Deleting a branch that only re-labels
  proves nothing; drop data instead. Aim a negative test at something the check
  actually covers, or it proves the opposite of what it looks like it proves.
- **A check that can pass on nothing has to be made to see something.** An empty
  list matching an empty list; an assertion run where its rule cannot fire.
- **Re-derivation is not enough when the RULE is what might be wrong.** The
  pinout's directions are checked against the netlist *and* against what a
  6502's pins are known to do, because page and harness could agree and both be
  wrong.
- **Measure the thing under the condition it is supposed to hold under.** Two
  drawer-cap assertions passed because the filter had already cut the list to
  one row.
- **A mutation test whose child page is not the mutant tests nothing.**

**Silence is the failure mode.**

- **A throw inside a refresh leaves the previous, plausible output on screen.**
  Three separate bugs here presented as "the control does nothing".
- **A `var()` naming a token that does not exist drops the whole declaration,
  silently.** Check with a `:root`-vs-`var()` diff, not by eye.
- **A flex item that shrinks to nothing does not overflow, and that is worse.**
  Assert both that the header fits and that its controls stay usable sizes.
- **A CSSOM write and a `style=` attribute leave an identical DOM**, and only one
  survives the live CSP. Run harnesses under the real policy.
- **A silent no-op in the build yields a bundle that 404s at runtime.**
  `replace_once()` exists to fail instead. Adding an import or a `fetch()` to a
  page means adding it to `build-web.py`, and **booting `dist/`**.
- **A guard that absorbs a bad row makes a plausible row rather than an obvious
  failure.** Every repair a scanner makes must be reported.

**Derivation discipline.**

- **One fact, one place.** Every shared module here (`sch-draw.js`,
  `block-cone.js`, `blueprint-draw.js`, `block-palette.js`, `pins.js`,
  `clock-gen.js`, `die-centroids.js`, `claim-table.js`, `solo-palette.js`,
  `site-menu.js`, `chip-groups.js`) exists because a second copy would drift and
  a reader comparing the two would have no way to tell which was lying.
- **Authored and measured are kept apart and labelled.** Mixing a reading in with
  a measurement launders one into the other.
- **The netlist proposes; the measurement disposes.** A backward walk always
  finds *something*, and the number it finds is not evidence.
- **An all-green comparison is what a broken comparison produces.** Pin the row
  that differs, by name.
- **Numbers are never typed into shipped prose.** The stray-digit scans exist
  because prose is the part of this site most likely to go quietly wrong. Adding
  a prose field to a notes file means adding it to that scan.
- **Encode a claim from the thing making it, not from somebody's copy of it.**
- **Generated prose can go stale in the same breath it is generated.**

**Repeating UI bugs.**

- **A discrete action must repaint on the action, not on the next frame.** Five
  appearances so far, and invisible until the page is driven where frames are
  throttled.
- **z-order has to agree with click priority**, or `elementFromPoint` returns
  something the page did not select. Adding a container kind moves older kinds'
  click spots.
- **Anything decided before an `await` must be rechecked after it.**
- **`settle()` is the wrong tool for asserting that something must NOT happen.**
  It returns as soon as nothing is currently changing.

## Hosting and the repository

Live at <https://6502.tinymachines.ai>: entirely static, no application process,
plus a uvicorn API behind `/api/`. `scripts/deploy.sh` is the orchestrator and is
the one to reach for -- it runs the same systemd unit rather than duplicating the
build, then restarts the API (which holds `groups.json` in memory), then verifies
what actually landed. `--verify` alone is read-only and is the fastest way to
answer "is what is live what I think is live". Full detail, and the nginx traps
that fail silently, in `docs/notes/hosting.md`. Two that must not be
rediscovered:

- **No `add_header` inside any `location`.** nginx does not merge them: a
  location containing *any* `add_header` discards every inherited one, which
  silently dropped the CSP and HSTS from the HTML document.
- **The nginx site installs with the `.nginx` suffix.** Copying to the name
  without it creates a second, unreferenced file: `nginx -t` passes, the reload
  succeeds, and nothing changes. Check the symlink target rather than the
  directory listing.

Before pushing anything, two things worth keeping true:

- **Do not commit host-specific detail.** Addresses, zone paths and the local
  runbook live in `deploy/HOSTING.local.md`, which is gitignored. This split
  exists because CLAUDE.md previously documented an internal LAN address and a
  security weakness on the host.
- **Nothing generated is committed** -- `target/`, `dist/`, `web/pkg/`,
  `web/layout.bin`, the golden trace. A fresh clone must build; verify with a
  real `git clone` into a temp directory and `cargo test --workspace`, which is
  how the "test fails out of the box" bug was found.

Work on `main`; there are no feature branches. `legacy-rag-agent` preserves the
unrelated Python project that previously occupied the repo.

## The engineering log, and where it went

This file used to carry all of it and had grown to 397 KB, which is more than
fits in the context it exists to fill. The detail is intact, one handbook per
area, under `docs/notes/`. `docs/README.md` indexes those beside the derived
documents and the component handbooks that live next to their own code
(`service/README.md`, `games/README.md`, `archive/README.md`,
`docs/halfwave-lab/`).

| Note | What is in it |
|---|---|
| `docs/notes/engine.md` | The crates, the `halfphi` split, the solver, the ported invariants in full, the two oracles, the performance measurements and the search profile, `graph.json`, the two wasm builds, the machine as a value, the geometry pipeline. |
| `docs/notes/service.md` | `halfwave`'s line protocol, the stateless state model, the pool measurements, every API route and what a reviewer's findings changed, cartridges and what minting found, the registry and its one SQLite file, MCP. |
| `docs/notes/web-shell.md` | The site menu, the harness list, the transport, the responsive layout and PWA, the CSP, the renderer invariants, the hashed bundle and service worker, the version footer, deep links. |
| `docs/notes/tracer-and-chipmap.md` | All twenty-five container kinds and how each is derived, the partition into 132 groups, the node grids, the ADC tour, the workbench console, the optimizer. |
| `docs/notes/schematic-and-blocks.md` | Gate recognition from the switch network, the walk both ways, the study view and its console, pin chains, the address on the drawing, and the twelve block pages. |
| `docs/notes/pages.md` | Lab, Trace, Exploded, Blueprint, Decode, Programs, Halfshot, Primer, talk, block diagram, pinout, die graph, designer, Timing: what each claims and how. |
| `docs/notes/derivations.md` | The address rubric behind `docs/atlas.md`, the idiom catalogue, the Snake walk, and the datapath-control-line oracle including where the die's names come from. |
| `docs/notes/hosting.md` | The deploy, the nginx configuration and its silent failures, DNS and TLS, the repository rules. |
| `docs/notes/archive.md` | What is wrong with visual6502.org, what was recovered and how, the drip, and the invariants that keep the archive honest. |

## Licensing — read before shipping

See `NOTICE.md`. The short version: this project's code is MIT, but
`segdefs.js`/`transdefs.js` — the die data, which `netlist.bin` is derived from and
which is embedded in every artefact — are **CC BY-NC-SA 3.0**, attributed to Greg
James / visual6502.org. **NonCommercial and ShareAlike propagate to anything shipped.**
Surface this before any distribution or monetisation decision; do not silently
relicense.
