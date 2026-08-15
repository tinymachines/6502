// The primer's numbers, none of which are typed into the page.
//
// This is an explanatory page, which is exactly the kind that goes stale: prose
// is written once against whatever was true that afternoon, and a count in a
// sentence has nothing checking it afterwards. So every figure here is a
// `data-fact` slot filled from the same published files the other pages are
// drawn from -- decode.json, timing.json, schematic.json -- and the page reports
// a failure rather than showing a stale number or an empty gap.
//
// The rule to keep: if a number appears in primer.html, it is in the wrong file.

const $ = (id) => document.getElementById(id);

/**
 * Every fact the page can state, as a function of the published data.
 *
 * Anything derived twice would be two chances to disagree with itself, so the
 * pin table below is built from the same `names` array that answers "how many
 * bits is the address bus".
 */
const FACTS = {
  // --- the interface ------------------------------------------------------
  nodes: (d) => d.sch.names.length,
  transistors: (d) => d.sch.counts.transistors,
  addressBits: (d) => bitsOf(d.sch, 'ab'),
  dataBits: (d) => bitsOf(d.sch, 'db'),
  addressRange: (d) => `$0000–$${(2 ** bitsOf(d.sch, 'ab') - 1).toString(16).toUpperCase()}`,
  pinsIn: (d) => PINS.in.filter((p) => named(d.sch, p.name)).length,
  pinsOut: (d) => PINS.out.filter((p) => named(d.sch, p.name)).length + bitsOf(d.sch, 'ab'),

  // --- the decode ---------------------------------------------------------
  terms: (d) => d.dec.rows.length,
  termsNamed: (d) => d.dec.rows.filter((r) => r.name).length,
  lines: (d) => d.dec.outputs.length,
  linesFitted: (d) => d.dec.links.length,
  linesUnresolved: (d) => d.dec.unresolvedLines.length,

  // --- the timing ---------------------------------------------------------
  opcodes: (d) => d.tim.opcodes.length,
  jams: (d) => d.tim.opcodes.filter((o) => o.jam).length,
  jamList: (d) => d.tim.opcodes.filter((o) => o.jam)
    .map((o) => '$' + o.op.toString(16).padStart(2, '0').toUpperCase()).join(' '),
  terminating: (d) => d.tim.opcodes.filter((o) => !o.jam).length,
  cycleLow: (d) => Math.min(...cycles(d.tim)),
  cycleHigh: (d) => Math.max(...cycles(d.tim)),
  endOnT0: (d) => d.tim.opcodes.filter((o) => !o.jam
    && o.arrived.some((i) => (d.tim.terms[i] || '').startsWith('op-T0-'))).length,
  endOnNothing: (d) => d.tim.opcodes.filter((o) => !o.jam && !o.arrived.length).length,
};

const named = (sch, name) => sch.names.indexOf(name) >= 0;
const bitsOf = (sch, stem) =>
  sch.names.filter((n) => n && new RegExp(`^${stem}\\d+$`).test(n)).length;
const cycles = (tim) => tim.opcodes.filter((o) => !o.jam).map((o) => o.cycles);

/**
 * The pins, as the die names them.
 *
 * The *role* of each is authored -- the die says `rdy`, not "low stalls the chip
 * on a read" -- but which pins exist is not: every row is resolved through the
 * name table and a row that does not resolve is dropped and counted, rather than
 * printed as a pin this chip does not have.
 */
const PINS = {
  in: [
    ['clk0', 'φ0, the clock. The chip has no oscillator of its own'],
    ['res', 'reset, active low'],
    ['irq', 'interrupt request, active low — masked by the I flag'],
    ['nmi', 'non-maskable interrupt, active low'],
    ['rdy', 'ready — low stalls the chip on a read cycle'],
    ['so', 'set overflow — sets the V flag directly'],
  ].map(([name, role]) => ({ name, role })),
  out: [
    ['rw', 'read or write: which way the data pins are pointing'],
    ['sync', 'high during an opcode fetch, and only then'],
    ['clk1out', 'phase 1, derived from φ0 and handed back'],
    ['clk2out', 'phase 2, the other half of the same cycle'],
  ].map(([name, role]) => ({ name, role })),
};

function pinRows(sch) {
  const row = (name, dir, role) => `<tr>
      <td class="mono pr-pin">${name}</td>
      <td class="pr-dir pr-${dir}">${dir}</td>
      <td>${role}</td>
    </tr>`;
  const ab = bitsOf(sch, 'ab');
  const db = bitsOf(sch, 'db');
  return [
    row(`ab0…ab${ab - 1}`, 'out', `the address bus — ${ab} lines, so ${
      FACTS.addressRange({ sch })} of address space`),
    row(`db0…db${db - 1}`, 'both', `the data bus — ${db} lines, pointing whichever way `
      + `<span class="mono">rw</span> says`),
    ...PINS.out.filter((p) => named(sch, p.name)).map((p) => row(p.name, 'out', p.role)),
    ...PINS.in.filter((p) => named(sch, p.name)).map((p) => row(p.name, 'in', p.role)),
    row('vcc, vss', 'power', 'and nothing else. That is the whole interface'),
  ].join('');
}

async function boot() {
  const status = $('pr-status');
  try {
    const [sch, dec, tim] = await Promise.all(
      ['schematic.json', 'decode.json', 'timing.json'].map((f) =>
        fetch(f).then((r) => {
          if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
          return r.json();
        })));
    const data = { sch, dec, tim };

    // Every slot, or the page says so. A missing fact is a silent blank in a
    // sentence, which reads as a design choice rather than as a fault.
    const missing = [];
    for (const el of document.querySelectorAll('[data-fact]')) {
      const key = el.dataset.fact;
      const fn = FACTS[key];
      if (!fn) { missing.push(key); continue; }
      try {
        const v = fn(data);
        if (v === undefined || v === null || v === '') { missing.push(key); continue; }
        el.textContent = String(v);
      } catch (e) {
        missing.push(`${key} (${e.message})`);
      }
    }

    $('pr-pins').innerHTML = pinRows(sch);

    if (missing.length) throw new Error('facts not derived: ' + missing.join(', '));
    $('pr-boot').hidden = true;
    $('pr-main').hidden = false;
  } catch (e) {
    status.textContent = 'Could not load: ' + (e && e.message ? e.message : e);
    status.classList.add('error');
    throw e;
  }
}

boot();
