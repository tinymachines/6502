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
| Simulation | Complete. 25 tests, bit-exact against the original. |
| Renderer | WebGL2, 83,227 triangles, live state overlay, GPU picking. |
| Front end | Responsive page (phone → desktop), installable PWA, offline. |
| Hosting | <https://6502.tinymachines.ai> — nginx + a oneshot systemd deploy. |
| Repository | <https://github.com/tinymachines/6502> — **public**. MIT code, NC-SA data. |

Known gaps, all deliberate:

- **Touch gestures are unverified on real hardware.** Pinch/pan/tap are
  implemented and the plumbing is right, but headless Chrome cannot synthesise a
  two-finger pinch. Needs a phone.
- **Mobile GPU performance unmeasured.** Every headless number here is
  SwiftShader software rasterisation (~2–5 fps), which says nothing about a real
  device.
- No CI. The tests and checks below are run by hand.

## Commands

**Toolchain gotcha:** a stray `/usr/bin/rustc` (1.75) shadows rustup's shim in
`PATH`, and cargo 1.97 invoking it fails with `-Z unstable-options ... check-cfg`.
Prefix every session:

```bash
export PATH="$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin:$PATH"
```

```bash
cargo test --workspace              # 25 tests: netlist, functional, golden, rewind
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
python3 -m http.server 8777 --directory web        # http://localhost:8777/

# Web app, production shape: content-hashed bundle + service worker into dist/
python3 tools/build-web.py web dist

# Regenerate the PWA icons (only after changing the artwork)
python3 tools/make-icons.py web/icons

# Publish. Does all of the above, verifies it, and swaps the live symlink.
sudo systemctl start 6502-deploy
journalctl -u 6502-deploy -n 40

# Run the original for comparison
python3 -m http.server 8000 --directory extern/visual6502   # /expert.html
```

`web/pkg/`, `web/layout.bin`, `dist/` and the golden trace are all generated and
gitignored. Regenerate after any change to the Rust crates or the die data.

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

`?program=N&run=1&speed=N&steps=N&find=SIGNAL` — mirrors the spirit of the
original's query parameters, and is how the app is driven in headless checks.

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
`app.js` (glue + UI), `disasm.js`, `index.html`, `style.css`.

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
  common phone width.

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
copy is the source of truth but is not read live.

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

A mirror of visual6502.org, which is decaying. Separate from the simulator and
deployed separately; see `archive/README.md` for the full account.

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

```bash
python3 archive/tools/wayback-index.py --refetch   # rebuild the URL manifests
bash     archive/tools/mirror-live.sh              # crawl what the site links
bash     archive/tools/harvest-site.sh             # the 2.3 GB nothing links to
python3  archive/tools/harvest-wiki.py             # the wiki, out of Wayback
python3  archive/tools/build-archive.py            # -> archive/public/
sudo bash deploy/archive-deploy.sh                 # publish to /archive/
```

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
- **Two images have no copy at any resolution**, and they are the two that matter
  most: hand-drawn 6502 schematic sheets dated November 1974 and August 1975.
  Description pages survive; the scans do not.
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
  moment that site does.
- **`archive/public/full` is a relative symlink** to `../mirror/visual6502.org/images`,
  so `mirror/` must be published as a *sibling* of `archive/`. `rsync -a`
  preserves the symlink instead of copying 2.3 GB through it.
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
