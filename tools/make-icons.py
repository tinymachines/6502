#!/usr/bin/env python3
"""Generate the PWA icon set.

A DIP-package silhouette with the part number on it -- legible at 48px on a home
screen, which rules out anything resembling the actual die. Kept in the repo so
the icons are reproducible rather than mystery binaries.

    python3 tools/make-icons.py web/icons
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BG = (11, 17, 32)        # --space
BODY = (26, 39, 64)      # --subtle
ACCENT = (34, 211, 238)  # --accent
PIN = (125, 211, 252)    # --gold

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
]


def load_font(size):
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def draw_icon(px, *, padding_ratio=0.0, rounded_bg=True):
    """Render at `px`. `padding_ratio` insets the artwork for maskable icons,
    whose outer ~10% can be cropped to any shape by the launcher."""
    scale = 4  # supersample, then downscale: cheap antialiasing
    size = px * scale
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if rounded_bg:
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.18), fill=BG)
    else:
        d.rectangle([0, 0, size - 1, size - 1], fill=BG)

    inset = size * padding_ratio
    area = size - 2 * inset

    # Chip body, centred, a little wider than tall like a real DIP.
    bw, bh = area * 0.62, area * 0.50
    bx0 = inset + (area - bw) / 2
    by0 = inset + (area - bh) / 2
    bx1, by1 = bx0 + bw, by0 + bh

    # Pins: four per side, straddling the body edge.
    pin_w, pin_h = area * 0.085, area * 0.045
    for i in range(4):
        cy = by0 + bh * (i + 1) / 5 - pin_h / 2
        d.rounded_rectangle([bx0 - pin_w, cy, bx0 + area * 0.012, cy + pin_h],
                            radius=pin_h * 0.3, fill=PIN)
        d.rounded_rectangle([bx1 - area * 0.012, cy, bx1 + pin_w, cy + pin_h],
                            radius=pin_h * 0.3, fill=PIN)

    d.rounded_rectangle([bx0, by0, bx1, by1], radius=area * 0.045,
                        fill=BODY, outline=ACCENT, width=max(2, int(area * 0.018)))

    # Pin-1 notch, the detail that makes it read as a chip.
    nr = area * 0.035
    ncx, ncy = bx0 + area * 0.055, by0 + area * 0.055
    d.ellipse([ncx - nr, ncy - nr, ncx + nr, ncy + nr], fill=ACCENT)

    text = "6502"
    font = load_font(int(bh * 0.44))
    l, t, r, b = d.textbbox((0, 0), text, font=font)
    d.text(((bx0 + bx1) / 2 - (r - l) / 2 - l,
            (by0 + by1) / 2 - (b - t) / 2 - t), text, font=font, fill=ACCENT)

    return img.resize((px, px), Image.LANCZOS)


SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="6502">
  <rect width="64" height="64" rx="12" fill="#0b1120"/>
  <g fill="#7dd3fc">
    <rect x="9" y="21" width="8" height="3" rx="1.5"/><rect x="9" y="29" width="8" height="3" rx="1.5"/>
    <rect x="9" y="37" width="8" height="3" rx="1.5"/><rect x="47" y="21" width="8" height="3" rx="1.5"/>
    <rect x="47" y="29" width="8" height="3" rx="1.5"/><rect x="47" y="37" width="8" height="3" rx="1.5"/>
  </g>
  <rect x="16" y="16" width="32" height="30" rx="3" fill="#1a2740" stroke="#22d3ee" stroke-width="2.5"/>
  <circle cx="21" cy="21" r="2" fill="#22d3ee"/>
  <text x="32" y="36" font-family="ui-monospace,monospace" font-size="11" font-weight="700"
        fill="#22d3ee" text-anchor="middle">6502</text>
</svg>
"""


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "web/icons")
    out.mkdir(parents=True, exist_ok=True)

    draw_icon(192).save(out / "icon-192.png")
    draw_icon(512).save(out / "icon-512.png")
    # Maskable: artwork inside the safe zone so a circular crop keeps it whole.
    draw_icon(512, padding_ratio=0.12, rounded_bg=False).save(out / "icon-512-maskable.png")
    draw_icon(180).save(out / "apple-touch-icon.png")
    (out / "icon.svg").write_text(SVG)

    for f in sorted(out.iterdir()):
        print(f"  {f.name:26} {f.stat().st_size:>7} bytes")


if __name__ == "__main__":
    main()
