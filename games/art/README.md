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

Converted to CHR at build time -- 2 bits per pixel, 16 bytes per tile, plane 0
then plane 1. `encodeCHR` in `../chr.js` is the reference implementation, so
the pipeline and the console cannot drift apart.
