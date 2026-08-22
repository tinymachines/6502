# 6502 as a service

**Live at <https://6502.tinymachines.ai/api/>.**

A transistor-level MOS 6502 over HTTP, one half-cycle at a time. Nothing here
models 6502 behaviour: every request settles the real 3510-switch network and
every register in every response is read back out of its own storage nodes.

**The server is stateless.** The whole machine travels in each request as a
`Machine` object: the four chip bitsets (every node level, every pull, every
conducting transistor, ~2 KB of hex) plus a sparse 64 KiB memory (a fill byte
and only the 256-byte pages that differ from it). The response carries the
whole machine back. Your copy of that object IS the session, which is what
lets any number of instances answer any request, and what makes a session a
thing you can save to a file, diff, or hand to somebody else.

`crates/v6502-sim/tests/state.rs` is the license for that claim: restoring a
snapshot into a fresh machine is proven bit-exact over every node at every
half-cycle, and three serialize/resume hops land exactly where one straight
run does. `test_service.py` proves the same through the HTTP surface.

## Pieces

| | |
|---|---|
| `target/release/halfwave` | The engine: a warm, resident, stateless chip. Netlist parsed once; state injected per request. Line protocol in, one JSON line out. Zero dependencies, like the rest of the workspace. |
| `asm-bridge.mjs` | The assembler: `web/asm.js` over stdin/stdout. There is one assembler in this project and this is how the service uses it rather than growing a second one. |
| `models.py` | The public shapes (Pydantic): `Machine`, `ChipState`, `SparseMemory`, `Rom`, `Observation`. |
| `engine.py` | The pool of warm engine processes. |
| `app.py` | FastAPI: the endpoints. |
| `atlas.py` | The chip atlas: the die's derived containers, indexed and queryable. Reads two generated files and runs nothing. |
| `api.html` | The API reference page, served at `/`. The test suite holds it to the app: every route named, every stated number the measured one. `/docs` and `/redoc` are generated beside it from the same models. |
| `test_service.py` | 26 tests, end to end. |
| `test_atlas.py` | 52 tests over the atlas, against the site's own published figures. |

## Run

In production it is `deploy/6502-api.service` (uvicorn on 127.0.0.1:6502,
`--root-path /api`) behind the site nginx's `/api/` proxy location; both
carry comments on the traps they step around (systemd's node is v12, and an
nginx location with any `add_header` discards every inherited one, so the
/api/ location declares the complete set with its own CSP). Locally:

```bash
# The engine (once):
export PATH="$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin:$PATH"
cargo build --release -p v6502-sim --bin halfwave

# The service:
uvicorn app:app --app-dir service --port 6502

# The tests:
python3 -m pytest service/test_service.py -q
```

Environment: `HALFWAVE_BIN` (path to the engine, default `target/release/halfwave`),
`HALFWAVE_POOL` (warm instances, default 2), `NODE` (node binary for the
assembler, default `node`; needs >= 16).

## The flow a learner follows

```bash
# 1. Assemble (or skip straight to boot with a rom: the boot assembles too).
curl -s localhost:6502/v1/assemble -H 'content-type: application/json' -d '{
  "source": "        .org $0200\nstart:  LDA #$2E\n        STA $80\n        JMP start"
}'
# -> bytes, a listing with an address and bytes per line, the label table

# 2. Boot: the rom is laid into memory at its org, the reset vector aimed at
#    it, and the chip power-cycled through its real reset sequence. The
#    machine comes back standing at its first opcode fetch.
curl -s localhost:6502/v1/boot -d '{"rom": {"source": "..."}}' > m0.json

# 3. Step: POST the machine back with a half-cycle count, or
#    until="instruction" to run to the next opcode fetch. trace=true returns
#    one Observation per half-cycle; watch=["sync","sb0"] reads any named
#    node on the die at each one.
jq '{machine, half_cycles: 41, trace: true}' m0.json | \
  curl -s localhost:6502/v1/step -d @- > m1.json
```

