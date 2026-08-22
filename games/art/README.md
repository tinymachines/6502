# Drop sprite sheets here

One PNG, **128x128**, a 16x16 grid of **8x8 tiles**, using exactly these four
colours and no others:

| index | colour | what it means |
|---|---|---|
| 0 | `#0B1120` | substrate: the die with nothing on it |
| 1 | `#3E93A6` | diffusion: the switched layer |
| 2 | `#E0A24B` | polysilicon: gates, and anything that controls |
| 3 | `#4FBFD4` | metal: wires, and anything the runner rides |

Tile order is the one `chr.js` draws in code, and those drawings are the spec:
whatever a tool produces has to decode to the same shape.

```
0 substrate   1 metal trail    2 charge packet
3 diffusion   4 poly gate      5 via
6 pass transistor CONDUCTING   7 pass transistor BLOCKING
8 the runner
```

Tiles 6 and 7 carry the most weight: they are the same channel on the two
clock phases, and a player has to tell conducting from blocking at a glance,
at 8x8, while it scrolls. Everything else can be pretty; those two have to be
legible.

## What arrived, and what is shipped

`IMG_0981.png` is the sheet in use: 1024x1024, a 16x16 grid of 64px tiles, all
sixteen drawn. `IMG_0979.png` is the same art at 32px and only carries tiles
0..8; `IMG_0980.png` is the labelled contact sheet. **All nine overlapping
tiles decode byte-identical between the two sheets**, so the upscaling was
faithful and one file does the job.

```bash
python3 games/tools/png2chr.py games/art/IMG_0981.png games/art/tiles.chr
```

Each tile is reduced to 8x8 by the **majority colour of each source pixel's
block**, not a sample from it: the art carries a drawn grid over the top, and a
single sample lands on a grid line about a quarter of the time and turns a
solid pixel into a colour that is not in the palette. The majority ignores it
-- which is also why the anti-aliased 1024 sheet converts as cleanly as the
flat one.

The converter reports how far the worst colour had to travel to reach the
palette, because "it converted" and "it converted correctly" are different
claims: a sheet drawn in some other palette converts without complaint and
comes out looking like mud. The 512 sheet measures **0.0, exact**; the 1024
measures 39.7, which is its anti-aliased edges landing on the nearest entry.

Tiles 0..8 decode to **exactly** the shapes `chr.js` draws in code. The spec
was not approximated, it was met.

The shipped `tiles.chr` is 256 bytes. `chr.js`'s starter set stays as the
fallback and the spec, so a missing or broken sheet costs the artwork and
nothing else.

Converted to CHR at build time -- 2 bits per pixel, 16 bytes per tile, plane 0
then plane 1. `encodeCHR` in `../chr.js` is the reference implementation, so
the pipeline and the console cannot drift apart.
