// The designer's account of the chip, asked of the chip.
//
// Same two registers as talk.js, and the same reason for keeping them apart:
// the account of what somebody intended is history and cannot be derived, while
// every verdict beside it is computed from the published files. What is
// different here is whose account it is. talk.html checks a reverse engineer
// who read this die in 2010; this page checks one of the people who drew it in
// 1975, speaking from memory forty years later.
//
// That difference is the point of the page rather than a caveat on it. A
// reverse engineer's claims are about the artefact and should match it. A
// designer's claims are about intent, and the interesting rows are the ones
// where the intent is exactly right and the number attached to it is not.
//
// THE STANDING LIMIT, and every row that touches the 6501 has to respect it:
// there is no 6501 on this die. Nothing here can measure a difference between
// two chips. What it can measure is how big the circuit in question is on the
// one chip we have, and rows are worded as that.

import { renderClaims } from './claim-table.js';
import { clockGen as clockGenOf } from './clock-gen.js';

const $ = (id) => document.getElementById(id);

/** Files this page reads. All published, all read by other pages. */
const FILES = ['schematic.json', 'decode.json', 'timing.json', 'blocks.json'];

const hex = (n) => '$' + n.toString(16).toUpperCase().padStart(2, '0');

/* -- the clock generator ---------------------------------------------------
 *
 * Derived by a rule, never by a list of node numbers, in clock-gen.js, which
 * the tracer shares: start at the `clk0` pad and walk forward through gate
 * inputs, including the four clocks it ends at but never expanding them. That
 * last clause is what bounds the walk: `cclk` alone gates 273 transistors, so
 * expanding it reaches the decode pipeline and from there most of the chip.
 *
 * Two things make this trustworthy rather than merely plausible. The walk finds
 * a circuit that is closed and symmetric, which a wrong boundary would not. And
 * counting its transistors out of schematic.json agrees exactly with counting
 * real transistor IDs out of the die data, which `_designer-test.html` does
 * independently.
 */
function clockGen(d) {
  return clockGenOf(d.sch);
}

/* -- the decimal correction ------------------------------------------------
 *
 * The one circuit the designer claims personally. Found by name: this die names
 * both decode outputs and the carries between the digit halves.
 */
const DECIMAL = ['dpc18_#DAA', 'dpc22_#DSA', 'DC34', 'DC78', 'DC78.phi2'];

function decimal(d) {
  const { idx, gates } = d.net;
  const nodes = DECIMAL.map((n) => idx.get(n)).filter((n) => n !== undefined);
  const cost = (n) => {
    const g = gates.get(n);
    if (!g) return 0;
    return g[3].reduce((a, leg) => a + leg.length, 0) + (g[2] >= 0 ? 1 : 0);
  };
  return { names: DECIMAL, nodes, transistors: nodes.reduce((a, n) => a + cost(n), 0) };
}

/* -- what the decoder does and does not know ------------------------------ */

const termsFor = (d) => {
  if (d._fired) return d._fired;
  d._fired = new Map(d.dec.opcodes.map((o) =>
    [o.op, new Set(o.hc.flatMap((h) => h.r))]));
  return d._fired;
};

/** Opcodes that fire a named term, ignoring terms that fire for all 256. */
const opsFiring = (d, name) => {
  const i = d.dec.rows.findIndex((r) => r.name === name);
  if (i < 0) return [];
  return [...termsFor(d).entries()].filter(([, s]) => s.has(i)).map(([op]) => op).sort((a, b) => a - b);
};

/** Anything on the die that names an opcode invalid. There is nothing. */
const validityNames = (d) => {
  const re = /illeg|invalid|undef|unused|trap/i;
  return [...d.dec.rows.map((r) => r.name), ...d.dec.outputs.map((o) => o.name)]
    .filter((n) => n && re.test(n));
};

/**
 * The facts stated in prose, each filled into a `data-fact` slot.
 *
 * A missing one fails the page rather than blanking a word, for the reason the
 * primer gives: a number that silently does not appear reads as a design choice
 * rather than as a fault.
 */
