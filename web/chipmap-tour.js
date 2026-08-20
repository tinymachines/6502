// The guided tour: one instruction across the chip map, container by
// container. This file is the AUTHORED half and is labelled as such, the same
// register as block-notes.js and the Lab's prose: the narration was written
// from a per-half-cycle dump of this exact program on the engine
// (_tour-probe.html), and every claim it makes rides beside a check function
// that the page evaluates live and _chipmap-test.html re-evaluates on a chip
// of its own. If the narration and the silicon ever disagree, both go red.
//
// One tour, ADC, because it is the site's own star witness: the instruction
// whose result exists before it is anywhere, and whose add happens while the
// next opcode is already being fetched.
//
// Steps are offsets from the instruction's OWN opcode fetch, found by running
// until `sync` with its address on the bus; the address comes from the
// assembler's label, never a byte offset. A remembered half-cycle number
// would shift silently the first time reset timing moved.

export const TOUR = {
  id: 'adc',
  title: 'ADC #$02, container by container',
  // Loops rather than ending, like every program on this site: running off
  // the end reaches $00, which is BRK, which vectors to another BRK.
  source: `        .org $0200
start:  clc
        lda #$40
adcop:  adc #$02
        jmp start
`,
  target: 'adcop',
  steps: [
    { at: 0, subject: 'pins:bidirectional', title: 'The fetch',
      note: 'Sync is high and $69, the ADC opcode, is on the data pads. The '
        + 'instruction register still holds $A9: the previous instruction’s '
        + 'opcode, about to be replaced. The accumulator already reads $40, '
        + 'because the LDA before this landed.',
      checks: [
        { claim: 'sync is high', fn: (r) => r.sync() === true },
        { claim: 'IR still holds $A9', fn: (r) => r.ir() === 0xa9 },
        { claim: 'A reads $40', fn: (r) => r.bus('a') === 0x40 },
      ] },
    { at: 1, subject: 'dbus:idl', title: 'The road in',
      note: 'The byte crosses the pads into the input data latch and climbs '
        + 'the load path while the fetch line is open. Look at the rings: the latch, the '
        + 'load path and the predecode are most of what switched at this '
        + 'edge, and the moved list below is measured, not written.',
      checks: [
        { claim: 'the fetch line is open', fn: (r) => r.hi('fetch') },
      ] },
    { at: 2, subject: 'stage:T0', title: 'Decoded',
      note: 'The instruction register reads $69 and the PLA answers: '
        + 'op-T0-adc/sbc is high, one term of the T0 stage. The address '
        + 'latches have already moved on, putting the operand’s address on '
        + 'the pins, and the incrementer is stepping the counter past it.',
      checks: [
        { claim: 'IR holds $69', fn: (r) => r.ir() === 0x69 },
        { claim: 'op-T0-adc/sbc is high', fn: (r) => r.hi('op-T0-adc/sbc') },
      ] },
    { at: 4, subject: 'alu:b', title: 'The operands, and the overlap',
      note: 'DBADD opens the data bus into the B input, which now holds the '
        + 'operand $02; SBADD holds the accumulator’s $40 on A. And '
        + 'op-T+-adc/sbc fires: the add happens in the instruction’s last '
        + 'cycle, while sync is already high for the next fetch. The overlap '
        + 'is not a corner case, it is the design.',
      checks: [
        { claim: 'B input holds $02', fn: (r) => r.bus('alub') === 0x02 },
        { claim: 'A input holds $40', fn: (r) => r.bus('alua') === 0x40 },
        { claim: 'op-T+-adc/sbc is high', fn: (r) => r.hi('op-T+-adc/sbc') },
        { claim: 'sync is already high again', fn: (r) => r.sync() === true },
      ] },
    { at: 5, subject: 'regs:a', title: 'The result is in no register',
      note: 'The adder holds $42 and the accumulator still reads $40: the '
        + 'selected card’s byte is A’s own storage saying so. The sum exists, '
        + 'and it is nowhere an assembly programmer can name. This is the '
        + 'moment the whole site exists to show.',
      checks: [
        { claim: 'the adder holds $42', fn: (r) => r.bus('alu') === 0x42 },
        { claim: 'A still reads $40', fn: (r) => r.bus('a') === 0x40 },
      ] },
    { at: 6, subject: 'sbus:sb', title: 'Writeback, one instruction late',
      note: 'SBAC opens the special bus into the accumulator and A becomes '
        + '$42, carried on the bus this card reads. The instruction register '
        + 'already holds $4C: the JMP after this is decoding while ADC '
        + 'finishes. The tail of one instruction is the head of the next.',
      checks: [
        { claim: 'A now reads $42', fn: (r) => r.bus('a') === 0x42 },
        { claim: 'SBAC is open', fn: (r) => r.hi('dpc23_SBAC') },
        { claim: 'IR already holds the JMP', fn: (r) => r.ir() === 0x4c },
      ] },
  ],
};

/**
 * The one reader the checks are written against, shared by the page and the
 * harness so a claim cannot mean two things. Everything it returns is read
 * off the machine.
 */
export function readerOf(m) {
  return {
    sync: () => m.sync(),
    ir: () => m.ir(),
    hi: (name) => { const id = m.nodeId(name); return id >= 0 && m.isNodeHigh(id); },
    bus: (stem) => {
      let v = 0, bits = 0;
      for (let i = 0; i < 8; i++) {
        const id = m.nodeId(`${stem}${i}`);
        if (id < 0) continue;
        bits++;
        if (m.isNodeHigh(id)) v |= 1 << i;
      }
      return bits ? v : null;
    },
  };
}
