# 6502 as a service: halfwave, the API, cartridges, the registry, MCP

The engine over HTTP, and the one place state lives. Split out of `CLAUDE.md`. See also `service/README.md`, which is the handbook for whoever builds on it.

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
  `STATE`/`FILL`/`PAGE`/`WATCH`/`TRACE`/`ROWS`, ending `GO`) read with
  `split_whitespace` and `from_str_radix`, which have nothing in them to be
  wrong about; responses are one hand-written JSON line, the emission style
  every export binary already uses. The asymmetry is the point: parse
  simple, emit rich. A malformed line errors the whole block but still
  consumes to `GO`, so one bad request cannot desynchronise the stream, and
  never kills the process.
- **Warm means the netlist, not the session.** The binary parses the netlist
  once and keeps one constructed machine; each request overwrites all four
  bitsets and all 64 KiB. The Python `Pool` is N such processes behind
  per-worker locks, respawned on death. `HALFWAVE_BIN`, `HALFWAVE_POOL`.
- **Twelve chips, started at boot rather than on first use.** A chip is
  **3 ms and 2.2 MB** measured, so the pool is 40 ms and 26 MB and there is
  nothing to weigh. Lazy spawning made "a pool of warm instances" false for
  exactly as many requests as there are workers; `Pool.warm()` runs in the
  lifespan and a worker that fails to start is left for the next request
  rather than refusing the boot.
- **It does not buy twelve times the throughput, and the docs must not imply
  it.** Best of three, 24 concurrent requests of 3000 half-cycles: pool
  1/4/6/8/12 gives **1.00x / 3.74x / 4.49x / 5.09x / 5.55x**. This is a
  **6-core** part with two threads per core, and the solver is compute-bound
  (IPC 2.04, 1.28% L1 miss), so the second thread on a core has little to
  interleave with. An earlier note here claimed "12 cores, so a 12x win" and
  was wrong on both counts: six physical cores, on a box whose load average
  was 14 at the time of measuring.
  - Twelve still beats eight, which is why it is twelve. Spare chips absorb
    scheduling jitter on a shared host for 2.2 MB each.
  - **Per-size noise is 1.05x to 1.20x here**, so single runs cannot rank
    adjacent sizes: one run had 8 beating 12. Best-of-three makes the curve
    monotonic. Same discipline as the solver bench.
- **The HTTP layer is not the limit, and that was checked rather than
  assumed.** With the work set to one half-cycle the same path serves about
  **980 requests a second at roughly 1 ms each**, so at 50 req/s of real work
  the framework is nowhere near the ceiling.
- **The pool picks an idle chip, not the next one.** Round-robin alone hands
  out the next worker whether or not it is busy, so a request could queue
  behind a chip mid-settle while eleven sat idle. The sweep starts at the
  round-robin cursor so an unloaded pool still spreads out.
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
- **The engine names itself**: `halfwave --version` and the `META` reply
  carry the workspace version and the commit the binary was built from,
  stamped by `crates/v6502-sim/build.rs` out of `.git` (no `git` on the
  PATH needed; `-dirty` when the tree was not clean, `unknown` outside a
  checkout). `/v1/meta` passes both through, so a site in front of this
  service can check which engine is answering rather than hashing the file.
  A release does not rebuild halfwave, which is exactly when that matters.
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
  band by the test). **The rows are packed by the engine, not the
  service**: `ROWS` is a halfwave line beside `TRACE`, and
  `v6502_sim::rows` is the one packer, the same function the wasm
  `Machine`'s `traceRows` calls, so `app.py` encodes no column at all and
  passes `trace_rows` through. It used to re-encode halfwave's objects in
  Python, which was a second implementation of the format the moment the
  browser needed a first; `tools/check-wasm-parity.py` now holds the two
  ends bit-identical over all 34 columns, and `tests/rows.rs` holds the
  packer to `observe()`. Two transport rounds later: `watch` is a lowercase
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
    after). Measured when it was built: **135 containers, 88 nodes in more
    than one, five at most**, and three containers existing only in the
    overlapping layer. Adding the three `dpc` clock-phase sets afterwards
    moved all three numbers, and today's export reads **138 containers, 122
    nodes in more than one, still five at most** (`pipeUNK39` and
    `pipeUNK41` are each in `alat:ADL/ABL`, `dbus:rw`, `sdp:sd1` or
    `sdp:sd2`, `pipe:unk` and `alu:out`), with **six containers existing
    only in the overlapping layer** -- `sdp:sd1`, `sdp:sd2`, `sbus:link`,
    `dpc:phi1`, `dpc:both` and `dpc:unreached`, absorbed whole. The `dpc`
    three claim nothing by construction: a clock phase is added last, when
    every one of its nodes already has a derivation that explains it. SD1 and SD2 are the store-data latches the simulator's own timing
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

## Cartridges (`service/cartridge.py`), and what minting found

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

## The registry (`service/registry.py`), and the one place state lives

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
- **The issuer's copy lives in `tools/keys.py`**, a SQLite store at
  `~/.tinymachines/keys.db`, directory 700 and file 600. The registry is the
  *verifier* and keeps no secrets; that is the other half, the issuer's
  notebook, and it keeps nothing else. Losing it costs the ability to re-send
  a token to whoever holds it and lets nobody in, because the registry
  authenticates against its own hashes and never reads it. **SQLite has no
  server**: it is a file and a lock, reachable by one account on one machine,
  and putting credentials on a network port would be a different decision with
  a different threat model.
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

## MCP (`service/mcp_server.py`): coarse tools, and why

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
