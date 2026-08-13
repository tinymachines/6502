//! Instruction lengths, measured from the chip rather than from a table.
//!
//! The point of these is that they *could* fail. Nothing in the measurement
//! path consults an instruction table -- the count comes from watching `sync` --
//! so agreement with the published cycle counts is evidence about the
//! simulation, not a tautology.

use std::sync::Arc;

use v6502_netlist::Netlist;
use v6502_sim::{bus::FlatMemory, cpu::Cpu};

const BASE: u16 = 0x0200;

/// Cycles from this opcode's fetch to the next, or `None` if it never gets
/// there.
fn cycles(nl: &Arc<Netlist>, opcode: u8) -> Option<u64> {
    let mut mem = FlatMemory::new();
    mem.load(BASE, &[opcode, 0x00, 0x00, 0x00]);
    mem.set_reset_vector(BASE);
    let mut cpu = Cpu::new(nl.clone(), mem).unwrap();
    cpu.power_cycle();
    let mut found = false;
    for _ in 0..60 {
        if cpu.sync() && cpu.last_fetch().map(|f| f.addr) == Some(BASE) {
            found = true;
            break;
        }
        cpu.half_step();
    }
    found.then_some(())?;
    let mut n = 0;
    while n < 20 {
        cpu.step_cycle();
        n += 1;
        if cpu.sync() {
            return Some(n);
        }
    }
    None
}

/// Published cycle counts, covering every addressing mode plus the stack, jump
/// and read-modify-write forms. Operands are zero, so none of these cross a
/// page and the base count applies.
#[test]
fn measured_lengths_match_the_published_ones() {
    let nl = Arc::new(Netlist::mos6502());
    let expected: &[(u8, u64)] = &[
        (0xa9, 2), (0xa5, 3), (0xb5, 4), (0xad, 4), (0xbd, 4), (0xb9, 4),
        (0xa1, 6), (0xb1, 5), (0x20, 6), (0x60, 6), (0x40, 6), (0x00, 7),
        (0x48, 3), (0x68, 4), (0x08, 3), (0x28, 4), (0x4c, 3), (0x6c, 5),
        (0xea, 2), (0xe8, 2), (0x18, 2), (0x85, 3), (0x8d, 4), (0x9d, 5),
        (0x99, 5), (0x81, 6), (0x91, 6), (0x06, 5), (0x0e, 6), (0x1e, 7),
        (0xe6, 5), (0xee, 6), (0xfe, 7),
    ];
    for (op, want) in expected {
        assert_eq!(cycles(&nl, *op), Some(*want), "opcode ${op:02X}");
    }
}

/// Twelve opcodes stop the chain and never fetch again. They are recorded as
/// such rather than timed out at some arbitrary number, because a plausible
/// count beside an instruction that does not have one is worse than an honest
/// gap.
#[test]
fn exactly_twelve_opcodes_never_finish() {
    let nl = Arc::new(Netlist::mos6502());
    let jams: Vec<u8> = (0..=255u8).filter(|op| cycles(&nl, *op).is_none()).collect();
    assert_eq!(
        jams,
        vec![0x02, 0x12, 0x22, 0x32, 0x42, 0x52, 0x62, 0x72, 0x92, 0xb2, 0xd2, 0xf2],
        "the JAM opcodes have changed"
    );
}

/// Twelve undocumented opcodes take eight cycles -- longer than anything in the
/// datasheet. Nothing was built for them; the chain simply takes that long to
/// reach a term that stops it.
#[test]
fn twelve_undocumented_opcodes_run_longer_than_any_documented_one() {
    let nl = Arc::new(Netlist::mos6502());
    let eight: Vec<u8> =
        (0..=255u8).filter(|op| cycles(&nl, *op) == Some(8)).collect();
    assert_eq!(
        eight,
        vec![0x03, 0x13, 0x23, 0x33, 0x43, 0x53, 0x63, 0x73, 0xc3, 0xd3, 0xe3, 0xf3],
        "the eight-cycle opcodes have changed"
    );
    // ...and nothing runs longer than that.
    for op in 0..=255u8 {
        if let Some(c) = cycles(&nl, op) {
            assert!(c <= 8, "${op:02X} took {c} cycles");
        }
    }
}

/// Which term arrives in the final cycle.
///
/// "Arrives" means high in the last cycle and not high in any earlier one --
/// listing everything high at the end instead sweeps in the terms describing
/// the instruction's class, which were high throughout and end nothing.
///
/// This is coincidence in time, not a traced wire. It is asserted because the
/// page makes the claim, and because the naming agreeing with the measurement
/// across two thirds of the instruction set is worth not losing quietly.
#[test]
fn instructions_end_on_the_term_named_for_them() {
    let nl = Arc::new(Netlist::mos6502());
    let pla = v6502_netlist::pla::Pla::derive(&nl);
    for (opcode, want) in [
        (0x20u8, "op-T0-jsr"),
        (0x00, "op-T0-brk/rti"),
        (0x4c, "op-T0-jmp"),
        (0x48, "op-T0-php/pha"),
        (0xa9, "op-T0-lda"),
    ] {
        let arrived = arriving_terms(&nl, &pla, opcode);
        assert!(
            arrived.iter().any(|n| n == want),
            "${opcode:02X} should end on {want}, got {arrived:?}"
        );
    }
}

/// Terms high in the final cycle that were not high earlier.
fn arriving_terms(
    nl: &Arc<Netlist>,
    pla: &v6502_netlist::pla::Pla,
    opcode: u8,
) -> Vec<String> {
    use std::collections::BTreeSet;
    let mut mem = FlatMemory::new();
    mem.load(BASE, &[opcode, 0x00, 0x00, 0x00]);
    mem.set_reset_vector(BASE);
    let mut cpu = Cpu::new(nl.clone(), mem).unwrap();
    cpu.power_cycle();
    for _ in 0..60 {
        if cpu.sync() && cpu.last_fetch().map(|f| f.addr) == Some(BASE) {
            break;
        }
        cpu.half_step();
    }
    let mut earlier: BTreeSet<usize> = BTreeSet::new();
    let mut n = 0;
    loop {
        let now: BTreeSet<usize> = pla
            .rows
            .iter()
            .enumerate()
            .filter(|(_, r)| cpu.engine().is_high(r.node))
            .map(|(i, _)| i)
            .collect();
        cpu.step_cycle();
        n += 1;
        if cpu.sync() || n >= 20 {
            return now
                .difference(&earlier)
                .filter_map(|i| pla.rows[*i].name.clone())
                .collect();
        }
        earlier.extend(now);
    }
}
