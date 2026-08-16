// The programs every page on this site runs.
//
// Shared rather than duplicated: two copies would drift, and "Fibonacci" on one
// page meaning something different from "Fibonacci" on the other is exactly the
// kind of difference nobody notices until a walkthrough stops matching.
//
// These used to be columns of hand-typed hex with a comment beside each byte.
// They are source now, assembled by `asm.js` at load: the bytes are computed
// from the text the Programs page shows you, so a comment cannot quietly come
// to describe a byte that is no longer there. The first three assemble to
// exactly the bytes that were typed here before, and `_asm-test.html` pins that
// -- otherwise "we rewrote how the programs are built" would be a claim with
// nothing behind it.
//
// Every program loops rather than ending. There is no operating system to
// return to, and running off the end reaches $00, which is BRK, which vectors
// to $0000, which is another BRK -- a chip climbing down its own stack forever
// while looking perfectly busy. That bug was real on two pages of this site.

import { assemble } from './asm.js';

export const LOAD_ADDR = 0x0200;

const SOURCES = [
  {
    id: 'counter',
    name: 'Counter (visual6502 default)',
    blurb: 'The program the original visual6502 boots with. It does nothing '
         + 'useful on purpose: it exercises the stack, the ALU and a '
         + 'read-modify-write in eleven instructions, which is what makes the '
         + 'die light up in interesting places.',
    watch: [{ addr: 0x000f, name: 'counter' }],
    source: `        .org $0200
start:  LDA #$00        ; A starts the run at zero
loop:   JSR bump        ; push the return address, then jump
        JMP loop        ; and round again, forever

        .org $0210      ; the eight bytes below $0210 are left as $00

bump:   INX             ; X and Y are never initialised -- they hold
        DEY             ; whatever their storage nodes came up as
        INC $0F         ; read, modify, write: this byte is written twice
        SEC
        ADC #$02        ; carry was just set, so this adds three
        RTS`,
    notes: {
      loop: 'JSR is the reason this program is worth watching. It pushes the '
          + 'return address onto the stack a byte at a time, so the address bus '
          + 'visits page $01 twice before the jump happens.',
      bump: 'The subroutine. INC $0F is a read-modify-write, and the 6502 '
          + 'performs it by writing the *old* value back before writing the new '
          + 'one — a quirk of the silicon that behavioural emulators hide and '
          + 'the Trace page shows.',
    },
  },
  {
    id: 'fibonacci',
    name: 'Fibonacci (zero page $F0)',
    blurb: 'Two numbers, added and shuffled forever. It is nearly all '
         + 'zero-page traffic, so the address bus stays in page $00 and the '
         + 'adder runs on every pass.',
    watch: [
      { addr: 0x00f0, name: 'first' },
      { addr: 0x00f1, name: 'second' },
      { addr: 0x00f2, name: 'sum' },
    ],
    source: `        .org $0200
start:  LDA #$00
        STA $F0         ; the first number
        LDA #$01
        STA $F1         ; the second

step:   LDA $F0
        CLC             ; ADC adds the carry in as well, so clear it
        ADC $F1
        STA $F2         ; the sum

        LDA $F1
        STA $F0         ; second becomes first
        LDA $F2
        STA $F1         ; sum becomes second
        JMP step`,
    notes: {
      step: 'The CLC matters. There is no "add without carry" on a 6502 — ADC '
          + 'always adds the carry flag, so clearing it first is part of the '
          + 'addition rather than housekeeping.',
      start: 'Zero page is not a cache; it is simply the first 256 bytes, and '
           + 'an instruction that names one of them needs a one-byte address '
           + 'instead of two. That saves a byte and a cycle.',
    },
  },
  {
    id: 'fill',
    name: 'Fill page $0300',
    blurb: 'Writes 256 bytes with an indexed store, then starts over. Every '
         + 'pass drives a different address onto the bus, so this is the one to '
         + 'run while watching the address pins.',
    watch: [{ addr: 0x0300, name: '$0300', page: true }],
    source: `        .org $0200
start:  LDX #$00
fill:   TXA             ; the value written is the index itself
        STA $0300,X     ; absolute,X: the bus carries $0300 + X
        INX
        BNE fill        ; INX sets Z only when X wraps back to zero
        JMP start`,
    notes: {
      fill: 'STA $0300,X adds X to a 16-bit address the chip has to fetch two '
          + 'bytes to learn. The Blueprint page shows the low byte going one '
          + 'way and the high byte another.',
    },
  },
  {
    id: 'add',
    name: 'Add two bytes',
    blurb: 'The smallest complete thing a processor does: fetch two numbers '
         + 'from memory, add them, put the answer back. If you only run one '
         + 'program on this site, run this one on the Lab.',
    watch: [
      { addr: 0x0080, name: '$80' },
      { addr: 0x0081, name: '$81' },
      { addr: 0x0082, name: 'sum' },
    ],
    source: `        .org $0200
start:  LDA #$2E
        STA $80         ; put 46 somewhere to add from
        LDA #$14
        STA $81         ; and 20 beside it

sum:    CLC             ; the carry in is part of the sum
        LDA $80
        ADC $81
        STA $82         ; $2E + $14 = $42
        JMP start`,
    notes: {
      sum: 'Watch the accumulator across ADC and it will look wrong. The adder '
         + 'holds $42 a full cycle before A does: the result sits in the ALU’s '
         + 'hold register and transfers during the *next* instruction’s fetch. '
         + 'That overlap is real silicon behaviour, and it is what the Lab’s '
         + 'ADC walkthrough exists to show.',
    },
  },
  {
    id: 'multiply',
    name: 'Multiply by adding',
    blurb: 'There is no multiply instruction. Seven sixes is six added seven '
         + 'times, counted down in X — which is how every 6502 multiply '
         + 'routine ever written begins.',
    watch: [{ addr: 0x0090, name: 'product' }],
    source: `        .org $0200
start:  LDA #$00        ; the running total
        LDX #$07        ; how many times to add

again:  CLC
        ADC #$06        ; the number being added
        DEX             ; DEX sets Z when X reaches zero
        BNE again

        STA $90         ; seven sixes: $2A
        JMP start`,
    notes: {
      again: 'A loop on this chip is a flag and a branch. DEX writes Z, BNE '
           + 'reads it, and the branch itself costs an extra cycle when it is '
           + 'taken and another when it crosses a page — both measured on the '
           + 'Timing page rather than assumed here.',
    },
  },
  {
    id: 'bits',
    name: 'Count the set bits',
    blurb: 'Shifts a byte through the carry flag eight times and counts the '
         + 'ones. The carry is not a spare bit here — it is the ninth bit of '
         + 'the accumulator, and the shifter is the only part of the datapath '
         + 'that is not eight identical slices.',
    watch: [{ addr: 0x0091, name: 'ones' }],
    source: `        .org $0200
start:  LDA #$B7        ; the byte to examine: %10110111
        LDY #$00        ; how many ones found so far
        LDX #$08        ; eight bits to look at

shift:  LSR A           ; the bit that falls off the bottom lands in carry
        BCC skip
        INY

skip:   DEX
        BNE shift

        STY $91         ; six of the eight are set
        JMP start`,
    notes: {
      shift: 'LSR A shifts the accumulator itself rather than a byte in memory. '
           + 'On the die, bit 7 is opened onto the special bus by its own '
           + 'control line — dpc19_ADDSB7 — while bits 0 to 6 share '
           + 'dpc20_ADDSB06. That single asymmetry is the shifter.',
    },
  },
  {
    id: 'copy',
    name: 'Copy a string',
    blurb: 'Walks a list of bytes until it meets a zero, copying as it goes. '
         + 'Indexed addressing, a terminator, and a branch: the shape of almost '
         + 'every loop that touches memory.',
    watch: [{ addr: 0x0400, name: '$0400', page: true }],
    source: `        .org $0200
start:  LDX #$00

copy:   LDA text,X      ; text is ahead of here, so this assembles absolute
        BEQ done        ; the zero at the end of the text stops the loop
        STA $0400,X
        INX
        BNE copy

done:   JMP start

text:   .byte "HELLO", 0`,
    notes: {
      copy: 'LDA sets Z from the byte it just loaded, so the test for the '
          + 'terminator is free — there is no compare instruction here at all.',
      text: 'The text is *inside* the program. There is no separation between '
          + 'code and data on this chip: these six bytes are fetched as data '
          + 'here and would be executed as instructions if the program counter '
          + 'ever reached them.',
    },
  },
];

