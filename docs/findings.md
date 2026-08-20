# Findings & improvement ideas

Session notes covering the halfshot trace export, the HTTP API, and the Halfwave Lab
consumer app. Each item is marked **verified** (I ran it) or **suggestion** (I didn't).

---

## 1. Halfshot trace export

### 1.1 v1 → v2: all four issues closed — verified

Re-ran the same diagnostics against `halfshot-fibonacci-256.json`:

| Issue in v1 | State in v2 |
| --- | --- |
| Node 657 (`vcc`) toggled 80× — 40 down, 40 up | 0 toggles. `vss` also 0. |
| No bit-order / padding declaration | `encoding` block states LSB-first, zero-padded |
| `units.p` was `[22, 223]` with no schema | documented as `[value, mask]`; reconstructs `$36` |
| Trace ended h=256 ph1, dangling | ends h=255 ph2; stray `{start:256,end:256}` entry gone |

Also still clean: delta replay from frame 0 `levels` gives **zero violations**, structural
invariants (`h`, `ph`, `clk0`, `len(open) == len(controls)`) hold on all 256 frames, padding
bits 1725–1727 are zero, and the Fibonacci writes to `$F2` are 1, 1, 2, 3, 5, 8.

### 1.2 Open question: did the 657 fix land in the solver or the serializer?

Diffing reconstructed node histories between the two exports, **node 657 was the only node
that changed** — 40 frames, exactly the down-events. Nothing downstream moved.

That is consistent with two different stories:

- **(a)** the solver already fed a high into every transistor on that group, and only the
  reported level was wrong — a correct, localised fix; or
- **(b)** the serializer now clamps 657 to 1, masking a solver-side resolution bug that
  happens not to be sampled during those half-cycles.

The artifact can't distinguish them, and the two exports came from different runs, so the
"only one node differs" result isn't strong evidence either way.

**To settle it:**

1. Export before and after the fix from an *identical* run — same program, same seed, same
   half-cycle count. If 657 is still the only delta there, story (a) holds.
2. Regardless of the answer, the invariant belongs in the solver: assert that `Drive::Vcc`
   wins its group on every settle, so a future change to group resolution fails loudly
   instead of being papered over on write-out.

### 1.3 Add a build stamp to the export metadata — suggestion

We lost a round trip in this session to a re-uploaded stale file that was byte-identical to
the previous one. A `build` block next to `format` / `version` — git SHA, or a run
timestamp, or both — turns "did my fix land?" into a one-line check instead of a byte-count
comparison.

```json
"build": { "commit": "0905117", "exported": "2026-08-20T15:04:11Z", "run_id": "..." }
```

### 1.4 Invariants worth asserting in CI — suggestion

Everything below is cheap and catches the class of bug we hit:

- every node named in `rails` has zero entries in any `up`/`down` list
- replaying `up`/`down` from frame 0 `levels` produces no violations (a node in `up` was 0;
  a node in `down` was 1)
- `frames[i].h == i`; `ph` alternates 1,2; `clk0 == (i % 2)`
- `len(frame.open) == len(controls)` on every frame
- padding bits past node 1725 are zero
- frame count is even and the last frame is φ2
- `contested_groups == 0` and `nonconvergent_settles == 0` (already in your suite)

---

## 2. HTTP API

### 2.1 Verified

- **Statelessness holds bit-exact.** Stepped 45 half-cycles in one request; separately
  stepped 20, POSTed the result back, stepped 25. All four state bitsets *and* the memory
  matched byte-for-byte.
- **Engine agrees with the halfshot path.** `/v1/boot` returns `A=$AA`, `P=$36`, `S=$FD` —
  identical to frame 0 of the halfshot export.
- **The ADC demo reproduces.** On `LDA #$2E / STA $80 / LDA #$14 / STA $81 / CLC / LDA $80 /
  ADC $81 / STA $82`, A stays `$2E` through h=37 and becomes `$42` at h=38 — φ1 of the
  *next* instruction's T2, the same half-cycle IR latches `$85`.

### 2.2 Doc nit: `dpc17_SUMS` doesn't show the moment

"What to run first" points readers at `dpc17_SUMS` to watch the ADC overlap. In a
133-half-cycle capture of that exact program, **SUMS is high in every single frame** — it
never changes, so it can't mark the transfer.

`dpc23_SBAC` is the discriminating line: low across the whole tail of ADC, high at exactly
h=38. Suggest watching both — one held, one firing — and saying so, since "the adder is
always summing something" is itself a good lesson.

There's a sharper framing available too. Looking at the control lines cycle by cycle, the
*addition itself* doesn't happen during ADC's cycles at all:

```
h=34 φ1 T0  ir=65  SBADD ADLADD SUMS      <- address arithmetic, not the add
h=35 φ2 T0  ir=65  PCLADL PCHADH SUMS
h=36 φ1 T1  ir=65  DBADD SBADD SUMS       <- the add happens HERE, in the next fetch
h=37 φ2 T1  ir=65  ADDSB06 ADDSB7 SUMS    <- result onto SB
h=38 φ1 T2  ir=85  SBAC ...               <- into A, same half-cycle IR latches
```

Not "the result transfers late" — "the add happens after the instruction is over."

### 2.3 CORS — suggestion

`/api` returns no `Access-Control-Allow-Origin`, and `OPTIONS` on `/v1/step` returns 405.
Any consumer must be same-origin. If you want third-party notebooks, classroom pages, or
Observable/CodePen demos against this, allowing `GET`/`POST` with `content-type:
application/json` from `*` would unlock it at zero risk — the server holds no user state.

### 2.4 A node-name discovery route — suggestion

The docs say 846 nodes are watchable and give four examples. The only way to learn the rest
is to guess and read 400s — I burned a request on `dpc16_ADDSB06`, which doesn't exist
(it's `dpc20_ADDSB06`). A `GET /v1/nodes`, ideally grouped (`rails`, `pins`, `datapath
control`, `timing`, `registers`, `buses`), would make the watch feature discoverable. It's
static data and cacheable.

### 2.5 Compact trace encoding — suggestion

A 133-half-cycle trace with 22 watched nodes is **106 KB** of JSON. Re-encoded as row arrays
with the watch set packed into one integer bitmask it's **11 KB** — ~10× smaller, no
information lost. Two options, either is fine:

- a `format: "rows"` flag on `/v1/step` returning `{cols: [...], rows: [[...]]}`
- a `fields` parameter so a caller can ask for only what it renders

At `max_traced: 10000` the current encoding is roughly an 8 MB response.

### 2.6 Expose the values that live nowhere — suggestion

The flagship result is "the sum exists and is in no register." But the Observation can't
show it: there's no field for the ALU hold register, and no way to read the value on SB or
on ADL/ADH. A consumer can show that the *paths* are open, and can show A before and after,
but can't display the sum during the half-cycles when it's real and homeless.

Adding `alu`, `sb`, `adl`, `adh` to Observation — each read from its own storage nodes, same
discipline as the registers — would let the UI put the number on screen at the moment the
whole demo is about.

### 2.7 Smaller conveniences — suggestion

- `until: "cycle"` alongside `until: "instruction"`, for stepping a whole cycle without
  computing half-cycle counts client-side.
- `until_pc: 0x020B` — run to a given PC, with the same `completed: false` discipline at the
  bound. That's a breakpoint, and it's the one thing a lab UI needs that the API can't do.
- `/v1/step` currently requires a full `Machine` round trip per call. That's the right
  design; no change wanted. Just noting that `until_pc` is what removes the need for
  clients to poll.

---

## 3. Halfwave Lab (the consumer app)

### 3.1 Deploying

Single file, no build step. Serve it from any path on `6502.tinymachines.ai` and it resolves
`/api` on its own origin and goes live. Opened from disk it falls back to a packed
133-half-cycle trace so it's never a blank page; the assemble button disables itself in that
mode.

If you'd rather point it elsewhere, `API` is a single `const` at the top of the script.

### 3.2 What it does that the existing pages don't

- **Narration and diagram share a source of truth.** Both are generated from the same 22
  control-line booleans, so the picture cannot disagree with the words. Same principle as
  the programs page ("the comment and the byte are two independent claims").
- **The chrome carries the phase.** Cool for φ1, warm for φ2 — pill, stage edge, scrubber,
  changed registers all shift together. Holding the arrow key down makes the two-phase clock
  legible before you read anything.
- **Only the spine is drawn.** PC → ADH/ADL → address bus, data bus → SB → registers, and
  the ALU with its two inputs. 19 edges, each mapped to exactly one real control line. The
  existing animated view shows more and communicates less.

### 3.3 Two rules I had to correct against real data

Worth recording, because both are things a behavioural mental model gets wrong:

- `ADL→PCL` is conducting on **every** normal opcode fetch. The round trip out through the
  address bus and back through the incrementer *is* how PC advances. A jump is `ADL→PCL`
  **without** `PCL→ADL` — the PC loading a value it didn't put there.
- `SUMS` is high in all 133 frames, so it can't be narrated as an event. The app only speaks
  about the adder when both inputs are selected, and distinguishes address arithmetic
  (`ADL` on the B side) from data arithmetic (`DB`).

### 3.4 Next things worth building

Roughly in order of value per hour:

1. **Permalink a machine.** The API is stateless and `ChipState` is ~2 KB of hex — a URL can
   carry an entire chip mid-instruction. `?m=<base64url>` would let someone link "here,
   half-cycle 37, look at this" into a lesson, a bug report, or a forum post. This is the
   single feature the stateless design makes possible and nothing else offers.
2. **Breakpoints**, once `until_pc` exists server-side.
3. **Arbitrary node watch.** A search box over `/v1/nodes` that adds any of the 846 to a
   scope-style strip beneath the transport. Needs 2.4.
4. **Half-cycle diff view.** Pick two positions, show which nodes and registers differ. This
   is the tool I wanted while checking the two exports in §1.2, and it's the same code.
5. **Full memory pane** with a page selector; currently zero page only.
6. **Annotated tours.** A program plus a list of `{half_cycle, note}` — the ADC lag, the RMW
   double write, the JMP indirect wrap — so a reader can step a narrative rather than hunt
   for the moment.

---

## 4. Loose ends

- §1.2 needs a same-run before/after export pair to close.
- I never validated the four bundled example programs past assembly and a boot; only the add
  program has been stepped through in full.
- I have no view into the site's other pages beyond `/programs?program=0`, so the Lab may
  duplicate something that already exists on `/trace` or `/halfshot`.

---

## 5. Answers from the engine side (2026-08-20)

Appended after check-in, so the record closes where it was opened.

### 5.1 §1.2 answered: the fix landed in the solver, and the invariant already exists

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

### 5.2 §2.2 shipped

The api page's demo section now watches `dpc23_SBAC` beside `dpc17_SUMS` and
says which is held and which fires, with the h=36/h=38 story spelled out
(commit caf4ff2). The claims are pinned by a test that re-runs the section's
recipe and derives every number the prose states, verified able to tell by
corrupting the page and watching it go red. The sharper framing in §2.2's
cycle table ("the add happens after the instruction is over") is the same
story the site's Lab and chip-map tour tell for ADC, and it is right.

### 5.3 §4's last loose end

`/trace` and `/halfshot` do overlap the Lab in subject, not in framing:
trace is any-opcode tables plus the shorted-wire groups, halfshot is a
recorded gallery of the full plate. Nothing on the site draws the 19-edge
spine with narration generated from the same booleans as the picture; that is
new, and the "ADL->PCL conducts on every fetch, a jump is ADL->PCL without
PCL->ADL" reading in §3.3 is a genuinely good measured lesson.

### 5.4 The suggestion list, shipped (same day)

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
  suite asserts it agrees with the object form column for column and is
  at least 3x smaller; measured on a 10-row watch trace it is ~8x.

§1.3 shipped in the same round: halfshot exports now carry `build`
(`commit`, `committed`, `exported`), optional so old files stay valid,
validated by `check-halfshot.mjs` when present, asserted on the real page's
export by `_halfshot-test.html`. Still open from the list: only §2.5's
`fields` parameter (rows shipped instead).
