"""The cartridge: a ROM, its tiles, and the contract they were written to,
in one file.

A cartridge is a **gzipped JSON document**. One file, self-describing, and it
carries the console contract WITH the ROM rather than beside it -- because the
contract is the part an outside author has to agree with, and a contract that
lives in a different file from the bytes it governs is the copy that drifts.
Die Runner learned that twice already: a screen address moved and one of the
four places that named it was missed, and the game drew unrelated memory with
nothing erroring.

    {
      "format": "tinymachines.cartridge",
      "version": 1,
      "encoding": { ... how to read every field, in the file ... },
      "meta":    { name, author, blurb, minted },
      "rom":     { org, end, size, reset, bytes, labels, source },
      "console": { tick, input, screen, width, height, ... },
      "tiles":   { count, chr, palette, pixels },
      "verify":  { what the chip did when this file was minted }
    }

Two ways to give the art, and the second is the one that matters here. `chr`
is the binary tile format (8x8, two bits a pixel, sixteen bytes a tile, the
NES shape) as hex. `pixels` is the same thing as eight rows of eight digits
per tile -- which is the form a language model can actually emit. Whichever
arrives, both are written into the file, so a reader never has to decode to
see the art and a tool never has to parse ASCII to draw it.

Nothing here talks to the engine. `validate()` refuses a layout that cannot
work; whether the ROM *computes* anything is a question only the chip can
answer, and app.py asks it.
"""

from __future__ import annotations

import gzip
import json
import re
from datetime import datetime, timezone

FORMAT = "tinymachines.cartridge"
VERSION = 1

TILE = 8
BYTES_PER_TILE = 16

# The die's own four colours, the ones the exploded view paints the mask
# layers in. Kept here as the numbers rather than parsed out of games/chr.js:
# two files agreeing is the point, and test_cartridge.py says so if they ever
# stop.
PALETTE = [
    "#0B1120",   # 0  substrate: the die with nothing on it
    "#3E93A6",   # 1  diffusion: doped silicon, the switched layer
    "#E0A24B",   # 2  polysilicon: the gates, and anything that controls
    "#4FBFD4",   # 3  metal: the wires, and anything the runner rides
]

# "0123" is the canonical spelling of a pixel row. ".:o#" is accepted too
# because that is what games/tools/png2chr.py --ascii prints, so a sheet can
# be pasted straight out of the converter without being retyped -- and a
# retyped row is a row that can be retyped wrong.
GLYPHS = "0123"
ALIASES = {".": 0, ":": 1, "o": 2, "#": 3, " ": 0, "-": 0}

STACK = (0x0100, 0x0200)
VECTORS = (0xFFFA, 0x10000)

# Addresses the contract can name. The value is what it is for, and it is on
# the wire: a consumer reading a cartridge should not have to be told what
# `tick` means by a human.
CONTRACT = {
    "tick": "host clears it, the ROM raises it when a frame is finished",
    "input": "the controller, one byte, written by the host before each frame",
    "status": "the ROM raises it when the game is over",
    "score": "read by the host, never written by it",
    "entropy": "the host writes a fresh random byte here before each frame",
    "gate_mask": "the levels of the watched control lines, packed one per bit",
}

ENCODING = {
    "numbers": "every address and size is a decimal integer; hex only inside strings",
    "bytes": "lowercase hex, two characters a byte, no separators",
    "chr": (
        "8x8 tiles, two bits a pixel, 16 bytes a tile: bytes 0..7 are bit 0 of "
        "each row (MSB the leftmost pixel), bytes 8..15 bit 1. "
        "colour = (plane1 << 1) | plane0"
    ),
    "pixels": "one string of eight '0'..'3' per row, eight rows a tile, in the same order as chr",
    "palette": "four CSS colours, index 0..3, the die's own mask layers",
    "screen": "console.width * console.height bytes at console.screen, one tile index a cell, row major",
    "container": "gzip of this JSON document, UTF-8",
    "rom.end": (
        "the address of the LAST byte, not one past it: org + size - 1. "
        "The assembler's own convention, kept rather than converted, because "
        "two spellings of the same edge is how an off-by-one gets in"
    ),
}


class CartridgeError(Exception):
    """A cartridge that cannot work, with the reason a person can act on."""


# -- tiles -------------------------------------------------------------------

