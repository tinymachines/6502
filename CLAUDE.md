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
| Simulation | Complete. 84 tests, bit-exact against the original. |
| Library | `halfphi`, extracted and published. Loads the 6502, the 6800 and the Z80. Kept in step by `tools/check-halfphi.mjs`, which the deploy runs. |
| Renderer | WebGL2, 83,227 triangles, live state overlay, GPU picking. |
| Front end | Responsive page (phone → desktop), installable PWA, offline. |
| Controls | Program, transport and clock live in the header and drive every page. The rate is the simulated clock in Hz. |
| Menu | One grouped list with sub-heads and a line per entry, shared by the simulator and the archive. |
| Programs | Seven programs as **source**, assembled in the page, annotated, run on the chip. One choice, shared by every page. |
| Halfshot | The chosen program recorded one frame per half-cycle: a fixed plate of registers, buses, pins and memory, and an island of what switched. Every node at every edge, exportable losslessly. |
| Primer | The mental model, corrected one step at a time. Every number derived, every claim runnable. |
| Lab | Four instructions followed opcode → decode PLA → bus → register. |
| Trace | Any of the 256 opcodes, half-cycle by half-cycle, with the wires that are one wire. |
| Tracer | The whole circuit on one screen at its die positions, lit live and re-marked at every half-cycle with everything that moved, beside the code, the registers and a bit-by-bit watch of the latches and buses. Fourteen kinds of container over it: blocks, buses, gate clusters, decode stages, control lines, pins, the timing chain as cells, the clock generator, the interrupt logic as what each pin reaches, the branch logic split where the wiring splits it, the decimal correction as everything its names are wired into, the registers S, A, X and Y as the die builds them with the lines that move each, the program counter's incrementer as what lies between the counter and its next value, the status register as a container per flag with its logic, the address latches as a chain of seven a bit with their load lines and the constant generators, the ALU read bit by bit with its inputs, ends and line groups, the data latch, the output register, the bus and the read/write control, the instruction register with its predecode, load path and predecoder, the special bus with its lines by measured direction, the store-data pipeline as the detect and the two latches the timing readout names, the ready logic as the receiver, the master and its re-timed copies, the program counter's own storage with its six lines, the 52-latch pipeline file, and the SYNC generator. Twenty-five kinds; the clustering arc is complete. |
| Chip map | The whole chip as one schematic: the tracer's derivations made disjoint into 132 groups covering every node once, columns by measured pin distance, die order within a column, 534 counted bundles, live off the running chip, every box linking to its container on the tracer. And a guided tour: ADC walked across the map container by container, every authored claim checked live. The boxes open into node grids: every member snapped in a stated order, squares for the switch-holders, filled while they conduct. The boxes drag (snapped, kept, Tidy restores), and fullscreen is the workbench's study view with the floating console. |
| Exploded | The die pulled apart: 3 layers, 12 blocks, and the static logic. |
| Blocks | One page per functional block: what crosses its edge, and the circuit inside it. Twelve pages, one document. |
| Schematic | 1160 gates recognised from the switch network. Walk a signal both ways, with the islands you came from still on screen and a console for the chip's I/O, memory and stack. |
| Blueprint | The datapath as a block diagram, **derived** from switch topology. |
| Block diagram | The published datasheet figure as a dataset, drawn from it, and every block it names resolved against the die. 5 of 6 agree. |
| Pinout | The forty pins, with every column but the numbering derived. Direction measured from the switch network, not copied off an arrow. |
| Die graph | Every node at its own centroid on the die, with every edge. Nothing laid out: the positions are read off the polygons. |
| Decode | All 122 PLA product terms + 32 of 46 control lines traced back to them. |
| Timing | Every instruction's length, measured sync to sync, and what ends it. |
| Talk | Where the die data came from, and the source talk's claims re-asked of the chip. 6 of 7 agree, and the page computes that itself. |
| Designer | The other account: one of the chip's authors, recalling it forty years on. 4 of 5 agree, and the clock generator is derived here for the first time. |
| Hosting | <https://6502.tinymachines.ai> — nginx + a oneshot systemd deploy. |
| Games | <https://games.tinymachines.ai> -- Die Runner: a console on the API. The game is a 6502 ROM, the screen is a page of its memory, the browser draws it. The round trip is the frame rate. Cartridges are one gzipped file carrying the ROM, its tiles and the contract; the page loads one from `?cart=` or a file picker. See `games/README.md`. |
| Cartridges | `POST /v1/cartridge` mints one: assemble, refuse a layout that cannot work, **run it on the chip**, pack it. `GET /v1/console` publishes the contract, the memory map and the tile format. |
| MCP | `POST /api/mcp`, hand-written JSON-RPC, no session and no SSE. Five coarse tools; `run` hands back the screen as hex so a model can read its own picture. |
| Registry | Builders, their pages and the ROMs on them: <https://games.tinymachines.ai/builders>. The one stateful thing here, one SQLite file beside the checkout. Tokens by hand, shown once, only the hash stored. Art is the die's four colours, converted in the browser, stored as CHR. |
| Archive | <https://6502.tinymachines.ai/archive/> — visual6502.org, preserved. Full Wayback sweep complete: 24,429 URLs, 3.01 GB. |
| Repository | <https://github.com/tinymachines/6502> — **public**. MIT code, NC-SA data. |
| Service | 6502 as a service: the `halfwave` stateless engine binary plus a FastAPI reference implementation in `service/`. Proven bit-exact across serialize/resume hops. Launches under a separate site property; only the engine lives here. |
| Atlas | The chip map's own derivation over HTTP: 132 groups over 23 kinds covering all 1547 nodes once, the 135 overlapping containers behind it, the hierarchy, the wiring between groups, and a bounded neighbour walk. One module, shared with the pages. |

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
- **The header transport is verified headlessly, never on a device.** The
  clock's blink and the run/pause swap are asserted through discrete steps
  because animation frames are throttled to nearly zero in an iframe, so what
  is checked is that the state is right at each step rather than that the
  blink *looks* like a blink at 1 Hz. Same class of gap as tap slop.
- **The menu's desktop inline row is gone, deliberately.** There is one
  organized panel behind the button at every width. The alternative worth
  keeping in mind is a short inline row of primaries beside it, generated from
  the same list so the two cannot drift.
- **No `screenshots` in the manifest**, so desktop Chrome shows its small
  install dialog rather than the rich one. It would need a browser at deploy
  time; see the PWA section.
- **The trace shows one bit at a time and says so.** The wire panel watches a
  single bit because the eight are different circuits; a reader who wants the
  whole byte has to move the slider eight times. Showing all eight at once
  would need a different presentation, not a bigger list.
- **Eleven of the twelve block pages still have no *labs*.** All twelve now say
  what they do, in one authored paragraph each (`DOES` in `block-notes.js`), but
  only the ALU carries the deeper reading and the per-half-cycle labs. The rest
  render their derived half, which is complete and stands on its own. The
  remaining gap is deliberate: a lab has to be written from `_block-probe.html`
  against a dump of what the chip actually did, and a plausible-sounding
  walkthrough on eleven pages would be worse than eleven pages that are honestly
  all measurement.
- **The trace's preamble is fixed.** `LDA #$41 / LDX #$02 / LDY #$03 / CLC`,
  printed on the page. Tracing an instruction against a *chosen* starting state
  would need an editor and is not built.
- **The full Wayback drip is complete** (`archive/tools/drip.py`): 24,442 URLs
  indexed, **24,429 fetched, 13 permanently failed, 3.01 GB on disk** across
  23,958 distinct content blobs (471 URLs deduplicated by digest). The 13 are
  9 × HTTP 404 and 4 × HTTP 500 — server-side and not retryable; re-running the
  fetch retries them and they fail the same way. Measured rate held at ~15
  URLs/min over the whole run.
  - What it does **not** cover, and would each need their own pass: full version
    history per URL (this took one snapshot each), and `blog.visual6502.org`,
    which is on Blogger and therefore outside this domain index.

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
                                    # per half-cycle. Run this before designing
                                    # anything that wants to draw "what changed".

# 6502 as a service: the stateless engine, and its HTTP reference implementation
cargo build --release -p v6502-sim --bin halfwave   # the warm engine process
cargo test -p v6502-sim --test state                # snapshot/restore, bit-exact
python3 -m pytest service/ -q                       # 125 tests: the service end to
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

# The preservation archive, deployed separately (see its own section below).
python3 archive/tools/build-archive.py && bash deploy/archive-deploy.sh

# Run the original for comparison
python3 -m http.server 8000 --directory extern/visual6502   # /expert.html
```

`web/pkg/`, `web/layout.bin`, `web/blueprint.json`, `web/blocks.json`,
`web/schematic.json`, `web/graph.json`, `web/groups.json`, `web/decode.json`, `web/timing.json`,
`web/build-info.json`, `dist/`, the golden trace
and everything under `archive/` except `urls/` and `tools/` are generated or
fetched, and gitignored. Regenerate after any change to the Rust crates or the
die data.

**Serve `web/` with `tools/serve.py`, not `python3 -m http.server`.** The nav
links point at bare paths (`/schematic`), which nginx resolves with
`try_files $uri $uri.html $uri/`. The stock server does not, so every nav link
404s and the site looks broken while every page is still present. `serve.py`
mirrors the same three-step lookup in the same order — file, then `.html`, then
directory — because a page has to beat a same-named directory.

**`serve.py` also sends the live Content Security Policy**, read out of
`deploy/6502.tinymachines.ai.nginx` at startup so the two cannot drift, on
every response except the `_*` harness documents (whose inline module could
not run under `script-src 'self'`; the pages they frame are not exempt). It
adds `report-uri /__csp-report` and keeps the reports in memory, readable at
`GET /__csp-reports` (`?clear=1` empties them), which is what `_csp-test.html`
polls. See "The CSP is part of the page" under the renderer invariants for
what this cost before it existed.

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

**`google-chrome` headless hangs on this box; use snap `chromium`.** As of
Chrome 149 here, *any* headless page load with `--dump-dom` or `--screenshot`
never returns, including on a trivial static page, and `timeout` kills it with
no output. That reads exactly like a page that failed to boot, and it was
mistaken for one: the control that settled it was running the same invocation
against `/timing`, a page that had not been touched, and then against a
three-line static file. `--version` still works, which makes it look installed
and healthy. `/snap/bin/chromium` returns normally with the same flags and is
what every invocation below should use. Its one limit is the confinement note
further down: it cannot write a screenshot outside `$HOME`.

**`pkill -f <pattern>` will kill this shell.** `pkill -f 'chrome.*headless'`
matches the *full command line* of the bash process running it, which contains
that text, so the shell dies before the pattern reaches anything else. It
surfaces as an inexplicable exit code 144 and no output. The bracket trick does
not help either, because the literal `--headless=new` elsewhere in the same
command line still matches. List with `ps -eo pid,comm` and kill by pid.

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

**Four headless artifacts that look exactly like catastrophic bugs:**

- A screenshot taken after a programmatic scroll to a `#hash`, with a sticky
  header, can come back **blank or with a huge blank band**. Re-capture without
  the hash before believing it.
- `--screenshot=/dev/null` logs an "Unsupported screenshot image file type"
  error. Harmless.
