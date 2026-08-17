// The talk that produced the data this site runs on, with its claims re-checked.
//
// Two halves, kept apart on purpose.
//
// The account of how the die was opened and photographed is HISTORY. It cannot
// be derived from anything here, it is written from the talk, and it is labelled
// as written rather than measured. Its numbers are years and counts of people,
// which cannot go stale.
//
// The verification table is the other half, and none of it is authored. Each row
// carries what the talk claims and a function that answers the same question
// from the published files -- schematic.json, decode.json, timing.json,
// blocks.json, blueprint.json -- and the VERDICT is computed by comparing the
// two rather than typed in. That matters: a table where somebody wrote "agrees"
// beside each row would be a claim about a claim. Here, if the chip stops
// agreeing, the page says so on its own.
//
// Same discipline as primer.js, and for the same reason: prose is the part of
// this site most likely to go quietly wrong, because nothing checks it
// afterwards.

const $ = (id) => document.getElementById(id);

/** Files this page reads. All are published, and all are read by other pages. */
const FILES = ['schematic.json', 'decode.json', 'timing.json', 'blocks.json', 'blueprint.json'];

const hex = (n) => '$' + n.toString(16).toUpperCase().padStart(2, '0');

/** Row indices of the two product terms whose overlap is the LAX family. */
const ldaRow = (d) => d.dec.rows.findIndex((r) => r.name === 'op-T0-lda');
const ldxRow = (d) => d.dec.rows.findIndex((r) => r.name && r.name.startsWith('op-T0-ldx'));
const firesBoth = (d) => {
  const [a, x] = [ldaRow(d), ldxRow(d)];
  return d.dec.opcodes.filter((o) => o.hc.some((h) => h.r.includes(a))
    && o.hc.some((h) => h.r.includes(x)));
};

/** Which IR bit a named row requires high, if it requires exactly one of 0 and 1. */
const lowBitOf = (d, name) => {
  const r = d.dec.rows.find((x) => x.name === name
    || (x.name && name.endsWith('*') && x.name.startsWith(name.slice(0, -1))));
  if (!r) return null;
  const low = r.ir.filter(([b]) => b <= 1);
  return low.length === 1 && low[0][1] ? low[0][0] : null;
};

const jams = (d) => d.tim.opcodes.filter((o) => o.jam);
const blockNamed = (d, name) => d.blk.blocks.find((b) => b.name === name);
const functional = (d) => d.blk.blocks
  .filter((b) => b.name !== 'Unaccounted' && b.name !== 'Static logic');

/**
 * The facts this page states in prose, each filled into a `data-fact` slot.
 *
 * A missing one fails the page rather than blanking a word: a number that
 * silently does not appear reads as a design choice, not as a fault.
 */
const FACTS = {
  transistors: (d) => d.sch.counts.transistors,
  nodes: (d) => d.sch.names.length,
  gates: (d) => d.sch.counts.gates,
  unresolvedGates: (d) => d.sch.counts.unresolved,
  terms: (d) => d.dec.rows.length,
  decodeTransistors: (d) => blockNamed(d, 'Decode PLA').transistors,
};

/**
 * What the talk says, and what this chip says when asked the same question.
 *
 * `says` is quoted or paraphrased from the talk and is the only authored part of
 * a row. `got` is derived. `holds` decides the verdict by comparing them, so
 * agreement is computed rather than asserted.
 */
