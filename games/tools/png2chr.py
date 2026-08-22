#!/usr/bin/env python3
"""A sprite sheet, into the tile format the console actually reads.

    python3 games/tools/png2chr.py games/art/IMG_0979.png games/art/tiles.chr

The sheet is a grid of square tiles, each an integer upscale of an 8x8 design.
Every tile is reduced back to 8x8 by taking the MAJORITY colour of each source
pixel's block rather than a sample from it: the art carries a drawn grid over
the top, and a single sample can land on a grid line and turn a solid pixel
into a colour that is not in the palette. A majority ignores it.

Colours are matched to the four the console draws, nearest in RGB. The report
says how far each one had to travel, because "it converted" and "it converted
correctly" are different claims: a sheet drawn in a different palette will
convert without complaint and come out looking like mud.

Output is `chr.js`'s format and nothing else: 8x8, two bits a pixel, sixteen
bytes a tile, plane 0 then plane 1, MSB the leftmost pixel.
"""

import sys
from collections import Counter
from pathlib import Path

from PIL import Image

# The console's palette, from games/chr.js. Kept here as the numbers rather
# than parsed out of the JavaScript: two files agreeing is the point, and the
# check below will say if they ever stop.
PALETTE = [
    (0x0B, 0x11, 0x20),   # 0 substrate
    (0x3E, 0x93, 0xA6),   # 1 diffusion
    (0xE0, 0xA2, 0x4B),   # 2 polysilicon
    (0x4F, 0xBF, 0xD4),   # 3 metal
]
GLYPH = ".:o#"


def nearest(rgb):
    """Index of the closest palette entry, and how far it was."""
    best, dist = 0, None
    for i, p in enumerate(PALETTE):
        d = sum((a - b) ** 2 for a, b in zip(rgb, p))
        if dist is None or d < dist:
            best, dist = i, d
    return best, dist ** 0.5


def tile_size(width, tiles_across=16):
    if width % tiles_across:
        sys.exit(f"png2chr: {width}px does not divide into {tiles_across} tiles")
    size = width // tiles_across
    if size % 8:
        sys.exit(f"png2chr: a {size}px tile is not an integer upscale of 8x8")
    return size


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: png2chr.py <sheet.png> [out.chr] [--count N] [--ascii]")
    src = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 and not sys.argv[2].startswith('-') else None
    want = 16
    if '--count' in sys.argv:
        want = int(sys.argv[sys.argv.index('--count') + 1])

    im = Image.open(src).convert('RGB')
    w, h = im.size
    size = tile_size(w)
    scale = size // 8
    px = im.load()

    chr_bytes = bytearray()
    report = []
    worst = 0.0
    for t in range(want):
        ox = (t % 16) * size
        oy = (t // 16) * size
        cells = []
        for y in range(8):
            for x in range(8):
                # The majority colour of this source pixel's block. The drawn
                # grid is a minority everywhere, so it never wins; a sample
                # would hit it about a quarter of the time.
                votes = Counter(px[ox + x * scale + dx, oy + y * scale + dy]
                                for dy in range(scale) for dx in range(scale))
                rgb, _ = votes.most_common(1)[0]
                idx, d = nearest(rgb)
                worst = max(worst, d)
                cells.append(idx)
        # plane 0 then plane 1, MSB leftmost: chr.js's encodeCHR, in Python
        for plane in (0, 1):
            for y in range(8):
                b = 0
                for x in range(8):
                    if (cells[y * 8 + x] >> plane) & 1:
                        b |= 1 << (7 - x)
                chr_bytes.append(b)
        report.append((t, cells))

    print(f"{src.name}: {w}x{h}, {size}px tiles ({scale}x upscale of 8x8), {want} tiles")
    print(f"worst colour distance from the palette: {worst:.1f} "
          f"({'exact' if worst == 0 else 'approximate'})")
    if worst > 40:
        print("  WARNING: this sheet is not drawn in the console's four colours.")

    if '--ascii' in sys.argv:
        for t, cells in report:
            print(f"\ntile {t}")
            for y in range(8):
                print('  ' + ''.join(GLYPH[cells[y * 8 + x]] for x in range(8)))

    if out:
        out.write_bytes(bytes(chr_bytes))
        print(f"wrote {out} ({len(chr_bytes)} bytes, {len(chr_bytes)//16} tiles)")


if __name__ == '__main__':
    main()
