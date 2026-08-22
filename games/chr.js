/* Tiles: 8x8, two bits a pixel, sixteen bytes each.
 * ===========================================================================
 *
 * The NES shape, and not by accident: it is what every old-school sprite tool
 * emits, it packs a full tile into sixteen bytes, and four colours per tile is
 * the constraint that makes 1980s art look like 1980s art rather than like a
 * photograph with the saturation turned up.
 *
 *   bytes 0..7   bit 0 of each pixel, one byte per row, MSB is the left pixel
 *   bytes 8..15  bit 1 of each pixel
 *   colour       (plane1 << 1) | plane0, so 0..3 into the palette
 *
 * Colour 0 is the background and is drawn, not skipped: this is a tiled
 * screen, not a sprite layer. A cartridge that wants transparency composites
 * it itself.
 *
 * The palette is the die's own. Those four colours are what the exploded view
 * paints the mask layers in, which is the whole conceit of Die Runner: the
 * playfield is the chip.
 */

export const PALETTE = [
  '#0B1120',   // 0  substrate: the die with nothing on it
  '#3E93A6',   // 1  diffusion: doped silicon, the switched layer
  '#E0A24B',   // 2  polysilicon: the gates, and anything that controls
  '#4FBFD4',   // 3  metal: the wires, and anything the runner rides
];

export const TILE = 8;
export const BYTES_PER_TILE = 16;

/** CHR bytes -> one Uint8Array of palette indices per tile. */
export function decodeCHR(bytes) {
  const tiles = [];
  for (let t = 0; t + BYTES_PER_TILE <= bytes.length; t += BYTES_PER_TILE) {
    const px = new Uint8Array(TILE * TILE);
    for (let y = 0; y < TILE; y++) {
      const lo = bytes[t + y];
      const hi = bytes[t + 8 + y];
      for (let x = 0; x < TILE; x++) {
        const bit = 7 - x;
        px[y * TILE + x] = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
      }
    }
    tiles.push(px);
  }
  return tiles;
}

/** The inverse, so the art pipeline and the console share one definition. */
export function encodeCHR(tiles) {
  const out = new Uint8Array(tiles.length * BYTES_PER_TILE);
  tiles.forEach((px, t) => {
    for (let y = 0; y < TILE; y++) {
      let lo = 0;
      let hi = 0;
      for (let x = 0; x < TILE; x++) {
        const c = px[y * TILE + x] & 3;
        lo |= (c & 1) << (7 - x);
        hi |= ((c >> 1) & 1) << (7 - x);
      }
      out[t * BYTES_PER_TILE + y] = lo;
      out[t * BYTES_PER_TILE + 8 + y] = hi;
    }
  });
  return out;
}

/**
 * Every tile drawn once into one atlas at the display scale, so a frame is
 * `w*h` drawImage calls out of video memory rather than `w*h*64` putImageData
 * pixels. At 32x24 that is 768 blits a frame, which is nothing; done the naive
 * way it is 49,152 pixel writes, which is not.
 */
export function buildSheet(tiles, scale, palette = PALETTE) {
  const cols = 16;
  const rows = Math.ceil(tiles.length / cols);
  const c = document.createElement('canvas');
  c.width = cols * TILE * scale;
  c.height = rows * TILE * scale;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  tiles.forEach((px, t) => {
    const ox = (t % cols) * TILE * scale;
    const oy = ((t / cols) | 0) * TILE * scale;
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        g.fillStyle = palette[px[y * TILE + x]];
        g.fillRect(ox + x * scale, oy + y * scale, scale, scale);
      }
    }
  });
  return { canvas: c, scale, cols, count: tiles.length };
}

/** One screen: tile indices in, pixels out. */
export function drawScreen(ctx, sheet, indices, w, h) {
  const s = TILE * sheet.scale;
  for (let i = 0; i < indices.length; i++) {
    const t = indices[i] % Math.max(1, sheet.count);
    ctx.drawImage(
      sheet.canvas,
      (t % sheet.cols) * s, ((t / sheet.cols) | 0) * s, s, s,
      (i % w) * s, ((i / w) | 0) * s, s, s,
    );
  }
}

/* -- the starter set ------------------------------------------------------
 * Drawn in code so the console has something to render before any art
 * arrives, and so the SPEC is executable: whatever a sprite tool produces has
 * to decode to exactly this shape. Each tile is eight strings of eight
 * characters, one per palette entry.
 */
const ART = {
  //  . substrate   : diffusion   o polysilicon   # metal
  0: ['........', '...  ...', '........', '........',   // empty die: a faint
      '........', '.....  .', '........', '........'],  // dot of nothing
  1: ['.######.', '#######.', '########', '########',   // metal: the trail the
      '########', '########', '.#######', '.######.'],  // runner leaves
  2: ['...oo...', '..oooo..', '.oo##oo.', 'oo####oo',   // a charge packet
      'oo####oo', '.oo##oo.', '..oooo..', '...oo...'],
  3: ['::::::::', ':......:', ':.::::.:', ':.:..:.:',   // diffusion: doped
      ':.:..:.:', ':.::::.:', ':......:', '::::::::'],
  4: ['oooooooo', 'o......o', 'o.oooo.o', 'o.o..o.o',   // polysilicon gate
      'o.o..o.o', 'o.oooo.o', 'o......o', 'oooooooo'],
  5: ['..####..', '.#....#.', '#..oo..#', '#.o..o.#',   // a via: metal down to
      '#.o..o.#', '#..oo..#', '.#....#.', '..####..'],  // the layer below
  6: ['oo....oo', 'oo....oo', 'oo....oo', 'oo....oo',   // pass transistor,
      'oo....oo', 'oo....oo', 'oo....oo', 'oo....oo'],  // OPEN: you may pass
  7: ['oo####oo', 'oo####oo', 'oo####oo', 'oo####oo',   // pass transistor,
      'oo####oo', 'oo####oo', 'oo####oo', 'oo####oo'],  // SHUT: its gate is low
  8: ['...##...', '..####..', '.##..##.', '##....##',   // the runner: a charge
      '##....##', '.##..##.', '..####..', '...##...'],  // carrier, mid-flight
};
const CH = { '.': 0, ' ': 0, ':': 1, o: 2, '#': 3 };

export function starterTiles(count = 16) {
  const tiles = [];
  for (let t = 0; t < count; t++) {
    const px = new Uint8Array(TILE * TILE);
    const rows = ART[t];
    if (rows) {
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) px[y * TILE + x] = CH[rows[y][x]] ?? 0;
      }
    }
    tiles.push(px);
  }
  return tiles;
}

export const starterCHR = () => encodeCHR(starterTiles());
