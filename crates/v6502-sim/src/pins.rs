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
    cpu.bus.armed = false;
    PinEngine::power_cycle(cpu);
    cpu.bus.armed = true;
    let (r, i, n, y, s) = v6502_pins::IDLE_INPUTS;
    cpu.set_inputs(r, i, n, y, s);
    run_on_record(cpu, 0, steps, stim)
}

/// The comparison loop shared by a whole record and a window: from the
/// chip as it stands at `from` (the record's `h`), `steps` half-steps,
/// the stimulus applied by `h`, the chip's frame held to the record's
/// after every step. The bus follows the chip's count by itself
/// (`Bus::half_step`).
#[cfg(feature = "mos6502")]
fn run_on_record(cpu: &mut Cpu<crate::recorded::RecordedBus>, from: u64, steps: u64, stim: &[v6502_pins::Stim]) -> Replayed {
    use v6502_pins::PinEngine as _;
    let mut frames = Vec::with_capacity(steps as usize + 1);
    frames.push(cpu.pins());
    let mut next = 0usize;
    for k in 0..=steps {
        let h = from + k;
        let Some(expected) = cpu.bus.frame_at(h) else {
            return Replayed::Refused(
                crate::recorded::Refusal { h, what: "a half-cycle outside the record", addr: 0, value: 0, frame: v6502_pins::PinFrame { h, ..Default::default() } },
                frames,
            );
        };
        let got = frames[k as usize];
        if let Some(field) = crate::recorded::first_difference_under_record(&expected, &got) {
            return Replayed::Differs { h, field, expected, got, frames };
        }
        if k == steps {
            break;
        }
        while next < stim.len() && stim[next].h <= h {
            let st = stim[next];
            cpu.set_inputs(st.res, st.irq, st.nmi, st.rdy, st.so);
            next += 1;
        }
        PinEngine::half_step(cpu);
        frames.push(cpu.pins());
        if let Some(r) = cpu.bus.refusal.clone() {
            return Replayed::Refused(r, frames);
        }
    }
    Replayed::Agrees { steps, held_reads: cpu.bus.held_reads }
}

/// Rung 0 standing inside a window: the bus is the window's frames from
/// its origin, the shadow its fill and pages, and the chip is RESTORED
/// to the window's machine value rather than reset (`crate::state`).
#[cfg(feature = "mos6502")]
pub fn rung0_window(w: &v6502_pins::Window) -> Result<Cpu<crate::recorded::RecordedBus>, String> {
    let bus = crate::recorded::RecordedBus::window(w.frames.clone(), w.origin, w.fill, &w.pages);
    let nl = std::sync::Arc::new(v6502_netlist::mos6502());
    let (nodes, transistors) = (nl.node_count(), nl.transistor_count());
    let mut cpu = Cpu::new(nl, bus).expect("the embedded 6502 netlist has every required signal");
    let fetch = w.state.fetch.map(|(addr, opcode)| crate::cpu::Fetch { addr, opcode });
    let st = crate::state::MachineState::from_hex(nodes, transistors, &w.state.value, &w.state.pullup, &w.state.pulldown, &w.state.trans_on, w.state.half_cycle, fetch)?;
    crate::state::restore(&mut cpu, &st);
    Ok(cpu)
}

/// A window run against its own frames: `steps` half-steps from the
/// origin (bounded by the window's length), the window's stimulus
/// applied, every frame compared.
#[cfg(feature = "mos6502")]
pub fn run_window(cpu: &mut Cpu<crate::recorded::RecordedBus>, w: &v6502_pins::Window, steps: u64) -> Replayed {
    let steps = steps.min(w.frames.len().saturating_sub(1) as u64);
    run_on_record(cpu, w.origin, steps, &w.stim)
}

/// Cut a window `from..=to` (extended by one if `to` is a phi1 frame, so
/// the window ends on a phi2) out of a whole record: rung 0 runs the record
/// from reset to `from` (refusing if it parts from the record on the
/// way), its machine value and shadow are taken there, and the frames
/// and the inputs in force through the window are copied. The stimulus
/// is derived from the frames as the console's tool derives it: an input
/// first seen in frame h was driven at h - 1, and the levels in force at
/// the origin are written at the origin.
#[cfg(feature = "mos6502")]
pub fn cut_window(name: &str, trace: &v6502_pins::Trace, stim: &[v6502_pins::Stim], from: u64, to: u64) -> Result<v6502_pins::Window, String> {
    if from >= to || to as usize >= trace.frames.len() {
        return Err(format!("a window {from}..={to} does not fit a record of {} frames", trace.frames.len()));
    }
    // A window ends on a phi2 frame (clk0 high), so no cycle is left half
    // done: a reader pairing each phi1 with its phi2 finds the pair, which
    // is the rule the halfshot page and its validator hold a recording to.
    let to = if !trace.frames[to as usize].clk0 && (to as usize) + 1 < trace.frames.len() { to + 1 } else { to };
    let mut cpu = rung0_recorded(trace.frames.clone(), &trace.header.loads, trace.header.reset_vector);
    match run_recorded(&mut cpu, from, stim) {
        Replayed::Agrees { .. } => {}
        Replayed::Refused(r, _) => return Err(format!("rung 0 parts from the record before the window: the bus refused at {r}")),
        Replayed::Differs { h, field, .. } => return Err(format!("rung 0 parts from the record before the window: h={h} in {field}")),
    }
    let st = crate::state::snapshot(&cpu);
    let hex = st.chip_hex();
    let shadow = cpu.bus.shadow();
    let mut pages = Vec::new();
    for id in 0..=255u8 {
        let page = &shadow[id as usize * 256..(id as usize + 1) * 256];
        if page.iter().any(|&b| b != 0) {
            pages.push((id, page.to_vec()));
        }
    }
    let frames: Vec<v6502_pins::PinFrame> = trace.frames[from as usize..=to as usize].to_vec();
    let mut wstim = Vec::new();
    let mut last: Option<(bool, bool, bool, bool, bool)> = None;
    for f in &frames[1..] {
        let now = (f.res, f.irq, f.nmi, f.rdy, f.so);
        if last != Some(now) {
            wstim.push(v6502_pins::Stim { h: f.h - 1, res: f.res, irq: f.irq, nmi: f.nmi, rdy: f.rdy, so: f.so });
            last = Some(now);
        }
    }
    Ok(v6502_pins::Window {
        name: name.to_string(),
        record: trace.header.stamp.clone(),
        origin: from,
        state: v6502_pins::WindowState {
            value: hex[0].clone(),
            pullup: hex[1].clone(),
            pulldown: hex[2].clone(),
            trans_on: hex[3].clone(),
            half_cycle: st.half_cycle,
            fetch: st.last_fetch.map(|f| (f.addr, f.opcode)),
        },
        fill: 0,
        pages,
        stim: wstim,
        frames,
    })
}
