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

Above the tabs: an instruction lane and a scope with φ1, φ2, RDY, SYNC and T0–T5 — Figure
3.4 of the MCS6500 manual, redrawn from the recording. Both are controls. In the lane, a
cell is one half-cycle and the **label above it is the instruction**: clicking the label
lands on that opcode's own fetch, which is where every tab then reads from, so the label is
the coarse control and the cells the fine one. The scope **drags**: press anywhere on the
waveform and scrub, and the window follows when the cursor reaches an edge. The window is
state rather than "centre on the cursor at every paint", because a window that recentres
slides out from under the finger and makes the pointer's own x mean a different half-cycle.
The scope also collapses to a one-line strip (a shaded box per signal at the current
half-cycle, painted from the same chVal the waveforms use), which is most of the panel's
height handed back to whatever tab is open. The fold persists.

**Power is not rewind, and they used to be one button called "reset".** `start` moves the
cursor back through a recording that already exists; `power` throws the recording away and
boots a new machine from the source, which is the only thing that puts memory back and
releases a pin that was pulled. With no API there is nothing to boot and frame 0 already is
the power-on state, so the button says so rather than lying. The Memory tab's page map is
drawn **as of the cursor** for the same reason: it used to show every address the whole
recording touched, so rewinding visibly reset nothing. The rows are still every page the
recording touches, so the map keeps its shape while you scrub.

**There is a light theme, and the switcher is top right.** It works because no rule anywhere
carries a bare colour: twenty-eight hardcoded hex values in the stylesheet became tokens, so
`:root[data-theme="light"]` restating them *is* the theme. The canvases cannot use a custom
property, so the drawing code reads the tokens itself through `cssv()`, cached and dropped
when the theme changes. The palette is chosen against the dark one rather than derived from
it: an inverted lightness gives washed-out accents on white, so the three datapath colours
are darkened until they carry on a pale panel. **The default is dark, not the system
preference** -- this page is dark-native and a light-mode reader who has never touched the
switch would otherwise arrive somewhere different from every screenshot of it. `?theme=light`
deep-links, the choice persists, and `<meta name="theme-color">` follows.

Verified by pixel-diffing the dark render against the pre-tokenisation build: **zero
differing pixels** once the one deliberate change is put back (the digit drawn on a filled
adder cell moved from `--sunk` to `--ground`, 3/255 in dark, and necessary so it inverts on
light). A control diffing two captures of the same build was also zero, which is what makes
the comparison mean anything.

**A slider picks the clock rate** -- 1, 10, 100, 1000 Hz and max -- as the rate of the
simulated chip, so 1 Hz is two half-cycles a second. It replaced a fixed 170ms interval,
which is a fact about `setInterval` rather than about a 6502; the loop is paced against
wall-clock time and clamped at 500ms so a backgrounded tab cannot return and run the whole
recording in one frame. Playing past the end of the recording runs the chip for more while
the API is reachable, up to 4000 half-cycles: at 1000 Hz a 300-frame recording is over in a
fifth of a second, so without that the top of the slider would be a control with nothing to
show.

**The latch diagram carries arrowheads too**, from the same computed path code as the
datapath. One edge needs `rev`: the address goes out on the pins and the byte comes back on
the data pins, so the arrow points at the data pins even though the path is drawn from them.
A latch that took a value at this edge now **fills solid in its own colour** with its text
inverted, so the diagram answers "what moved" without reading a byte. The datapath map keeps
its tint, because `hot` means a conducting control line there -- a claim about a wire rather
than about storage.

**The position readout sits flush left in the scope bar** rather than in the header, and the
scope toggle aligns to the bottom of that bar so it sits with the strip's last row. Measured
at six widths: the strip wraps to two rows at 480px (last row exactly `T2,T3,T4,T5`), four at
390 and five at 320, and the toggle is within 1px of the last row's midline at every one.

**One icon family**, 24-unit outlines stroked in `currentColor`, defined once in `IC` and
painted into every `[data-ic]`, so an icon inherits the colour and hover state of the control
it sits in and no glyph can be spelled two ways in two places.

**The tabs are a menu in the header**, on a row under the wordmark, marked by a rule rather
than drawn as folder tabs: the panels stopped sitting visually inside a tab, so the folder
shape was claiming a containment the layout no longer had. Every panel heading **allocates**
its lines rather than merely allowing them, because a row that grows when you switch to a
longer heading moves the whole panel down under the reader: two lines on a desktop, and on a
phone the status readout takes a row of its own for a steady three. Measured across all
thirteen tabs at three widths: 57px throughout on a desktop, 77px throughout on a phone. The
`min-height` alone was not enough and the measurement is what said so, cutting the jump from
37px to 12px rather than to zero.

**The datapath draws arrowheads at the consumer.** Every edge is written producer to
consumer, so the head goes on the last segment and is computed from the path rather than
placed beside it; the diagram answers "who is taking this" without the reader knowing which
box is upstream. `SBDB` is the one exception and is marked as one: it moves no value, it
shorts SB and DB into one wire, so it gets a head at both ends. The head is two stroked
lines rather than an SVG marker, because a marker's fill would have to be coloured
separately from the line it belongs to and these lines already change colour and opacity
with `.e.on`.

**Bits tiles into section boxes, two columns on a phone**, and the lane goes vertical to make
room. The sections are ordered so each row pairs like with like -- OFF-CHIP beside REGISTERS,
INTERNAL beside ADDER, IN beside OUT -- and row-mates stretch to a common height rather than
sizing to their own content, so the rows are level. `align-items: start` was sizing each box
to its own lanes, which put a seven-lane section beside a one-lane one at two different
heights on a shared top edge.

**The grid is uniform at every width**, because a 16-bit lane stacks into its two bytes
everywhere rather than only on a phone. The two sections holding one (AB, PC) used to span
the whole grid, which made the desktop layout two full-width rows and a tiled remainder. The
column count is pinned rather than left to `auto-fill`: six sections tile evenly as 2x3 or
3x2 and no other way, and auto-fill gave 4+2 at 1200px and 5+1 at 1440 -- uniform boxes in a
ragged rectangle. Two columns below 980px, three above, measured at seven widths: every row
complete, every row level, no box overflowing its column. Measured first: side by side, a name plus eight cells plus the hex needs 158px against
the 141 a half column has at 390px, and shrinking the pieces lands exactly on the limit at
one width and over it at the next. Stacked (name and value on one line, bits under them) it
needs only the 78px the cells occupy and fits at 320px with room to spare. A 16-bit lane
wraps into two bytes, which is how they are named anyway.

**Story carries a third panel**, the blocks that move no value and therefore never came up in
a story about a value moving: instruction register, decode PLA, predecode, timing chain,
status register, stack pointer, memory interface, input pins. Generated from this
half-cycle's own bytes and booleans like everything else. The decode group from `/v1/nodes`
is **132 nodes, not 132 product terms** -- 123 named `op-...` and 9 predecode nodes
(`PD-...`, `ONEBYTE`, `clearIR`, `fetch`, `irline3`) -- so the panel counts them separately
rather than calling all of them terms.

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
