//! What rung 0 does in decimal mode: the control vector and the datapath
//! latches through a chain of BCD operations, which is the measurement
//! rung 3's decimal authoring is written from (the same method as
//! `reset-probe`). The interesting columns are `#DAA` and `#DSA`, the two
//! active-low decimal-adjust enables, and what the ADD register holds
//! against the binary and the adjusted sums.
//!
//!   cargo run --release -p v6502-sim --example decimal-probe
//!   cargo run --release -p v6502-sim --example decimal-probe -- 0 40

use std::sync::Arc;

use v6502_sim::bus::FlatMemory;
use v6502_sim::cpu::Cpu;
use v6502_pins::PinEngine;

#[allow(dead_code)]
mod lines {
    include!("../../v6502-micro/src/lines.rs");
}
use lines::LINE_NAMES;

fn main() {
    let (from, to) = {
        let a: Vec<u64> = std::env::args().skip(1).filter_map(|s| s.parse().ok()).collect();
        (a.first().copied().unwrap_or(0), a.get(1).copied().unwrap_or(44))
    };

    // The decimal-adc fixture's opening: SED CLC LDA #$19 ADC #$28 STA $80
    // PHP, then more (tools/pin-golden/decimal-adc.pins carries the whole).
    let mut mem = FlatMemory::new();
    mem.load(0x0200, &[0xf8, 0x18, 0xa9, 0x19, 0x69, 0x28, 0x85, 0x80, 0x08,
                       0xa9, 0x09, 0x69, 0x01, 0x85, 0x81, 0x08]);
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
        if h < from {
            continue;
        }
        let pf = PinEngine::pins(&cpu);
        let on: Vec<&str> = ids
            .iter()
            .enumerate()
            .filter(|(_, &id)| cpu.engine().is_high(id))
            .map(|(i, _)| {
                let full = LINE_NAMES[i];
                full.split_once('_').map_or(full, |(_, n)| n)
            })
            .collect();
        let i = cpu.internals().expect("the netlist names the internal buses");
        let r = cpu.registers();
        println!(
            "h={h:3} clk0={} ab={:04x} db={:02x} rw={} sync={} | a={:02x} p={:02x} add={:02x} ai={:02x} bi={:02x} sb={:02x} idb={:02x} dl={:02x} cin={} | {}",
            pf.clk0 as u8, pf.ab, pf.db, pf.rw as u8, pf.sync as u8,
            r.a, r.p, i.alu, i.alua, i.alub, i.sb, i.idb, i.idl,
            cpu.engine().is_high(alucin) as u8,
            on.join(" ")
        );
    }
}
