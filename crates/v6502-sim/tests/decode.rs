//! The decode PLA, measured against the documented instruction set.
//!
//! `export-decode` writes a table claiming "these opcodes fire this product
//! term". That claim is only worth anything if something independent keeps
//! checking it, so this runs the same experiment on a handful of terms and
//! compares against opcode sets taken from the published 6502 instruction set.
//!
//! Two directions, and they are not the same assertion:
//!
//! - **Nothing documented may be missing.** If `op-T0-lda` ever stops firing for
//!   an opcode the datasheet calls `LDA`, the derivation has lost a real
//!   instruction.
//! - **Extras are expected, and must be undocumented.** `op-T0-lda` fires for
//!   sixteen opcodes; the eight the datasheet does not list are `LAX`. That is
//!   the finding, not a fault -- but an extra that turned out to be a
//!   *documented* opcode would mean two instructions had been conflated.

use std::sync::Arc;

use v6502_netlist::{mos6502, pla::Pla};
use v6502_netlist::Netlist;
use v6502_sim::{bus::FlatMemory, cpu::Cpu};

const BASE: u16 = 0x0200;
const WINDOW: usize = 16;

/// Opcodes that fire `term`, measured the way `export-decode` measures them.
fn opcodes_firing(nl: &Arc<Netlist>, pla: &Pla, term: &str) -> Vec<u8> {
    let node = pla.row(term).unwrap_or_else(|| panic!("no term {term}")).node;
    let mut out = Vec::new();
    for opcode in 0..=255u8 {
        if fires(nl, node, opcode, &[]) || fires(nl, node, opcode, &[0x38, 0xa9, 0x80]) {
            out.push(opcode);
        }
    }
    out
}

fn fires(nl: &Arc<Netlist>, node: u16, opcode: u8, preamble: &[u8]) -> bool {
    let mut mem = FlatMemory::new();
    let at = BASE + preamble.len() as u16;
    mem.load(BASE, preamble);
    mem.load(at, &[opcode, 0x00, 0x00, 0x00]);
    mem.set_reset_vector(BASE);
    let mut cpu = Cpu::new(nl.clone(), mem).unwrap();
    cpu.power_cycle();

    // Find the opcode's own fetch by watching sync, never by counting.
    let mut found = false;
    for _ in 0..60 {
        if cpu.sync() && cpu.last_fetch().map(|f| f.addr) == Some(at) {
            found = true;
            break;
        }
        cpu.half_step();
    }
    if !found {
        return false;
    }
    for _ in 0..WINDOW {
        if cpu.engine().is_high(node) {
            return true;
        }
        cpu.half_step();
    }
    false
}

fn setup() -> (Arc<Netlist>, Pla) {
    let nl = Arc::new(mos6502());
    let pla = Pla::derive(&nl);
    (nl, pla)
}

#[test]
fn terms_without_undocumented_siblings_decode_exactly() {
    let (nl, pla) = setup();
    for (term, want) in [
        ("op-T0-jsr", vec![0x20u8]),
        ("op-T0-plp", vec![0x28]),
        ("op-T0-jmp", vec![0x4c, 0x6c]),
        ("op-T0-clc/sec", vec![0x18, 0x38]),
        ("op-T0-brk/rti", vec![0x00, 0x40]),
    ] {
        let got = opcodes_firing(&nl, &pla, term);
        assert_eq!(got, want, "{term} decoded {got:02x?}, expected {want:02x?}");
    }
}

/// The headline result, pinned: the accumulator-load term is high for the eight
/// documented `LDA` opcodes *and* the eight `LAX`/`LAS` ones, which is why those
/// undocumented instructions load the accumulator at all.
#[test]
fn the_lda_term_also_fires_for_the_lax_opcodes() {
    let (nl, pla) = setup();
    let got = opcodes_firing(&nl, &pla, "op-T0-lda");
    let documented = [0xa9u8, 0xa5, 0xb5, 0xad, 0xbd, 0xb9, 0xa1, 0xb1];
    for op in documented {
        assert!(got.contains(&op), "op-T0-lda no longer fires for LDA ${op:02X}");
    }
    let extra: Vec<u8> = got.iter().copied().filter(|o| !documented.contains(o)).collect();
    assert_eq!(
        extra,
        vec![0xa3, 0xa7, 0xab, 0xaf, 0xb3, 0xb7, 0xbb, 0xbf],
        "the undocumented opcodes sharing the LDA term have changed"
    );
}

/// `op-branch-done` is the term that ends a branch's page-crossing fixup, and it
/// only fires when the branch is both taken *and* crosses a page. Getting a
/// single trace to show it took a scenario doing both; this pins the fact so a
/// future change to the export cannot quietly lose it again.
#[test]
fn the_branch_term_needs_a_taken_branch_across_a_page() {
    let (nl, pla) = setup();
    let node = pla.row("op-branch-done").unwrap().node;

    // BCS with C set, offset 0: taken, same page.
    assert!(
        !fires(&nl, node, 0xb0, &[0x38, 0xa9, 0x80]),
        "no page crossing, so nothing to fix up"
    );

    // The same branch placed so the offset crosses a page.
    let mut mem = FlatMemory::new();
    mem.load(0x02f0, &[0x38, 0xa9, 0x80]);
    mem.load(0x02f3, &[0xb0, 0x7f]);
    mem.set_reset_vector(0x02f0);
    let mut cpu = Cpu::new(nl.clone(), mem).unwrap();
    cpu.power_cycle();
    let mut found = false;
    for _ in 0..60 {
        if cpu.sync() && cpu.last_fetch().map(|f| f.addr) == Some(0x02f3) {
            found = true;
            break;
        }
        cpu.half_step();
    }
    assert!(found, "never reached the branch");
    let mut fired = false;
    for _ in 0..WINDOW {
        fired |= cpu.engine().is_high(node);
        cpu.half_step();
    }
    assert!(fired, "a taken branch across a page must fire op-branch-done");
}
