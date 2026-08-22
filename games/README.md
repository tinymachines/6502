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