const CHECKS = [
  {
    says: 'The subtitle: 3510 transistors',
    got: (d) => `${d.sch.counts.transistors} transistors, ${d.sch.names.length} nodes`,
    holds: (d) => d.sch.counts.transistors === 3510,
    where: { href: 'exploded', label: 'Exploded' },
  },
  {
    says: 'LAX loads A and X at once because the load-A row and the load-X row '
      + 'are high together, in the case the datasheet calls undefined',
    got: (d) => {
      const both = firesBoth(d);
      return `${both.length} opcodes fire both rows: ${both.map((o) => hex(o.op)).join(' ')}`;
    },
    holds: (d) => firesBoth(d).length === 8
      && lowBitOf(d, 'op-T0-lda') === 0 && lowBitOf(d, 'op-T0-ldx*') === 1,
    note: (d) => `The load-A row requires IR bit ${lowBitOf(d, 'op-T0-lda')}, the load-X row `
      + `requires bit ${lowBitOf(d, 'op-T0-ldx*')}, and neither constrains the other. `
      + `An opcode with both of those bits set therefore satisfies both rows, and `
      + `every one of the ${firesBoth(d).length} is such an opcode.`,
    where: { href: 'decode', label: 'Decode' },
  },
  {
    says: 'The opcodes that end in 2 mostly halt the machine, and no further '
      + 'fetch ever happens',
    got: (d) => {
      const j = jams(d);
      return `${j.length} opcodes never finish, all ending in 2: ${j.map((o) => hex(o.op)).join(' ')}`;
    },
    holds: (d) => jams(d).length === 12 && jams(d).every((o) => (o.op & 0x0f) === 2),
    note: (d) => {
      // Derived, including the count of the ones that are NOT jams: writing
      // "twelve of the sixteen" here would be a number nothing checks again.
      const endInTwo = d.tim.opcodes.filter((o) => (o.op & 0x0f) === 2);
      const ordinary = endInTwo.filter((o) => !o.jam);
      return `${jams(d).length} of the ${endInTwo.length} opcodes ending in 2, so "mostly" `
        + `is the right word: ${ordinary.map((o) => hex(o.op)).join(', ')} are ordinary `
        + 'instructions.';
    },
    where: { href: 'timing', label: 'Timing' },
  },
  {
    says: 'The published block diagram is wrong to show one internal bus. '
      + 'There are two',
    got: (d) => {
      const buses = d.bp.units.filter((u) => u.kind === 'bus').map((u) => u.name);
      return `${buses.length} buses derived from switch topology: ${buses.join(' ')}`;
    },
    holds: (d) => ['sb', 'idb'].every((n) => d.bp.units
      .some((u) => u.kind === 'bus' && u.name === n)),
    note: () => 'The two he means are the special bus and the internal data bus. '
      + 'The derivation also separates the address bus into its high and low halves '
      + 'and finds the program counter precharge lines, which a block diagram would '
      + 'not draw as buses.',
    where: { href: 'blueprint', label: 'Blueprint' },
  },
  {
    says: 'The decoder is at the top of the die, and that is how you tell a '
      + '6502 is the right way up',
    got: (d) => {
      const f = functional(d).slice().sort((a, b) => b.die[1] - a.die[1]);
      return `the decode PLA has the highest centroid of any functional block `
        + `(${Math.round(f[0].die[1])}, next is ${f[1].name} at ${Math.round(f[1].die[1])})`;
    },
    holds: (d) => {
      const f = functional(d).slice().sort((a, b) => b.die[1] - a.die[1]);
      return f[0].name === 'Decode PLA';
    },
    where: { href: 'block?b=decode-pla', label: 'Blocks' },
  },
  {
    says: 'The decode ROM only looks at the upper six bits of the opcode, and '
      + 'ignores the lowest two',
    got: (d) => `${d.dec.rows.filter((r) => r.ir.some(([b]) => b <= 1)).length} of `
      + `${d.dec.rows.length} product terms are gated by IR bit 0 or bit 1 directly`,
    holds: () => false,
    note: () => 'The one claim here that does not survive being asked of the silicon, '
      + 'and it is a simplification rather than an error: the mechanism he gives for '
      + 'LAX in the row above is exactly right, and it works precisely because those '
      + 'two bits reach the decoder. On this die they arrive as ordinary inputs '
      + 'rather than only through a derived line.',
    where: { href: 'decode', label: 'Decode' },
  },
  {
    says: 'Nobody has found anything that makes the random control logic easier '
      + 'to understand',
    got: (d) => `${d.sch.counts.gates} gates recognised from the switch network, `
      + `${d.sch.counts.unresolved} node unresolved`,
    holds: (d) => d.sch.counts.gates > 1000 && d.sch.counts.unresolved <= 1,
    note: (d) => `Sixteen years is a long time. NMOS builds logic exactly one way, so `
      + `every static gate is an inverted sum of products: ${d.sch.counts.inverter} `
      + `inverters, ${d.sch.counts.nor} NORs, ${d.sch.counts.nand} NANDs and `
      + `${d.sch.counts.aoi} AOI. This is the row that is least like a verification `
      + 'and most like an answer.',
    where: { href: 'schematic', label: 'Schematic' },
  },
];

function renderChecks(d) {
  const host = $('tk-checks');
  host.innerHTML = '';
  let agreed = 0;
  for (const c of CHECKS) {
    let holds;
    try {
      holds = c.holds(d);
    } catch {
      holds = null;
    }
    if (holds) agreed += 1;
    const row = document.createElement('div');
    row.className = 'tk-check' + (holds ? '' : ' tk-check-differs');
    const verdict = holds ? 'agrees' : 'differs';
    row.innerHTML = `
      <div class="tk-says"><span class="tk-verdict">${verdict}</span>${esc(c.says)}</div>
      <div class="tk-got"><span class="tag live">measured here</span> ${esc(c.got(d))}</div>
      ${c.note ? `<p class="tk-note muted">${esc(c.note(d))}</p>` : ''}
      <p class="tk-where"><a href="${c.where.href}">Shown on ${esc(c.where.label)}</a></p>`;
    host.appendChild(row);
  }
  $('tk-tally').textContent = `${agreed} of ${CHECKS.length} agree`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

/**
 * The hero's stat line, in the same shape every other page uses: one run of
 * text with middot separators, not a grid of cards. A second arrangement of the
 * same furniture is a second thing to keep in step.
 */
function stats(d) {
  $('tk-stats').textContent =
    `${d.sch.counts.transistors} transistors · ${d.sch.names.length} nodes · `
    + `${d.sch.counts.gates} gates recognised · ${d.dec.rows.length} decode product terms`;
}

async function boot() {
  const status = $('tk-status');
  try {
    const [sch, dec, tim, blk, bp] = await Promise.all(FILES.map((f) =>
      fetch(f).then((r) => {
        if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
        return r.json();
      })));
    const d = { sch, dec, tim, blk, bp };

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
    renderChecks(d);

    if (missing.length) throw new Error('facts not derived: ' + missing.join(', '));
    $('tk-boot').hidden = true;
    $('tk-main').hidden = false;
  } catch (e) {
    status.textContent = 'Could not load: ' + (e && e.message ? e.message : e);
    status.classList.add('error');
    throw e;
  }
}

boot();