An `Observation` is what a learner reads at one instant: the bus (address,
data, read/write, sync), the registers with a `nv-BdIzC` flag string, the
clock phase, the timing chain's T-states, the last opcode fetch, and any
watched nodes. All of it read off the silicon, none of it modelled.

## The atlas: what a wire is part of

`/v1/nodes` answers *what can I watch*, and its grouping is a reading of the
die's names. Five more routes answer *what is this node part of*, and every
answer is measured. Twenty-three kinds of machinery, walked out of the switch
network by `web/chip-groups.js` (the module the tracer and the chip map draw
with) and exported by `tools/export-groups.mjs` into `web/groups.json`.

```bash
curl -s localhost:6502/v1/atlas/full                  # ALL of it, one file, 48 KB gzipped
curl -s localhost:6502/v1/atlas                       # just the kinds, blocks, counts
curl -s 'localhost:6502/v1/groups?kind=alu'           # the ALU as 17 containers
curl -s 'localhost:6502/v1/groups/regs:a'             # one, with its wiring
curl -s 'localhost:6502/v1/tags?multi=true'           # the 88 nodes in more than one
curl -s 'localhost:6502/v1/node/pipeUNK39'            # one node, all of its tags
curl -s 'localhost:6502/v1/neighbors?node=a0&via=switch'
```

Two layers, and the difference is the point. The **partition** is 132 groups
with every one of the 1547 nodes in exactly one, because a drawing needs
disjoint boxes. The **containers** are the same derivations unfiltered: 135,
overlapping, 88 nodes in more than one, and three (`sdp:sd1`, `sdp:sd2`,
`sbus:link`) that exist only there. `?layer=containers` on a group asks for
the derivation's own set instead of the box: `intr:nmi` is 20 nodes as a walk
and 18 as a box, and the two it loses include `pipeVectorA2`, the one address
bit by which `$FFFA` differs from `$FFFE`.

Nothing here runs the chip and none of it changes, so nginx serves the whole
family `public, max-age=86400`.

Rebuild it whenever the die exporters run (`deploy.sh` does), then
`sudo systemctl restart 6502-api`: the atlas is held in memory.

## Cartridges: a ROM, its tiles, and the contract, in one file

There is no video hardware on this die and no interrupt in use, so a *frame*
is not something the silicon knows about. It is an agreement between a ROM
and whatever drives it, and that agreement is the whole console: the host
clears a byte and the ROM sets it back when a frame is finished; the host
writes a byte that is the controller; the host reads a page that is the
screen. It works over HTTP *because* the API is stateless, the frame boundary
being a memory edit between two `/v1/step` calls.

```bash
curl -s localhost:6502/v1/console                     # the contract, published
curl -s localhost:6502/v1/cartridge -d @cart.json \
     -H 'content-type: application/json' -o mine.cart.gz
curl -s 'localhost:6502/v1/cartridge?format=json' -d @cart.json ... | jq .verify
```

A cartridge is **gzipped JSON** carrying the ROM (bytes, labels and source),
its tiles in both the binary form and as rows of `0..3`, and the console
addresses it was written to. The contract travels *with* the bytes rather
than beside them, because it is the part an outside author has to agree with
and a contract in a different file is the copy that drifts. `mtime` is zero,
so minting the same cartridge twice gives the same bytes and two of them can
be diffed.

Two things minting does that assembling cannot:

- **It refuses a layout that cannot work.** A ROM overlapping its own screen
  assembles perfectly and then draws over itself; a contract byte inside the
  ROM is the host writing into the code. Each is 422 with the reason. Reading
  the assembler's inclusive `end` as one-past made every one of those checks a
  byte short, which `test_cartridge.py` now pins from both sides.
- **It runs the thing.** A ROM that assembles, boots and never raises its tick
  flag is a ROM that does not run on this console, and nothing short of
  running it says so. The report carries frames completed, what each cost,
  whether the screen changed, and which tiles are on it.

**The frame cost is measured on an absolute ladder** (128 half-cycles to 16k,
then 1024) and deliberately not seeded from anything the cartridge declares.
Sizing the first step from a declared cost is right for a *host* and wrong for
a measurement: the same ROM minted at `frame_cost` 512 and 20000 measured 6400
and 6250, each number being its own request rounded up. Die Runner's page had
carried a declared 12,000 for exactly that reason. Measured, it is **8,704**.

