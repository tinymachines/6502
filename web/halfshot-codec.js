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
//
// The format, as a reader of the file needs it. Every one of these was asked
// about by the first person to read an export cold, so they are written down
// here and, where a field can carry it, in the file itself (`encoding`).
//
//   format, version   'v6502.halfshot', 2. Version 1 files are the same shape
//                     minus `encoding`; in them the vcc rail's level can dip
//                     (see below), and the last frame may be a lone phi1.
//   nodes             1725: the length of every level array, and the node
//                     numbering is visual6502's own (nodenames.js), so
//                     `rails.vss` is 558 and `rails.vcc` is 657.
//   rails             Definitions, not measurements: vss reads 0 and vcc reads
//                     1 in every frame. That was NOT true of version 1: the
//                     solver wrote a group's resolved level into a rail it had
//                     reached, so 657 went low for half a cycle on most opcode
//                     fetches. Found by a reader replaying an export.
//   units, controls,  Names, in the order the per-frame `units`, `open` and
//   terms             `terms` fields use.
//   frames[k]         One half-cycle. `h` is the chip's half-cycle count and
//                     `ph` the internal phase (1 or 2, from the die's own
//                     phase-1 node); `clk0` is the input pin, which is not the
//                     same thing. A recording never ends on a phi1: a batch
//                     that would takes one more frame, so every phi1 has its
//                     phi2 (except across a gap, where `h` says how far the
//                     chip moved).
//     units[i]        The byte a datapath unit holds. A bare number means all
//                     eight bits have a storage node; `[value, mask]` means
//                     only the bits set in `mask` do, and the others in `value`
//                     are 0 and mean nothing. `p` is `[v, 0xDF]` because the
//                     status register has no bit 5. This is `unitValue()` in
//                     blueprint-draw.js; the register field `p` beside it is
//                     the readout, with bit 5 forced to 1 as the silicon does.
//     open            One character per control line, '1' where the switches
//                     it gates conduct.
//     terms           Indices into `terms` of the decode-PLA product terms
//                     that are high.
//     access          `{kind: 'R'|'W', addr, val}` for the memory access the
//                     edge before this frame serviced (a read as clk0 falls,
//                     a write as it rises), or null.
//     levels          Frame 0 only: base64 of a bitset, 216 bytes for 1725
//                     nodes. Bit i of the stream is node i, LSB-FIRST within
//                     each byte (node 0 is bit 0 of byte 0, node 8 is bit 0 of
//                     byte 1). The three bits past node 1724 are padding and
//                     zero.
//     up, down        Every later frame: the nodes that went high and the
//                     nodes that went low since the previous frame. Applying
//                     them in order to frame 0's levels reproduces every
//                     frame's levels exactly; `levelsAt` does that.
//     gap, mem        On a frame taken after Record was off: how many
//                     half-cycles went unrecorded, and base64 of the whole
//                     64 KiB of memory as it then stood.
//   instructions      Frame ranges grouped by the opcode fetch that began them.

// A file also carries `build` when the exporting page knows it: the deployed
// commit and its date from build-info.json (null in development, where the
// stamp may not exist) and `exported`, the moment the file was written. It
// answers "which build made this" in one field: a reader once lost a round
// trip to a stale re-upload that was byte-identical to the previous file.
// Optional so old files stay valid; still version 2.

export const FORMAT = 'v6502.halfshot';
export const VERSION = 2;

/**
 * What a reader needs to decode the fields without this source in front of
 * them, written into every file. Prose in a data file is unusual; a reader
 * guessing MSB-first got vss reading high, which is worse.
 */
export const ENCODING = Object.freeze({
  levels: 'base64 bitset, bit i = node i, LSB first within each byte, zero padded to whole bytes',
  units: 'a byte where all eight bits have a storage node, else [value, mask] with mask marking the bits that do',
  open: 'one char per control line, 1 = conducting',
  rails: 'definitions: vss is 0 and vcc is 1 in every frame',
  frames: 'one per half-cycle; ph is the internal phase, and the last frame is always a phi2 unless the cap intervened',
});

/** Levels (0/255 per node) -> base64 of a packed bitset, bit i = node i, LSB first in each byte. */
export function packLevels(levels) {
  const bytes = new Uint8Array(Math.ceil(levels.length / 8));
  for (let i = 0; i < levels.length; i++) if (levels[i]) bytes[i >> 3] |= 1 << (i & 7);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/** Raw bytes -> base64, for the memory image a frame after a gap carries. */
export function packBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function unpackBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
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
    // A frame after a gap: how far the chip moved unrecorded, and memory as it
    // stood, because the writes in between were never seen.
    if (f.gap > 0) {
      rec.gap = f.gap;
      if (f.snapshot) rec.mem = packBytes(f.snapshot);
    }
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
    encoding: ENCODING,
    build: meta.build || null,
    program: meta.program,
    nodes: meta.nodes,
    rails: { vss: meta.vss, vcc: meta.vcc },
    units: meta.units,
    controls: meta.controls,
    terms: meta.terms,
    // Which frames belong to which instruction, as the strip groups them.
    instructions: meta.instructions || [],
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