def pixels_to_chr(pixels: list[list[str]]) -> bytes:
    """Rows of glyphs -> the binary tile format. The inverse is below, and
    round-tripping through both is what test_cartridge.py checks: a format
    with only one direction implemented is a format with one direction
    tested."""
    out = bytearray()
    for t, rows in enumerate(pixels):
        if len(rows) != TILE:
            raise CartridgeError(f"tile {t}: {len(rows)} rows, a tile is {TILE}")
        cells = []
        for y, row in enumerate(rows):
            row = str(row)
            if len(row) != TILE:
                raise CartridgeError(f"tile {t} row {y}: {len(row)} pixels, a row is {TILE}")
            for x, ch in enumerate(row):
                if ch in GLYPHS:
                    cells.append(int(ch))
                elif ch in ALIASES:
                    cells.append(ALIASES[ch])
                else:
                    raise CartridgeError(
                        f"tile {t} row {y} pixel {x}: {ch!r} is not a colour. "
                        f"Use '0'..'3' (or the converter's '.:o#')."
                    )
        for plane in (0, 1):
            for y in range(TILE):
                b = 0
                for x in range(TILE):
                    if (cells[y * TILE + x] >> plane) & 1:
                        b |= 1 << (7 - x)
                out.append(b)
    return bytes(out)