- **`--window-size` below roughly 500px does not narrow the layout, only the
  photograph.** A 390px screenshot of the header came back with the clock select
  off the right edge and the menu button on a third row, while an iframe at a
  real 390px viewport showed everything fitting. The page had been laid out
  wider and then cropped. **Measure narrow layouts in an iframe** (which is what
  `_navfit-test.html` and `_overflow-test.html` do); to *photograph* one, put
  the page in a 390px iframe and screenshot the host.
- **Snap `chromium` cannot write a screenshot outside its confinement.** It fails
  with "No such file or directory" on a path that plainly exists, including
  anything under `/tmp/claude-*`. Write to `$HOME` instead.
- **The bottom 87px of every screenshot is unpainted white.** `--window-size`
  is the *window*; the viewport is 87px shorter, and the remainder is left
  blank. It is exactly 87 at every size, so a fixed footer sits entirely inside
  it and looks like it failed to render. To photograph anything anchored to the
  bottom, add 87 to the height and crop at `h - 87`. **Control for it before
  believing it**: the same band appears on the live site, whose footer is not
  fixed at all, which is what proved it was the camera rather than the page.

Two more things about driving it, both of which cost a round:

- **A persistent `--user-data-dir` often stops `--dump-dom` and `--screenshot`
  returning at all** — the process hangs past any virtual-time budget and
  `timeout` kills it with no output, which reads exactly like a page that failed
  to render offline. It is not reliable enough to distinguish the two. Warm and
  test under a **remappable hostname** (`MAP offline.test 127.0.0.1`, then
  `127.0.0.2`) rather than by stopping the server; that path returns cleanly.
- **Check what is actually listening before believing a result.** A stale
  `python3 -m http.server` from an earlier session held port 8778 and answered
  every request from an old `dist/`; the new server's bind failure was in a log
  nobody read. The tell was the page title being one revision behind.

**"Run it" runs it.** The hero button points at `#explorer`, so the browser does
the scrolling and `app.js` only has to start the chip on click — every
`a[href="#explorer"]` is wired to `setRunning(true)`. The header's copy of that
button is now the program picker (see the Programs section); the sub-pages'
`?run=1#explorer` link went with it, because on those pages choosing a program
*is* the way in. `_handler-test.html` asserts the hero click, and that the two
program controls on the Explorer cannot disagree.

### Deep links

`?program=N&run=1&speed=N&steps=N&find=SIGNAL&panel=NAME&lab=ID&step=N` —
mirrors the spirit of the original's query parameters, and is how the app is
driven in headless checks. `?lab=adc&step=4` opens one moment of a walkthrough,
which is the only practical way to point someone at a specific half-cycle.

**`?program=N` is now honoured by every page and outranks the saved choice**, so
a link that names a program gets that program. Without the parameter, the page
runs whatever was last chosen anywhere on the site.

`blueprint.html` takes `?program=N&run=1&path=CONTROL` — e.g.
`blueprint.html?path=dpc23_SBAC` pins the accumulator's path to the special bus.

`?speed=` is the **simulated clock in Hz** (0 for max), not a frame multiplier.
See the transport section.

### The site menu (`site-menu.js`)

One grouped list, rendered into every header. It was ten hand-copied lists
before this, and **they had already drifted three ways**: the index carried
three About links, most pages carried one, the blueprint carried two, and
`timing.html` had quietly lost "Credit" altogether. Nobody noticed for the life
of the project, because a nav missing one link still looks exactly like a nav.
Same reasoning as `version-footer.js` and `block-palette.js`.

- **A `Developers` group holds the API and the Halfwave Lab**, between the
  measured tables and About: things to build against rather than things to
  read, which is why they are not entries under About. Both are marked
  `off: true`, as the archive now is: **deployed beside this tree rather than
  inside it** (the archive is an alias, `/api/` is a proxy to uvicorn, the Lab
  is its own property), so all three are 404s against the dev server and real
  pages in production. `renderMenu` puts that on the link as `data-off`, so
  `_menu-test.html` skips fetching them **by the data's own rule rather than a
  list of its own** -- it then pins the set (a fourth unverifiable link cannot
  appear silently) and reaches all three against the live site. An absolute
  `href` also gets `rel="noopener"`.
- **The order is a reading order, not a sitemap.** Start here → the chip drawn
  four ways → one instruction at a time → the measured tables → about. `Blocks`
  sits between Exploded and Schematic, which is where it belongs: the exploded
  view is where a reader first meets the twelve, and the workbench is where they
  end up once one block is not enough. A reader
  arriving does not know what a decode PLA is, so the tables come after the
  pages that explain them.
- **Every entry carries one line of what it is**, and that line is the part a
  list of nouns cannot do: Exploded, Schematic and Blueprint are three drawings
  of the same silicon, and the difference is the only thing worth knowing when
  choosing between them.
- **One menu at every width.** The inline row of fourteen links was what forced
  the 80rem breakpoint, so a phone and a desktop were navigating differently
  shaped sites; it could carry neither a heading nor a description. Dropping it
  is also where the header found room for the controls.
- **`./` is right from everywhere except the page itself.** From `/primer` it
  means the index, so the entry for the page you are on pointed at the wrong
  page. It resolves to `#top` now, which every page has on its `<main>`.
- **`site-nav.js` measures the room and sets `max-height`; CSS cannot.** The
  panel hangs off a sticky header whose height is not fixed — on a phone the
  controls wrap it onto a second row — and a `calc(100vh - 4.25rem)` left the
  last group 38px below the fold with no way to reach it. It also needs a
  `ResizeObserver`: the header grows *after* boot when the picker and transport
  are filled in, and measuring only on open cached a 70px header.
- **A dot marks the pages that changed since the previous deploy, and it is
  measured.** `tools/build-info.py` asks git which pages' own files changed
  between the commit that was live and the one being deployed, and stamps the
  list into `build-info.json` as `changed`; `site-menu.js` reads it and dots
  those entries. `deploy.sh` reads the live commit off the current release's own
  stamp, which is the one fact about the previous deploy that cannot drift.
  Nothing decides which pages are new by hand, so the dots cannot go stale the
  way a kept list would, and a new page cannot be forgotten.
  - **Not a fixed number of days, and this was measured rather than assumed.**
    A 14-day window was built first and dotted every entry on the menu, because
    the whole site is two weeks old. Every window either dots nothing useful or
    dots everything, and a constant tuned against today's history is wrong
    again a month later. "Changed since you could last have seen it" is what a
    returning reader means, and it adjusts itself as the site ages.
  - **The page-to-files map is a page's own document and script**, not
    `style.css`, the shared modules or the JSON it reads: those touch every page
    at once and would light every dot at once, which says nothing.
  - **The archive shares `site-menu.js` and stays undotted on purpose**: its
    `build-info.json` is `kind: archive` and carries no `changed` list, and
    `markRecent()` does nothing without one. Failure to load leaves the menu
    exactly as it was; the dots are a courtesy, not navigation.
  - **`_menu-test.html` asserts the DOM agrees with the file**: every page in
    `changed` carries a dot and no page outside it does, with a title and
    screen-reader text on each.
  - **The panel is measured at real viewports now, and the last entry has to
    be reachable.** Every narrow case used to be measured in an 820px-tall
    frame, which is not a phone, so the panel never had to scroll and a
    reachability check could not have failed. At 320x568 it is **458px of room
    for 1937px of menu**. Fitting is not reaching, so the harness scrolls the
    panel to its end and requires the last link to be inside it. Proved by
    removing the scroll box (`overflow-y: visible`), which fails it -- **note
    that `overflow: hidden` does NOT**, because a hidden box is still
    programmatically scrollable in Chrome and only the user is stopped. That
    was the first mutation tried and it passed, which looked like a weak
    assertion and was a wrong proof.
- **The archive's menu is grouped the same way but is not the same list.**
  `shell.py` owns it, split into "The archive" and "The simulator", which is
  the fact a reader most needs: half of those links leave the archive. The
  disclosure wiring in `site-nav.js` is shared verbatim; the list is not.
  `with_extra()` inserts the wiki's Images entry **by label**, replacing an
  index splice that was correct only until somebody reordered the list.

### House style for shipped text

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

### Development harnesses in `web/`

Thirty-three harnesses plus three probes, all prefixed `_` and **never shipped** —
`build-web.py` copies only the files it names, so they cannot reach `dist/`.
They exist because the front end has no other test route and screenshots do not
catch this class of bug.

```bash
_camera-test.html      # zoom limits and pan clamping, asserted
_resize-test.html      # resize the renderer, then read back pixels: is it drawn?
_handler-test.html     # drive every event handler; report anything that throws
_overflow-test.html?w=320&page=trace   # what pushes a page wider than the viewport
_navfit-test.html      # the header, at 12 widths x 4 pages: does it fit, and are
                       # the picker, transport and clock still usable sizes?
_chipnav-test.html     # the shared transport: the rate is a rate (paced with
                       # synthetic timestamps), and every control is one store
_menu-test.html        # every page offers the same menu, every link reaches a
                       # page, and the panel fits the screen it opens on
_contrast-test.html    # every button, every state, checked for readable text
_persist-test.html     # the console's configuration, across a second page load
_pinio-test.html       # pinned I/O chains, vs an independent search of the netlist
_asm-test.html         # the assembler round-trips, the old programs are byte-
                       # identical, and each new one is RUN until its answer lands
_programs-test.html    # the Programs page vs the assembler, timing.json and the chip
_halfshot-test.html    # every recorded frame vs an independent chip, the island's
                       # switch set recomputed, the exported deltas replayed, and
                       # the file's stated encoding decoded by hand and pinned
_halfshot-dump.html    # the export as JSON in a <pre>, for check-halfshot.mjs:
                       # ?gap=1 drives the Record-off path first, ?frames=N grows
_lab-probe.html        # per-half-cycle dump: T-states, decode lines, every bus
_lab-test.html         # every Lab claim, checked against the engine
_primer-test.html      # the primer's numbers re-derived, and its five examples run
_trace-test.html       # cycle counts counted, and ADC landing after the end
_tracer-test.html      # the whole-circuit view: rings, flashed and bright edges,
                       # watch bytes and the current line all recomputed from a
                       # chip of its own; positions from layout.bin itself
_schematic-test.html   # does the drawing contain everything the caption claims?
_solo-test.html        # the study view, driven against the REAL page in an iframe
_solo-shot.html        # ...and into a screenshot: fullscreen needs a click
_exploded-test.html    # the exploded view: do the sliders actually move geometry?
_blueprint-test.html   # the block diagram: drawn, bound, and no label collisions
_decode-test.html      # the decode table, re-checked against the documented ISA
_timing-test.html      # cycle counts, re-checked against the published ones
_block-test.html       # the block pages: the interface and the circuit, re-derived
_block-probe.html      # what one block's signals do, per half-cycle, for its prose
_talk-test.html        # the talk page: every claim re-derived from the JSON by the
                       # harness itself, and the one row that DIFFERS is pinned
_designer-test.html    # the designer page: the clock generator re-walked by the
                       # harness, and the walk re-run WITHOUT its boundary clause
                       # to prove the clause is load-bearing
_blockdiagram-test.html # the published figure: every block re-resolved from
                       # schematic.json by the harness, and the one row that
                       # DIFFERS pinned to the single-bus claim
_archive-changed-test.html  # the archive index's changed-since section vs the
                       # stamp AND the footer, in all three states; run from
                       # the archive's own root (see its header)
_pinout-test.html      # the pinout: directions re-derived by the harness AND
                       # checked against what a 6502's pins are known to do,
                       # because the page and a naive harness could agree
_diegraph-test.html    # the die graph: the harness recomputes every centroid
                       # from layout.bin itself and compares, which is the only
                       # assertion that tests the page's thesis
_ports-test.html       # the block bench's Ports drawer: the filter filters, a
                       # switched-on pill survives a filter that excludes it,
                       # and the drawer is capped to the strip and SCROLLS
_csp-test.html         # every page, with its deep links, booted under the LIVE
                       # Content Security Policy: zero violations reported, and
                       # the policy proven to reach a framed page first
_chipmap-test.html     # the chip map: partition complete and disjoint, every
                       # bundle recounted and every column recomputed from the
                       # raw arrays, the ownership joints pinned by name, and
                       # the tour's every authored claim re-run on its own chip
_tour-probe.html       # per-half-cycle dump of the tour's program: buses,
                       # control lines, and the change set grouped by the
                       # partition. Run it before editing any tour prose.
_graph-test.html       # graph.json against the files it was written from: names,
                       # blocks, roles, centroids (via die-centroids.js), gate and
                       # switch edges vs schematic.json, transistor kinds recounted
```

