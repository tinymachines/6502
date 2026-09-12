//! The selector sees the index register the seam is about to write.
//!
//! An ALU result is not in its register when the next opcode's sync
//! rises: it sits in the hold register and lands through the seam, the
//! finished op's write-back lines carried into the next span's first
//! half-cycle. The next op's span is chosen at its fetch, and the
//! choice's index-crossing bits ask X and Y. Asked as stored, they answer
//! with the value from BEFORE the seam: `INY` then `LDA (zp),Y`, whose add
//! carries with the new Y and not the old, played the five-cycle variant,
//! read the un-carried address and kept that byte.
//!
//! Found by the NES console's trace of a commercial cartridge (one wrong
//! tile on a title screen, walked back through the pins to the read that
//! never happened), located with `examples/diverge`, and held here
//! against rung 0: every seam-written index register before every
//! crossing form, in both directions (the written register crosses where
//! the stored one would not, and the reverse: the first fix answered
//! "cross" for anything in flight and passed a one-sided version of this
//! file, which the cartridge's menu then refuted), and the same pairs
//! with an instruction between them, where the register has landed and
//! nothing was ever wrong. `MUTATE_SEAM=1` asks the registers as stored
//! and must go red.

use v6502_micro::machine::MicroCpu;
use v6502_pins::{compare, Load, PinEngine};
use v6502_sim::pins::rung0;

/// Zero page $00/$01 point at $03F3; $0300 and $0400 hold different bytes
/// so a read from the un-carried address is visible in the pins.
fn loads(program: &[u8]) -> Vec<Load> {
    let mut prog = program.to_vec();
    // Then spin, so the run has nowhere new to go.
    let here = 0x0200 + prog.len() as u16;
    prog.extend_from_slice(&[0x4c, here as u8, (here >> 8) as u8]);
    vec![
        Load { org: 0x0000, bytes: vec![0xf3, 0x03] },
        Load { org: 0x0300, bytes: vec![0x20] },
        Load { org: 0x0400, bytes: vec![0x0a] },
        Load { org: 0x0200, bytes: prog },
    ]
}

/// Rung 0 and rung 3 from the same power cycle over the same bytes, for
/// `n` half-cycles, every pin frame compared.
fn lockstep(name: &str, program: &[u8], n: usize) -> Result<(), String> {
    let loads = loads(program);
    let mut a = rung0(&loads, 0x0200);
    a.power_cycle();
    let mut b = MicroCpu::rung3(&loads, 0x0200);
    let mut expected = Vec::with_capacity(n + 1);
    let mut got = Vec::with_capacity(n + 1);
    for _ in 0..=n {
        expected.push(a.pins());
        got.push(PinEngine::pins(&b));
        a.half_step();
        PinEngine::half_step(&mut b);
    }
    compare(&expected, &got).map_err(|m| format!("{name}: {m:?}"))
}

/// Each case: the register write whose result is in flight, then the
/// crossing form that asks that register. Every pair is also run with a
/// NOP between (the register has landed) as the control.
const CASES: &[(&str, &[u8])] = &[
    ("INY then LDA (zp),Y", &[0xa0, 0x0c, 0xc8, 0xb1, 0x00]),
    ("INY then STA (zp),Y", &[0xa0, 0x0c, 0xc8, 0x91, 0x00]),
    ("INY then LDA abs,Y", &[0xa0, 0x0c, 0xc8, 0xb9, 0xf3, 0x03]),
    ("DEY then LDA abs,Y", &[0xa0, 0x00, 0x88, 0xb9, 0x01, 0x03]),
    ("INX then LDA abs,X", &[0xa2, 0x0c, 0xe8, 0xbd, 0xf3, 0x03]),
    ("DEX then LDA abs,X", &[0xa2, 0x00, 0xca, 0xbd, 0x01, 0x03]),
    ("INX then STA abs,X", &[0xa2, 0x0c, 0xe8, 0x9d, 0xf3, 0x03]),
    ("TAY then LDA (zp),Y", &[0xa9, 0x0d, 0xa8, 0xb1, 0x00]),
    ("TAX then LDA abs,X", &[0xa9, 0x0d, 0xaa, 0xbd, 0xf3, 0x03]),
    ("LDY # then LDA (zp),Y", &[0xa0, 0x0d, 0xb1, 0x00]),
    ("LDX # then LDA abs,X", &[0xa2, 0x0d, 0xbd, 0xf3, 0x03]),
    ("LDY zp then LDA abs,Y", &[0xa9, 0x0d, 0x85, 0x10, 0xa4, 0x10, 0xb9, 0xf3, 0x03]),
    ("INY then INC abs,X (X stale, Y in flight)", &[0xa2, 0x0d, 0xa0, 0x0c, 0xc8, 0xfe, 0xf3, 0x03]),
    ("INX then LDA (zp),Y (Y stale, X in flight)", &[0xa0, 0x0d, 0xa2, 0x0c, 0xe8, 0xb1, 0x00]),
    // The other direction: the stored register would cross, the written
    // one does not. A selector answering "cross" for anything in flight
    // passes every case above and fails these (the first fix did).
    ("DEY then LDA (zp),Y, no crossing", &[0xa0, 0x0d, 0x88, 0xb1, 0x00]),
    ("DEX then LDA abs,X, no crossing", &[0xa2, 0x0d, 0xca, 0xbd, 0xf3, 0x03]),
    ("INY from zero then LDA (zp),Y, no crossing", &[0xa0, 0x00, 0xc8, 0xb1, 0x00]),
    ("INX from zero then STA abs,X, no crossing", &[0xa2, 0x00, 0xe8, 0x9d, 0xf3, 0x03]),
    ("INY under carry set then LDA (zp),Y, no crossing", &[0x38, 0xa0, 0x00, 0xc8, 0xb1, 0x00]),
    ("INY after a store then LDA (zp),Y, no crossing (the cartridge's sequence)", &[0xa0, 0x00, 0xb1, 0x00, 0x8d, 0x00, 0x02, 0xc8, 0xb1, 0x00]),
    ("ADC then TAY then LDA (zp),Y (A's seam, Y loaded in its own span)", &[0x18, 0xa9, 0xf0, 0x69, 0x0f, 0xa8, 0xb1, 0x00]),
    ("TSX then LDA abs,X", &[0xa2, 0x0d, 0x9a, 0xba, 0xbd, 0xf3, 0x03]),
];

#[test]
fn a_seam_written_index_register_is_seen_by_the_next_selector() {
    let mut failures = Vec::new();
    for (name, program) in CASES {
        if let Err(e) = lockstep(name, program, 120) {
            failures.push(e);
        }
    }
    assert!(failures.is_empty(), "rung 3 left rung 0 on {} of {} cases:\n{}", failures.len(), CASES.len(), failures.join("\n"));
}

#[test]
fn the_same_pairs_with_the_register_landed_agree_as_they_always_did() {
    for (name, program) in CASES {
        // A NOP between the write and the crossing form: the seam has
        // played, the stored register is the one to ask.
        let mut spaced = program.to_vec();
        let at = spaced.len() - crossing_len(program);
        spaced.insert(at, 0xea);
        lockstep(&format!("{name} with a NOP between"), &spaced, 120).unwrap();
    }
}

/// The byte length of the crossing form at the end of a case's program.
fn crossing_len(program: &[u8]) -> usize {
    match program[program.len() - 3] {
        0xb9 | 0xbd | 0x9d | 0xfe => 3,
        _ => 2,
    }
    // (every case ends in its crossing form; a 3-byte form's opcode sits
    // three from the end, a 2-byte form's two, and no case's operand
    // byte collides with those opcodes at that position)
}
