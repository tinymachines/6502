//! The table generalizes: contexts the recorder never saw.
//!
//! The recorder proves single-valuedness over ITS eight contexts; this
//! test is the other half of that claim. Three fresh contexts (registers,
//! flags, operands and base pages the recorder never used, chosen to fire
//! every mechanism: big indexes both crossing, a taken BEQ and BVS across
//! a page, negative branch offsets) run all 256 opcodes on rung 0, the
//! selector computes the key from the machine at the fetch, and the
//! table's span must predict every control line at every half-cycle. A
//! missing variant is a failure by name, not a fall-through.
//!
//! `MUTATE=1` flips one bit of one expected span word and the test must
//! go red.

use std::sync::Arc;

use v6502_micro::lines::*;
use v6502_micro::table;
use v6502_sim::bus::FlatMemory;
use v6502_sim::cpu::Cpu;

include!("../src/select.rs");
include!("../src/harness.rs");

const CONTEXTS: &[(&str, u16, &[u8], &[u8])] = &[
    // C=1, N=1, Z=0; X=$80 and Y=$C0 both cross on operand $B9; the branch
    // offset is negative and stays in the page.
    ("gen-a", 0x0247, &[0xa9, 0x7f, 0xa2, 0x80, 0xa0, 0xc0, 0x38], &[0xb9, 0x02, 0x00]),
    // Z=1, C=0 near the page end: BEQ taken across a page, indexes that do
    // not cross.
    ("gen-b", 0x02e9, &[0xa9, 0x00, 0xa2, 0x10, 0xa0, 0x03, 0x18], &[0x17, 0x03, 0x00]),
    // V=1, C=1 near the page end: BVS and BCS taken across a page, X
    // crossing.
    ("gen-c", 0x02f4, &[0xa9, 0x40, 0x85, 0x10, 0x24, 0x10, 0xa2, 0xc0, 0x38], &[0x55, 0x02, 0x00]),
];

#[test]
fn fresh_contexts_are_predicted_line_for_line() {
    let mutate = std::env::var_os("MUTATE").is_some();
    let nl = v6502_netlist::mos6502();
    let ids: Vec<u16> = LINE_NAMES[..49]
        .iter()
        .map(|n| nl.node(n).expect("a line is a node on this die"))
        .collect();
    let mut checked_hc = 0u64;
    let mut variants_hit = std::collections::HashSet::new();
    for &(name, base, pre, ops) in CONTEXTS {
        for op in 0..=255u8 {
            let image = memory_image(base, pre, op, ops);
            let at = base + pre.len() as u16;
            let mut cpu = boot(&image);
            let mut guard = 0;
            while !(cpu.sync() && cpu.address_bus() == at) {
                cpu.half_step();
                guard += 1;
                assert!(guard < 400, "op {op:02x} in {name}: never fetched at {at:04x}");
            }
            let regs = cpu.registers();
            let key = selector(op, regs.p, regs.x, regs.y, at, &image);
            let span = table::span(op, key).unwrap_or_else(|| {
                panic!("op {op:02x} in {name}: no recorded variant for key {key:#04x} (mask {:#04x})", table::MASKS[op as usize])
            });
            variants_hit.insert((op, key & table::MASKS[op as usize]));
            cpu.half_step();
            cpu.half_step();
            for (h, &want) in span.iter().enumerate() {
                let mut want = want;
                if mutate && op == 0xa9 && name == "gen-a" && h == 1 {
                    want ^= 1 << BIT_SYNC;
                    eprintln!("MUTATE=1: flipped sync in LDA #'s expected span at h=3");
                }
                let got = vector(&cpu, &ids);
                if got != want {
                    let d = got ^ want;
                    let names: Vec<&str> = (0..51).filter(|i| d >> i & 1 != 0).map(|i| LINE_NAMES[i]).collect();
                    panic!("op {op:02x} in {name} at h={}: table and chip disagree on {}", h + 2, names.join(", "));
                }
                checked_hc += 1;
                if h + 1 < span.len() {
                    cpu.half_step();
                }
            }
        }
    }
    eprintln!(
        "coverage: 256 opcodes x {} fresh contexts, {checked_hc} half-cycles predicted line for line; {} variants exercised of {}",
        CONTEXTS.len(),
        variants_hit.len(),
        table::VARIANTS.len()
    );
}