const FACTS = {
  clockTransistors: (d) => clockGen(d).transistors,
  clockLogic: (d) => clockGen(d).logic,
  clockDrivers: (d) => clockGen(d).drivers,
  clockNodes: (d) => clockGen(d).nodes.size,
  clockShare: (d) => (clockGen(d).transistors / d.sch.counts.transistors * 100).toFixed(1),
  interlock: (d) => clockGen(d).feedback.length,
  // How much the internal clock has to drive, counted as the switches it opens.
  // Deliberately NOT "transistors it gates": that number is 273, and it is not
  // cleanly recoverable from this file, because a transistor can appear both as
  // a switch and inside a gate's pulldown network and the two lists overlap.
  // The switch count is exact here, and makes the same point about load.
  cclkSwitches: (d) => d.sch.switches.filter((s) => s[0] === d.net.idx.get('cclk')).length,
};

/**
 * "About a dozen", read generously, so the verdict is a comparison rather than
 * a decision. Twelve is the claim; fifteen is the most that phrase can carry.
 * If this chip ever measured that small the row would flip on its own.
 */
const A_DOZEN = 15;

const CHECKS = [
  {
    says: 'Putting the clock generator on the chip cost "about a dozen transistors", '
      + 'and that is the whole difference between the 6501 and the 6502',
    got: (d) => {
      const c = clockGen(d);
      return `${c.transistors} transistors across ${c.nodes.size} nodes, of which `
        + `${c.logic} generate the phases and ${c.drivers} are the four output drivers`;
    },
    holds: (d) => clockGen(d).transistors <= A_DOZEN,
    note: (d) => {
      const c = clockGen(d);
      return 'There is no 6501 on this die, so the difference between two chips cannot be '
        + 'measured here: what is measured is the generator itself, walked forward from the '
        + `clk0 pad to the four clocks it produces. Read generously at ${A_DOZEN}, the count `
        + `is high by roughly a factor of two even counting only the ${c.logic} transistors of `
        + `logic. The engineering claim beside it survives intact, which is the more `
        + `interesting half: he argued it would not make the chip bigger, and the whole `
        + `circuit is ${(c.transistors / d.sch.counts.transistors * 100).toFixed(1)}% of the die.`;
    },
    where: { href: 'schematic', label: 'Schematic' },
  },
  {
    says: 'The reason for moving it on chip was that an external clock could drift '
      + 'against the part and overlap the two phases',
    got: (d) => {
      const f = clockGen(d).feedback;
      const nm = (i) => d.sch.names[i] || `#${i}`;
      return `${f.length} transistors carry a generated clock back into the generator: `
        + f.map(([c, n]) => `${nm(c)} pulls down ${nm(n)}`).join(', ');
    },
    // Two, gated by the same clock, landing on two different nodes: one in each
    // of the generator's symmetric halves. That is an interlock rather than a
    // coincidence, and asserting the shape is what distinguishes the two.
    holds: (d) => {
      const f = clockGen(d).feedback;
      return f.length === 2
        && new Set(f.map(([c]) => c)).size === 1
        && new Set(f.map(([, n]) => n)).size === 2;
    },
    note: () => 'Non-overlap is not a property the circuit is asked to have, it is a '
      + 'property this feedback gives it: each phase holds the other one off until it has '
      + 'gone away. Both transistors are gated by the same internal clock and each lands in '
      + 'one of the two symmetric halves, which is what makes it an interlock rather than '
      + 'two unrelated wires.',
    where: { href: 'schematic', label: 'Schematic' },
  },
  {
    says: 'There are no illegal opcodes, only unused ones: nobody designed what they do, '
      + 'and nobody looked',
    got: (d) => {
      const none = [...termsFor(d).values()].filter((s) => s.size === 0).length;
      return `all ${termsFor(d).size} opcodes fire product terms (${none} fire none), and `
        + `no product term and no control line on the die names validity`;
    },
    holds: (d) => [...termsFor(d).values()].every((s) => s.size > 0)
      && validityNames(d).length === 0,
    note: (d) => {
      const jam = d.tim.opcodes.filter((o) => o.jam).length;
      return 'The decoder has no notion of a valid instruction to check against. Every '
        + 'opcode is fed to the same array and whatever it happens to select is what the '
        + `chip does, which is why ${jam} of them never finish: nothing rejects those, the `
        + 'timing chain simply never reaches a term that would stop it.';
    },
    where: { href: 'decode', label: 'Decode' },
  },
  {
    says: 'The decimal correction was a distinct piece of design, and the part that was '
      + 'patented',
    got: (d) => {
      const dc = decimal(d);
      return `${dc.nodes.length} nodes name it (${dc.names.join(', ')}), `
        + `${dc.transistors} transistors`;
    },
    holds: (d) => decimal(d).nodes.length === DECIMAL.length,
    note: () => 'It reads as a separable circuit rather than as behaviour spread through '
      + 'the adder: the die names the two decode outputs that ask for the correction and the '
      + 'carries between the two digit halves that perform it. Both of those outputs are '
      + 'among the six control lines that idle high and assert low.',
    where: { href: 'block?b=alu', label: 'Blocks' },
  },
  {
    says: 'One 8-bit quantity is a whole instruction: increment X, increment Y, no other '
      + 'information needed',
    got: (d) => {
      const ops = opsFiring(d, 'op-implied');
      return `${ops.length} opcodes fire op-implied, the term for an instruction with no `
        + `operand: ${ops.slice(0, 8).map(hex).join(' ')} and ${ops.length - 8} more`;
    },
    holds: (d) => {
      const ops = new Set(opsFiring(d, 'op-implied'));
      // The four he names by hand, plus immediate LDA as the control: it takes
      // an operand byte and must NOT be in the set.
      return [0xE8, 0xC8, 0xCA, 0x88].every((o) => ops.has(o)) && !ops.has(0xA9);
    },
    note: (d) => `Every instruction he names is in that set: INX ${hex(0xE8)}, INY `
      + `${hex(0xC8)}, DEX ${hex(0xCA)}, DEY ${hex(0x88)}. Immediate LDA ${hex(0xA9)} is `
      + 'not, which is the control: it needs a second byte and does not fire the term.',
    where: { href: 'timing', label: 'Timing' },
  },
];

