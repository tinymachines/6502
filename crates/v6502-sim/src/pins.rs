//! Rung 0 of the engine ladder: the switch-level `Cpu` at its pins.
//!
//! This is the adapter the pin golden is recorded from, so it reads the pins
//! through the accessors the rest of the crate already uses (`address_bus`,
//! `data_bus`, `rw`, `sync`, `clk0`) rather than looking at nodes itself: if
//! those accessors are wrong, the golden test against the reference says so
//! first. The five inputs are read back from their own nodes, which are
//! driven by pull and therefore read as driven.
//!
//! `db` is whatever is on D0..D7 after the step, which is the serviced value:
//! a read is serviced as `clk0` falls and a write as it rises, inside
//! `half_step`.

use crate::bus::Bus;
use crate::cpu::{Cpu, ReadWrite};
use v6502_pins::{PinEngine, PinFrame};

impl<B: Bus> PinEngine for Cpu<B> {
    fn power_cycle(&mut self) {
        Cpu::power_cycle(self);
    }

    fn set_inputs(&mut self, res: bool, irq: bool, nmi: bool, rdy: bool, so: bool) {
        self.set_res(res);
        self.set_irq(irq);
        self.set_nmi(nmi);
        self.set_rdy(rdy);
        self.set_so(so);
    }

    fn half_step(&mut self) {
        Cpu::half_step(self);
    }

    fn pins(&self) -> PinFrame {
        let e = self.engine();
        let s = self.signals();
        PinFrame {
            h: self.half_cycle(),
            clk0: self.clk0(),
            ab: self.address_bus(),
            db: self.data_bus(),
            rw: self.rw() == ReadWrite::Read,
            sync: self.sync(),
            res: e.is_high(s.res),
            irq: e.is_high(s.irq),
            nmi: e.is_high(s.nmi),
            rdy: e.is_high(s.rdy),
            so: e.is_high(s.so),
        }
    }

    fn h(&self) -> u64 {
        self.half_cycle()
    }
}

/// One line saying which build recorded a trace: the crate version and the
/// size of the netlist it ran. Not a digest (nothing here computes one); it
/// is enough to tell a trace from one crate version and die-data export apart
/// from another, and it is labelled as what it is.
pub fn stamp<B: Bus>(cpu: &Cpu<B>) -> String {
    let nl = cpu.engine().netlist();
    format!(
        "v6502-sim {} nodes {} transistors {}",
        env!("CARGO_PKG_VERSION"),
        nl.node_count(),
        nl.transistor_count()
    )
}

/// Rung 0 built from what a `.pins` header says: 64 KiB of RAM with each
/// `# load` placed and the reset vector set, before the reset sequence runs.
/// The recorder and every replay test go through this one function, so a
/// trace cannot be recorded from one memory image and replayed against
/// another.
#[cfg(feature = "mos6502")]
pub fn rung0(loads: &[v6502_pins::Load], reset_vector: u16) -> Cpu<crate::bus::FlatMemory> {
    let mut mem = crate::bus::FlatMemory::new();
    for l in loads {
        mem.load(l.org, &l.bytes);
    }
    mem.set_reset_vector(reset_vector);
    Cpu::new(std::sync::Arc::new(v6502_netlist::mos6502()), mem)
        .expect("the embedded 6502 netlist has every required signal")
}
