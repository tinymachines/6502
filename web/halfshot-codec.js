// The halfshot recording as a file: one object per half-cycle, and every node's
// level at every half-cycle, encoded as deltas.
//
// A frame is a photograph of the whole chip at one clock edge. Keeping every
// photograph whole is 1725 bytes a frame and about 165 of them change between
// one frame and the next, so the file carries the first frame in full and each
// later frame as the nodes that went up and the nodes that went down. That is
// lossless: `levelsAt` replays it and gets the original bytes back, and the
// harness asserts it does. Everything else in a frame (registers, buses, pins,
// the memory access, which switches are open) is derived from those levels at
// record time and kept beside them so a reader of the file does not need the
// netlist to make sense of it.
//
// A leaf module: it imports nothing, so a harness can load it without booting
// the page, and the page and the harness cannot disagree about the format.

export const FORMAT = 'v6502.halfshot';
export const VERSION = 1;

/** Levels (0/255 per node) -> base64 of a packed bitset, bit i = node i. */
export function packLevels(levels) {
  const bytes = new Uint8Array(Math.ceil(levels.length / 8));
  for (let i = 0; i < levels.length; i++) if (levels[i]) bytes[i >> 3] |= 1 << (i & 7);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/** The inverse of `packLevels`, back to one byte per node (255 or 0). */
export function unpackLevels(b64, count) {
  const s = atob(b64);
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    if ((s.charCodeAt(i >> 3) >> (i & 7)) & 1) out[i] = 255;
  }
  return out;
}

/** The nodes that differ between two level arrays, split by direction. */
export function delta(prev, next) {
  const up = [];
  const down = [];
  for (let i = 0; i < next.length; i++) {
    if (prev[i] === next[i]) continue;
    (next[i] ? up : down).push(i);
  }
  return { up, down };
}

/**
 * Build the file. `frames` are the page's records, each carrying `levels`;
 * `meta` is what a reader needs to interpret them: unit names, control names,
 * term names, node count and the program.
 */
export function encode(frames, meta) {
  const out = [];
  for (let k = 0; k < frames.length; k++) {
    const f = frames[k];
    const rec = {
      h: f.h, ph: f.ph, clk0: f.clk0 ? 1 : 0, sync: f.sync ? 1 : 0, t: f.t,
      ab: f.ab, db: f.db, rw: f.rw, pc: f.pc, a: f.a, x: f.x, y: f.y, s: f.s, p: f.p, ir: f.ir,
      fetch: f.fetch, op: f.op,
      pins: f.pins,
      units: f.units.map((u) => (u.mask === 0xff ? u.value : [u.value, u.mask])),
      open: f.open.map((o) => (o ? 1 : 0)).join(''),
      terms: f.terms,
      access: f.access,
    };
    if (k === 0) rec.levels = packLevels(f.levels);
    else {
      const d = delta(frames[k - 1].levels, f.levels);
      rec.up = d.up;
      rec.down = d.down;
    }
    out.push(rec);
  }
  return {
    format: FORMAT, version: VERSION,
    program: meta.program,
    nodes: meta.nodes,
    rails: { vss: meta.vss, vcc: meta.vcc },
    units: meta.units,
    controls: meta.controls,
    terms: meta.terms,
    frames: out,
  };
}

/** Replay the deltas to recover every node's level at frame `k`. */
export function levelsAt(file, k) {
  const levels = unpackLevels(file.frames[0].levels, file.nodes);
  for (let i = 1; i <= k; i++) {
    const f = file.frames[i];
    for (const n of f.up) levels[n] = 255;
    for (const n of f.down) levels[n] = 0;
  }
  return levels;
}