def chr_to_pixels(blob: bytes) -> list[list[str]]:
    tiles = []
    for t in range(len(blob) // BYTES_PER_TILE):
        base = t * BYTES_PER_TILE
        rows = []
        for y in range(TILE):
            lo, hi = blob[base + y], blob[base + TILE + y]
            rows.append("".join(
                GLYPHS[(((hi >> (7 - x)) & 1) << 1) | ((lo >> (7 - x)) & 1)]
                for x in range(TILE)
            ))
        tiles.append(rows)
    return tiles


def read_tiles(tiles: dict | None) -> tuple[bytes, list[list[str]]]:
    """Whichever form arrived, both forms leave."""
    if not tiles:
        return b"", []
    if tiles.get("pixels"):
        blob = pixels_to_chr(tiles["pixels"])
    elif tiles.get("chr"):
        raw = re.sub(r"\s+", "", tiles["chr"])
        try:
            blob = bytes.fromhex(raw)
        except ValueError as e:
            raise CartridgeError(f"tiles.chr is not hex: {e}") from e
        if len(blob) % BYTES_PER_TILE:
            raise CartridgeError(
                f"tiles.chr is {len(blob)} bytes, which is not a whole number of "
                f"{BYTES_PER_TILE}-byte tiles"
            )
    else:
        return b"", []
    return blob, chr_to_pixels(blob)


# -- the layout --------------------------------------------------------------

def _overlap(a: tuple[int, int], b: tuple[int, int]) -> bool:
    return a[0] < b[1] and b[0] < a[1]


def validate(rom: dict, console: dict, tile_count: int) -> list[str]:
    """Refuse a cartridge that cannot work, and return the notes on one that
    can. Every refusal here is a mistake this project has actually made, or
    one that would surface as a game drawing something plausible and wrong
    rather than as an error."""
    # Half-open, computed from the size. `rom["end"]` is the assembler's
    # inclusive last byte, and reading it as an exclusive bound left every
    # overlap check one byte short -- a ROM whose final byte was the screen's
    # first minted cleanly, which is precisely the failure this refuses.
    rom_span = (rom["org"], rom["org"] + rom["size"])
    cells = console["width"] * console["height"]
    screen = (console["screen"], console["screen"] + cells)
    notes: list[str] = []

    if rom["size"] == 0:
        raise CartridgeError("the ROM assembled to no bytes")
    if rom_span[1] > 0x10000:
        raise CartridgeError(f"the ROM ends at ${rom_span[1]:04X}, past the top of memory")
    if screen[1] > 0x10000:
        raise CartridgeError(f"the screen ends at ${screen[1]:04X}, past the top of memory")

    # The one that cost a round: a ROM that reaches its own screen is
    # overwritten by its own display, and it assembles and boots first.
    if _overlap(rom_span, screen):
        raise CartridgeError(
            f"the ROM (${rom_span[0]:04X}..${rom_span[1] - 1:04X}) covers its own screen "
            f"(${screen[0]:04X}..${screen[1] - 1:04X}). It will be overwritten by the "
            f"picture it draws. Move the screen to a higher page, or shorten the ROM."
        )
    if _overlap(rom_span, VECTORS):
        raise CartridgeError(
            f"the ROM reaches ${VECTORS[0]:04X}, where the reset and interrupt vectors "
            f"live. Booting writes the reset vector, so those bytes would be replaced."
        )
    if _overlap(rom_span, STACK):
        raise CartridgeError(
            f"the ROM covers the stack page (${STACK[0]:04X}..${STACK[1] - 1:04X}). "
            f"Any JSR or interrupt would write into the code."
        )
    if _overlap(screen, STACK):
        raise CartridgeError(
            f"the screen covers the stack page (${STACK[0]:04X}..${STACK[1] - 1:04X}). "
            f"A subroutine call would draw on it."
        )
    if _overlap(screen, VECTORS):
        raise CartridgeError(f"the screen reaches ${VECTORS[0]:04X}, where the vectors live")

    named = {k: console[k] for k in CONTRACT if console.get(k) is not None}
    for key, addr in named.items():
        if rom_span[0] <= addr < rom_span[1]:
            raise CartridgeError(
                f"console.{key} is ${addr:04X}, inside the ROM. The host writes that "
                f"byte between frames, so it would be writing into the code."
            )
        if screen[0] <= addr < screen[1]:
            raise CartridgeError(
                f"console.{key} is ${addr:04X}, inside the screen. Drawing would "
                f"overwrite it."
            )
    seen: dict[int, str] = {}
    for key, addr in named.items():
        if addr in seen:
            raise CartridgeError(
                f"console.{key} and console.{seen[addr]} are both ${addr:04X}; "
                f"they are different bytes and cannot share one"
            )
        seen[addr] = key

    reset = rom["reset"]
    if not rom_span[0] <= reset < rom_span[1]:
        notes.append(
            f"the reset vector (${reset:04X}) is outside the ROM "
            f"(${rom_span[0]:04X}..${rom_span[1] - 1:04X}); the chip will start on "
            f"whatever is there"
        )
    if cells == 0:
        raise CartridgeError("the screen is zero cells")
    if tile_count == 0:
        notes.append("no tiles: a player gets the console's starter sheet")
    if console.get("frame_cost") is None:
        notes.append("no frame_cost: the host will size its requests by guesswork "
                     "unless verification measures one")
    return notes


# -- the document ------------------------------------------------------------

def build(meta: dict, assembled: dict, console: dict, tiles: dict | None,
          reset: int | None = None) -> dict:
    blob, pixels = read_tiles(tiles)
    rom = {
        "org": assembled["org"],
        "end": assembled["end"],
        "size": assembled["size"],
        "reset": assembled["org"] if reset is None else reset,
        "bytes": assembled["bytes"],
        "labels": assembled["labels"],
        "source": assembled.get("source", ""),
    }
    console = {k: v for k, v in console.items() if v is not None}
    notes = validate(rom, console, len(pixels))
    doc = {
        "format": FORMAT,
        "version": VERSION,
        "encoding": ENCODING,
        "contract": CONTRACT,
        "meta": {
            "minted": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            **{k: v for k, v in meta.items() if v is not None},
        },
        "rom": rom,
        "console": console,
        "tiles": {
            "count": len(pixels),
            "size": TILE,
            "palette": PALETTE,
            "chr": blob.hex(),
            "pixels": pixels,
        },
        "notes": notes,
    }
    return doc


def pack(doc: dict) -> bytes:
    """One file. mtime 0 so the same cartridge minted twice is the same bytes:
    a container that changes every time it is written cannot be diffed, and
    diffing two cartridges is how a person sees what an edit did."""
    raw = json.dumps(doc, separators=(",", ":"), sort_keys=False).encode("utf-8")
    return gzip.compress(raw, compresslevel=9, mtime=0)


def unpack(blob: bytes) -> dict:
    try:
        raw = gzip.decompress(blob)
    except OSError as e:
        raise CartridgeError(f"not a gzip file: {e}") from e
    try:
        doc = json.loads(raw)
    except ValueError as e:
        raise CartridgeError(f"not JSON inside the gzip: {e}") from e
    if doc.get("format") != FORMAT:
        raise CartridgeError(f"format is {doc.get('format')!r}, expected {FORMAT!r}")
    if doc.get("version") != VERSION:
        raise CartridgeError(f"version {doc.get('version')} is not {VERSION}")
    return doc
