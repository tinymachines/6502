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

/**
 * What each block does, in one paragraph, above its measured interface.
 *
 * This replaced a paragraph explaining what a boundary is, which was the same
 * words on all twelve pages: true, and worth saying once, but a reader who has
 * arrived at the program counter wants to know about the program counter. The
 * four relations it described are named and explained on the panel itself,
 * which is where they belong.
 *
 * These are readings, not measurements, and they are the reason this file is
 * kept separate and deliberately untagged. Every one of them is grounded in
 * something this project measured elsewhere -- predecode forcing a BRK is
 * `tests/interrupts.rs`, the pipeline's lag is the decode fitting, the missing
 * status bit is the name table's own sentinel -- but a sentence is not a
 * measurement however well sourced it is, and the tags on this page say
 * `derived` only where something was derived.
 *
 * The stray-digit scan in `_block-test.html` covers these, so a count cannot be
 * typed into one and sit there unchallenged. Signal names in <code> are exempt,
 * which is why quantities here are words.
 */
export const DOES = {
  pads: `The ring of bond pads around the edge of the die, and the drivers and
    receivers that sit between them and everything else. A pad is not a wire,
    which is the thing here most worth knowing: an output pad is a driver, and a
    signal arriving from outside comes in through a receiver, which is a gate.
    Nothing enters this chip through a pass transistor, so a trace that follows
    only switches can never leave this ring.`,

  'instruction-register': `Holds the opcode being executed, and predecodes the
    byte on its way in. Predecode is the part worth knowing about: it looks at
    the byte before the instruction register latches it, and when an interrupt
    is pending it forces that byte to a <code>BRK</code>. That is why this chip
    has no interrupt sequencer at all. Reset, <code>NMI</code> and
    <code>IRQ</code> all run the ordinary <code>BRK</code> instruction, and only
    the vector fetched at the end and one flag tell them apart.`,

  'decode-pla': `The array that turns the opcode, together with how far the chip
    has got through the instruction, into the product terms every other control
    block is built on. What it does not do is the more useful half: there is no
    notion of a valid instruction anywhere in it. Every opcode is fed to the
    same array and whatever it happens to select is what the chip does, which is
    why the undocumented opcodes do something particular rather than faulting.`,

  'control-pipeline': `Takes the product terms the decoder produces and turns
    them into the control lines that operate the datapath, latching them on the
    clock along the way. That latch is why a control line does not assert in the
    same instant its term goes high: there is a lag of a half-cycle or two, and
    it is not the same depth for every line. Most of these lines are precharged
    rather than statically driven, held high by a clocked transistor and pulled
    down only when the decoder has something to say.`,

  'timing-chain': `Counts how far the chip has got through the current
    instruction. It is a shift register of clocked latches rather than a
    counter, and it is active low, like the control lines it feeds. Nothing here
    stores how long an instruction is meant to take: the chain advances until a
    product term resets it, so a cycle count is however many cycles went by
    before that happened rather than a number the chip looked up.`,

  interrupts: `Samples the interrupt inputs and supplies the vector addresses
    fetched at the end of the sequence. It does less on its own than its name
    suggests, because the chip has no interrupt sequencer: the instruction
    register's predecode forces a <code>BRK</code> and the ordinary
    <code>BRK</code> instruction does the pushing. What is left here is deciding
    when an input is allowed to be seen, and which vector reaches the address
    bus when the time comes.`,

  'program-counter': `Holds the address of the next byte to be fetched, and
    increments as bytes are consumed. It is loaded rather than incremented for a
    jump, a branch, or the vector at the end of an interrupt sequence. Its low
    and high halves increment separately, which is why crossing a page costs an
    extra cycle on the instructions where it can happen: the high half only
    moves when the low half has run out. The die names its precharge nodes as
    well as its storage, so both sides of the dynamic latch are visible.`,

  alu: `Every arithmetic and logical result the chip produces comes out of this
    block, and none of it is kept here. There are exactly two operand registers
    and no third input, so an add, an increment and a branch's address fixup are
    the same silicon being handed different bytes. The result lands in a hold
    register rather than in a register you can name, and something else has to
    carry it away before the next half-cycle overwrites it. That is why a value
    can be computed and correct while every architectural register still reads
    its old contents.`,

  registers: `The accumulator, the two index registers and the stack pointer.
    They are storage and nothing else: no arithmetic happens here, and every
    operation that changes one of them routes the value out to the adder and
    back. The storage is dynamic, held as charge on a node rather than by a
    static pair of transistors, which is why this chip has a minimum clock speed
    as well as a maximum, and why the stack pointer comes out of a power cycle
    holding whatever it happens to hold.`,

  'status-register': `The flags, and the logic that decides what sets them. Most
    are written straight from the adder's outputs as a side effect of whatever
    it just computed, rather than being worked out separately afterwards. One
    thing here is a real absence rather than a simplification: there is no bit
    between the overflow and break flags. The die's own name table marks it as
    not existing, and the chip reads it high because there is nothing there to
    pull it down.`,

  'address-latches': `Assembles the address the chip is about to put on its
    pins, out of a low half and a high half loaded from different places
    depending on what kind of access it is. It is also where this chip keeps its
    constants: the high half carries generators that can force the stack page or
    the top of memory onto the bus without anything having to compute them,
    which is how a push and a vector fetch reach the right page without
    involving the adder at all.`,

  'data-bus': `Moves bytes between the pins, the registers and the adder. The
    distinction worth holding onto is that the internal bus and the data pins
    are not the same wire: the internal one is what the registers and the adder
    talk to, and the pads sit behind their drivers and receivers at the edge. A
    byte arriving from memory crosses from one to the other, and most of what is
    filed here is the switches deciding which of several possible sources is
    driving the internal bus at any instant.`,
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
