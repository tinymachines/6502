# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A transistor-level MOS 6502 simulator in Rust/WASM, being built into a visual
explorer for the chip. Nothing here models 6502 *behaviour* — the behaviour falls
out of simulating 3510 switches. Every register value is read back out of storage
nodes; every cycle count is emergent.

`extern/visual6502/` is a checkout of [trebonian/visual6502](https://github.com/trebonian/visual6502),
kept **read-only** as the source of the die data and as the correctness oracle.
Do not edit it.

Status: simulation core and WebGL renderer both working and verified.

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

# Web app: build the wasm, export the geometry, serve
wasm-pack build crates/v6502-wasm --target web --out-dir ../../web/pkg
cargo run -p v6502-netlist --bin export-layout -- web/layout.bin
python3 -m http.server 8777 --directory web        # http://localhost:8777/

# Run the original for comparison
python3 -m http.server 8000 --directory extern/visual6502   # /expert.html
```

Both `web/pkg/` and `web/layout.bin` are generated and gitignored — regenerate
after any change to the Rust crates or the die data.

### Verifying the renderer without a browser

There is no browser automation configured, but Chrome is installed and headless
WebGL works via SwiftShader:

```bash
google-chrome --headless=new --no-sandbox --enable-unsafe-swiftshader \
  --use-gl=angle --use-angle=swiftshader --window-size=1600,1000 \
  --virtual-time-budget=25000 --screenshot=/tmp/shot.png \
  "http://localhost:8777/index.html?steps=51"
```

Expect ~5 fps under SwiftShader; that is software rasterisation, not the
renderer. Add `--dump-dom` and write values into the DOM to read measurements out
of the page.

**Diffing two screenshots is the only reliable check that the state overlay is
live** — a dead overlay still renders a perfect-looking die. Capture `?steps=0`
and `?steps=51` and compare the canvas region; roughly a third of pixels should
change.

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

### Verifying the live site

```bash
google-chrome --headless=new --no-sandbox --enable-unsafe-swiftshader \
  --use-gl=angle --use-angle=swiftshader --window-size=1600,1000 \
  --virtual-time-budget=30000 \
  --screenshot=/tmp/live.png "https://6502.tinymachines.ai/?steps=51&find=sync"
```

This exercises the real TLS, the real CSP and the real cache headers — worth
doing after any nginx change, since a CSP mistake produces a blank canvas rather
than an error. Add `--host-resolver-rules="MAP <host> <addr>"` when testing from
inside the network that hosts it.

## Licensing — read before shipping

See `NOTICE.md`. The short version: this project's code is MIT, but
`segdefs.js`/`transdefs.js` — the die data, which `netlist.bin` is derived from and
which is embedded in every artefact — are **CC BY-NC-SA 3.0**, attributed to Greg
James / visual6502.org. **NonCommercial and ShareAlike propagate to anything shipped.**
Surface this before any distribution or monetisation decision; do not silently
relicense.