**A harness that samples state still in flight tests nothing.** `_handler-test`
failed about one run in twenty, and the cause was not slowness: the section
before it clicks fullscreen while `requestFullscreen` still exists, and that
request can take arbitrarily long to be refused when there is no user
activation. Its `setFaux(true)` then landed *after* the next "start from a known
state" check had already read the class list, so every click from there on did
the opposite of what it looked like and the whole section ran inverted. The fix
is `settle()` — poll until the classes stop changing — before establishing a
known state. Found by writing a throwaway instrumented copy that logged every
class mutation with a timestamp; the inversion was obvious in one trace and
invisible in the pass/fail line.

Two lessons that generalise, both of which cost a round here:

- **`settle()` is the wrong tool for asserting that something must *not* happen.**
  It returns as soon as nothing is currently changing, so an assertion about a
  commit that lands 400ms later runs before it and passes either way. Wait past
  the event instead.
- **A fix is not justified until the test fails without it.** The `settle()`
  change alone cured the flake; the app-side guard was verified separately by
  reverting it and watching the new assertion go red. Two earlier versions of
  that assertion passed with and without the fix and were therefore worthless.

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
| `halfphi` | Chip-agnostic: the die-data parser, the netlist, the solver. Names no chip. |
| `v6502-netlist` | The 6502's die data, and the analyses seeded from its names. |
| `v6502-sim` | The 6502 clock/bus layer, timing chain, rewind. |
| `v6502-wasm` | `wasm-bindgen` surface consumed by `web/`. |

### `halfphi`, and why it is separate

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

**~25,800 half-cycles/s native (~12.9 kHz simulated 6502)**, against the
reference JavaScript's 302 half-cycles/s: **85x faster**. A real 6502 runs at
1 to 2 MHz, so this is 77x to 155x slower than the part.

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
- **Throughput and latency are different problems.** One machine is bounded by
  the above; machines per second is bounded by cores, and there are 12.

## 6502 as a service (`halfwave`, `service/`)

The chip over HTTP, one half-cycle at a time. **Live at
<https://6502.tinymachines.ai/api/>** (the page, with /docs and /redoc
beside it), run by `deploy/6502-api.service` behind an `/api/` proxy
location in the site's nginx config. The learning site itself will launch
under its own property: **only the engine and this reference service live in
this repository**, and `service/README.md` is the handbook for whoever
builds it.

