//! The ALU on rung 0 through a short program: the hold register, both
//! input latches, the SB bus and A every half-cycle, beside the ALU's
//! control lines, so an authored path in rung 3 is measured rather than
//! reasoned about.
//!
//!     cargo run --release -p v6502-sim --example alu-probe [hex bytes] [half-cycles]
//!
//! The default program is ROR A under both carries (SEC; LDA #$db; ROR A;
//! STA $80; CLC; LDA #$db; ROR A; STA $81), the measurement behind
//! `SEAM_ADDSB7_OFF` in v6502-micro's lines.rs: with the carry set the
//! shift cycle and the next instruction's first half-cycle both leave
//! `ADD/SB7` off, so A takes bit 7 from the undriven SB7 while the ALU
//! register holds zero there.

use std::sync::Arc;
use v6502_pins::PinEngine;
use v6502_sim::{bus::FlatMemory, cpu::Cpu};

#[path = "../../v6502-micro/src/lines.rs"]
#[allow(dead_code)]
mod lines;
use lines::LINE_NAMES;

fn main() {
    let prog: Vec<u8> = match std::env::args().nth(1) {
        Some(h) => (0..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i + 2], 16).expect("hex bytes")).collect(),
        None => vec![0x38, 0xa9, 0xdb, 0x6a, 0x85, 0x80, 0x18, 0xa9, 0xdb, 0x6a, 0x85, 0x81],
    };
    let to: u64 = std::env::args().nth(2).and_then(|a| a.parse().ok()).unwrap_or(40);
    let mut mem = FlatMemory::new();
    mem.load(0x0200, &prog);
    mem.load(0xfffc, &[0x00, 0x02]);
    let mut cpu = Cpu::new(Arc::new(v6502_netlist::mos6502()), mem).expect("signals resolve");
    cpu.power_cycle();
    let nl = cpu.engine().netlist();
    let ids: Vec<u16> =
        LINE_NAMES[..49].iter().map(|n| nl.node(n).unwrap_or_else(|| panic!("{n} is a node"))).collect();
    let alucin = nl.node("alucin").expect("alucin is a node");
    for h in 0..=to {
        if h > 0 {
            cpu.half_step();
        }
        let pf = PinEngine::pins(&cpu);
        let on: Vec<&str> = ids
            .iter()
            .enumerate()
            .filter(|(_, &id)| cpu.engine().is_high(id))
            .map(|(i, _)| LINE_NAMES[i].split_once('_').map_or(LINE_NAMES[i], |(_, n)| n))
            .filter(|n| matches!(*n, "SRS" | "SUMS" | "ANDS" | "ORS" | "EORS" | "ADDSB7" | "ADDSB06" | "SBAC" | "ACSB" | "SBDB" | "SBADD" | "DBADD" | "DL/DB"))
            .collect();
        let i = cpu.internals().expect("the netlist names the internal buses");
        let r = cpu.registers();
        println!(
            "h={h:3} clk0={} ab={:04x} db={:02x} rw={} sync={} | a={:02x} p={:02x} add={:02x} ai={:02x} bi={:02x} sb={:02x} cin={} | {}",
            pf.clk0 as u8, pf.ab, pf.db, pf.rw as u8, pf.sync as u8,
            r.a, r.p, i.alu, i.alua, i.alub, i.sb,
            cpu.engine().is_high(alucin) as u8,
            on.join(" ")
        );
    }
}
