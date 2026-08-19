// The forty pins, and which way each one points.
//
// Shared by the pinout page and the tracer since the tracer wanted the pads as
// containers grouped by direction. Two copies of the package table would drift
// (a second copy of anything here has), and two copies of the direction rule
// would be worse: the rule has one subtlety that takes a paragraph to state,
// and a copy that dropped it would call RDY and S.O. outputs.

/**
 * The package. `node` is what this die calls the pin, or null where there is
 * nothing to call: three pins are not connected and the manual says so.
 *
 * `role` is ours -- one line each, written here rather than lifted -- and it is
 * the only authored column. It carries no numbers for the same reason
 * `block-notes.js` carries none: a count typed into prose is a count nothing
 * checks again.
 */
export const PACKAGE = [
  { n: 1, label: 'VSS', node: 'vss', power: true, role: 'Ground. It arrives twice, on this pin and on 21.' },
  { n: 2, label: 'RDY', node: 'rdy', role: 'Held low, the chip stalls on a read rather than stopping its clock.' },
  { n: 3, label: 'PHI1 OUT', node: 'clk1out', role: 'The first internal phase, driven back out for the rest of the system.' },
  { n: 4, label: 'IRQ', node: 'irq', role: 'Maskable interrupt, active low. Level sensitive, because devices wire their outputs together onto it and hold it low until they are served.' },
  { n: 5, label: 'N.C.', node: null, role: 'No connection.' },
  { n: 6, label: 'NMI', node: 'nmi', role: 'Non-maskable interrupt, active low. Taken on the edge rather than the level, so one device owns it and one fall is one interrupt.' },
  { n: 7, label: 'SYNC', node: 'sync', role: 'High while the byte being fetched is an opcode. The chip saying what it is doing.' },
  { n: 8, label: 'VCC', node: 'vcc', power: true, role: 'Supply.' },
  { n: 9, label: 'A0', node: 'ab0', role: 'Address, low bit.' },
  { n: 10, label: 'A1', node: 'ab1', role: 'Address.' },
  { n: 11, label: 'A2', node: 'ab2', role: 'Address.' },
  { n: 12, label: 'A3', node: 'ab3', role: 'Address.' },
  { n: 13, label: 'A4', node: 'ab4', role: 'Address.' },
  { n: 14, label: 'A5', node: 'ab5', role: 'Address.' },
  { n: 15, label: 'A6', node: 'ab6', role: 'Address.' },
  { n: 16, label: 'A7', node: 'ab7', role: 'Address. The top of the zero page, and of the stack.' },
  { n: 17, label: 'A8', node: 'ab8', role: 'Address.' },
  { n: 18, label: 'A9', node: 'ab9', role: 'Address.' },
  { n: 19, label: 'A10', node: 'ab10', role: 'Address.' },
  { n: 20, label: 'A11', node: 'ab11', role: 'Address.' },
  { n: 21, label: 'VSS', node: 'vss', power: true, role: 'Ground again. The die names one node; the package brings it out twice.' },
  { n: 22, label: 'A12', node: 'ab12', role: 'Address.' },
  { n: 23, label: 'A13', node: 'ab13', role: 'Address.' },
  { n: 24, label: 'A14', node: 'ab14', role: 'Address.' },
  { n: 25, label: 'A15', node: 'ab15', role: 'Address, high bit. This is the whole of the space the chip can reach.' },
  { n: 26, label: 'D7', node: 'db7', role: 'Data, high bit. Also the bit a branch tests after a load.' },
  { n: 27, label: 'D6', node: 'db6', role: 'Data.' },
  { n: 28, label: 'D5', node: 'db5', role: 'Data.' },
  { n: 29, label: 'D4', node: 'db4', role: 'Data.' },
  { n: 30, label: 'D3', node: 'db3', role: 'Data.' },
  { n: 31, label: 'D2', node: 'db2', role: 'Data.' },
  { n: 32, label: 'D1', node: 'db1', role: 'Data.' },
  { n: 33, label: 'D0', node: 'db0', role: 'Data, low bit.' },
  { n: 34, label: 'R/W', node: 'rw', role: 'High to read, low to write. The chip telling memory which way the byte goes.' },
  { n: 35, label: 'N.C.', node: null, role: 'No connection.' },
  { n: 36, label: 'N.C.', node: null, role: 'No connection.' },
  { n: 37, label: 'PHI0 IN', node: 'clk0', role: 'The one clock the chip is given. Everything else it makes itself.' },
  { n: 38, label: 'S.O.', node: 'so', role: 'Set overflow: drives the V flag from outside. Arithmetic sets that flag as a side effect and CLV clears it, but the die carries no term for setting it outright, so this pin is the only deliberate way in.' },
  { n: 39, label: 'PHI2 OUT', node: 'clk2out', role: 'The second phase, driven back out. Memory is read and written against it.' },
  { n: 40, label: 'RES', node: 'res', role: 'Reset, active low. It runs the BRK sequence with the writes suppressed.' },
];

/**
 * Which way a pin points, measured rather than copied off an arrow.
 *
 * A pin is an OUTPUT if a gate drives it, an INPUT if it feeds gates, and both
 * if both. The subtlety, and it is the reason this is derived at all: a gate
 * whose every pulldown leg is gated by **vss** can never pull anything down.
 * It is a pullup wearing a gate's clothes.
 *
 * Two pins have exactly that -- RDY and S.O., both inputs, both with a
 * permanently-off pulldown holding them high when nothing outside is driving
 * them. Counting those as drivers reports two input pins as outputs, which is
 * what the first version of this did. Seventeen transistors on this die are
 * gated by vss and they are all this kind of thing.
 */
export function direction(d, node) {
  const i = d.byName.get(node);
  if (i === undefined) return null;
  const g = d.driver.get(i);
  const driven = !!g;
  const read = (d.feeds.get(i) || 0) > 0;
  if (driven && read) return 'bidirectional';
  if (driven) return 'output';
  if (read) return 'input';
  return 'neither';
}


/**
 * The facts the direction rule needs, read once out of schematic.json: which
 * nodes a gate that can actually pull down drives, how many gate inputs each
 * node feeds, and how many switch channels touch it.
 */
export function pinFacts(sch) {
  const byName = new Map(sch.names.map((n, i) => [n, i]).filter(([n]) => n));
  // A driver is a gate that can actually pull down. See `direction`.
  const driver = new Map();
  const feeds = new Map();
  for (const [node, , pre, legs] of sch.gates) {
    if (legs.some((leg) => !leg.every((x) => x === sch.vss))) driver.set(node, true);
    for (const leg of legs) for (const i of leg) feeds.set(i, (feeds.get(i) || 0) + 1);
    if (pre >= 0) feeds.set(pre, (feeds.get(pre) || 0) + 1);
  }
  const chan = new Map();
  for (const [, a, b] of sch.switches) {
    chan.set(a, (chan.get(a) || 0) + 1);
    chan.set(b, (chan.get(b) || 0) + 1);
  }
  return { sch, byName, driver, feeds, chan };
}
