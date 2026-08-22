#!/usr/bin/env python3
"""Mint the sample cartridge from the ROM and the art, through the live API.

    python3 games/tools/mint.py --api https://6502.tinymachines.ai/api

Nothing here knows the cartridge format. It posts the source, the console
addresses and the tile sheet, and writes back whatever comes out, so this
script cannot drift from the format the way a second encoder would. The
deploy runs it, which also means every deploy exercises the endpoint.

The console addresses are the ones games/game.js has for this cartridge, and
they are the one thing here that is typed twice. `verify` in the response is
what says they were right: a wrong tick address is a cartridge that never
completes a frame, and this refuses to write one.
"""

import argparse
import gzip
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent

CONSOLE = {
    "tick": 0x0D, "input": 0x02, "status": 0x03, "score": 0x11,
    "screen": 0x0500, "width": 16, "height": 16, "gate_mask": 0x14,
    "dirs": {"left": 3, "right": 4},
    "watch": ["dpc25_SBDB", "dpc9_DBADD", "dpc10_ADLADD", "dpc21_ADDADL",
              "dpc23_SBAC", "dpc30_ADHPCH", "dpc40_ADLPCL", "dpc2_XSB"],
}
BLURB = ("Ride the metal. Thread the gates. A pass transistor conducts on one "
         "clock phase and blocks on the other, so a channel that is shut now "
         "will open in a moment.")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="https://6502.tinymachines.ai/api")
    ap.add_argument("--out", default="dierunner.cart.gz")
    ap.add_argument("--frames", type=int, default=4)
    args = ap.parse_args()

    body = {
        "rom": {"source": (HERE / "rom" / "dierunner.s").read_text(), "org": 0x0200},
        "meta": {"name": "Die Runner", "author": "tinymachines", "blurb": BLURB},
        "console": CONSOLE,
        "tiles": {"chr": (HERE / "art" / "tiles.chr").read_bytes().hex()},
        "frames": args.frames,
    }
    req = urllib.request.Request(
        f"{args.api.rstrip('/')}/v1/cartridge",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            blob = r.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:400]
        print(f"mint: HTTP {e.code}: {detail}", file=sys.stderr)
        return 1
    except OSError as e:
        print(f"mint: {e}", file=sys.stderr)
        return 1

    doc = json.loads(gzip.decompress(blob))
    v = doc.get("verify") or {}
    # A cartridge that does not run is not written. The whole reason the mint
    # runs the chip is so this can be a refusal rather than a file.
    if args.frames and v.get("frames_completed", 0) < args.frames:
        print(f"mint: only {v.get('frames_completed')} of {args.frames} frames "
              f"completed; not writing. {v.get('notes')}", file=sys.stderr)
        return 1
    out = HERE / args.out
    out.write_bytes(blob)
    print(f"minted {out.name}: {len(blob)} bytes, ROM {doc['rom']['size']}B, "
          f"{doc['tiles']['count']} tiles, {v.get('frame_cost')} half-cycles a frame")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
