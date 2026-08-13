// The Lab: one instruction, followed from opcode byte to register, on the die.
//
// The 6502 has no instruction decoder in the sense a textbook means. An opcode
// is a byte that lands in a latch; a PLA turns those eight bits into ~38 control
// lines; those lines open and close switches that connect registers to buses. If
// you can see which lines are asserted and what is on each bus, you can watch an
// instruction happen rather than take anyone's word for it.
//
// Every step below is anchored to a half-cycle offset from the instruction's own
// opcode fetch, and every claim in the prose was read out of this engine first
// (web/_lab-probe.html dumps the same signals as a table). The control lines
// shown alongside each step are read live from the chip at that instant, not
// stored here: if the prose and the silicon ever disagree, the readout is what
// the reader sees.
//
// Offsets are in HALF-cycles, because the chip does work on both clock edges.

/** ab0..ab15 and friends: the die names buses as numbered scalars. */
const bits = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

// The decode PLA's outputs. The tail of each name says what the line does --
// ACSB gates the accumulator onto the special bus, SUMS selects the adder's sum,
// SBX writes the special bus into X. This is the vocabulary of the whole chip.
export const DPC_NAMES = [
  'dpc0_YSB', 'dpc1_SBY', 'dpc2_XSB', 'dpc3_SBX', 'dpc4_SSB', 'dpc5_SADL',
  'dpc6_SBS', 'dpc7_SS', 'dpc8_nDBADD', 'dpc9_DBADD', 'dpc10_ADLADD',
  'dpc11_SBADD', 'dpc12_0ADD', 'dpc13_ORS', 'dpc14_SRS', 'dpc15_ANDS',
  'dpc16_EORS', 'dpc17_SUMS', 'dpc19_ADDSB7', 'dpc20_ADDSB06', 'dpc21_ADDADL',
  'dpc23_SBAC', 'dpc24_ACSB', 'dpc25_SBDB', 'dpc26_ACDB', 'dpc27_SBADH',
  'dpc28_0ADH0', 'dpc29_0ADH17', 'dpc30_ADHPCH', 'dpc31_PCHPCH', 'dpc32_PCHADH',
  'dpc33_PCHDB', 'dpc34_PCLC', 'dpc35_PCHC', 'dpc37_PCLDB', 'dpc38_PCLADL',
  'dpc39_PCLPCL', 'dpc40_ADLPCL',
];

// Regions of the die a step can frame. Each is a real set of named nodes, so
// "show me the instruction register" means the polygons that are the register.
const REGIONS = {
  ab:     { label: 'address bus pins',      nodes: bits('ab', 16) },
  db:     { label: 'data bus pins',         nodes: bits('db', 8) },
  pd:     { label: 'predecode latch',       nodes: bits('pd', 8) },
  ir:     { label: 'instruction register',  nodes: bits('ir', 8) },
  decode: { label: 'decode PLA',            nodes: DPC_NAMES },
  idb:    { label: 'internal data bus',     nodes: bits('idb', 8) },
  sb:     { label: 'special bus',           nodes: bits('sb', 8) },
  alu:    { label: 'adder and its inputs',  nodes: [...bits('alua', 8), ...bits('alub', 8), ...bits('alu', 8)] },
  a:      { label: 'accumulator',           nodes: bits('a', 8) },
  x:      { label: 'X register',            nodes: bits('x', 8) },
  adh:    { label: 'address high bus',      nodes: bits('adh', 8) },
  dor:    { label: 'data output register',  nodes: bits('dor', 8) },
};

/**
 * The walkthroughs.
 *
 * `at` is the address of the instruction being studied; the bytes before it are
 * setup, and are run through normally. `d` is the half-cycle offset from that
 * instruction's opcode fetch.
 */
