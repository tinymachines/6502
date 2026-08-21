# Halfwave Lab

A notebook for walking a transistor-level 6502 one half-cycle at a time, built against
the API at `6502.tinymachines.ai/api`.

```
halfwave-lab.html      the app — single file, no build step, drop it anywhere
build.sh               rebuild it from src/
src/lab.template.html  the source, with a __DEMO__ placeholder
src/demo.json          the packed fallback trace (a saved API response)
src/capture-demo.py    regenerate demo.json from the API
findings.md            everything checked this session, marked verified vs suggestion
issues/                eight ready-to-file issue bodies
file-issues.sh         files them with `gh`
```

## Running it

Serve it from any path on the same host as `/api` and it goes live on its own. Opened from
disk it falls back to a packed 132-half-cycle trace, so it is never a blank page; the
assemble button disables itself in that mode.

To point it somewhere else:

```
halfwave-lab.html?api=https://6502.tinymachines.ai/api
```

`file://` will not reach a remote API — Chromium blocks fetch from file origins regardless
of CORS. Serve over HTTP to test the live path.

## Rebuilding

```bash
./build.sh                # inline the current demo.json
./build.sh --recapture    # refresh demo.json from the API first
```

`build.sh` with no arguments reproduces the shipped `halfwave-lab.html` byte for byte.

## What it shows

**Datapath** — the block diagram with wires lit only where a pass transistor conducts,
beside a narration generated from the *same* booleans, so the picture cannot disagree with
the words.

**Latches** — the thirteen pieces of named storage as their own diagram: the PC
primes waiting for write-back, the address latches feeding the pins, the input
data latch, the adder's inputs and hold register, the data output register. A
box lights when its value moved at this half-cycle; the values are the API's
own first-class fields.

**Bits** — inside the boxes: every bus and latch as individual bits, grouped
off-chip → in → internal → adder → registers → out. Bits that flipped this
half-cycle get a ring; lanes that did not move dim out.

**Timeline** — instructions as bars against time, alternating lanes, cells
coloured by T-state, and the overlap drawn as overlap: an instruction's T+
half-cycles glow inside the next instruction's fetch, which is where an ADC's
sum finally reaches A. Click to seek.

**Decode** — the PLA's product terms as beads, watched on the die by name
(fetched from `/v1/nodes`' decode group and appended to the trace's watch
list), grouped by the T-state their name carries. The lit set IS the
instruction being decoded, and the firing pills name it: at STA's T2 you read
`op-store`, `op-sta/cmp`, `op-T2-mem-zp` straight off the silicon.

**Adder** — ALUA, ALUB, the carry, and the sum as four bit rows, with the
carry row read from the die's own chain (`alucin`, `C01`..`C78`, `alucout`)
rather than computed: each dashed cell is the carry arriving into that bit
from the bit on its right. Bit 7 is last because its carry rippled through
all eight slices.

**Memory** — the footprint: every touched address as a row against time,
reads cool, writes warm, click to seek; below it each touched page as a
64-cell grid shaded by access type.

**Stack** — page $01 with S marked, pushes highlighted, growing downward.
Run the subroutine preset and watch return addresses appear. Mid-JSR the tab
says what it is actually seeing: S is not a stack pointer during the push
cycles, it is holding the low byte of the address being called.

**Interrupt** — the three pins, with buttons that pulse one low and append
what the chip did to the trace. The sequence is then read back out of the
recording: the byte that was actually fetched, the instruction register going
to `$00` with no BRK in memory, the three pushes, the vector, the handler.
Every claim under it is derived from those rows.

**Signals** — all 22 datapath control lines, and the external bus.

**State** — registers and zero page.

**Program** — editor, four worked examples, assemble, and the listing with the executing
line highlighted.

Above the tabs: an instruction lane (one cell per half-cycle, clickable) and a scope with
φ1, φ2, RDY, SYNC and T0–T5 — Figure 3.4 of the MCS6500 manual, redrawn from the recording.
The scope collapses to a one-line strip (a shaded box per signal at the current half-cycle,
painted from the same chVal the waveforms use), which is most of the panel's height handed
back to whatever tab is open. The fold persists.

## Three things worth knowing

**The clock phases are read as pins**, `clk1out` and `clk2out`, not derived from the `phase`
field. Deriving them would produce a guaranteed-perfect square wave that could never show a
violation; measured, the scope would show one if the solver ever broke non-overlap.

**`ADL→PCL` conducts on every normal opcode fetch.** The round trip out through the address
bus and back through the incrementer *is* how PC advances. A jump is `ADL→PCL` **without**
`PCL→ADL`. `SUMS` is high in all 132 frames, so it is never narrated as an event.

**The internal address buses disagree with the pins in 63 of 132 frames** — every φ2. The
address buffer holds the φ1 value all cycle, which is why the datasheet can promise a stable
address. The pins box goes dashed when it is holding stale.

## Try this

Load the default program and step to **h=37**. The ALU and SB both read `$42`; A still reads
`$2E` and is dimmed because it did not move. Step once more and A takes it — in the same
half-cycle IR latches the next opcode.

The addition does not happen during ADC's cycles at all. It happens during the *next*
instruction's fetch.
