#!/usr/bin/env python3
"""The Lab's PWA icons: a half wave, literally.

One square-wave half-cycle on the Lab's own palette: the phi1 half high in
its blue, the phi2 half low in its orange, on the app's ground colour.
Legible at 48px, reproducible rather than mystery binaries.

    python3 src/make-icons.py          # writes icons/ beside the app
"""
from pathlib import Path

from PIL import Image, ImageDraw

GROUND = (16, 22, 32)     # --ground
RULE = (38, 49, 63)       # --rule
PHI1 = (124, 155, 196)    # --phi1
PHI2 = (232, 160, 92)     # --phi2

OUT = Path(__file__).resolve().parent.parent / "icons"


def icon(size: int, pad_frac: float) -> Image.Image:
    s = size * 4  # draw at 4x, downsample for clean edges
    im = Image.new("RGB", (s, s), GROUND)
    d = ImageDraw.Draw(im)
    pad = int(s * pad_frac)
    w = max(6, s // 22)  # stroke

    # Baseline grid line, faint.
    mid = s // 2
    d.rectangle([pad, mid - w // 6, s - pad, mid + w // 6], fill=RULE)

    hi = pad + int((s - 2 * pad) * 0.22)
    lo = s - pad - int((s - 2 * pad) * 0.22)
    x0, x1, x2 = pad, s // 2, s - pad

    # phi1: the high half. phi2: the low half. One shared falling edge:
    # a half-cycle, literally.
    d.rectangle([x0, hi - w // 2, x1 + w // 2, hi + w // 2], fill=PHI1)
    d.rectangle([x1 - w // 2, hi, x1 + w // 2, lo], fill=PHI2)
    d.rectangle([x1 - w // 2, lo - w // 2, x2, lo + w // 2], fill=PHI2)

    return im.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(exist_ok=True)
    for size, pad, name in [
        (192, 0.16, "icon-192.png"),
        (512, 0.16, "icon-512.png"),
        (180, 0.16, "icon-180.png"),
        # Maskable: content inside the 40% safe zone, so a round mask
        # cannot clip the wave.
        (512, 0.26, "icon-512-maskable.png"),
    ]:
        icon(size, pad).save(OUT / name)
        print(f"wrote icons/{name}")


if __name__ == "__main__":
    main()
