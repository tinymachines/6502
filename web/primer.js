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

import init, { Machine } from './pkg/v6502_wasm.js';
import { PROGRAMS, LOAD_ADDR } from './programs.js';
import {
  hex2, hex4, lamps, el, createChip, transport, createScope, readout, runWhileVisible,
} from './demos.js';

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


// ---------------------------------------------------------------------------
// The runnable examples
// ---------------------------------------------------------------------------
//
// One chip, five views of it. They share a machine and a clock, so stepping in
// any of them steps all of them -- which is the honest arrangement, since they
// are five readings of the same silicon and not five simulations.
//
// Every number in them is read back out of the running chip. That is the same
// rule the prose above follows, arrived at from the other end: the prose fills
// its slots from published measurements, and these fill theirs from a chip that
// is running while you read.

/** The pins, and the five you can pull. */
function demoPins(host, chip, data) {
  const m = chip.machine;
  transport(host, chip);
  const paint = readout(host, [
    ['ab', 'Address'], ['db', 'Data'], ['cycle', 'This half-cycle'], ['phase', 'Phase'],
  ]);
  const pinHost = el('div', { class: 'dm-pins' }, host);
  const PINS = [
    ['res', 'RES'], ['irq', 'IRQ'], ['nmi', 'NMI'], ['rdy', 'RDY'], ['so', 'SO'],
  ];
  const setter = { res: 'setRes', irq: 'setIrq', nmi: 'setNmi', rdy: 'setRdy', so: 'setSo' };
  const node = Object.fromEntries(PINS.map(([n]) => [n, m.nodeId(n)]));
  const high = (n) => node[n] < 0 || m.isNodeHigh(node[n]);
  const buttons = PINS.map(([name, label]) => {
    const b = el('button', { class: 'dm-pin', type: 'button', 'data-pin': name }, pinHost);
    b.addEventListener('click', () => { m[setter[name]](!high(name)); chip.announce(); });
    return [name, label, b];
  });
  el('p', { class: 'dm-note', html:
    'Pull <b>RDY</b> low and the chip stops on its next read without its clock '
    + 'stopping — the half-cycles keep counting. Pull <b>IRQ</b> low and it '
    + 'vectors through <span class="mono">$FFFE</span>, which this program never '
    + 'filled in, so it lands on <span class="mono">$00</span> and pushes the '
    + 'stack down forever. Both are the silicon doing exactly as it is told.' }, host);

  chip.on(() => {
    const ab = m.addressBus(), db = m.dataBus(), r = m.isRead();
    paint({
      ab: `<b class="mono">$${hex4(ab)}</b>${lamps(ab, 16)}`,
      db: `<b class="mono">$${hex2(db)}</b>${lamps(db, 8)}`,
      cycle: r
        ? `read <span class="mono">$${hex4(ab)}</span> → <span class="mono">$${hex2(db)}</span>`
        : `<span class="dm-write">write <span class="mono">$${hex2(db)}</span> → `
          + `<span class="mono">$${hex4(ab)}</span></span>`,
      phase: `<span class="mono">${m.clk0() ? 'φ1' : 'φ2'}</span>`
        + `${m.sync() ? ' · <b>SYNC</b> — this is an opcode fetch' : ''}`,
    });
    for (const [name, label, b] of buttons) {
      const on = high(name);
      b.classList.toggle('low', !on);
      const text = `${label} ${on ? 1 : 0}`;
      if (b.textContent !== text) b.textContent = text;
    }
  });
}

/** Two edges, recorded rather than drawn. */
function demoClock(host, chip) {
  const m = chip.machine;
  transport(host, chip);
  const scope = createScope({
    channels: [
      { key: 'clk0', label: 'φ0', cls: 'dm-ch-clk' },
      { key: 'sync', label: 'sync', cls: 'dm-ch-sync' },
      { key: 'write', label: 'write', cls: 'dm-ch-rw' },
    ],
    span: 20,
  });
  host.append(scope.el);
  const paint = readout(host, [['at', 'Half-cycle'], ['edge', 'What this edge did']]);
  el('p', { class: 'dm-note', html:
    'The trace is a recording, not a diagram: it is what these three pins '
    + 'actually did, sampled once per half-cycle as the chip ran. Each faint '
    + 'divider is one <em>cycle</em> — and there are two samples between them, '
    + 'which is the whole of the point.' }, host);

  let seen = -1;
  chip.on(() => {
    const at = m.halfCycle();
    if (at !== seen) {
      // Record forwards only. Stepping back rewinds the chip, and a recording
      // that grew a new sample for a half-cycle being *undone* would be a
      // history of the reader rather than of the chip.
      if (at > seen) {
        scope.record({ clk0: m.clk0(), sync: m.sync(), write: !m.isRead() });
      } else {
        scope.clear();
      }
      seen = at;
    }
    paint({
      at: `<b class="mono">${at}</b> — cycle <span class="mono">${Math.floor(at / 2)}</span>`,
      edge: m.clk0()
        ? 'clock high: the write half. A store lands here'
        : 'clock low: the read half. A fetch is serviced here',
    });
  });
}

/** The opcode, and the product terms it is matching right now. */
function demoDecode(host, chip, data) {
  const m = chip.machine;
  transport(host, chip);
  const paint = readout(host, [['ir', 'Instruction register'], ['terms', 'Matching now']]);
  el('p', { class: 'dm-note', html:
    'The terms are read out of the die: each one is a node, and it is listed '
    + 'here when that node is high. Nothing consults a table of what the '
    + 'instruction is supposed to do — the pattern of <span class="mono">ir</span> '
    + 'bits and the timing state are the only inputs the plane has.' }, host);

  const rows = data.dec.rows.filter((r) => r.name);
  chip.on(() => {
    const ir = m.ir();
    const firing = rows.filter((r) => m.isNodeHigh(r.node));
    paint({
      ir: `<b class="mono">$${hex2(ir)}</b>${lamps(ir, 8)}`,
      terms: firing.length
        ? `<span class="dm-terms">${firing
            .map((r) => `<i>${r.name}</i>`).join('')}</span>`
        : '<span class="muted">nothing — between instructions</span>',
    });
  });
}

