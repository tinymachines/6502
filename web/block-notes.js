// The authored half of the block pages: a slug, a reading, and the labs.
//
// Everything else on those pages is derived -- the ports, the counts, the
// circuit, which control lines reach in -- and is labelled `measured` where it
// appears. This file is the part that is not, and it is kept small, kept
// separate and deliberately not given that tag, for the same reason `STEMS` in
// schematic.js is: a reading of the names is a claim by a person, and mixing it
// in with the measurements would launder one into the other.
//
// The rule for prose here is the one the Lab already follows: it is written
// from `_block-probe.html`, against a dump of what the chip did, and every
// number in it is then re-checked by `_block-test.html` against the engine.
// Writing plausible sentences about silicon is easy; noticing afterwards that
// they are wrong is not.
//
// A block with no entry here still has a page. The derived half stands up on
// its own, and an empty section is not rendered -- which is why adding a block
// to `blocks.rs` cannot break this file, and why this file being incomplete
// cannot break a page.

/**
 * Slugs, keyed by the block name `blocks.rs` gives it.
 *
 * By name rather than by index, so that reordering the blocks cannot silently
 * repoint every URL at its neighbour, and a renamed block fails loudly here
 * instead of quietly serving the wrong page. `block.js` checks that every
 * functional block has one.
 */
export const SLUGS = {
  'Pads & I/O': 'pads',
  'Instruction register': 'instruction-register',
  'Decode PLA': 'decode-pla',
  'Control pipeline': 'control-pipeline',
  'Timing chain': 'timing-chain',
  'Interrupts & vectors': 'interrupts',
  'Program counter': 'program-counter',
  ALU: 'alu',
  Registers: 'registers',
  'Status register': 'status-register',
  'Address latches': 'address-latches',
  'Data bus': 'data-bus',
};

export const NOTES = {
  alu: {
    // Where the circuit view starts. A signal, not a region: the drawing is a
    // walk, and a walk needs somewhere to stand.
    start: 'alu0',
    lede: `Every arithmetic and logical result the 6502 produces comes out of
      this block, and none of it is stored here. The adder computes; something
      else has to take the answer away before the next half-cycle overwrites it.`,
    sections: [
      {
        title: 'Two inputs, and nothing else',
        body: `The adder has exactly two operand registers, <code>alua</code> and
          <code>alub</code>, and every instruction that computes anything routes
          its operands onto those two buses first. There is no third input and no
          accumulator path that bypasses them: an <code>ADC</code>, an
          <code>INX</code> and a branch's address fixup are the same silicon
          being handed different bytes.`,
      },
      {
        title: 'The intermediate products are named after the logic they are',
        body: `The die names the adder's internals as the functions they compute
          rather than as wires: <code>A+B</code> is the bitwise OR of the two
          inputs, <code>#(AxB)</code> the inverted XOR, <code>#A.B</code> the
          inverted AND. Those three are what a carry-lookahead adder is built
          from, and because they are named, they can be read out and checked
          against arithmetic anyone can do by hand. The lab below does exactly
          that, bit by bit, on whatever the chip happens to be holding.`,
      },
      {
        title: 'The carry chain is the slow part, and it is visible',
        body: `<code>C01</code> through <code>C78</code> are the carries between
          adjacent bit pairs, each with its inverted twin. They are the reason
          bit 7 is not the same circuit as bit 0 and the reason a bit-slice
          drawing of this chip is a lie: the carry links each bit to its
          neighbour, so the eight slices are eight different circuits that happen
          to look alike.`,
      },
      {
        title: 'Bit 7 leaves by a different door',
        body: `The result reaches the special bus through <code>ADDSB06</code>
          for bits 0 to 6 and through <code>ADDSB7</code> for bit 7 alone. That
          split is the shifter. Merging the two into one path would draw a
          tidier diagram and would hide the only asymmetry in the output stage.`,
      },
    ],
    labs: [
      {
        id: 'operands',
        title: 'The operands arrive before the answer does',
        blurb: `An <code>ADC #$01</code> with <code>$41</code> in the accumulator.
          Follow it from the opcode fetch and watch the two operands land on the
          adder's inputs a full half-cycle before any sum exists.`,
        source: `        .org $0200
start:  lda #$41
        clc
here:   adc #$01
        sta $80
loop:   jmp loop`,
        // Where to start counting. Found by running until the chip fetches from
        // this label's address, never by a hardcoded half-cycle: reset timing
        // moving would silently shift every step by the same amount and the
        // page would go on looking right.
        from: 'here',
        watch: ['alua', 'alub', 'alu', 'A+B', '#(AxB)', '#A.B'],
        steps: [
          { at: 0, note: `The fetch of the ADC itself. <code>sync</code> is high
            and IR still holds the <em>previous</em> opcode, because the byte on
            the bus has not been latched yet.` },
          { at: 2, note: `IR now reads <code>$69</code>. The adder's inputs are
            still carrying the leftovers of the instruction before.` },
          { at: 4, note: `The operands are there: <code>alua</code> is
            <code>$41</code> and <code>alub</code> is <code>$01</code>. No sum
            yet. This is the half-cycle the whole page exists to show.` },
          { at: 5, note: `<code>alu</code> reads <code>$42</code>. The result
            exists and it is in no register: the accumulator still reads
            <code>$41</code>.` },
          { at: 6, note: `And now the accumulator has it. The instruction ended a
            half-cycle ago; the answer arrived during the next one's fetch.` },
        ],
      },
      {
        id: 'products',
        title: 'The intermediates really are OR, XNOR and NAND',
        blurb: `Read <code>alua</code> and <code>alub</code> off the chip, then
          read the three named intermediate buses, and check them against the
          arithmetic. Nothing here is looked up: both sides come out of the
          silicon and the comparison is done on the page.`,
        source: `        .org $0200
start:  lda #$5A
        clc
here:   adc #$3C
        sta $80
loop:   jmp loop`,
        from: 'here',
        watch: ['alua', 'alub', 'A+B', '#(AxB)', '#A.B'],
        // Checked rather than narrated: each row states a relation between buses
        // that must hold whatever the operands are, and the page evaluates it
        // against the bytes it just read off the chip.
        //
        // Functions, not expression strings. The CSP is `script-src 'self'` with
        // no 'unsafe-eval', so a string would need a parser written here, and a
        // parser here is a second thing that can be wrong about arithmetic.
        checks: [
          { at: 4, claim: 'A+B is the OR of the inputs',
            fn: (b) => b['A+B'] === (b.alua | b.alub) },
          { at: 4, claim: '#(AxB) is the inverted XOR',
            fn: (b) => b['#(AxB)'] === (~(b.alua ^ b.alub) & 0xff) },
          { at: 4, claim: '#A.B is the inverted AND',
            fn: (b) => b['#A.B'] === (~(b.alua & b.alub) & 0xff) },
        ],
        steps: [
          { at: 4, note: `Both operands are on the inputs. The three relations
            below are evaluated against what the chip is holding at this exact
            half-cycle, so they are a measurement of this run rather than a
            restatement of what an adder is.` },
        ],
      },
    ],
  },
};