## MCP: five tools, each one a whole errand

`POST /mcp` speaks the Model Context Protocol over streamable HTTP, with no
session and no SSE stream, for the same reason the API keeps no sessions.
`console_spec`, `assemble`, `run`, `mint_cartridge`, `chip_atlas`.

**The tools are coarse where the HTTP routes are fine-grained, and that is the
design.** The API is stateless because a *program* holds the machine: 2 KB of
hex out and back, and the client's copy is the session. An MCP client is a
language model, and a model cannot usefully hold 2 KB of hex, so `run`
assembles, boots, steps and reports in one call and the machine never leaves
the server.

`run` renders the screen as two hex characters a cell. That is the one thing
that turns writing a 6502 game from guessing into working: an assembler says
the bytes are legal, and only the picture says the program is right.

## The registry: builders, pages, and what they publish

<https://games.tinymachines.ai/builders>. **The only stateful thing here, and
the boundary is the point.** The chip is untouched: every request still carries
the whole machine, and running a published ROM still means POSTing it. What is
stored is a catalogue. One SQLite file (`REGISTRY_DB`), a row per thing.

```bash
python3 service/registry_admin.py mint --note "who it is for"   # printed once
python3 service/registry_admin.py tokens
python3 service/registry_admin.py builders
python3 service/registry_admin.py revoke <token-or-hash>
python3 service/registry_admin.py grant <token> <handle> <name>  # reserved names
```

There is no sign-up: a token is minted by hand, handed over, and claimed. One
token, one builder. That is deliberately the whole of the auth story for now,
and it is a limitation rather than a design. What it does get right is the part
that would hurt to change later: **a token is shown once and only its SHA-256
is stored**, so a copy of the database is not a copy of everybody's
credentials.

Three rules that shape the rest:

- **The registry measures rather than believes.** A cartridge is a file
  somebody can edit, so its own `verify` block is a claim by its author. On
  publish the cartridge is unpacked and **run here**, and the size, tile count
  and frame cost printed beside it are what that run produced. A ROM that does
  not complete its frames is refused rather than listed. The test publishes a
  cartridge claiming a 12-half-cycle frame and requires the stored number to be
  the measured one.
- **Art is only ever rows of `'0'..'3'`.** Converting a photograph happens in
  the browser, so there is no image parser in the request path and what lands
  on disk is CHR: the same encoding a sprite sheet uses, so the portrait on a
  builder page is drawn by the same `decodeCHR` that draws the game.
- **A PATCH touches only what it names**, so a client saving a bio cannot blank
  an avatar it never loaded.

A token that is not this builder's gets **404, not 403**: it has no business
learning whether the builder exists. Revoking leaves the page and its ROMs
alone, because revoking is about the credential.

## What to try first

The programs page's "Add two bytes" ($2E + $14): boot it, step 41
half-cycles with `trace` on, and watch the answer. At half-cycle ~37 the
adder holds $42 while A still reads $40; the ADC's result exists and is in
no register until the next instruction's fetch transfers it. That overlap is
real silicon behaviour, it is invisible in every behavioural emulator, and
seeing it in a trace is the reason this service simulates switches instead
of opcodes.

## Notes for whoever builds the site on this

- Speed: ~28k half-cycles/s per warm instance. A request is bounded at
  200,000 half-cycles (`max_step` in `/v1/meta`), so shard long runs.
- The engine caps traced steps at 10,000 per request.
- A JAM opcode ($02 and friends) never reaches another fetch:
  `until="instruction"` returns `completed: false` when the cap is hit,
  which is the honest answer rather than a hang.
- The chip's own quirks are surfaced, not smoothed: S is undefined out of
  power-on (reset only decrements it by three), P bit 5 reads as 1 because
  no storage node exists for it, and BOOT's memory with no reset vector runs
  whatever $FFFC points at, exactly like the silicon.