/** Nothing counts the cycles: watch one get counted anyway. */
function demoTiming(host, chip) {
  const m = chip.machine;
  transport(host, chip);
  const paint = readout(host, [
    ['state', 'Timing chain'], ['since', 'Cycles since the last fetch'],
    ['took', 'So the last instruction took'],
  ]);
  el('p', { class: 'dm-note', html:
    'Nothing on the chip is holding that number. The chain shifts along until a '
    + 'product term resets it, <span class="mono">sync</span> goes high, and the '
    + 'next opcode is fetched — so the count is however many cycles went by, '
    + 'measured after the fact, here and on the Timing page alike.' }, host);

  let sinceSync = 0;
  let took = null;
  let seen = -1;
  let wasSync = false;
  chip.on(() => {
    const at = m.halfCycle();
    if (at > seen) {
      const sync = m.sync();
      if (sync && !wasSync) {
        if (sinceSync > 0) took = { n: Math.round(sinceSync / 2), op: m.lastFetchOpcode() };
        sinceSync = 0;
      }
      sinceSync += 1;
      wasSync = sync;
    } else if (at < seen) {
      sinceSync = 0;
      took = null;
    }
    seen = at;
    paint({
      state: `<b class="mono">${m.timingStates() || '—'}</b>`,
      since: `<span class="mono">${Math.floor(sinceSync / 2)}</span>`,
      took: took
        ? `<b class="mono">${took.n}</b> cycle${took.n === 1 ? '' : 's'}`
        : '<span class="muted">waiting for the next fetch</span>',
    });
  });
}

/** A level belongs to a group of wires, not to a wire. */
function demoGroups(host, chip) {
  const m = chip.machine;
  transport(host, chip);
  const paint = readout(host, [['idb', 'Joined to <span class="mono">idb0</span>'],
                               ['sb', 'Joined to <span class="mono">sb0</span>']]);
  el('p', { class: 'dm-note', html:
    'These are the wires that are <em>shorted together right now</em>, on bit 0, '
    + 'read straight out of the simulation. A level is not a property of a wire; '
    + 'it belongs to whatever group of wires a set of open switches has joined it '
    + 'to, and that group changes at every edge. No behavioural emulator has '
    + 'anywhere to put this, which is why none of them model it.' }, host);

  // One bit of the datapath. Mixing bits would make a join look wider than it is.
  const WATCH = ['idl0', 'idb0', 'sb0', 'dasb0', 'alua0', 'alub0', 'alu0',
                 'a0', 'x0', 'y0', 's0', 'pcl0', 'pch0', 'adl0', 'adh0',
                 'abl0', 'abh0', 'dor0'];
  const ids = new Map();
  for (const name of WATCH) {
    const id = m.nodeId(name);
    if (id >= 0) ids.set(id, name);
  }
  const groupOf = (name) => {
    const id = m.nodeId(name);
    if (id < 0) return '<span class="muted">not on this die</span>';
    const members = [...m.nodeGroup(id)]
      .map((n) => ids.get(n))
      .filter((x) => x && x !== name);
    const level = m.isNodeHigh(id) ? 1 : 0;
    return members.length
      ? `<span class="dm-join">${[name, ...members]
          .map((x) => `<i>${x}</i>`).join('<b>=</b>')}</span>`
        + `<span class="dm-level">${level}</span>`
      : `<span class="dm-join"><i>${name}</i></span>`
        + `<span class="muted">on its own</span><span class="dm-level">${level}</span>`;
  };
  chip.on(() => paint({ idb: groupOf('idb0'), sb: groupOf('sb0') }));
}

const DEMOS = {
  pins: demoPins, clock: demoClock, decode: demoDecode,
  timing: demoTiming, groups: demoGroups,
};

async function bootDemos(data) {
  const hosts = [...document.querySelectorAll('[data-demo]')];
  if (!hosts.length) return;
  try {
    await init();
    const chip = createChip({
      Machine, program: PROGRAMS[0].bytes, loadAddr: LOAD_ADDR, rate: 2,
    });
    for (const host of hosts) {
      const build = DEMOS[host.dataset.demo];
      if (!build) continue;
      host.replaceChildren();
      build(host, chip, data);
    }
    // Arrive somewhere worth looking at: past the reset sequence, with the
    // scope already carrying a recording. Twenty-four half-cycles is enough to
    // reach the first real fetch on this program.
    chip.warm(24);
    runWhileVisible(chip, document.getElementById('pr-main'));
    chip.setRunning(true);
  } catch (e) {
    // The page is worth reading without them. A dead example says so rather
    // than leaving five empty boxes that look like a layout bug.
    for (const host of hosts) {
      host.replaceChildren();
      el('p', { class: 'dm-note', html:
        `This example needs the simulator, which did not load: ${
          e && e.message ? e.message : e}` }, host);
    }
  }
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

    // The examples come up after the page does, and cannot take it down with
    // them: the prose and its measurements are worth reading on their own.
    bootDemos(data);
  } catch (e) {
    status.textContent = 'Could not load: ' + (e && e.message ? e.message : e);
    status.classList.add('error');
    throw e;
  }
}

boot();
