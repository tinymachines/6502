# Engine-side answers to the Lab's findings

The reviewer's tool exports `halfwave-lab/findings.md` wholesale, so answers
appended there get clobbered on every export (it happened once). This file
is the engine side of the conversation, and nothing overwrites it. Section
references like §1.2 point into the findings file as it stood at the time.

## 1. First round (2026-08-20)

Appended after check-in, so the record closes where it was opened.

### 1.1 §1.2 answered: the fix landed in the solver, and the invariant already exists

It is story (a), and not by inference: the fix is one line in
`halfphi/src/engine.rs::recalc_node`, which now skips rails in the loop that
writes a group's resolved level into every member's storage. Nothing clamps
anything at serialization time; the halfshot writer reads the same storage it
always read. Before the fix, a group joined to both rails resolved to Vss and
wrote `false` into vcc's own storage cell -- the reference implementation does
exactly the same -- and it was unobservable to the solver because a rail
resolves by identity, never by its stored level. The reported level was wrong;
every input the solver fed downstream was right. That is (a) as stated.

The requested invariant also already exists where §1.2 asks for it:
`rails_hold_their_level_at_every_half_cycle` in
`crates/v6502-sim/tests/functional.rs` asserts both rails at every half-cycle
of a run, and goes red when the `recalc_node` line is reverted. A future
change to group resolution fails loudly in the test suite, not on write-out.

Two corroborating facts, both recorded in CLAUDE.md at the time: the fix
changed behaviour on another die entirely (the Z80 now converges from a cold
power-on; it has 32 vcc-gated transistors that the bouncing rail was toggling,
where the 6502 has none), which a serializer clamp could not have done; and
"only node 657 differs" is the expected shape, since vss's stored level
already matched its resolved value.

### 1.2 §2.2 shipped

The api page's demo section now watches `dpc23_SBAC` beside `dpc17_SUMS` and
says which is held and which fires, with the h=36/h=38 story spelled out
(commit caf4ff2). The claims are pinned by a test that re-runs the section's
recipe and derives every number the prose states, verified able to tell by
corrupting the page and watching it go red. The sharper framing in §2.2's
cycle table ("the add happens after the instruction is over") is the same
story the site's Lab and chip-map tour tell for ADC, and it is right.

### 1.3 §4's last loose end

`/trace` and `/halfshot` do overlap the Lab in subject, not in framing:
trace is any-opcode tables plus the shorted-wire groups, halfshot is a
recorded gallery of the full plate. Nothing on the site draws the 19-edge
spine with narration generated from the same booleans as the picture; that is
new, and the "ADL->PCL conducts on every fetch, a jump is ADL->PCL without
PCL->ADL" reading in §3.3 is a genuinely good measured lesson.

### 1.4 The suggestion list, shipped (same day)

§2.3, §2.4, §2.6, and both halves of §2.7's until wishes, plus the rows
half of §2.5, are live:

