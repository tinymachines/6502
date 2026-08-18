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
| Simulation | Complete. 83 tests, bit-exact against the original. |
| Library | `halfphi`, extracted and published. Loads the 6502, the 6800 and the Z80. |
| Renderer | WebGL2, 83,227 triangles, live state overlay, GPU picking. |
| Front end | Responsive page (phone → desktop), installable PWA, offline. |
| Controls | Program, transport and clock live in the header and drive every page. The rate is the simulated clock in Hz. |
| Menu | One grouped list with sub-heads and a line per entry, shared by the simulator and the archive. |
| Programs | Seven programs as **source**, assembled in the page, annotated, run on the chip. One choice, shared by every page. |
| Halfshot | The chosen program recorded one frame per half-cycle: a fixed plate of registers, buses, pins and memory, and an island of what switched. Every node at every edge, exportable losslessly. |
| Primer | The mental model, corrected one step at a time. Every number derived, every claim runnable. |
| Lab | Four instructions followed opcode → decode PLA → bus → register. |
| Trace | Any of the 256 opcodes, half-cycle by half-cycle, with the wires that are one wire. |
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
| Archive | <https://6502.tinymachines.ai/archive/> — visual6502.org, preserved. Full Wayback sweep complete: 24,429 URLs, 3.01 GB. |
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
cargo test --workspace              # 86 tests: netlist, functional, golden,
                                    # rewind, blueprint, pla, decode, blocks,
                                    # interrupts
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

# Every measured cycle count and byte length against the published instruction
# table: 138 of its 150 rows in about four seconds, against the 33 the
# hand-typed checks cover. RESCAN=1 re-reads the pages the first pass could not
# resolve and reaches 144, taking twenty seconds. SKIPS without the manual in
# reference/ (gitignored, not redistributed); REQUIRE_MANUAL=1 makes its absence
# a failure. deploy.sh runs the fast path.
python3 tools/check-timing-vs-manual.py
RESCAN=1 python3 tools/check-timing-vs-manual.py

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
`web/schematic.json`, `web/decode.json`, `web/timing.json`,
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

Thirty harnesses plus two probes, all prefixed `_` and **never shipped** —
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
                       # switch set recomputed, and the exported deltas replayed
_lab-probe.html        # per-half-cycle dump: T-states, decode lines, every bus
_lab-test.html         # every Lab claim, checked against the engine
_primer-test.html      # the primer's numbers re-derived, and its five examples run
_trace-test.html       # cycle counts counted, and ADC landing after the end
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

**The source exists in two repositories and nothing keeps them in sync.** The
five shared files are byte-identical today and drifted on whitespace within
minutes of the split. `tests/chips.rs` searches two candidate paths for the die
submodule precisely so one file can be correct in both layouts. The real fix is
a git or crates.io dependency; until then, changing one copy means changing the
other and re-checking with `diff`.

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
