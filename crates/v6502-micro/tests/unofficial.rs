//! The immediate-mode unofficial opcodes whose result is a bus fight,
//! held to the documented behaviour on rung 3 alone. Rung 0 is not the
//! oracle here: the fight between A's drivers and the data latch on SB
//! is the AND at phi1, but at the phi2 edge the latch's low path (the
//! cp1 pass gate) opens before SBADD and DBADD close, and A's pullup
//! charges the joined buses instantly in a model with no rise time, so
//! the ALU input latches sample $ff where the part, whose one load
//! cannot lift SB and DB in that interval, holds the AND (measured with
//! v6502-sim's latch-probe; docs/notes/engine.md). The pin golden's one
//! trace per opcode has A and the operand chosen so the two agree.
//! blargg's instr_test 03-immediate, whose checksums are from a real
//! 2A03, is what these were authored against; this file is the reading
//! that stays behind. MUTATE=1 swaps ATX's constant and must go red.

use v6502_micro::machine::MicroCpu;
use v6502_pins::{Load, PinEngine};

/// Runs `SEC` or `CLC`, `LDA #a`, `LDX #$5a`, the opcode with its
/// immediate, then stores A, X and P (through PHP/PLA) to $00..$02 and
/// spins. Returns (A, X, P with bits 5 and 4 masked).
fn run(carry: bool, a: u8, op: u8, imm: u8) -> (u8, u8, u8) {
    let mut prog = vec![if carry { 0x38 } else { 0x18 }, 0xa9, a, 0xa2, 0x5a, op, imm];
    prog.extend([0x85, 0x00, 0x86, 0x01, 0x08, 0x68, 0x85, 0x02]); // STA $00; STX $01; PHP; PLA; STA $02
    let here = 0x0200 + prog.len() as u16;
    prog.extend([0x4c, here as u8, (here >> 8) as u8]); // JMP here
    let loads = [Load { org: 0x0200, bytes: prog }];
    let mut m = MicroCpu::rung3(&loads, 0x0200);
    for _ in 0..160 {
        PinEngine::half_step(&mut m);
    }
    (m.mem[0], m.mem[1], m.mem[2] & !0x30)
}

fn nz(v: u8) -> u8 {
    (v & 0x80) | if v == 0 { 2 } else { 0 }
}

#[test]
fn asr_ands_then_shifts_right() {
    // I is set from reset and nothing here clears it.
    for (a, imm) in [(0xffu8, 0x81u8), (0x55, 0xff), (0x01, 0x01), (0xfe, 0x7f), (0x00, 0xff)] {
        for carry in [false, true] {
            let t = a & imm;
            let want = (t >> 1, 0x5a, nz(t >> 1) | 0x04 | (t & 1));
            assert_eq!(run(carry, a, 0x4b, imm), want, "ASR #{imm:02x} with A={a:02x} C={carry}");
        }
    }
}

#[test]
fn arr_ands_rotates_and_sets_c_and_v_from_bits_6_and_5() {
    for (a, imm) in [(0x55u8, 0x7fu8), (0xff, 0xff), (0x40, 0xff), (0x80, 0xff), (0x00, 0xff), (0x3c, 0xff)] {
        for carry in [false, true] {
            let v = ((a & imm) >> 1) | (carry as u8) << 7;
            let c = v >> 6 & 1;
            let ov = ((v >> 6) ^ (v >> 5)) & 1;
            let want = (v, 0x5a, nz(v) | ov << 6 | 0x04 | c);
            assert_eq!(run(carry, a, 0x6b, imm), want, "ARR #{imm:02x} with A={a:02x} C={carry}");
        }
    }
}

#[test]
fn atx_loads_a_and_x_with_a_or_the_constant_and_the_immediate() {
    let magic = if std::env::var_os("MUTATE").is_some() { 0xeeu8 } else { v6502_micro::lines::LAX_MAGIC };
    for (a, imm) in [(0x00u8, 0xffu8), (0x11, 0x0f), (0x00, 0x11), (0xff, 0x81), (0x01, 0x01)] {
        let v = (a | magic) & imm;
        let want = (v, v, nz(v) | 0x04 | 1);
        assert_eq!(run(true, a, 0xab, imm), want, "ATX #{imm:02x} with A={a:02x}");
    }
}

#[test]
fn anc_ands_and_copies_n_into_c() {
    for (a, imm) in [(0xffu8, 0x81u8), (0x7f, 0xff), (0x00, 0xff)] {
        let v = a & imm;
        let want = (v, 0x5a, nz(v) | 0x04 | (v >> 7));
        assert_eq!(run(false, a, 0x0b, imm), want, "ANC #{imm:02x} with A={a:02x}");
    }
}