export const LESSONS = [
  {
    id: 'lda',
    name: 'LDA #$42',
    blurb: 'A byte from memory into the accumulator, with the ALU sitting it out.',
    at: 0x0200,
    bytes: [0xa9, 0x42, 0xea, 0xea, 0xea],
    asm: ['LDA #$42', 'NOP', 'NOP', 'NOP'],
    steps: [
      { d: 0, region: 'ab', title: 'Fetch',
        text: 'SYNC is high, which is the chip announcing that the byte it is ' +
              'reading is an opcode. The address bus holds $0200 and memory ' +
              'returns A9. Nothing has decoded yet — the instruction register ' +
              'still holds the previous instruction.' },
      { d: 1, region: 'pd', title: 'Predecode',
        text: 'The byte reaches the predecode latch before the instruction ' +
              'register. Predecode is not a decoder: it is a small amount of ' +
              'logic that spots one-byte and branch instructions early, because ' +
              'the timing chain needs to know how long this instruction runs ' +
              'before the opcode has finished decoding.' },
      { d: 2, region: 'ir', title: 'Into the instruction register',
        text: 'IR now holds A9. The address bus has already moved on to $0201 ' +
              'and the operand 42 is on the data bus — the 6502 fetches the ' +
              'next byte while it decodes this one.' },
      { d: 2, region: 'decode', title: 'Decode',
        text: 'This block is the whole instruction decoder: a PLA whose inputs ' +
              'are the eight IR bits and the timing state, and whose outputs are ' +
              'the control lines listed below. It is combinational — there is no ' +
              'microcode, no sequencer, nothing to step through. The lines below ' +
              'are simply a function of what is in IR right now.' },
      { d: 4, region: 'a', title: 'Into the accumulator',
        text: 'dpc23_SBAC connects the special bus to the accumulator and A ' +
              'becomes 42. Notice when: SYNC is high again, so this is the ' +
              'fetch of the *next* instruction. LDA finishes inside its ' +
              'successor’s first cycle.' },
    ],
  },
  {
    id: 'adc',
    name: 'ADC #$02',
    blurb: 'The adder, and the reason the accumulator lags a cycle behind.',
    at: 0x0203,
    bytes: [0xa9, 0x40, 0x18, 0x69, 0x02, 0xea, 0xea, 0xea],
    asm: ['LDA #$40', 'CLC', 'ADC #$02', 'NOP', 'NOP'],
    steps: [
      { d: 0, region: 'ab', title: 'Fetch',
        text: 'A = $40 and carry is clear, set up by the two instructions ' +
              'before this one. SYNC is high and 69 — ADC immediate — is on the ' +
              'data bus.' },
      { d: 2, region: 'ir', title: 'Into the instruction register',
        text: 'IR holds 69 and the operand 02 is on the data bus. From here the ' +
              'PLA is asserting the lines that will steer both numbers into the ' +
              'adder.' },
      { d: 4, region: 'alu', title: 'Both operands reach the adder',
        text: 'dpc24_ACSB gates the accumulator onto the special bus, which ' +
              'feeds one adder input; the operand arrives at the other. Both ' +
              'inputs are now loaded — and A still reads $40. Nothing has been ' +
              'added yet.' },
      { d: 5, region: 'alu', title: 'The sum appears',
        text: 'The adder now holds $42. The accumulator still holds $40. This is ' +
              'the moment behavioural emulators cannot show you: the result ' +
              'exists, in the adder, and is not in any register.' },
      { d: 6, region: 'a', title: 'And only now, into A',
        text: 'dpc23_SBAC finally connects the special bus to the accumulator ' +
              'and A becomes $42 — three cycles after the opcode fetch, one ' +
              'cycle later than LDA managed. That extra cycle is the adder. Step ' +
              'back one and watch A change under you.' },
    ],
  },
  {
    id: 'inx',
    name: 'INX',
    blurb: 'A one-byte instruction that still goes all the way through the adder.',
    at: 0x0202,
    bytes: [0xa2, 0x05, 0xe8, 0xea, 0xea, 0xea],
    asm: ['LDX #$05', 'INX', 'NOP', 'NOP'],
    steps: [
      { d: 0, region: 'ab', title: 'Fetch',
        text: 'X = 5. E8 is on the data bus. Watch the control lines here: ' +
              'dpc3_SBX is asserted, which is the *previous* instruction still ' +
              'writing X while this opcode is being fetched. The overlap is real ' +
              'and it is why cycle counts on this chip are not simply additive.' },
      { d: 2, region: 'ir', title: 'Into the instruction register',
        text: 'IR holds E8. INX takes no operand, so the byte fetched alongside ' +
              'it at $0203 is simply the next opcode, read and then re-read.' },
      { d: 4, region: 'alu', title: 'X onto the bus, into the adder',
        text: 'dpc2_XSB puts X on the special bus and into one adder input. The ' +
              'other input is driven by dpc8_nDBADD — the data bus *inverted*. ' +
              'There is no increment unit on this chip; adding one is done by ' +
              'the adder like everything else.' },
      { d: 5, region: 'alu', title: 'The adder increments',
        text: 'The adder holds 6. X still holds 5 — the same one-cycle gap as ' +
              'ADC, for the same reason: this went through the adder.' },
      { d: 6, region: 'x', title: 'Back into X',
        text: 'dpc3_SBX writes the special bus into X, and X becomes 6. The ' +
              'round trip for "add one to a register" is: register, special bus, ' +
              'adder, special bus, register.' },
    ],
  },
  {
    id: 'sta',
    name: 'STA $10',
    blurb: 'The other direction: a register out through the pins, and R/W low.',
    at: 0x0202,
    bytes: [0xa9, 0x42, 0x85, 0x10, 0xea, 0xea, 0xea],
    asm: ['LDA #$42', 'STA $10', 'NOP', 'NOP'],
    steps: [
      { d: 0, region: 'ab', title: 'Fetch',
        text: 'A = $42, loaded by the instruction before. 85 — STA zero page — ' +
              'is on the data bus.' },
      { d: 2, region: 'ir', title: 'Into the instruction register',
        text: 'IR holds 85, and the operand 10 follows on the data bus. That ' +
              'byte is the whole address: zero-page addressing exists because a ' +
              'one-byte address saves a cycle and a byte.' },
      { d: 3, region: 'adh', title: 'Forming a zero-page address',
        text: 'dpc28_0ADH0 and dpc29_0ADH17 force every bit of the high address ' +
              'bus to zero. That is literally what "zero page" means here: the ' +
              'high byte is not fetched or computed, it is tied to zero by two ' +
              'control lines.' },
      { d: 4, region: 'dor', title: 'The write',
        text: 'The address bus holds $0010 and R/W has gone low — this is the ' +
              'only step in the Lab where the chip is driving the data pins ' +
              'rather than reading them. dpc26_ACDB connects the accumulator to ' +
              'the data bus.' },
      { d: 5, region: 'db', title: 'Out through the pins',
        text: '$42 is on the data bus and the write completes as the clock ' +
              'rises. The value never passed through the adder: a store is one ' +
              'of the few things on this chip that is a straight wire.' },
    ],
  },
];