/**
 * An index over the netlist the derivations need, built once.
 *
 * `feeds` is the forward direction: which gates a node is an input of. The
 * published file gives the backward direction only, because a gate lists its
 * own inputs, so walking forward means inverting it.
 */
function index(sch) {
  const idx = new Map();
  sch.names.forEach((n, i) => { if (n) idx.set(n, i); });
  const gates = new Map(sch.gates.map((g) => [g[0], g]));
  const feeds = new Map();
  const add = (k, v) => {
    if (!feeds.has(k)) feeds.set(k, new Set());
    feeds.get(k).add(v);
  };
  for (const [node, , pre, legs] of sch.gates) {
    for (const leg of legs) for (const i of leg) add(i, node);
    if (pre >= 0) add(pre, node);
  }
  return { idx, gates, feeds, vss: sch.vss, vcc: sch.vcc };
}

function stats(d) {
  const c = clockGen(d);
  $('dz-stats').textContent =
    `${d.sch.counts.transistors} transistors · ${c.transistors} of them generate the clock · `
    + `${decimal(d).transistors} correct for decimal · ${d.dec.rows.length} decode product terms`;
}

async function boot() {
  const status = $('dz-status');
  try {
    const [sch, dec, tim, blk] = await Promise.all(FILES.map((f) =>
      fetch(f).then((r) => {
        if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
        return r.json();
      })));
    const d = { sch, dec, tim, blk, net: index(sch) };

    const missing = [];
    for (const el of document.querySelectorAll('[data-fact]')) {
      const key = el.dataset.fact;
      const fn = FACTS[key];
      if (!fn) { missing.push(key); continue; }
      try {
        const v = fn(d);
        if (v === undefined || v === null || v === '') { missing.push(key); continue; }
        el.textContent = String(v);
      } catch (e) {
        missing.push(`${key} (${e.message})`);
      }
    }

    stats(d);
    renderClaims($('dz-checks'), $('dz-tally'), CHECKS, d);

    if (missing.length) throw new Error('facts not derived: ' + missing.join(', '));
    $('dz-boot').hidden = true;
    $('dz-main').hidden = false;
  } catch (e) {
    status.textContent = 'Could not load: ' + (e && e.message ? e.message : e);
    status.classList.add('error');
    throw e;
  }
}

boot();
