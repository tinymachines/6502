# Die Runner

**<https://games.tinymachines.ai>**

A console on a transistor-level MOS 6502. The game is a 6502 ROM, the screen is
a page of that chip's memory, and the browser draws it. There is no emulator
here: every frame settles 3510 switches on
[the real die](https://6502.tinymachines.ai) through
[6502 as a service](https://6502.tinymachines.ai/api/).

## The console is a contract, not hardware

The chip has no video, and nothing here uses its interrupt line. So a "frame"
is not something the silicon knows about. It is an agreement between the ROM
and whatever drives it, and that agreement is the whole console:

```
the host clears a byte   ->  the ROM notices, runs one frame, sets it back
the host writes a byte   ->  that byte is the controller
the host reads a page    ->  that page is the screen
```

The ROM busy-waits on the flag, which is the only way to synchronise with the
outside when you have no interrupt and no timer. It works over HTTP because the
API is **stateless**: the frame boundary is a memory edit between two
`/v1/step` calls, and the whole machine travels in each one. Nothing about this
was designed for games; it falls out of a design that carries the machine as a
value.

## What a frame costs, measured

| | |
|---|---|
| First frame (init: clear 256 cells, place food) | 5,400 half-cycles |
| Every frame after | **600 half-cycles**, exactly |
| That in chip time | about 0.3 ms |
| A round trip to the engine | about 200 ms |

**The chip is not the bottleneck by three orders of magnitude.** The frame rate
is the round trip, and the page says so rather than hiding it. A cartridge that
free-runs instead of busy-waiting could have 333 frames in one request (the API
caps at 200,000 half-cycles), at the cost of input latency; the flag handshake
buys responsiveness and pays one request per frame for it.

## Tiles

8x8 pixels, **two bits per pixel, sixteen bytes per tile** -- the NES shape,
because it is what every old-school sprite tool emits and because four colours
per tile is the constraint that makes the art look like the era rather than
like a photograph.

```
bytes 0..7    bit 0 of each pixel, one byte per row, MSB is the leftmost pixel
bytes 8..15   bit 1 of each pixel
colour        (plane1 << 1) | plane0   ->  0..3
```

The palette is the die's own, the four colours the exploded view paints the
mask layers in. That is the conceit of Die Runner: the playfield *is* the chip.

| | | |
|---|---|---|
| 0 | `#0B1120` | substrate, the die with nothing on it |
| 1 | `#3E93A6` | diffusion, the switched layer |
| 2 | `#E0A24B` | polysilicon, the gates and anything that controls |
| 3 | `#4FBFD4` | metal, the wires and anything the runner rides |

Colour 0 is drawn, not skipped: this is a tiled screen, not a sprite layer.

`chr.js` carries a starter set drawn in code, so the console renders before any
art exists and so the spec is executable -- whatever a tool produces has to
decode to exactly that shape. `encodeCHR` is the inverse, so the art pipeline
and the console share one definition rather than two that drift.

## The headless kind

A cartridge that draws nothing. `console.kind: "headless"` is a program on
the chip with no screen page and no tick flag: the seven programs the
explorer boots (`web/programs.js`) and the API's worked example, minted so
they are listed, measured and kept like any other cartridge instead of living
in a JavaScript file. Verifying one boots it, runs it for `console.half_cycles`
(the last quarter apart), and reads the registers and the bytes it names in
`console.peek` off the silicon; the report says whether the pc still moves,
which is a loop or a finished program on one side and a JAM on the other. The
layout checks that still mean something (the stack, the vectors) still apply;
the screen ones do not, and the file carries no screen fields, so nobody reads
a default `screen` off a cartridge that has none. The console refuses to boot
one, with the reason. `games/tools/mint-pack.mjs` mints and publishes the
pack.

## Cartridge one: Die Runner

`rom/dierunner.s` -> **339 bytes**, written for this console and assembled by
this project's own assembler (`games/tools/asm.mjs` over `web/asm.js`, which
inverts the disassembler's table -- so if it assembles, it disassembles back to
the same lines).

You are a charge carrier descending the die. The world scrolls up to meet you.
Polysilicon gates bar the way with one opening; **pass-transistor gates have
two channels and only one conducts**, and every eighth frame the clock phase
flips and they swap. A channel that is shut now will be open in a moment, which
is the whole game. Charge packets score. The die wraps.

### What is on the die

The seven tiles that arrived with the art are all in use, and none of them is
decoration for its own sake -- the die used to be empty between barriers.

| tile | what it is | what it does |
|---:|---|---|
| 9 | poly bus | a run of three across the die. Scenery |
| 10 | power rail | runs **down** a column for three to six rows. Scenery |
| 11 | diff well | an occasional single. Scenery |
| 12 | poly T | where a rail comes in |
| 13 | metal L | where a rail turns and leaves |
| 14 | capacitor | worth **five** charge packets |
| 15 | bond pad | **signposts the gap** of the barrier above it |

The power rail is the one worth understanding: the ROM draws a single cell per
row, and it comes out as a rail *because the world scrolls*. A poly T caps the
end it comes in at and a metal L the end it leaves by, so a rail has a
direction without the ROM ever drawing a line.

Only a **plain** barrier gets a bond pad. Which channel of a *switched* gate is
open depends on a control line that will have moved by the time the player
arrives, so a signpost there would be pointing at a guess.

A frame now costs **12,000 half-cycles**, up about 40% from the bare version.
At one request a frame that changes nothing a player can feel: the round trip
was always the frame rate.

### The screen moved to $0500

Adding the scenery pushed the ROM from 359 bytes to 521, past `$0400` -- which
was where its own screen lived. It assembles, it boots, and the picture eats
the code. `games/tools/asm.mjs --limit $0500` makes that a build failure
instead of a mystery, and the screen sits a page higher.

Moving it is four addresses, and **missing one is silent**: `$0410` is the
scroll's *source*, and with it left behind the game copied unrelated memory
into the screen every frame and drew an almost-empty die. Nothing errored.

### The gates are real

Each gate is a **switch that exists on this die**, and it conducts exactly when
its own control line is high **on the chip running the game**. Nothing
simulates a clock phase; the phase is whatever the 6502 executing this code
happens to be doing at the end of a frame.

The host watches eight lines, packs their levels into a byte, and hands it to
the ROM. A gate cell carries its own gate index (`16+g` is the channel that
conducts while line `g` is high, `24+g` the one that conducts while it is low),
so **what is drawn and what kills you come from the same byte** and the picture
cannot lie about which way is open. The two channels are complementary, so
there is always a way through -- that is not a kindness, it is what a pass
transistor is.

The eight were chosen by measurement, not taste: they are the lines that gate a
switch between two *named* nodes, ranked by how often they actually moved over
twenty-four frames of play. A line that never moves makes a gate that is always
shut or always open, which is scenery.

| gate | control line | high | flips | the switch it gates |
|---:|---|---:|---:|---|
| 0 | `dpc25_SBDB` | 16/24 | 10 | `sb0 - idb0` |
| 1 | `dpc9_DBADD` | 18/24 | 9 | `idb0 - alub0` |
| 2 | `dpc10_ADLADD` | 6/24 | 9 | `adl0 - alub0` |
| 3 | `dpc21_ADDADL` | 3/24 | 6 | `alu2 - adl2` |
| 4 | `dpc23_SBAC` | 4/24 | 4 | `sb0 - a0` |
| 5 | `dpc30_ADHPCH` | 21/24 | 4 | `pch3 - adh3` |
| 6 | `dpc40_ADLPCL` | 21/24 | 4 | `adl0 - pcl0` |
| 7 | `dpc2_XSB` | 2/24 | 2 | `x0 - sb0` |

Gates 5 and 6 move together and always will: `ADHPCH` and `ADLPCL` are the
program counter's own round trip, and they fire on every opcode fetch. Two
gates that are really one event is a true thing about the chip, so they are
both kept.

Sampling is one frame behind, and has to be: the chip must have run before
there is anything to read. So the gates you are threading are the state of the
CPU as it finished drawing the frame you are looking at.

**8,400 half-cycles a frame** -- measured, and the console sizes its request
chunks from it, so an ordinary frame is one round trip. The board-wide phase
scan is gone: a gate cell carries its own identity, so a change of state costs
nothing and nothing has to be rewritten.

Two things had to be measured rather than designed:

- **The runner sits at row 2, not row 13.** New terrain appears at row 15 and
  scrolls up, so from row 13 a wall arrived two frames after it appeared: no
  warning at all at five frames a second. From row 2 the same wall is thirteen
  frames away, and it reads as descending into the die rather than being
  ambushed by it.
- **Gaps drift, they do not land anywhere.** A gap at a random column can be
  further away than the runner can walk before the barrier arrives, which is
  not difficulty but a death the player could not have avoided. Each gap steps
  -3..+4 from the last, against six frames of travel.

## The cartridge format

A cartridge is one **gzipped JSON** file carrying the ROM (bytes, labels and
source), its tiles in both the binary form and as rows of `0..3`, and the
console addresses it was written to. The contract travels *with* the bytes
rather than beside them, because the contract is the part an outside author
has to agree with, and this page needs eight addresses to play a game with no
hardware to ask about any of them. Die Runner already learned what a second
copy costs: its screen moved and one of the four places naming it was missed,
and the game drew unrelated memory with nothing erroring.

```bash
# Minted by the API, which refuses a layout that cannot work and then RUNS it.
python3 games/tools/mint.py --api https://6502.tinymachines.ai/api
```

The page loads one from `?cart=<url>` or from the file picker, and a loaded
cartridge joins the picker rather than quietly replacing what the label says
is on screen. Its tiles replace the sheet, so a cartridge brings its own art.
`games/deploy.sh` mints the sample rather than keeping it in the tree, so it
cannot go stale against `rom/dierunner.s` and every deploy exercises the
endpoint.

The format, the memory map and the tile encoding are published at
<https://6502.tinymachines.ai/api/#cartridges>, and `GET /v1/console` is the
same thing as data.

### What minting found

**The frame cost this page claimed was its own request read back.** The
console asks for `frameCost` half-cycles and then reports what it spent, so
whatever was written there confirmed itself: 12,000 was a number this file
had typed, not a number the chip had produced. The mint measures on a fixed
ladder that is seeded from nothing the cartridge declares, and Die Runner's
steady frame is **8,704**, rock solid over twelve frames, with the first at
5,440. That is about 28% less chip time a frame than the page was buying.

**The eight labels beside the gates are derived now.** `joins` used to be
eight strings typed beside the eight watched line names, which is two claims
where there is one fact. The atlas answers instead, and agrees on five. The
three it does not are the useful part: `ADDADL` and `ADHPCH` each open one
switch a bit and the hand-written pair had named bit 2 and bit 3 where bit 0
is canonical, and `XSB` joins `sb0` to a node **the die never named**, so
`x0 - sb0` was naming the register a reader knows is there. The atlas says
that node is owned by `regs:x`.

## Builder pages

<https://games.tinymachines.ai/builders>. A page is `/b/<handle>`, and a ROM on
it is `/b/<handle>/<slug>`, which is the console with that cartridge already
loaded. Both are static documents that read their own path: nginx points a
quoted regex location at `builder.html` and at `index.html`, so a published ROM
has an address of its own rather than a query string.

`/manage` is the editor: paste a token, edit the page, publish a `.cart.gz`.

**A photograph is converted in the browser** (`art.js`) into the die's four
colours and uploaded as a grid of `'0'..'3'`, never as an image. The stored
form is CHR, so an avatar is drawn by the same `decodeCHR` that draws a sprite,
and every page looks like the console. Dithering is Floyd-Steinberg **in RGB
rather than in luminance**, and that was measured: by Rec.709 the palette is
17, 130, 169, 169, so polysilicon and metal are the same brightness to within
0.2 of 255 and differ only in hue. A luminance ramp has three steps, not four,
and throws the warm half of the palette away.

### The bug that only showed at depth two

`index.html` loaded `game.js` with a relative `src`. Served at `/`, that is
`/game.js`; served at `/b/tinymachines/die-runner` it is
`/b/tinymachines/game.js`, which is a 404. **The page still rendered**, because
the markup is static and only the JavaScript was missing, so it looked like a
console that had failed to boot rather than one whose script was never fetched.
The document's references are absolute now, and the two fetches inside
`game.js` resolve against `import.meta.url` rather than the page, the same
trick the wasm glue uses. Found by driving the real page, not by reading it.

## Cartridge zero

`rom/snake.rom` -- 351 bytes, here to prove the pipe end to end.

Every address in its cartridge entry was read off the disassembly
(`rom/snake.lst`) and then confirmed on the running chip, never guessed: an
earlier reading had `2 = right`, and the snake walked downwards to say
otherwise.

| addr | what |
|---|---|
| `$0D` | tick flag: host clears, ROM raises |
| `$02` | requested direction, 1 up 2 down 3 left 4 right |
| `$03` | game over |
| `$0400-$04FF` | the screen, 16x16, `0` empty `1` snake `2` food |

The board **wraps** rather than having walls: `AND #$0F` on both nibbles of the
cell index.

*Provenance: written by Grok on the site owner's prompt, and owned by them
under xAI's consumer terms. It is not derived from the die data and carries
none of that data's obligations.*

## Running it

```bash
bash games/deploy.sh          # rsync to /var/www/games.tinymachines.ai
```

No build step: the page is ES modules and a ROM, served as they are. `_*` is
excluded from the deploy, because `rsync -a --delete` copies everything and the
archive already learned that lesson.

## Three bugs worth keeping

**Input pressed during a request was thrown away.** It was read from the shared
slot *after* the request that used it:

```js
const r = await con.frame(state.input || undefined);
state.input = 0;                     // wrong
```

A request takes 200 ms and frames run back to back, so almost every keypress
lands *during* an await -- and this cleared the press that had just arrived
rather than the one that was used. The snake kept going straight. Read and
clear before the await. Proven by reverting it and watching the steering test
go red.

**Changing cartridge left the old loop running.** It woke from its await, saw
`running` true again, and carried on driving a console that had been replaced:
two loops, one machine. Every loop carries the generation it started in now.
Anything decided before an await has to be rechecked after it, and here a frame
*is* an await.

**One transient network failure ended the session.** A
`net::ERR_NETWORK_CHANGED` -- the OS reconfiguring an interface -- surfaced on
screen as "the engine stopped answering" while the engine was answering every
request with a 200. `post()` retries a rejected fetch up to three times; an
HTTP status is a real answer and is never retried. Retrying is free here in a
way it is not for most APIs: the machine is a value we still hold, so the retry
is the same body sent again, and the server has no session to have lost.