const hex = (v, n) => v.toString(16).padStart(n, '0').toUpperCase();

/**
 * Wire the Lab panel.
 *
 * The Lab drives the shared machine and renderer rather than owning a second
 * copy of either: a second WebGL context would mean uploading the 83k-triangle
 * die twice to show the same chip.
 */
export function createLab({ machine, renderer, els, onTakeOver }) {
  const control = DPC_NAMES
    .map((name) => ({ name, id: machine.nodeId(name) }))
    .filter((c) => c.id >= 0);

  // Resolve region node names once. A name that no longer exists in the die data
  // would otherwise fail silently as an empty highlight.
  const regions = {};
  for (const [key, region] of Object.entries(REGIONS)) {
    const ids = region.nodes.map((n) => machine.nodeId(n)).filter((n) => n >= 0);
    regions[key] = { ...region, ids };
  }

  let lesson = null;
  let base = 0;      // half-cycle of the studied instruction's opcode fetch
  let index = 0;

  function load(id) {
    lesson = LESSONS.find((l) => l.id === id) || LESSONS[0];
    onTakeOver();
    machine.load(0x0200, new Uint8Array(lesson.bytes));
    machine.setResetVector(0x0200);
    machine.powerCycle();

    // Find the instruction's own opcode fetch rather than assuming a half-cycle
    // number: reset takes its own time, and hard-coding the answer would break
    // the first time anything upstream changed.
    let guard = 0;
    while (guard++ < 4000 &&
           !(machine.sync() && machine.lastFetchAddr() === lesson.at)) {
      machine.halfStep();
    }
    base = machine.halfCycle();
    index = 0;
    show();
  }

  function goTo(half) {
    const now = machine.halfCycle();
    if (half > now) machine.runHalfCycles(half - now);
    else if (half < now && !machine.rewindTo(half)) load(lesson.id);
  }

  function show() {
    const step = lesson.steps[index];
    goTo(base + step.d);

    const region = regions[step.region];
    renderer.setHighlight(region.ids);
    if (region.ids.length) renderer.zoomToNodes(region.ids);

    const on = control.filter((c) => machine.isNodeHigh(c.id));
    const cycle = Math.floor(step.d / 2);

    els.body.innerHTML = `
      <div class="lab-step">
        <span class="lab-count">step ${index + 1} / ${lesson.steps.length}</span>
        <span class="lab-when">+${step.d} half-cycle${step.d === 1 ? '' : 's'}
          · cycle ${cycle} · φ${machine.phase()}</span>
      </div>
      <h3 class="lab-title">${step.title}</h3>
      <p class="lab-text">${step.text}</p>
      <div class="lab-region">showing: <b>${region.label}</b>${
        region.ids.length ? '' : ' <em>(not in this die data)</em>'}</div>
      <div class="lab-live">
        <div class="lab-kv"><label>A</label><span>${hex(machine.a(), 2)}</span></div>
        <div class="lab-kv"><label>X</label><span>${hex(machine.x(), 2)}</span></div>
        <div class="lab-kv"><label>IR</label><span>${hex(machine.ir(), 2)}</span></div>
        <div class="lab-kv"><label>AB</label><span>${hex(machine.addressBus(), 4)}</span></div>
        <div class="lab-kv"><label>DB</label><span>${hex(machine.dataBus(), 2)}</span></div>
        <div class="lab-kv"><label>R/W</label><span>${machine.isRead() ? 'read' : 'WRITE'}</span></div>
      </div>
      <div class="lab-ctrl-label">decode lines asserted right now &middot; ${on.length} of ${control.length}</div>
      <div class="lab-ctrl">${
        on.map((c) => `<span class="lab-line">${c.name.replace(/^dpc\d+_/, '')}</span>`).join('') ||
        '<span class="lab-none">none</span>'}</div>
    `;
    els.prev.disabled = index === 0;
    els.next.disabled = index === lesson.steps.length - 1;
    // The listing, with the instruction under study picked out from its setup.
    const studied = lesson.asm.indexOf(lesson.name);
    els.asm.innerHTML = lesson.asm
      .map((line, i) => `<div class="${i === studied ? 'on' : ''}">${line}</div>`)
      .join('');
  }

  /**
   * Idle state.
   *
   * Starting the Lab replaces whatever program is loaded and power-cycles the
   * chip, so it waits to be asked. Above the sidebar breakpoint every panel is
   * visible at once and there is no moment of "opening" this one, which is
   * exactly when an auto-start would quietly reset someone's running chip.
   */
  function idle() {
    els.body.innerHTML = `
      <p class="lab-intro">Follow one instruction from the opcode byte on the
      pins, through the latch that holds it, through the PLA that turns it into
      control lines, and into the register it changes — a step at a time, with
      the die framed on whichever part is doing the work.</p>
      <p class="lab-intro lab-warn">Loading a lesson replaces the current
      program and power-cycles the chip.</p>
      <button class="btn btn-primary btn-sm" type="button" data-lab-start>Load this instruction</button>`;
    els.prev.disabled = true;
    els.next.disabled = true;
    els.asm.innerHTML = '';
  }

  els.pick.innerHTML = LESSONS
    .map((l) => `<option value="${l.id}">${l.name} — ${l.blurb}</option>`)
    .join('');
  // Changing the instruction is itself a request to run it; only the very first
  // load needs the button.
  els.pick.onchange = () => (lesson ? load(els.pick.value) : idle());
  els.body.addEventListener('click', (e) => {
    if (e.target.closest('[data-lab-start]')) load(els.pick.value);
  });
  els.prev.onclick = () => { if (lesson && index > 0) { index--; show(); } };
  els.next.onclick = () => {
    if (lesson && index < lesson.steps.length - 1) { index++; show(); }
  };
  idle();

  return {
    /** The panel became visible. Does not load anything on its own. */
    start() { if (!lesson) idle(); },
    /** The console's own program picker took the machine back. */
    invalidate() { lesson = null; idle(); },
    /**
     * Open a lesson at a step, for `?lab=adc&step=4`. Deep-linking a single
     * moment is the point of the Lab -- "the adder holds the answer and the
     * accumulator does not" is one step, and now it has a URL.
     */
    open(id, step = 1) {
      if (!LESSONS.some((l) => l.id === id)) return false;
      els.pick.value = id;
      load(id);
      const n = Math.min(Math.max(1, step | 0), lesson.steps.length);
      if (n !== 1) { index = n - 1; show(); }
      return true;
    },
  };
}
