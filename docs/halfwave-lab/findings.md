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

## 5. The watch bitmask loses precision past 53 names — and how to fix it

### 5.1 The bug — verified

`TraceRows.watch` is a single JSON integer, bit *i* for `watch_names[i]`. With 64 watched
nodes the mask reaches 64 bits, and **39 of 40 rows fail a float64 round trip**:

```
max mask: 9368067230186766914   bit_length: 64   > 2^53: True
values that lose precision as float64: 39 / 40
```

The server is correct — Python integers are arbitrary precision. The corruption happens in
the consumer: `JSON.parse` in every browser produces a double, so the high bits are silently
wrong. No error, no warning, just the wrong nodes reported as conducting. RFC 8259 warns
that interoperable implementations should stay inside double precision for exactly this
reason.

**Practical ceiling today: 53 names per request.**

### 5.2 The fix: emit `watch` as a lowercase hex bitset

You have already specified this encoding, in `/v1/meta`:

> lowercase hex; bit i of a set is byte i/8, LSB first

Reusing it for `watch` means a consumer that can read `levels` reads `watch` with the same
three lines of code, there is no precision ceiling, the width is fixed and predictable, and
it scales to all 832 names.

**Measured cost.** Hex is fixed-width; integers get leading-zero compression for free, so on
sparse masks the integer is slightly shorter. On a 132-row, 25-name trace: 1056 chars →
1320, about **+264 bytes on a 13 KB file (~2%)**. Past ~53 names with dense masks hex wins
outright (64 all-ones: 20 chars as integer, 18 as hex). Under gzip the difference vanishes
entirely.

### 5.3 Alternatives, and why not

| Option | Verdict |
| --- | --- |
| Array of 32-bit chunks | Correct, but invents a second bitset convention alongside `levels`. Two ways to say one thing. |
| Integer ≤53 names, string beyond | Polymorphic field. Every consumer needs both branches, and the bug still only bites people who cross the threshold — same failure, relocated. |
| Cap at 53 and return 422 | Not a fix, but good belt-and-braces if you keep integers. Matches your own padding-bit principle: a state that decodes to the wrong chip is worse than one that is rejected. |

### 5.4 A second fix, independent of precision

Promote the named latches to Observation fields the way you did for `alu` / `sb` / `adl` /
`adh`: **`idl`, `idb`, `dor`, `alua`, `alub`**, and probably **`abl` / `abh`** and
**`pclp` / `pchp`**.

These are named storage on the die, the same category as `a` and `x` — not arbitrary nodes.
Today every consumer that wants them rebuilds a byte from 8 watched bits, which is repeated
work and a repeated chance to get bit order wrong. It also drops the common case back under
any threshold, so the two fixes reinforce each other. `abl` / `abh` additionally makes the
pins-versus-internal-bus divergence first-class instead of something a consumer infers.

### 5.5 The test that would have caught it

```python
assert mask <= 2**53 - 1, f"watch mask {mask} is not exactly representable in float64"
```

Better as a property test over N in 1..832 watched names: build the mask, round-trip it
through `float`, assert equality. That is exactly how this was found.

### 5.6 Migration

Pre-1.0 with a single field, so a straight swap plus a line in the `TraceRows` description is
defensible. If you would rather it be self-describing, add `watch_encoding: "hex"` next to
`cols` and `watch_names` — one extra key, and consumers can branch safely.

---

## 6. Transport: gzip, protobuf, websockets

### 6.1 gzip is off, and it is the single biggest win available — verified

`/api/v1/meta` returns no `Content-Encoding` even when the request sends
`Accept-Encoding: gzip, br`. Measured on a 300-half-cycle traced run, 25 watched nodes:

| Payload | Raw | gzip -6 | Ratio |
| --- | ---: | ---: | ---: |
| Request (machine + args) | 3,815 B | 1,360 B | 2.8× |
| Response, `format: rows` | 29,504 B | 4,613 B | **6.4×** |
| Response, `format: objects` | 235,805 B | 10,231 B | **23.0×** |
| `machine.state` hex alone | 2,308 B | 1,079 B | 2.1× |

Projected for larger runs in rows form: 2,000 half-cycles ≈ 170 KB → ~4 KB; 10,000 (your
`max_traced`) ≈ 850 KB → ~12 KB.

nginx is already fronting the API, so this is one `gzip_types application/json` line. Do this
first; it costs nothing and dwarfs every other transport change.

**One consequence worth knowing.** Compression changes the case for `rows`. Raw, it is 8.0×
smaller than `objects`; gzipped, only 2.2×. Repeated key names compress almost to nothing.
`rows` is still worth having — it parses faster and allocates far less in the browser — but
after gzip the argument is CPU and memory, not bytes. Worth adjusting the `TraceRows`
description once compression is on, since it currently sells the format purely on size.

### 6.2 protobuf: no

- gzip already captures most of the available win, for one line of config instead of a
  schema, a build step, and a decoder bundle in every client.
- It would cost the property the whole API is built around: that you can `curl` a route and
  read the answer. The documentation leans on this constantly, and the self-describing JSON
  body is what makes `cols` / `watch_names` / `encoding` legible.
- The one place a binary path could earn its keep is bulk node dumps — full `levels` for
  every half-cycle, where hex costs 2× over raw bytes. Even there, base64 (1.33×) or gzip on
  the hex gets most of it without a schema.

### 6.3 websockets: no, and for a specific reason

Measured round trip for a 300-half-cycle traced run: **130–260 ms total**, of which TTFB is
130–190 ms and body transfer is under 5 ms. Connection setup is ~30–40 ms. So latency is
server compute plus RTT; transport framing is not the cost.

More importantly, the Lab makes two requests and then scrubs 300 half-cycles entirely
client-side. There is no per-step round trip to eliminate. Websockets would solve a problem
this design does not have.

The deeper objection: a socket invites server-side session state, and statelessness is the
property that makes this API distinctive — it is what allows "hand someone a machine
mid-instruction", and it is the precondition for permalinking a chip in a URL (§3.4.1).
Trading that for framing efficiency would be a bad deal.

### 6.4 What would actually help instead

**Chunked streaming over ordinary HTTP** — NDJSON, one row per line, flushed as the solver
produces them. For a 10,000-half-cycle run the client renders progressively instead of
waiting on one large response, and nothing about statelessness changes: the final machine
still comes back at the end, and the client still owns it. No websocket, no new protocol,
works with `curl` unchanged.

That is the only transport change I would put on the list, and only after gzip.
