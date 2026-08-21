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
the words. Below it, "inside the boxes": every bus and latch as individual bits, grouped
off-chip → in → internal → adder → registers → out. Bits that flipped this half-cycle get a
ring; lanes that did not move dim out.

**Signals** — all 22 datapath control lines, and the external bus.

**State** — registers and zero page.

**Program** — editor, four worked examples, assemble, and the listing with the executing
line highlighted.

Above the tabs: an instruction lane (one cell per half-cycle, clickable) and a scope with
φ1, φ2, RDY, SYNC and T0–T5 — Figure 3.4 of the MCS6500 manual, redrawn from the recording.

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