- `GET /v1/nodes`: every resolvable name with its id, grouped (the grouping
  an authored reading of the names, said so). The count is **832**, and the
  846 in the docs was wrong in an instructive way: the die's table carries
  846 raw entries, 12 are duplicate keys that collapse under JS object
  semantics (the reference's own parse does the same), and 2 of the 834
  remaining are the bit-5 sentinels `p5`/`Pout5`. nginx serves this one
  route with `public, max-age=86400` where everything else is `no-store`.
- `until_pc`: a breakpoint on the opcode fetch at an address, RUNTO in the
  engine, `completed: false` at the bound. `until: "cycle"` too.
- `alu`, `sb`, `adl`, `adh` on every Observation, read from their own
  wires. The homeless sum is now on screen: at h=37 of the add program,
  `alu` and `sb` both read $42 while `a` reads $2E, pinned by a test that
  derives the half-cycle from A's own transition.
- CORS `*` via middleware; OPTIONS preflight answers 200.
- `format: "rows"`: the trace as columnar integer rows (`{cols,
  watch_names, rows}`), stated encodings, watch packed to a bitmask. The
  suite asserts it agrees with the object form column for column; measured
  3.7x smaller at 45 half-cycles with 2 watches and 7.5x at 133 with 22,
  the ratio growing with the watch list.

§1.3 shipped in the same round: halfshot exports now carry `build`
(`commit`, `committed`, `exported`), optional so old files stay valid,
validated by `check-halfshot.mjs` when present, asserted on the real page's
export by `_halfshot-test.html`. Still open from the list: only §2.5's
`fields` parameter (rows shipped instead).

### 1.5 The second round of tweaks, and the Lab's adoption (2026-08-20, later)

The rows compression claim is stated as the measured band above (it said
"about a tenth"; the reviewer measured 6.4x and was right to object), held
by a test that re-measures the 45/2 shape and asserts the page's figures.
The 49 `dpc*` lines moved out of `decode` into their own `datapath` group
on `/v1/nodes`, filed by what they operate rather than what drives them;
partition still sums to 832, count pinned. Both in commit 0ac7b66.

The checked-in Lab (`halfwave-lab.html`) now consumes the new surface:
`format: "rows"` for its traces, and the `alu`/`sb`/`adl`/`adh` fields,
with an ALU-op readout and a stale-value treatment for a bus reading that
is no longer driven.

## 2. The transport round (2026-08-20, the packaged findings and issues/)

The package (`halfwave-lab/`) arrived with eight filed issues. Dispositions:

- **01 watch bitmask precision: shipped.** `watch` is a lowercase hex bitset
  now (bit i in byte i/8, LSB first: the state blobs' own convention),
  fixed width, with `watch_encoding: "hex"` on the wire as §5.6 suggested.
  The regression test watches the 64 names from the issue and requires a
  mask past 2^53 before checking every bit of every row against the object
  form. The Lab template gained a dual-mode `wbit()` (hex or legacy
  integer, for its packed demo) and was rebuilt and redeployed; the fix
  also removes the 32-bit ceiling its own `>>` reads had.
- **02 gzip: shipped, both origins.** One stanza in each of the four API
  proxy locations (`gzip_types application/json`, level 5, min 860). A
  40-row 64-watch rows response is 2,417 bytes on the wire. The static
  halfwave index was already covered by the global text/html default.
- **03 promote latch fields: accepted, next round.** Same discipline as
  alu/sb/adl/adh: named storage read from its own wires.
- **04 TraceRows docs: shipped.** The boundary is stated ("measured on the
  trace payload alone; the machine, identical under both formats, is
  excluded") and the size claim carries the gzip caveat: gzipped the forms
  nearly converge, and rows earns its keep as parse time and allocation.
- **05 NDJSON streaming: deferred, on the issue's own numbers.** TTFB is
  server compute, transfer is under 5 ms, and a batching consumer has no
  per-step round trip to eliminate. The stateless answer to progressive
  rendering already exists: shard the run into smaller /v1/step slices and
  render as each machine returns; that is streaming with no new protocol,
  and it parallelises across workers, which one chunked response cannot.
  Revisit if a consumer genuinely needs a single 10,000-row response drawn
  as it computes.
- **06 rail fix location: closed by §1.1 above.** Solver, one line, and the
  invariant is `rails_hold_their_level_at_every_half_cycle`, red without it.
- **07 export build stamp: closed, shipped earlier** (commit 5c17f44), with
  the validator checking the shape when present.
- **08 export invariants in CI: covered where the checks live.** Every
  invariant on the list is asserted by `tools/check-halfshot.mjs` (rails
  untouched by deltas, replay clean, h/ph/clk0 structure, open==controls,
  padding, even frame count ending phi2) or the Rust suite
  (contested_groups, nonconvergent_settles). CI itself is this repo's
  documented deliberate gap; the checks run by hand and in the deploy.

## 3. Issue 03: the latches, promoted (2026-08-21)

`alua`, `alub`, `idb`, `idl`, `dor`, `abl`, `abh`, `pclp`, `pchp` are
first-class Observation fields beside the four that already were, each byte
read from its own wires, in the object form and as rows columns. The test
that keeps the promotion honest: every field must equal the byte rebuilt
from watching its own 8 bits, on every half-cycle of a run.

The payoff on the demo trace is the whole mechanism in three fields: at
h=36 the operands sit in `alua`/`alub` ($2E, $14) while sync is already
high for the next fetch; at h=37 the sum is real in `alu` and on `sb`
while A still reads $2E and `idl` already holds the next opcode ($85, STA);
at h=38 A takes it. "The add happens after the instruction is over," now
visible field by field, and the api page's demo section walks exactly that.

## 4. Two new tabs, and the bug adding them caught (2026-08-21)

The Lab gained a **Latches** tab (the thirteen named-storage fields as their
own diagram, boxes lit by movement, drawn from the promoted fields) and a
**Half-cycle** tab (the generated narration at full width, a before/after
table of every value, and the conducting lines), both after Datapath. With
issue 03's fields native, the Lab's second 40-watch request and its merge
went the way the capturer's own comment predicted: one call now, and the
demo is recaptured from the live API so the packed and live paths are the
same shape again (hex watch included).

The catch on the way in: `bit()` still read the watch mask as an integer
(`o.w & (1<<n)`), so since the hex switch every control-line read on the
live path had been silently false: dark edges, empty narration beats, a
perfect-looking page. The redeploy check after the hex change had verified
only the connection badge, which is the dead-overlay mistake the simulator's
own docs warn about. Fixed with the same wbit() the other two call sites
got, and the deploy verification now asserts lit edges and a non-trivial
narration, which is the check that fails when an overlay dies.

Revised same day: the Half-cycle tab came back out as redundant on arrival
(its narration is the Datapath sidebar's, its table the Latches diagram's,
its pills the Signals tab's), and "Inside the boxes" moved out of the
Datapath tab into its own **Bits** tab instead. Tabs now: Datapath, Latches,
Bits, Signals, State, Program.

## 5. The PWA round (2026-08-21)

The Lab is an installable PWA: manifest (name Halfwave, standalone, the
half-wave glyph icons generated by `src/make-icons.py`, maskable variant
inside the safe zone), a service worker with a stated strategy (network
first with cache fallback for the shell; `/api` never touched, because
every response there reflects the machine just POSTed), and the vhost
gained the webmanifest MIME type this nginx lacks. Proven offline in one
CDP session: install online, cut the network at the browser, reload; the
worker serves the shell and the app degrades to its packed trace with all
seven tabs and the latch commentary working, which is exactly the design.

Mobile tucked in: the header is locked to the top with tabular digits and
reserved widths on the counter, phase pill, and scrubber label, so the
chrome no longer jumps as numbers grow; the transport is the footer, fixed
to the bottom at every width with safe-area insets; the page never scrolls
sideways (`overflow-x: clip`, with the wide diagram and grids scrolling
inside their own boxes).

The narration moved to a **Story** tab (per request), joined by a new
generated section, **the latches read**: sentences derived per half-cycle
from the latch bytes and control booleans: the PC primes waiting for their
write-back (and whether it is happening now), the output latches holding
the pins steady while ADL/ADH move on, IDL's byte and whether it is the
executing opcode, the adder's inputs, result, and whether anyone is taking
it, DOR staged or driving. Nothing authored per instruction.

Two catches on the way: the vhost CSP of `script-src 'unsafe-inline'`
without `'self'` silently blocks service worker registration (a worker is
a script resource); and every headless one-shot load exits before the
async install completes, so worker verification needs a browser kept
alive (CDP) rather than --dump-dom, whose persistent-profile mode hangs,
as the 6502 docs already warn.
