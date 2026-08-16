// One hue per functional block, in `blocks.json` id order.
//
// This lived inside `exploded-gl.js`, which is fine while one page uses it and
// wrong the moment two do: the schematic wants the same colours and cannot
// import a WebGL renderer to get them. A second copy would drift, and two pages
// disagreeing about what colour the ALU is would be exactly the quiet
// difference this site exists to remove.
//
// Presentation, not derivation -- but the *order* is not arbitrary: control
// blocks are warm, datapath blocks are cool, so the two halves of the chip stay
// distinguishable at a glance even before the labels are read.

export const BLOCK_COLOR = [
  [0.42, 0.45, 0.52], // 0  unclassified -- grey, and it stays grey
  [0.60, 0.70, 0.85], // 1  pads & I/O
  [1.00, 0.62, 0.25], // 2  instruction register
  [1.00, 0.36, 0.62], // 3  decode PLA
  [0.82, 0.42, 1.00], // 4  control pipeline
  [1.00, 0.85, 0.35], // 5  timing chain
  [1.00, 0.40, 0.35], // 6  interrupts & vectors
  [0.35, 0.95, 0.70], // 7  program counter
  [0.30, 0.85, 1.00], // 8  ALU
  [0.45, 0.70, 1.00], // 9  registers
  [0.75, 0.95, 0.45], // 10 status register
  [0.35, 0.62, 0.92], // 11 address latches
  [0.40, 0.92, 0.85], // 12 data bus
  [0.58, 0.55, 0.70], // 13 static logic -- deliberately muted: it is the
                      //    background the functional blocks sit in, and a
                      //    loud colour here would fight all twelve of them
];

/** The same colour as CSS, for the pages that draw with SVG rather than GL. */
export function blockCss(block, alpha = 1) {
  const c = BLOCK_COLOR[block] || BLOCK_COLOR[0];
  const [r, g, b] = c.map((v) => Math.round(v * 255));
  return alpha >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`;
}