/**
 * Assemble every program at load.
 *
 * Eager rather than lazy because a program that fails to assemble should fail
 * loudly here, where the message names the program and the line, rather than at
 * whatever moment some page first asks for its bytes.
 */
export const PROGRAMS = SOURCES.map((p) => {
  let asm;
  try {
    asm = assemble(p.source, { org: LOAD_ADDR });
  } catch (err) {
    throw new Error(`program "${p.name}": ${err.message}`);
  }
  return { ...p, asm, bytes: asm.bytes };
});

// ---------------------------------------------------------------------------
// Which one is selected
// ---------------------------------------------------------------------------
//
// One choice, shared by every page that runs the chip. It is kept in
// localStorage so that walking from the Explorer to the Blueprint does not
// silently change what is running -- comparing two views of the same program is
// the whole reason both pages exist.
//
// `?program=N` still wins, because a link that names a program is somebody
// asking for that program, and a stored preference overruling the URL would be
// the page arguing with the person who sent it.

const KEY = 'v6502.program';

/** The index a URL asks for, or null if it does not ask. */
export function programFromUrl(search) {
  const p = new URLSearchParams(search ?? (typeof location === 'object' ? location.search : ''));
  if (!p.has('program')) return null;
  const i = Number(p.get('program'));
  return Number.isInteger(i) && PROGRAMS[i] ? i : null;
}

/** The program to run: the URL's, else the saved one, else the first. */
export function selectedProgram(search) {
  const fromUrl = programFromUrl(search);
  if (fromUrl !== null) return fromUrl;
  try {
    const saved = Number(localStorage.getItem(KEY));
    if (Number.isInteger(saved) && PROGRAMS[saved]) return saved;
  } catch { /* storage disabled: fall through to the default */ }
  return 0;
}

export function setSelectedProgram(index) {
  if (!PROGRAMS[index]) return;
  try { localStorage.setItem(KEY, String(index)); } catch { /* nothing to do */ }
}

/** Index by id, for links that would rather name a program than number it. */
export function programIndexById(id) {
  const i = PROGRAMS.findIndex((p) => p.id === id);
  return i < 0 ? null : i;
}
