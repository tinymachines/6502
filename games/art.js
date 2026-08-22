/* A photograph, into the console's four colours.
 * ===========================================================================
 * The registry accepts art only as rows of '0'..'3', so converting an image is
 * the client's job. That is not a shortcut: it leaves no image parser in the
 * request path, no arbitrary bytes on anyone's disk, and one encoding rather
 * than two. What goes up is the same tile format a sprite sheet is made of, so
 * the portrait on a builder page is drawn by the same decodeCHR that draws the
 * game.
 *
 * The palette is the die's, and it has a property worth knowing before
 * choosing a mode. Measured by Rec.709 luminance:
 *
 *     0 substrate  #0B1120    17
 *     1 diffusion  #3E93A6   130
 *     2 polysilicon #E0A24B  169
 *     3 metal      #4FBFD4   169
 *
 * Polysilicon and metal are the SAME brightness and differ only in hue, so as
 * a greyscale ramp this palette has three steps, not four. A luminance-only
 * conversion therefore throws away a quarter of the palette; matching in full
 * RGB keeps amber and cyan apart and is what both modes below do.
 */
import { PALETTE } from './chr.js';

export const TILE = 8;

const RGB = PALETTE.map((hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]);

export const LUMA = RGB.map(([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b);

/** Nearest palette entry in RGB, and how far it was. */
function nearest(r, g, b) {
  let best = 0, dist = Infinity;
  for (let i = 0; i < RGB.length; i++) {
    const d = (r - RGB[i][0]) ** 2 + (g - RGB[i][1]) ** 2 + (b - RGB[i][2]) ** 2;
    if (d < dist) { best = i; dist = d; }
  }
  return best;
}

/**
 * Draw an image into a w*8 by h*8 buffer, cropped to COVER the box.
 * Cover rather than fit, because a portrait letterboxed into a square is
 * mostly substrate, and the subject is what the box is for.
 */
function rasterise(img, w, h) {
  const W = w * TILE, H = h * TILE;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = true;
  const sw = img.width, sh = img.height;
  const scale = Math.max(W / sw, H / sh);
  const dw = sw * scale, dh = sh * scale;
  g.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
  return { data: g.getImageData(0, 0, W, H).data, W, H };
}

/**
 * @param {ImageBitmap|HTMLImageElement} img
 * @param {number} w  width in tiles
 * @param {number} h  height in tiles
 * @param {{dither?: boolean}} opts
 * @returns {string[][]} one entry per tile, row major, each 8 strings of 8
 */
export function imageToTiles(img, w, h, opts = {}) {
  const dither = opts.dither !== false;
  const { data, W, H } = rasterise(img, w, h);
  // Work in floats so error diffusion has somewhere to put the error. A
  // Uint8ClampedArray would round it away at every step, which looks like
  // dithering doing nothing.
  const buf = new Float32Array(W * H * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    // Composite onto substrate rather than ignoring alpha: a transparent PNG
    // over white comes back as a white rectangle otherwise.
    const a = data[i + 3] / 255;
    for (let k = 0; k < 3; k++) buf[j + k] = data[i + k] * a + RGB[0][k] * (1 - a);
  }

  const idx = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 3;
      const want = [buf[p], buf[p + 1], buf[p + 2]];
      const pick = nearest(want[0], want[1], want[2]);
      idx[y * W + x] = pick;
      if (!dither) continue;
      // Floyd-Steinberg, in RGB rather than in luminance: two of these four
      // colours have the same brightness, so a luminance-only error term
      // cannot tell amber from cyan and the picture loses its warm half.
      const err = [want[0] - RGB[pick][0], want[1] - RGB[pick][1], want[2] - RGB[pick][2]];
      const spread = (dx, dy, f) => {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= W || ny >= H) return;
        const q = (ny * W + nx) * 3;
        for (let k = 0; k < 3; k++) buf[q + k] += err[k] * f;
      };
      spread(1, 0, 7 / 16); spread(-1, 1, 3 / 16);
      spread(0, 1, 5 / 16); spread(1, 1, 1 / 16);
    }
  }

  // Into tiles, row major, which is exactly CHR's own order.
  const tiles = [];
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      const rows = [];
      for (let y = 0; y < TILE; y++) {
        let row = '';
        for (let x = 0; x < TILE; x++) row += idx[(ty * TILE + y) * W + tx * TILE + x];
        rows.push(row);
      }
      tiles.push(rows);
    }
  }
  return tiles;
}

/** A File from an <input type="file">, decoded without touching the network. */
export async function tilesFromFile(file, w, h, opts) {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name} is not an image`);
  // createImageBitmap decodes off the main thread and, unlike an <img src=blob>,
  // reports a decode failure as a rejection rather than as a silent 0x0.
  const bitmap = await createImageBitmap(file);
  try {
    return imageToTiles(bitmap, w, h, opts);
  } finally {
    bitmap.close();
  }
}

/** The inverse, for showing what is stored: CHR hex to a canvas. */
export function drawArt(canvas, art, scale = 4) {
  if (!art || !art.chr) return false;
  const bytes = Uint8Array.from(art.chr.match(/../g) || [], (b) => parseInt(b, 16));
  const W = art.w * TILE, H = art.h * TILE;
  if (bytes.length < art.w * art.h * 16) return false;
  canvas.width = W; canvas.height = H;
  canvas.style.width = `${W * scale}px`;
  canvas.style.height = `${H * scale}px`;
  const g = canvas.getContext('2d');
  const im = g.createImageData(W, H);
  for (let t = 0; t < art.w * art.h; t++) {
    const base = t * 16, tx = (t % art.w) * TILE, ty = ((t / art.w) | 0) * TILE;
    for (let y = 0; y < TILE; y++) {
      const lo = bytes[base + y], hi = bytes[base + TILE + y];
      for (let x = 0; x < TILE; x++) {
        const c = RGB[(((hi >> (7 - x)) & 1) << 1) | ((lo >> (7 - x)) & 1)];
        const o = ((ty + y) * W + tx + x) * 4;
        im.data[o] = c[0]; im.data[o + 1] = c[1]; im.data[o + 2] = c[2]; im.data[o + 3] = 255;
      }
    }
  }
  g.putImageData(im, 0, 0);
  return true;
}

/** Tiles as sent, drawn straight into a canvas, so a preview needs no round trip. */
export function drawTiles(canvas, tiles, w, h, scale = 4) {
  const W = w * TILE, H = h * TILE;
  canvas.width = W; canvas.height = H;
  canvas.style.width = `${W * scale}px`;
  canvas.style.height = `${H * scale}px`;
  const g = canvas.getContext('2d');
  const im = g.createImageData(W, H);
  tiles.forEach((rows, t) => {
    const tx = (t % w) * TILE, ty = ((t / w) | 0) * TILE;
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const c = RGB[+rows[y][x]];
        const o = ((ty + y) * W + tx + x) * 4;
        im.data[o] = c[0]; im.data[o + 1] = c[1]; im.data[o + 2] = c[2]; im.data[o + 3] = 255;
      }
    }
  });
  g.putImageData(im, 0, 0);
}