**The server is stateless, and the state model is the whole design.** A
machine's entire mutable state is `ChipState`'s four bitsets (value, pullup,
pulldown, trans_on) plus the half-cycle counter, the fetch bookkeeping and
memory: the same fact the keyframed rewind already relied on, turned into a
wire format. Every request carries all of it in; every response carries all
of it back out. `crates/v6502-sim/src/state.rs` owns the codec (lowercase
hex, bit i of a set in byte i/8 LSB-first, the halfshot convention, node
numbering visual6502's own; node sets 216 bytes, the transistor set 439) and
it **refuses** a wrong-length blob or a set bit in the padding, because a
state that decodes to the wrong chip is worse than one that is rejected.

- **`tests/state.rs` is the licence for the whole idea**: restore into a
  FRESH machine (never reset, standing in for another process on another
  day) and run 600 half-cycles in lockstep against the original, comparing
  `state_string` — every node, every half-cycle. And three serialize/resume
  hops of 41 land exactly where one straight run of 123 does. The snapshot
  in that test goes **through the wire format**, not through `Clone`, so
  what is proven is what travels.
- **`halfwave` parses no JSON, and that is the workspace's zero-dependency
  rule holding.** Requests are a line protocol (`BOOT`/`STEP n`/`RUN max` +
  `STATE`/`FILL`/`PAGE`/`WATCH`/`TRACE`, ending `GO`) read with
  `split_whitespace` and `from_str_radix`, which have nothing in them to be
  wrong about; responses are one hand-written JSON line, the emission style
  every export binary already uses. The asymmetry is the point: parse
  simple, emit rich. A malformed line errors the whole block but still
  consumes to `GO`, so one bad request cannot desynchronise the stream, and
  never kills the process.
- **Warm means the netlist, not the session.** The binary parses the netlist
  once and keeps one constructed machine; each request overwrites all four
  bitsets and all 64 KiB. The Python `Pool` is N such processes behind
  per-worker locks, round-robin, respawned on death. `HALFWAVE_BIN`,
  `HALFWAVE_POOL`.
- **There is one assembler and the service does not grow a second one.**
  `/v1/assemble` shells to node running `service/asm-bridge.mjs`, which
  imports `web/asm.js` — the assembler that inverts the disassembler's
  table. A Python port would be the copy that drifts. An `AsmError` comes
  back as a 422 with the line number, never a crash.
- **Memory is sparse and canonical**: a fill byte plus only the 256-byte
  pages that differ from it, both directions. A supplied page that turns out
  to be all fill is dropped on the way back, because "fill everywhere except
  the listed pages" is the entire meaning. The engine expands to a flat
  64 KiB at the boundary; `FlatMemory` journalling is off (the service never
  rewinds; the client re-POSTs an old machine instead, which is what
  statelessness is for).
- **A `Rom` is source, not bytes.** Boot lays the assembled program over
  memory at its org and aims the reset vector there unless told otherwise,
  then `power_cycle()`s through the real reset sequence; the machine comes
  back standing at its first opcode fetch. The test suite pins the
  assembled bytes against a hand-assembled copy written out longhand — the
  same duplicated-on-purpose arrangement `_asm-test.html` uses, because an
  expectation derived from the assembler under test proves nothing.
- **Caps are stated, not silent**: 200,000 half-cycles per request, 10,000
  when tracing, both in `/v1/meta`. `until="instruction"` on a JAM opcode
  returns `completed: false` at the cap — the honest answer, since twelve
  opcodes never reach another fetch.
- **The reviewer's findings (`docs/findings.md`) drove a second round, all
  live**: `GET /v1/nodes` (every resolvable name, grouped by an authored
  reading of the names; **832**, because the die's 846 raw entries hold 12
  duplicate keys and the two bit-5 sentinels; nginx serves exactly this
  route `public, max-age=86400` via an exact-match location while the rest
  stays `no-store`); `until_pc` (a breakpoint: the engine's RUNTO stops at
  the opcode fetch AT an address, read from the latched fetch, `completed:
  false` at the bound); `until: "cycle"`; `alu`/`sb`/`adl`/`adh` on every
  observation, read from their own wires, so the homeless sum is on screen
  (h=37 of the add program: alu and sb read $42 while A reads $2E, pinned
  by a test deriving the half-cycle from A's own transition); CORS `*`
  (stateless, so open on purpose); and `format: "rows"` (the trace as
  columnar rows with stated encodings, asserted to agree with the object
  form column for column; the measured figures on the page are held to a
  band by the test). Two transport rounds later: `watch` is a lowercase
  HEX bitset (`watch_encoding: "hex"`), because a JSON integer is a
  float64 to every browser and silently corrupts past 53 watched names,
  found by a consumer watching 64 and pinned by a regression that requires
  a mask past 2^53; and the API locations gzip
  (`gzip_types application/json` per location, since the global
  gzip_types is commented out and covers only text/html). The named
  latches are first-class observation fields (alu, alua, alub, sb, idb,
  idl, dor, adl, adh, abl, abh, pclp, pchp), each held by a test to equal
  the byte rebuilt from watching its own 8 bits.
- **`pins` drives the input pins** (`res irq nmi rdy so`, levels not
  assertions: four are active low). The drive is a pull on the pad node,
  which lives in the state bitsets, so a pin stays where it was put across
  requests until set again: the suite pins that a machine carrying `rdy`
  low stays stalled with no `pins` field in the next request. It also
  unlocks the interrupt story the API could not tell: `irq` low with I
  clear vectors through `$FFFE`, and the test reads the pushed P off the
  stack to show B clear (an IRQ, not a BRK) with the return address the
  assembler's own label table names.
- **A finding the service surfaced: JSR parks its target in the stack
  pointer.** During JSR's push cycles S does not read a stack pointer at
  all, it reads the LOW BYTE OF THE CALL TARGET: the chip stashes the new
  PCL in S while the address latches are busy pushing the return address.
  Found by a consumer's stack view looking broken, pinned in
  `service/test_service.py` across two subroutines at different addresses
  so the value is shown to track the call rather than being one
  coincidental byte. No behavioural emulator shows this; S is meant to
  step down smoothly.
- **The `/api/` nginx location declares the COMPLETE header set, and must.**
  This config's own top comment is the rule: one `add_header` in a location
  discards every inherited one, so the proxy location restates HSTS,
  nosniff, referrer policy and Cache-Control (`no-store`: every response
  reflects the state just POSTed) beside a CSP of its own. The CSP cannot be
  the site's: api.html carries an inline `<style>` and the generated /docs
  and /redoc load Swagger UI and ReDoc from jsdelivr with inline bootstrap
  scripts and a blob: worker, none of which survives `style-src 'self'`.
  uvicorn runs with `--root-path /api`, which is what makes the generated
  docs ask for `/api/openapi.json`.
- **The unit sets `NODE` and `HALFWAVE_BIN` by absolute path**, because the
  assembler bridge under systemd would otherwise find `/usr/bin/node` (v12):
  the exact trap that once cost a deploy, avoided this time by design.
- **`service/api.html` is the API reference, served at `/`, and the test
  holds it to the app**: every route the app serves must be named on the
  page, and every number it states (caps, blob lengths, node counts) is
  compared against `/v1/meta` and the model constants, so the page cannot
  drift the way prose does. `/docs` and `/redoc` are generated beside it
  from the same Pydantic models.
- **The chip atlas: five routes that answer what a wire is part of, and the
  derivation is the page's, not a second one.** `/v1/nodes` groups the die's
  832 names by an authored regex table and lands 310 in `other`; it says
  nothing about the 674 static-logic nodes the die never named. The atlas is
  the measured half: `/v1/atlas`, `/v1/groups`, `/v1/groups/{key}`,
  `/v1/tags`, `/v1/node/{ref}`, `/v1/neighbors`, plus `/v1/atlas/full`
  (the whole thing in one response: **the exporter's own file byte for byte**,
  328 KB / 48 KB gzipped, less than `/v1/tags` alone costs, so a consumer
  grabs it once and answers every other route locally), served from
  `service/atlas.py` over `web/groups.json` + `web/graph.json`, holding
  **132 groups over 23 kinds covering all 1547 nodes exactly once**.
  - **`web/chip-groups.js` runs under node, and that is what makes this
    honest.** It was already a pure function of `schematic.json`,
    `blocks.json` and `timing.json` with no DOM in it, so
    `tools/export-groups.mjs` imports the module the tracer and the chip map
    draw with rather than porting it to Rust or Python. A second
    implementation of "which container is this node in" is the copy that
    drifts, and there would be no way for a reader comparing the API with the
    drawing to tell which was lying.
  - **Two layers, because a partition is a fact about a DRAWING.** The
    tracer's containers overlap on purpose and the chip map makes them
    disjoint so every node gets one box. `chipGroups()` now records each
    candidate set before the ownership filter as well as after
    (`containers`, additive: the partition, its order and its counts are
    unchanged, and `_chipmap-test` and `_tracer-test` passed before and
    after). Measured: **135 containers, 88 nodes in more than one, five at
    most** (`pipeUNK39` is in `alat:ADL/ABL`, `dbus:rw`, `sdp:sd1`,
    `pipe:unk` and `alu:out`), and **three containers exist only in the
    overlapping layer** -- `sdp:sd1`, `sdp:sd2` and `sbus:link`, absorbed
    whole. SD1 and SD2 are the store-data latches the simulator's own timing
    readout names, so the partition alone cannot answer a question about
    them at all.
  - **`?layer=containers` on a group is the same key read the other way, and
    a test found the need for it.** `intr:nmi` is 20 nodes as a walk and 18
    as a box, because the pipeline latch file outranks the interrupts; the
    two it loses include `pipeVectorA2`, the one address bit by which
    `$FFFA` differs from `$FFFE`. Asserting the finding against the
    partition reported it as absent. The response carries `owned` and
    `claimed_elsewhere` so the difference is visible rather than implied.
  - **Hierarchy is reported, never invented.** A kind is the root; a group
    whose id is `X.Y` is a child of `kind:X` where that group exists, which
    today is the register load lines and nothing else (`regs:a.SBAC` ->
    `regs:a` -> `regs`). Everything else hangs off its kind rather than
    being given a plausible parent.
  - **Bundles are counted the chip map's way, out of `schematic.json`'s gate
    legs and switches, NOT out of `graph.json`'s edges.** The first version
    used graph.json and got 530 bundles / 1602 gate edges against the page's
    534 / 1644: graph.json deduplicates to 2435 distinct input-to-output
    pairs and does not count a precharge as an input, which is a different
    question with a different right answer. Two numbers for one drawing is
    the failure this repo keeps finding, so the exporter uses the page's
    rule and reproduces 534 / 1644 / 310 / 922 / 313 exactly.
  - **Four neighbour relations, kept apart.** `drives` and `driven_by` are
    the two ends of a gate edge and the only pair `direction` applies to;
    `channel` is a pass transistor, which conducts both ways and has no
    direction, reported with the control that opens it; `opens` is a control
    line reaching the ends of its switch, which is not a path through it.
    **A rail is reported and never walked** (eleven gates take vss as an
    input: the permanently-off pull-up that makes RDY and S.O. inputs), and
    `via=control` is opt-in for the reason the schematic walk states:
    `cclk` opens 243 switches.
  - **`/v1/nodes` is untouched and a test says so.** Its shape, its count
    and its eight group names are pinned, because consumers depend on it and
    the atlas is a different claim: the decode NAME group is 132 nodes, the
    decode PLA's product terms are 122, and the API must not imply those are
    one set.
  - **nginx serves the whole static family from one regex location**
    (`~ ^/api/v1/(nodes|atlas|groups|tags|node|neighbors)(/|$)`), replacing
    the exact `/api/v1/nodes` block. Six near-identical exact blocks would be
    six chances to drop a header, which is this config's own documented
    trap. A regex location cannot carry a URI on `proxy_pass`, hence the
    `rewrite ^/api/(.*)$ /$1 break`.
  - Two path routes take `{...:path}`, because **five group keys and 47 die
    names carry a slash** (`alat:ADL/ABL`, `op-T2-ADL/ADD`). The api page
    prints `{key}` and the page-vs-app test strips the converter, checking
    first that a converter existed at all.
  - The atlas loads lazily and its name aliasing is best effort, so a
    missing file is a 503 on these routes and nowhere else, and an engine
    that is down costs the 125 aliases rather than the whole atlas.
  - **The Lab reads the atlas: three ways in, one derivation.** Every readout
  carries `data-atlas` and a delegated click opens an inspector panel between
  the scope and the tabs (ONE panel, not one per tab); an **Atlas tab**
  browses kinds -> containers -> one node with its neighbours; and a
  container's named members can be pushed into the trace's own watch set.
  `ANAMES` maps a UI id to die names and is WRITTEN OUT, not derived from the
  ids: LADH and ADH are two boxes for one latch, ABUS and APIN the same pads
  on two diagrams, and `p` has no bit 5.
  - **`/v1/atlas/full` once, in the background, after the trace lands.** 50 KB
    gzipped, cached a day, `cache: "force-cache"`. Nothing new is on the step
    path. Bundles have to be indexed per group from the dump's FLAT `bundles`
    array: `groups[]` do not carry them, only `/v1/groups/{key}` computes them
    per request, and the harness caught the assumption.
  - **Watching a container RE-RECORDS, and says so.** A trace row's watch set
    is fixed when the row is taken, so `toggleWatch` reboots with the wider
    watch and restores the cursor. `bootBody()` was factored out for it (one
    home for the preset-memory rule) and `fetchTrace` asks `traceWatch()`, so
    a watch survives growing the recording and a power cycle. Proven the only
    way that counts: the eight watched `sb` pills reconstruct exactly the
    `SB$xx` byte the readout strip already reports, 12 of 12 half-cycles.
  - **Neighbours are the one thing the dump does not carry** (no node-level
    adjacency), so they come from `/v1/neighbors`, a few KB per ordinary wire,
    cached in a Map.
  - **The die's alias table comes from `/v1/nodes`**, which the Lab already
    fetched for the decode names: the dump carries ONE name per node and 125
    nodes have more (`sb0` is also `dasb0`).
  - **Machine permalinks: a value fits in a URL, and two forms say two things.**
  The **view** link (~180 chars) carries the program, what was DONE to the
  recording (`HIST.acts`: a grow, a pin pulse), the cursor, the tab and the
  watched containers, and reproduces the machine by booting the same source
  again -- exact, because the chip is deterministic, and the whole recording
  comes back so the reader can step BACKWARD. The **machine** link (~1.7 KB)
  carries the four state bitsets and memory whole, for when no source
  reproduces the state; it arrives with no history and the page says so.
  - **In the hash, never the query.** It never reaches the server, never
    lands in a log or a Referer, and the service worker caches by URL
    without it. `?m=` is accepted too, which is why the base64 is url-safe:
    `URLSearchParams` turns a `+` into a space.
  - **`machineAtCursor` is NOT "boot, then step i".** The recording may have
    had a pin pulsed part way through, and a chip that never saw the pulse
    is a different chip. It walks the same segments the recording was built
    from (300 base, 200 per grow, 16 low + 44 high per pulse), applying each
    segment's pins. Stepping `i` rather than `i+1` is right: trace rows start
    at half-cycle 1, so the receiver's first step makes its row 0 equal the
    sender's row `i`.
  - **The share button read the tab AFTER opening the State panel**, so every
    link made from the header claimed the State tab. `currentTab()` is read
    first and passed in.
  - **Three testing traps, all mine, all worth keeping:**
    - **A mutation test whose child iframe loads a different file tests
      nothing.** Every mutant pointed its iframe at a pristine `plain.html`,
      so four mutations in the READING half passed. Each mutant now ships its
      own child page.
    - **An IRQ pulse on a program that never clears I changes nothing**, so
      the mutant that dropped `pins` produced a byte-identical machine and
      passed. Use NMI, which is non-maskable, when the point is that the pin
      was driven.
    - **Whether plain base64 contains a `+` is data-dependent**: the same
      url-safety mutant passed and failed on the same code when the program
      changed. Assert the claim (the alphabet is url-safe), not a symptom.
  - The header's 4px of horizontal scroll is `.tabs`, a sideways-scrolling
    strip that fourteen tabs cannot fit on a phone. Identical before and
    after; the invariant is that the PAGE does not scroll.
- **`docs/atlas-elk.zip` is a reviewer's ELK layout of the atlas, and every
    claim in it verified against the live endpoint.** elkjs is NOT bundled --
    it would be five to ten times the Lab's whole size for one view, and the
    chip map already draws the whole chip. Two of its findings are used and
    are now pinned in `service/test_atlas.py`:
    - **`ab + ba == gate` for every bundle**, splitting 202 forward / 256
      reverse / 16 both / **60 with no direction, which are exactly the 60
      with `gate == 0`**: pure pass-transistor links, which conduct both ways
      and have no direction to have. The Lab draws those without an
      arrowhead. `regs:s <-> sbus:sb` is the clean case: 16 switches, no gate,
      under `dpc4_SSB` and `dpc6_SBS`.
    - **Pruning is the readability knob, not algorithm tuning**: the median
      bundle carries ONE transistor and 381 of 534 carry two or fewer, so the
      wiring view shows eight and states what it cut and at what weight.
- **`deploy.sh` runs the exporter** after `check-programs.mjs` (where
    `NODE_BIN` is known). The API holds it in memory: `sudo systemctl
    restart 6502-api` after a deploy that changed it.
- **`Cpu::set_last_fetch` exists for restore and nothing else.** The fetch
  is bookkeeping for disassembly, not silicon, so it travels beside the
  bitsets rather than being lost on every hop.

### Cartridges (`service/cartridge.py`), and what minting found

A game on this chip is a ROM plus the handful of addresses the host and the
ROM have agreed on, and there is no hardware to consult about either. So the
console is published (`GET /v1/console`) rather than left to be inferred from
a game that already works, and a cartridge is **one gzipped JSON file carrying
the contract WITH the bytes**: the ROM (bytes, labels and source), the tiles in
both the binary form and as rows of `0..3`, and the console addresses. A
contract in a different file from the bytes it governs is the copy that
drifts, which Die Runner proved when its screen moved and one of four places
naming it was missed.

- **Art arrives in either of two forms and leaves in both.** `chr` is the
  binary tile format as hex, which is what a converter emits; `pixels` is
  eight strings of eight `'0'..'3'` a tile, which is the form something
  writing a cartridge **from text** can actually emit. The Python encoder is
  checked against `games/art/tiles.chr`, a file it did not write (it came out
  of the JavaScript encoder by way of a PNG), so agreeing with it is evidence
  rather than agreeing with itself. `png2chr.py --ascii`'s own `.:o#` glyphs
  are accepted, because a row that has to be retyped is a row that can be
  retyped wrong.
- **The refusals are the point, and one of them was a byte wrong.**
  `validate()` refuses a ROM overlapping its own screen, a ROM or screen over
  the stack page, a ROM reaching the vectors, a contract byte inside the ROM
  or the screen, and two contract fields sharing an address. Every one of
  those assembles and boots first. **The assembler's `end` is the address of
  the LAST byte, not one past it**, and reading it as a half-open bound left
  every check a byte short: a ROM whose final byte was the screen's first
  minted cleanly. Pinned from both sides now, and proved by reverting the fix
  and watching only that assertion go red.
- **Minting runs the thing**, because assembling is not the same as being
  right: a ROM that assembles, boots and never raises its tick flag is a ROM
  that does not run on this console. The report carries frames completed, what
  each cost, whether the screen changed and which tiles are on it. A screen
  that is one value everywhere is called out, because that is what a program
  drawing nothing looks like.
- **The frame cost is measured on an absolute ladder** (128 half-cycles to
  16k, then 1024) and deliberately **not** seeded from anything the cartridge
  declares. Sizing the first step from a declared cost is right for a *host*
  (it makes an ordinary frame one round trip) and exactly wrong for a
  measurement: the same ROM minted at `frame_cost` 512 and at 20000 measured
  6400 and 6250, each number being its own request rounded up.
  **`games/game.js` had carried a declared 12,000 for that reason** -- the
  console requests `frameCost` and then reports what it spent, so whatever was
  written there confirmed itself. Measured, Die Runner's steady frame is
  **8,704**, rock solid over twelve frames, first frame 5,440. The test mints
  the same ROM under two declared costs and requires the same answer.
- **What each watched control line opens is derived, not typed.** `joins` was
  eight strings beside eight names in `game.js`, which is two claims where
  there is one fact; `_joins_for()` asks the atlas. It agrees on five, and the
  three it does not are the useful part: `ADDADL` and `ADHPCH` each open one
  switch a bit and the hand-written pair had named bit 2 and bit 3 where bit 0
  is canonical (bit 7's transistor happens to carry the lowest number on the
  die, so "lowest transistor" is arbitrary and "lowest bit" is not); and
  `XSB` joins `sb0` to a node **the die never named**, so `x0 - sb0` was
  naming the register a reader knows is there. The atlas says that node is
  owned by `regs:x`. The pair is unordered and sorted for determinism: a pass
  transistor conducts both ways, which is why the atlas keeps `channel` apart
  from `drives`.
- **`mtime` is zero in the gzip**, so minting the same cartridge twice gives
  the same bytes and two cartridges can be diffed. A container that changes
  every time it is written cannot be.
- **The sample cartridge is minted at deploy time, never committed**
  (`games/tools/mint.py`, run by `games/deploy.sh`), so it cannot go stale
  against `rom/dierunner.s` and every deploy exercises the endpoint. It
  refuses to write a file whose verification did not complete its frames.

### The registry (`service/registry.py`), and the one place state lives

Builders, their pages, and the cartridges they publish, at
<https://games.tinymachines.ai/builders>. **This is the only stateful thing
behind the API and the boundary is the point:** the chip is untouched, every
request still carries the whole machine, and running a published ROM still
means POSTing it. What is stored is a *catalogue*. One SQLite file, a row per
thing, WAL on so a publish does not block every reader while the chip runs.

- **The registry measures rather than believes, and that is the load-bearing
  test.** A cartridge is a file somebody can edit, so the `verify` block it
  arrives with is a claim by its author. On publish the cartridge is unpacked
  and **run here**, and the size, tile count and frame cost printed beside it
  are what that run produced. A ROM that does not complete its frames on this
  chip is refused rather than listed. The test publishes a cartridge whose own
  block claims a 12-half-cycle frame and requires the stored number to be the
  measured one.
- **Art is only ever rows of `'0'..'3'`.** Converting a photograph happens in
  the browser (`games/art.js`, in a canvas), so there is no image parser in
  the request path, no arbitrary bytes on disk, and the stored form is CHR:
  the same encoding a sprite sheet uses, so `decodeCHR` draws a portrait and
  every builder page looks like the console. Avatars are 8x8 tiles, covers up
  to 24x24.
  - **Dithering is in RGB, not luminance, and that was measured.** By Rec.709
    the palette is 17, 130, 169, 169: **polysilicon and metal are the same
    brightness to within 0.2 of 255** and differ only in hue. A luminance ramp
    therefore has three steps rather than four and throws the warm half of the
    palette away. Floyd-Steinberg in RGB keeps amber and cyan apart.
- **A token is shown once and never stored.** The table holds its SHA-256, so
  a copy of the database is not a copy of everybody's credentials; a lost
  token is re-minted, never recovered. An unknown token and a revoked one get
  the same refusal, because telling them apart is telling somebody which
  guesses were close. One token, one builder. `test_the_token_is_never_stored`
  reads the database file as bytes, which is the only way to check a claim
  about what is *not* in it.
- **A token that is not this builder's gets 404, not 403.** It has no business
  learning whether the builder exists. Revoking leaves the page and its ROMs
  alone: revoking is about the credential.
- **A PATCH touches only what it names**, so a client saving a bio cannot
  blank an avatar it never loaded. `exclude_unset` on the Pydantic side and,
  on the page, pending art held apart from the loaded page. Worth a test
  because the failure is somebody losing work rather than an error.
- **Two bugs found by the tests, both of which only a user would have hit:**
  - The handle regex was `first + optional(middle + last)`, which matches a
    length of 1 or 3-and-up and **never 2**: `rm` was refused while `a` was
    accepted, and the message said "2 to 32" throughout. It is
    `first middle{0,30} last` now.
  - **Slugs were checked against the handle reserved list**, so nobody could
    call their game `game`, `rom`, `console` or `cart`. A handle is a
    top-level path (`/b/api` is confusing) and a slug is not; they are
    different questions and the list belongs to only one of them.
    `check_slug` takes the characters and not the list.
- **A reserved name needs the admin path.** `registry_admin.py grant` is the
  only caller that may take one, because the list exists so nobody *claims* a
  name implying they speak for the project, and the person who can already
  read the database is not who it protects those names from. Weakening the
  list so the project could have its own page would have removed the
  protection for everyone.
- **The database lives outside the checkout** (`REGISTRY_DB`, the unit sets
  `/var/lib/6502-registry/registry.db` with `StateDirectory=`), because a git
  operation must never be able to delete somebody's page.
- **The pages are static documents that read their own path.**
  `/b/<handle>` and `/b/<handle>/<slug>` are nginx regex locations serving
  `builder.html` and `index.html`; the handle and slug come out of
  `location.pathname`, so a published ROM has an address of its own rather
  than a query string. **The regexes are QUOTED**: `{2,32}` unquoted is the
  start of a block to nginx's parser and it fails with "unknown directive"
  naming the middle of the pattern, which is the same trap the 6502 config
  already records for a `map` key.
- `games/site.css` is the shell the four pages share, added when the third
  one would otherwise have carried a third copy of a header and a button.

### MCP (`service/mcp_server.py`): coarse tools, and why

`POST /api/mcp` speaks the Model Context Protocol over streamable HTTP:
`initialize`, `tools/list`, `tools/call`. No session id and no SSE stream, for
the same reason the API keeps no sessions; `GET` returns 405, which is the
spec's own answer for a server that offers no stream. Hand-written JSON-RPC
rather than an SDK, for the reason the engine parses a line protocol rather
than JSON: three methods over one POST is forty lines with nothing in it to be
wrong about, and this service's promise is that it has no dependencies to go
stale underneath it.

- **The tools are coarse where the HTTP routes are fine-grained, and that is
  the same design serving a different kind of client.** The API is stateless
  because a *program* holds the machine: 2 KB of hex out and back, and the
  client's copy is the session. An MCP client is a language model, and a model
  cannot usefully hold 2 KB of hex -- pasting a machine into the next call
  would spend most of a context window carrying a value it cannot read. So
  `run` assembles, boots, steps and reports in one call and the machine never
  leaves the server.
- **`run` renders the screen as two hex characters a cell**, which is the one
  thing that turns writing a 6502 game from guessing into working: an
  assembler says the bytes are legal and only the picture says the program is
  right. The test drives it with two different controller bytes and requires
  the drawn cell to move, because a plausible grid that did not answer the
  input is exactly the failure this exists to prevent.
- **A tool that refuses is a normal result with `isError`, never a JSON-RPC
  error.** The model has to read the reason and try again; a protocol error is
  for the client, and most clients never show it to the model.
- **Addresses are hex with or without a `$`, or an integer.** A model writes
  `$0500` and a program writes 1280, and neither should have to learn the
  other's spelling.
- The five: `console_spec`, `assemble`, `run`, `mint_cartridge`,
  `chip_atlas`. `make_handler` asserts at import that every declared tool has
  an implementation, so a tool cannot be advertised and missing.
- **`/api/mcp` needs no nginx change**: the existing `/api/` location proxies
  with the prefix stripped, and uvicorn's `--root-path /api` handles the rest.
  A deploy that changes any of this still needs
  `sudo systemctl restart 6502-api`.

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
`app.js` (glue + UI), `disasm.js`, `lab.js`, `asm.js` (the 6502 assembler),
`programs.js` (the shared program set, assembled at load), `program-nav.js`
(the header picker), `chip-controls.js` (run state and clock rate) and
`chip-nav.js` (the header transport), `blueprint.js`, `decode.js`, `timing.js`,
`programs-page.js` and `trace.js` (five further pages, see
below), `claim-table.js` (the verdict card, shared by `talk.js` and
`designer.js`), `index.html`,
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

### The Trace (`trace.html`, `trace.js`)

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

#### The instruction's length, measured on this page

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

#### What the measurement said before any of it was drawn

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

### The Tracer (`tracer.html`, `tracer.js`, `die-centroids.js`)

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

### `graph.json`: the chip as one node-and-edge file

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

### The chip map (`chipmap.html`, `chipmap.js`, `chip-groups.js`)

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

### The Exploded view (`exploded.html`, `exploded-gl.js`, `blocks.rs`)

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

#### The blocks (`blocks.rs`)

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

### The Schematic (`schematic.html`, `schematic.js`, `schematic.rs`)

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
  leaves them holding charge. 150 nodes work this way — the same dynamic storage
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

#### Fullscreen is the study view

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

#### The console, and what it found

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

#### Pinning the chip's I/O, and colouring by block

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

#### Explaining it to a reader

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

#### The bit slice is a lie

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

### The functional block pages (`block.html`, `block.js`, `block-notes.js`)

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

#### `--sec-gap`, and why the fix is a token

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

#### The ports are switches, and the block is always drawn whole

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

#### The block circuit is live, and the header transport drives it

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

#### `block-cone.js`: where a block stops, computed once

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

#### "Open in the workbench" opens the workbench

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

#### Every levels slider starts at 1

`sch-depth` and the study view's copy of it defaulted to three, and `state.depth`
with them. The walk *merges* as you follow signals, so arriving at three levels
means arriving at a wall of gates nobody asked for; starting at one and clicking
outward is how the bench is actually used. `bk-depth` was already one.

- **`_schematic-test.html` went red on this, correctly.** Its "a dense cone
  still draws every element" assertion leaned on the page defaulting to three,
  and reported two elements for a signal with forty switches on it. It sets the
  depth itself now: a test about density that depends on somebody else's default
  is testing the default. Fixed, it reports 56.

#### The Ports drawer: capped, scrolling, and filtered

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

#### `web/block.js` contained a raw NUL byte, and grep silently skipped it

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

### The Programs (`programs.html`, `programs-page.js`, `programs.js`, `asm.js`)

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

#### One program, every page

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

### Halfshot (`halfshot.html`, `halfshot.js`, `halfshot-codec.js`, `blueprint-draw.js`)

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

### The transport (`chip-controls.js`, `chip-nav.js`)

Whether the chip is running, and how fast, live in **one store**, and the site
header is its primary view. Four pages ran the chip and each carried its own
copy: three different transports, two speed lists with different steps, and the
exploded view with no rate control at all — so "the same program at the same
speed on two pages", which is the reason several of those pages exist, was not
something the site could do.

**The rate is the simulated clock in Hz, paced against wall-clock time.** Every
one of those old numbers was *half-cycles per animation frame*, which is a fact
about the browser rather than about the chip: the same setting ran at a
different rate on a 60 Hz display, a 120 Hz display, and the software rasteriser
the headless checks use. Hz is what the readouts were already trying to report.
A cycle is two half-cycles, so 1 Hz is two half-cycles a second.

- **One setter per thing, every control a view.** `setRunning`, `setClock`,
  `step`, `reset`; controls repaint from `subscribe()`. Same arrangement as the
  program picker's `choose()`, for the same reason.
- **`?speed=` is now in Hz**, and still beats the saved value, which still beats
  the slowest step. Same precedence as `?program=`.
- **The header slot stays empty on a page with no chip.** Decode and Timing are
  tables of 768 recorded runs; a run button there would have nothing behind it.
  `.nav-chip:empty { display: none }` collapses it, and `_chipnav-test.html`
  asserts both directions — every chip page has one, no measurement page does.
- **The pacing clamp is 500ms, not something tighter.** It stops a backgrounded
  tab returning and running a million half-cycles in one frame, but a clamp
  shorter than a frame silently caps the rate — and the software rasteriser
  manages 2–5 fps, so the page would then be slower than the control says.
- **The study view keeps a clock select of its own**, because it is fullscreen
  and there is no header to reach. Same store, so they cannot disagree. Its
  4/s pacing is gone: that existed only because the page had no rate control.
- `demos.js`'s `createChip` registers *itself* as the driver, so the primer's
  five examples and the programs page's run panel are driven by the header too.
  `setupChipNav()` is then called with no argument.
- **The rate control blinks on the chip's own phase.** `.tick` is held while
  the half-cycle count is even, so it goes on and off once per *cycle* — which
  is what a cycle is here, two half-cycles. It reads `halfCycle()` back off the
  driver rather than running from a timer: a timer would keep blinking after
  the chip stopped and would go on claiming a rate the machine was not
  delivering, which on the software rasteriser is routinely a different number
  from the one requested. Applied from the subscription *and* from a frame
  loop, for the same reason every other discrete action here is.
- **The buttons are sized with `width`/`height`, not `min-*`.** With `min-*` the
  glyph decides the shape and three buttons come out three different widths.
  36px square, over the 30px `_navfit-test.html` insists on for a tap target.
- **`programs.js` carries a `short` name, used only by the header picker.** The
  full name goes everywhere with room for it, and rides on the option's
  `title`. A name clipped mid-word is worse than a shortened one: the reader
  cannot tell which program is selected, which is the one thing the control is
  for. `_chipnav-test.html` measures the rendered text against the control's
  width rather than counting characters, because the font is not the harness's
  to know.

**A discrete step must apply immediately, and the explorer was not doing it.**
Its panels only repainted inside the frame loop, so a step landed on the next
animation frame. That is a real responsiveness bug on its own and it is
invisible until the page is driven somewhere frames are throttled — which is
what an iframe does, and how it was found. `syncToChip()` is now called from the
frame loop *and* after every discrete step. The schematic and the study view
already worked this way; this is the third time this exact bug has appeared here.

**Rate is measured, not read back off the control.** The explorer's readout
counts half-cycles over the window and divides. What the setting asks for and
what the machine delivered are two different claims, and on a slow GPU they are
two different numbers.

**Speed defaults to the slowest step everywhere.** At anything faster the die is
a flicker and the registers are a blur; the point of a transistor-level view is
watching one edge happen.

**`web/package.json` is not shipped.** It exists so node reads `web/*.js` as ES
modules, which is what lets `tools/check-programs.mjs` assemble every program
headlessly in the deploy — the only guard here that does not need a browser.
`build-web.py` copies only the files it names, so it cannot reach `dist/`.

#### What putting a `<select>` in the header cost, and what it taught

Two layout bugs, both invisible to every harness that existed, and the shape of
each is worth more than the fix.

- **A flex item that shrinks to nothing does not overflow, and that is worse.**
  The picker is `flex: 0 0 auto` because without it the header *looked* correct
  at every width while the control had collapsed to **22px** — the layout
  absorbed the problem and handed the reader an unusable widget. Meanwhile the
  header really was overflowing by 88px at 1280 and 359px at 992. So
  `_navfit-test.html` asserts both halves: the header must fit, *and* the picker
  must stay wide enough to read a program name in. Either assertion alone passes
  while the other is broken.
- **`_overflow-test.html` could not have caught it.** It checks 320px, where the
  nav links are behind the disclosure menu — so the row that overflows is not on
  screen. Every desktop width had gone unchecked for the life of the project.
  The links now go inline at **80rem rather than 62rem**, because 62rem was set
  when the row was shorter and the header carried a 90px button.
- **Write the breakpoint for the devices, not for the round number.** The narrow
  rules were at `max-width: 24rem` — 384px — so a **390px phone**, the most
  common width there is, fell through all of them and overflowed its header by
  29px. It is 34rem now. The old rule had been there since before this work and
  was never wrong for the 320px case it was written and tested against.

### The Primer (`primer.html`, `primer.js`)

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

### The talk (`talk.html`, `talk.js`), and the claims it is checked against

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

#### `tests/interrupts.rs`: the BRK that gets lost

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

### The published block diagram (`blockdiagram.html`, `blockdiagram.js`)

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

### The pinout (`pinout.html`, `pinout.js`)

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

### The die graph (`diegraph.html`, `diegraph.js`)

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

### The designer (`designer.html`, `designer.js`)

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

#### The clock generator, derived for the first time

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

#### `claim-table.js`, extracted

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

#### Checked against the published table, 138 rows of it, or 144 asked twice

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

#### Instruction length, measured rather than looked up

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

### The Timing table (`timing.html`, `timing.js`, `export-timing.rs`)

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

### The CSP is part of the page, and nothing in development enforced it

The live site sends `style-src 'self'` with no `'unsafe-inline'`. That blocks
writing a **style attribute** (`setAttribute('style', …)`, or `style="…"` in
an `innerHTML` template) and allows the CSSOM (`el.style.setProperty`,
`el.style.width = …`). The two leave an identical DOM, because the CSSOM
reflects back into the attribute, so no assertion on rendered elements can
tell them apart, and the dev server sent no policy at all. The tracer shipped
with every container colour (`--bc` on regions, beads, halos, capsules, super
nodes) written through `sch-draw.js`'s `el()` as an attribute: on the live
site every container drew grey with one console error per element, while
`_tracer-test.html` was green. A reader's console dump is how it surfaced.

- **`el()` routes a `style` key through `style.setProperty`** and never the
  attribute, so every caller of the shared helper is fixed at once.
- **Run under the policy, the sweep found two pages that had shipped that way
  for the life of the site**: the explorer's layer-key swatches
  (`buildKeyPanel`) and the timing histogram's bars (`style="width:…"` in a
  template: every bar zero wide on the live site), plus the schematic's Ports
  pill swatch. All three set the value from the CSSOM after the template now.
- **`serve.py` sends the live policy** (see the Commands section), so every
  harness that frames a page now frames it under the conditions it ships
  under. The archive builders are not affected: `_*` is the only exemption.
- **`_csp-test.html` frames every page at its own URL, with its deep links,
  and reads the violation reports back from the server.** It proves the
  arrangement first (the header is on the page and not on the harness; a
  style attribute written into a framed page from the harness is reported; a
  CSSOM write is not), because a server that had quietly stopped sending the
  policy would otherwise pass every page forever. Each fix was verified by
  reverting it and watching its entry go red.
  - **A `srcdoc` frame was tried first and rejected.** It inherits the
    parent's policy, and a `<meta>` CSP on the harness did reach it; but
    `about:srcdoc` can carry no query and refuses `replaceState`, so the pages
    that only build something under `?block=` or `?step=` were passing
    vacuously. The check that caught it was the frame reporting its own
    `location.search` back, which came back empty. A harness that feeds a
    page a condition has to assert the condition took.
  - **Chrome deduplicates `report-uri` reports** by document, directive and
    source line, so the harness sees `x1` where the in-page
    `securitypolicyviolation` event fired 262 times. Count sites, not events.

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
- **A `var()` naming a token that does not exist drops the whole declaration,
  silently.** Three invented names — `--panel`, `--panel-2`, `--fg` — spread
  across the exploded and schematic styles before anyone noticed, because the
  usual symptom is "slightly wrong" rather than an error. The one that finally
  showed was the faux fullscreen: `background: var(--panel)` meant *no*
  background, so covering the viewport left the page visible underneath. The
  real tokens are `--surface`, `--subtle`, `--foreground`. Check with a
  `:root`-vs-`var()` diff, not by eye.
- **A bare `.btn` had no `background`,** so it inherited the user agent's button
  face — white, on a dark page. Every secondary button on every page wore it.
  Set `background`, `border-color` and `color` explicitly on the base class;
  variants override.
- **A variant that changes its background must restate its colour**, because the
  base class's *state* rules outrank the variant's resting one. `.btn:hover`
  declares `color: var(--accent)` at specificity (0,2,0) and `.btn-primary`
  declares its colour at (0,1,0), so hovering the primary call to action put
  cyan text on the gold background — two light blues at a contrast ratio of
  **1.08**, and nothing rendered at rest could show it. This is the same shape as
  the missing background above and was found the same way: by somebody pressing
  the button.
  - `_contrast-test.html` now checks every button in `:hover`, `:active` and
    `:focus`. A state cannot be forced from script, so it **re-implements the
    cascade**: collect the rules that would match, sort by specificity then
    source order, resolve `var()` against `:root`, and compute the winning pair.
    Verified by reintroducing the bug and watching it go from 11.31 to 1.08.
  - Two things it has to get right, both of which it got wrong first. A
    `background: var(--x)` shorthand does **not** expand in the CSSOM, so
    declarations are read out of `cssText` rather than from `rule.style`. And the
    page background is a *gradient*, so no ancestor has a background colour at
    all — a transparent button is read against the first opaque ancestor, and
    failing that against `--space`.
- **Anything decided before an `await` must be rechecked after it.** The
  fullscreen handler awaits `requestFullscreen` and then a 120ms verification
  before committing the fallback. Without a guard that commit lands whatever the
  reader has done in the meantime — press Escape during a slow refusal and the
  console drags you into a fullscreen you just cancelled. `setupFullscreen` now
  carries a `generation` counter that every committing path re-checks, and
  Escape bumps it. Pinned by "Escape cancels a fullscreen request still in
  flight", which fails without the guard.
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

### The page shell is a convention, and it is not written in the CSS

Every page carries the same head, header, footer and section classes, and none
of that is enforced by anything. Two of them went wrong on the block pages in
one sitting, and both looked like a stylesheet that had failed to load:

- **Prose sections are `class="wrap sec bp-prose"`, with the eyebrow and the
  heading inside a `<div class="sec-head">`.** `.wrap` carries *no vertical
  padding at all* -- it is max-width and side gutters only -- and `p` has
  `margin: 0`, so a section that is `wrap` alone has every heading butted
  straight against the content above it.
- **The footer is four elements, not one.** `<footer class="site-foot">` is the
  fixed bar; inside it a `.wrap` holds the wordmark, the `.foot-meta` line, and
  a `<span class="version-foot" data-version-footer>`. Putting
  `data-version-footer` on the `<footer>` itself renders the version in the
  page's body font at 16px instead of mono at 11.2px, and silently drops the
  wordmark and the project line.

**Diff the shell against a known-good page rather than reading it.** Blanking
out `<main>`, the title and the description leaves boilerplate that should be
byte-identical to `timing.html`; anything left in that diff is a divergence.
That found the remaining one (script order) in a single pass, after two rounds
of finding them one at a time by eye.

`.bp-prose` also puts a gap between adjacent paragraphs, which is right for a
column of prose and wrong inside a card or a table row, where two paragraphs in
a row are a value and its caption. Turn it off on the component, not on the
section: the section's own ledes still want it.

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

The header has its own four, and they are independent of the explorer's:

| Width | Header |
|---|---|
| ≤ 34rem | picker and clock narrowed, menu button tightened. The "Menu" label stays |
| ≤ 52rem | the control group takes a row of its own; the source link and menu button reorder together |
| < 80rem | nav links behind the disclosure menu |
| ≥ 80rem | links inline beside the controls; ≥ 96rem gives both more room |

**The control group wraps as one thing, and the menu button is reordered with
it.** Program, transport and clock are three controls competing for a row that
already held a wordmark and a menu button; at 320px they want about 90px more
than the viewport has, and a header that overflows scrolls the whole page
sideways rather than clipping. Given a row of its own the group has the full
width to divide up. Source order puts the menu button *after* the group, so
without `order` it wraps to a third row and the header eats 144px of a phone
screen to show three things.

- **Filling the row is not the same as being usable.** With no cap the picker
  grew to 645px on a page whose slot has no transport beside it. It is capped at
  18rem in the wrapped row and floored at 6rem in the narrow one.
- `_navfit-test.html` measures the transport and the clock the same way it
  measures the picker, and for the same reason: a tap target squeezed to nothing
  still renders and still looks like a control.

**There are TWO source links, and the second carries its name.** The simulator
is this site; `halfphi` is the switch-level engine underneath it, published on
its own because it is about switch networks rather than about a 6502 and because
it embeds no die data, which is the only reason it can be MIT. Two identical
octocats side by side is a choice with no answer, so the second is `.gh-lib`:
the mark plus `halfphi` in mono, **hidden below 34rem** where row one is down to
the wordmark and two buttons. The menu's Developers group carries it at every
width, which is what makes hiding it honest. Measured at four widths: 44px +
100px above 34rem, 44px alone below, no header or page overflow anywhere. **The
`.gh-lib` rule is written twice** -- `style.css` and `shell.py` -- because the
archive calls the mono token `--mono` and the simulator calls it `--font-mono`,
the trap this file already documents; and **the archive needs a rebuild** to
pick the shared `site-nav.js` up, since it deploys separately.

**The source link is injected by `site-nav.js`, and is the one header element
that is not hand-copied.** Everything else in the header -- wordmark, control
slots, menu button -- exists in eleven documents plus `archive/tools/shell.py`,
which is the arrangement that had already let ten copies of the nav list drift
three ways before `site-menu.js` existed. A twelfth hand-copied element would be
repeating that knowingly, so `addSourceLink()` inserts one before `.menu-btn` on
every header it wires. The archive gets it without any markup of its own,
because `build-archive.py` copies that file verbatim.

- **Its style has to be restated in `shell.py`.** The archive carries its own
  stylesheet rather than the simulator's, emitted per builder as
  `own CSS + shell.CSS` into `archive.css`, `wiki.css` and `gallery.css`. The
  three tokens the rule needs (`--line`, `--muted`, `--gold`) happen to exist
  under the same names on both sides; `--font-mono` does not, and is `--mono`
  there. **Check the `.css` files, not the HTML**: the header markup is in the
  pages and the header CSS is not, so grepping a generated page for a new rule
  reports it missing when it is present.
- **The pair reorders together below 52rem.** A default `order: 0` strands the
  link beside the wordmark while the button moves right, and the auto margin has
  to sit on whichever of the two comes first or a gap opens between them.
- **The "Menu" label is shown at every width.** It was hidden below 34rem when
  the controls still shared row one with the wordmark and a 90px call to action.
  Since the group took a row of its own at 52rem, row one holds the brand and
  those two buttons and nothing else, so the word fits at 320px. Measured in a
  real iframe: a `--window-size` under ~500px crops the photograph without
  narrowing the layout, so a screenshot cannot answer this.

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

- **A long word in a hero `h1` overflows the page, and every existing heading
  avoided it by luck.** `.hero h1` is Inter 900 at `clamp()` sizes, so at 320px a
  word of about eleven characters is already wider than the column; the first
  heading written with "photographed" in it pushed the whole document sideways by
  4px. `.hero h1` now carries `overflow-wrap: break-word`, which acts only when a
  word cannot fit on a line of its own and therefore changes nothing elsewhere.
  **The bisect is the lesson, not the fix**: hiding any single section still
  overflowed, hiding *all* of them did not, and that looked like "every section
  is guilty". It was not. A shorter page loses its vertical scrollbar, which
  hands back exactly the 4px the iframe scrollbar was taking, so the only
  section-level result that meant anything was the all-hidden one. Two CSS
  changes were made on wrong theories before that was noticed. **When hiding
  things changes the scrollbar, it changes the width you are measuring.**
- **`_overflow-test.html`'s "elements past the viewport edge" list is
  informational, not causal.** A passing page prints a long list of them:
  `timing` at 320px reports its opcode grid at 544px wide and still says PAGE OK,
  because that grid is inside something that clips. Read `scrollWidth` against
  `viewport` for the verdict and treat the list as a starting point only. An
  earlier round here "fixed" a table that was never the problem.
- **A flex item defaults to `min-width: auto`,** so it refuses to shrink below
  its content — and `min-width: 0` on a *child* cannot rescue it. The program
  `<select>` overflowed the console at 320px until `min-width: 0` was set on the
  wrapping `.field`, not just the select. Suspect this for any "why won't this
  shrink" question.
- **Grid tracks need `minmax(0, 1fr)`**, not `1fr`, or the track takes its
  automatic minimum from content. This sized the canvas to 1280×1280 in a 913px
  window.
- **Count columns with `auto-fit` and a real minimum, not with a breakpoint.**
  The schematic's controls went to three columns at 46rem, and a field there is a
  label *and* a pair of buttons — so at tablet widths the label ran through the
  control beside it and the last button was clipped by the console's own
  `overflow: hidden`. `repeat(auto-fit, minmax(13.5rem, 1fr))` cannot make that
  mistake at any width. The label sits above its control at every size for the
  same reason: beside it, the two compete for a track that is already too narrow.
  Found on a tablet, not in a harness — `_overflow-test.html` reported the page
  as fine, because the overrun was *inside* an element that fits.
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

**It installs on the desktop, and already did.** Chrome's bar for that is a
manifest with a name, 192px and 512px icons, a `start_url` in scope,
`display: standalone`, and a service worker with a fetch handler — all of which
were in place. What was added is polish rather than the qualification:
`display_override` for a browser that prefers `minimal-ui`, `launch_handler`
with `focus-existing` so a second launch raises the open window instead of
opening a second one, `handle_links` so in-scope links open in the app, and two
more shortcuts.

- **The remaining gap is `screenshots`.** Without one carrying
  `form_factor: "wide"`, desktop Chrome shows its small install dialog rather
  than the rich one. Adding them means capturing the site headlessly at build
  time, and the deploy runs under systemd where a browser is neither installed
  nor wanted — so this is deliberately not done, rather than forgotten.
- The manifest's `name` is a fourth place shipped text lives, and it is not
  matched by `grep '—' web/*.js web/*.html`. One em dash survived there for a
  whole pass because of exactly that. Check `web/manifest.webmanifest` too.

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

**The simulator's footer is fixed to the viewport, not to the end of the
document.** It is a status bar: which build this is and when it shipped,
readable without scrolling to the bottom of a long page. That costs a strip of
height on every screen, so it is a thin one, and `--foot-h` is *declared* rather
than measured with `body` reserving exactly that much — a last paragraph hidden
under a fixed bar reads as a page that was cut off. Everything in it is
left-aligned and reads in one order: what it is, then which build. The version
used to be pushed to the far edge with `margin-left: auto`, which on a wide
screen put the two halves of one sentence a metre apart. `body.no-scroll` hides
it, as it already hid the header: a footer floating over a fullscreen die is
worse than either. The archive keeps its own in-flow footer and is unaffected.

- **It also says what changed since the previous deploy**, as the same
  `changed` list the menu dots, so the two cannot disagree. Three states, and
  telling the last two apart is the point: pages named and linked to the GitHub
  compare between the two commits; `no page changed` when there is an anchor
  but an empty list, because a footer that goes quiet is ambiguous; and nothing
  at all when there was no previous deploy, since an empty list with no anchor
  is not "nothing changed", it is "nothing to compare against". The archive's
  stamp carries the pair too, measured over ITS pages against ITS previous
  deploy, so this file being shared costs nothing: the same renderer reads
  whichever stamp sits beside it.
  - **The archive's "pages" are its sections, and what changes them is the
    builder that emits them** plus the shared shell and the recovered content
    it is built from -- `ARCHIVE_FILES` in `build-info.py`. The 2.3 GB mirror is
    excluded on purpose: it is somebody else's site, preserved exactly, and
    "changed" is not something we should ever say about it.
  - **The archive is stamped at build time and only the deploy knows what is
    live**, so `archive-deploy.sh` re-stamps just before publishing, reading the
    anchor off the live copy's own `build-info.json` -- the same arrangement the
    simulator's deploy uses, for the same reason: it is the one fact about the
    previous deploy that cannot drift.
  - **The simulator index carries the same section**, and its labels come from
    the rendered menu rather than being written into the page: the slot says
    `data-changed-since="menu"` and the module reads `.navlinks a[data-page]`
    for label and href. Fifteen labels already live in `site-menu.js`, and a
    second copy in the HTML would be the one that drifts. The module cannot
    *import* the menu -- it is shared with the archive, which has no site menu
    -- so it reads the DOM and waits for it, both being module scripts.
    `_menu-test.html` asserts every label in the section is the menu's own by
    comparing the two DOMs, which is the check that a renamed page has to pass.
    - **Above six pages the list folds behind a `<details>` stating the count.**
      A deploy touching every page is a real event -- a shell change, a rename
      -- and should be said, but fifteen bullets is a wall that says less than
      one line. Asserted both ways: three flat, fifteen folded.
    - **Its `[hidden]` rule carries `!important`**, for the reason `#boot` and
      `#app` already taught: the UA's own is only (0,1,0).
  - **The archive index also carries the list as a section**, filled at
    runtime by the same shared `version-footer.js` into a `[data-changed-since]`
    slot. Runtime rather than baked by the builder, because the index is built
    *before* the deploy and only the deploy knows what was live -- the same
    timing gap the footer had. Reading the same stamp means the section and the
    footer can never disagree, and `_archive-changed-test.html` asserts they do
    not, in all three states. The hidden state (no previous deploy) is the one a
    broken fetch would fake perfectly, which is why it is asserted directly.
    - **That harness has to be served from the archive's own root.** From
      `web/` on another port the stamp fetch is cross-origin and blocked, which
      the first version found by failing on every state at once. It is copied
      into `archive/public/` to run and removed afterwards.
    - **The wiki's images contact sheet carries it too**, for the same reason
      the indexes do: it is a page this archive *built* (the backstop that keeps
      every recovered image reachable), not a rebuilt article. The rule is
      "ours, not theirs", and `images.html` is ours.
    - **The gallery chip pages carry it; the wiki articles do not.** The line
      is "is the *page* ours". A chip page is our page around somebody else's
      photographs, and the section only ever describes our deploys, so it is
      honest there. A wiki article is a *rebuilt third-party document*, and a
      note on it saying it "changed" reads as being about the article. The
      harness asserts a sampled article is slot-free and a sampled chip page is
      not, and drives the chip page at depth 2, where its hrefs are
      `../index.html` for the collection and `../../index.html` for the
      overview -- computed from `depth`, which is why they are right.
    - **The mirror under `full/` does NOT carry it, and now cannot quietly start
      to.** `full/` is a symlink into the byte-exact copy of visual6502.org: no
      builder writes those files, they are the original site's own HTML served
      exactly as captured, and this file already records that they keep no
      header for that reason. A changed-since note there would edit the
      preserved copy and would claim change on pages whose whole meaning is
      that they have not changed since 2010. It was asked for, considered, and
      declined with the reasoning stated; the honest alternatives (a wrapper
      page of ours in front of the mirror) were offered and not taken. The
      section already appears on every page this archive *built*, which is
      every page that can carry it truthfully. `_archive-changed-test.html`
      fetches a mirror page and asserts it is free of the section and of every
      other mark this archive adds, so a builder that started rewriting the
      mirror would fail the harness rather than break the preservation silently.
    - **JSSim in particular is untouched, and is now guarded by name.** It was
      asked for after the wrapper page and declined for a stronger reason than
      the landing page: `full/JSSim/` is the original 2010 simulator, and
      `segdefs.js` and `transdefs.js` beside it are **the die data every polygon
      on this site is built from**. Injecting a section means rewriting Greg
      James's HTML in the die data's own directory, and `expert.html` boots a
      running program on load that the injection could break. The honest place
      for our note is `mirror.html`'s JSSim card, which is ours. The harness
      now fetches `full/JSSim/expert.html` and `segdefs.js` specifically -- a
      check that only sampled the landing page could pass while JSSim had been
      edited -- and asserts the copyright notice, the array, and no chrome.
      - **The first draft asserted `var segdefs = [` at byte 0 and would have
        failed on the untouched file**, reading as an edit that never happened:
        the file opens with the authors' copyright notice. That notice is the
        better invariant regardless, being the attribution. Check what a file
        actually starts with before asserting it.
    - **`mirror.html` is the page in FRONT of the mirror**, built by
      `build-archive.py`, and it is where the entry points now go: the menu's
      "Original site" and the overview's "Open the mirror". It says what the
      mirror is, that it has **no way back** (its pages carry the original
      site's navigation and nothing else, because adding ours would mean
      editing them), and offers three counted doors in -- JSSim, the documents,
      the front door -- with the counts computed from the mirror rather than
      typed. It carries the changed-since note honestly, being ours. The mirror
      behind it is asserted byte-identical to its source.
      - **Deep links are NOT diverted through it.** A photograph's
        full-resolution original stays a direct `../full/images/…` link,
        because a reader who clicked a picture wants the picture, not a page
        about the archive. Asserted on a chip page's `class="dl"` links.
      - **The overview's inline chrome became a `page()` helper** the moment a
        second page of ours needed it. Two inline copies of a head and footer
        is the copy that drifts.
      - **Two harness assertions were wrong before the page was**, both in the
        same way. "No `mirror.html` anywhere on a chip page" failed on correct
        behaviour, because the header menu now points there from every page.
        And keying the photograph check on `class="orig"` would have failed
        vacuously on a chip with no description page beside its images; `dl`
        is the per-image link and is on every chip page. **A negative has to be
        aimed at the thing it means, and a positive has to be present on the
        sample it runs against.**
    - **The slot is placed by each page's BODY, after the h1 and lede, never by
      `shell()` before the body.** The first version had every builder's
      `shell()` emit it, and it landed above the title everywhere: a reader
      opening a chip page met a deploy notice before the name of the chip.
      Measured across the five pages by document order, then fixed in each
      builder. Asserted on the chip page: `h1 < lede < slot < banner`.
    - **It is an aside, not a panel, and that took two rounds because it has
      to work in two surrounds.** On the gallery it sits directly above the
      attribution banner, which *is* a panel (2px rule, hard shadow, the
      licence compliance); a second bordered box a hair beneath it read as two
      peers fighting. So: no box, no shadow, a left rule. But on the overview
      that same left rule sat directly under a callout ruled in the accent
      colour, and two left-ruled asides one above the other read as *one
      quotation* -- the note looked like the callout's last paragraph. The rule
      is solid gold, its own signal, with a top margin larger than the gap
      inside any of the archive's own blocks, so it breaks rather than
      continues. **Look at every surround a shared style lands in; fixing one
      collision made the other.**
    - **The harness re-ran itself forever, and it looked exactly like a
      headless hang.** The whole test lives inside `f.addEventListener('load',
      …)`. Checking the sub-indexes means navigating that same iframe, and
      each navigation fires `load` again -- which re-entered the entire handler
      from the top, which navigated again. No title, no output, `--dump-dom`
      never returning: indistinguishable from the Chrome hang this file already
      documents. **Two hypotheses were tested in isolation and "disproved"
      precisely because isolation removed the persistent handler.** The fix is
      `{ once: true }`, and the lesson generalises: a harness that navigates
      its own iframe must not be *triggered* by that iframe's load.
    - **`archive-deploy.sh` now excludes `_*`.** `rsync -a --delete
      archive/public/` copies *everything*, so a harness left in that directory
      would have shipped -- and the first draft of the harness's own comment
      claimed the opposite. `build-web.py` protects the simulator by naming
      what it copies; nothing had protected the archive. Proven with a dry run
      with the harness present: zero would publish.
  - **The `.vf-changed` rule lives in `shell.CSS`, once.** The three builders
    each carry their own copy of the other footer rules already, which is
    exactly the duplication that let ten nav lists drift; a fourth copy in
    three places was not the answer. All three emit `own CSS + shell.CSS`, so
    one rule reaches all three stylesheets, and the tokens it names (`--fg`,
    `--gold`, `--muted`) were checked to exist in each before relying on them --
    a `var()` naming a missing token drops the declaration silently.
  - `_menu-test.html` asserts the footer agrees with the dots, that the diff
    link names both commits, and that the separator's computed `::before`
    content is a real `·` -- the check that would have caught the `␀b7` escape
    below the first time.
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
| API service | `deploy/6502-api.service` → `/etc/systemd/system/`, enabled: uvicorn on 127.0.0.1:6502 behind the `/api/` proxy location |
| Halfwave Lab | <https://halfwave.tinymachines.ai> — `deploy/halfwave.tinymachines.ai.nginx` + `deploy/halfwave-deploy.sh`: the reviewer's package at `docs/halfwave-lab/` (template + `build.sh`, reproducible byte for byte), its built `halfwave-lab.html` served as index.html, with its own `/api/` proxy to the same engine so `location.origin + "/api"` just works. DNS in both split-horizon views; cert via the same webroot flow. Engine-side answers live in `docs/findings-answers.md`, NOT in the package's findings.md, which the reviewer's export tool overwrites wholesale |
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
- **Every page answers to its bare path** (`/schematic`, `/blueprint`, ...) via
  `try_files $uri $uri.html $uri/`. `$uri` first so a real file always wins;
  `$uri.html` before `$uri/` so a page beats a same-named directory, which is
  the ordering that already bit the archive. The `.html` form keeps working, so
  nothing that links to it breaks.
  - **Two other things must change with it, and both fail silently.** The
    Cache-Control map keys on `\.html$`, so a bare path would fall to the
    60-second default and a deploy would take a minute to appear on exactly the
    URLs the site advertises — hence the `~^/[^.]*$` rule, which matches "no dot
    in the path" rather than listing pages, so a new page cannot be forgotten.
  - **And the service worker caches by file, not by route.** `/schematic` is not
    in the precache list (`/schematic.html` is), so offline the first lookup
    misses and the navigation fallback would serve `SHELL` — the *explorer*,
    under the schematic's URL. The fallback now tries `<path>.html` before the
    shell. Verified by loading with a warm profile against a dead IP: the
    schematic and the blueprint each come back as themselves.
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
python3 archive/tools/drip.py --delay 1.5          # done: 24,429 of 24,442
                                                   # (nohup it: survives the session)
python3 archive/tools/drip.py --status             # progress, ETA, failures
```

### The drip (`drip.py`) — complete

The targeted harvest took what was known to be worth having. The drip took the
whole domain index — 24,442 URLs, mostly MediaWiki navigation permutations and
some spam pages from an old compromise — on the principle that the cheapest
moment to collect something is before anyone has decided it matters. Sorting
comes later; collection comes first.

It finished: **24,429 fetched, 13 permanently failed, 3.01 GB** (the estimate
beforehand was ~2.5 GB). The 13 are 9 × 404 and 4 × 500, server-side, and a
re-run fails on them identically.

- State is **SQLite, one row per URL**, committed as it goes. A kill loses at
  most the request in flight. Failures stay pending with their error and attempt
  count, so a re-run retries only those.
- **Digest hardlinking**: CDX carries a content digest, so a URL whose bytes we
  already hold is linked rather than refetched. It deduplicated 471 of 24,442
  (~2%) — these pages differ in small ways — but it is free and would matter on
  a duplicated corpus.
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
