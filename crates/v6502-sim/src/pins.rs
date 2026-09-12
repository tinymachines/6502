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

/// Rung 0 on a record instead of a memory image (`crate::recorded`): the
/// chip runs the program the record carries, and answers to it. The loads
/// and the reset vector serve the reset sequence only. The driver is
/// `run_recorded`.
#[cfg(feature = "mos6502")]
pub fn rung0_recorded(frames: Vec<v6502_pins::PinFrame>, loads: &[v6502_pins::Load], reset_vector: u16) -> Cpu<crate::recorded::RecordedBus> {
    let bus = crate::recorded::RecordedBus::new(frames, loads, reset_vector);
    Cpu::new(std::sync::Arc::new(v6502_netlist::mos6502()), bus)
        .expect("the embedded 6502 netlist has every required signal")
}

/// The outcome of a run under a record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Replayed {
    /// Every frame up to `steps` agreed by the record's rule.
    Agrees { steps: u64, held_reads: u64 },
    /// The bus refused a service: the chip asked for what the record does
    /// not show. Carries the frames produced so far.
    Refused(crate::recorded::Refusal, Vec<v6502_pins::PinFrame>),
    /// The chip's pins differ from the record at `h` in `field`.
    Differs { h: u64, field: &'static str, expected: v6502_pins::PinFrame, got: v6502_pins::PinFrame, frames: Vec<v6502_pins::PinFrame> },
}

/// `v6502_pins::run` under a record: the same driver (power cycle, idle
/// inputs, the stimulus applied by `h`), with the bus told which frame each
/// half-step produces and the chip's frame compared with the record's after
/// every step, so a run stops at the first half-cycle that differs rather
/// than at the end. `steps` is bounded by the record's length.
#[cfg(feature = "mos6502")]
pub fn run_recorded(cpu: &mut Cpu<crate::recorded::RecordedBus>, steps: u64, stim: &[v6502_pins::Stim]) -> Replayed {
    use v6502_pins::PinEngine as _;
    let steps = steps.min(cpu.bus.frames().len().saturating_sub(1) as u64);
    cpu.bus.at = None;
    PinEngine::power_cycle(cpu);
    let (r, i, n, y, s) = v6502_pins::IDLE_INPUTS;
    cpu.set_inputs(r, i, n, y, s);
    let mut frames = Vec::with_capacity(steps as usize + 1);
    frames.push(cpu.pins());
    let mut next = 0usize;
    for h in 0..=steps {
        let expected = cpu.bus.frames()[h as usize];
        let got = frames[h as usize];
        if let Some(field) = crate::recorded::first_difference_under_record(&expected, &got) {
            return Replayed::Differs { h, field, expected, got, frames };
        }
        if h == steps {
            break;
        }
        while next < stim.len() && stim[next].h <= h {
            let st = stim[next];
            cpu.set_inputs(st.res, st.irq, st.nmi, st.rdy, st.so);
            next += 1;
        }
        cpu.bus.at = Some(h + 1);
        PinEngine::half_step(cpu);
        frames.push(cpu.pins());
        if let Some(r) = cpu.bus.refusal.clone() {
            return Replayed::Refused(r, frames);
        }
    }
    Replayed::Agrees { steps, held_reads: cpu.bus.held_reads }
}
