//! What rung 0 does when RES is asserted mid-run: the control vector, the
//! pins and the datapath internals, per half-cycle, through the window the
//! `fixture-reset-mid-run` pin trace covers.
//!
//! This is the measurement rung 3's reset authoring is written from. The
//! fixture showed three cycles of freewheel between the in-flight BRK and
//! the warm reset sequence (addresses 0200 without sync, 5801, 0057, then
//! a sync at 00ff); which control lines produce those addresses cannot be
//! guessed from the pins, so this prints them, through the same line list
//! the recorder uses (`v6502-micro/src/lines.rs`, included by path so the
//! two cannot drift).
//!
//!   cargo run --release -p v6502-sim --example reset-probe
//!   cargo run --release -p v6502-sim --example reset-probe -- 10 60

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
        (a.first().copied().unwrap_or(14), a.get(1).copied().unwrap_or(50))
    };

    // The fixture's image: CLI NOP NOP BRK at 0200, a JMP loop at 0300 on
    // both vectors, reset vector 0200 (tools/pin-golden/fixture-reset-mid-run.pins).
    let mut mem = FlatMemory::new();
    mem.load(0x0200, &[0x58, 0xea, 0xea, 0x00, 0xea, 0xea, 0xea, 0xea, 0xea, 0xea, 0xea, 0xea]);
    mem.load(0x0300, &[0x4c, 0x00, 0x03]);
    mem.load(0xfffa, &[0x00, 0x03]);
    mem.load(0xfffc, &[0x00, 0x02]);
    mem.load(0xfffe, &[0x00, 0x03]);
    let mut cpu = Cpu::new(Arc::new(v6502_netlist::mos6502()), mem).expect("signals resolve");
    cpu.power_cycle();

    let nl = cpu.engine().netlist();
    let ids: Vec<u16> =
        LINE_NAMES[..49].iter().map(|n| nl.node(n).unwrap_or_else(|| panic!("{n} is a node"))).collect();

    // The fixture's script: res low at h=20, back at h=28.
    for h in 0..=to {
        if h > 0 {
            cpu.set_res(!(20..28).contains(&(h - 1)));
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
            "h={h:3} clk0={} ab={:04x} db={:02x} rw={} sync={} res={} | pc={:04x} pclp={:02x} pchp={:02x} s={:02x} ir={:02x} dl={:02x} dor={:02x} add={:02x} ai={:02x} bi={:02x} sb={:02x} idb={:02x} adl={:02x} adh={:02x} | {}",
            pf.clk0 as u8, pf.ab, pf.db, pf.rw as u8, pf.sync as u8, pf.res as u8,
            r.pc, i.pclp, i.pchp, r.s, r.ir, i.idl, i.dor, i.alu, i.alua, i.alub,
            i.sb, i.idb, i.adl, i.adh,
            on.join(" ")
        );
    }
}
