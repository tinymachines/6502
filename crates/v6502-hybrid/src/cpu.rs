//! The 6502 clock and bus layer over the hybrid engine: the same sequence as
//! `v6502_sim::Cpu`, call for call, because the pin contract's `db` is defined
//! by where in the half-cycle the bus is serviced.

use std::sync::Arc;

use halfphi::netlist::NodeId;
use v6502_netlist::mos6502;
use v6502_pins::{Load, PinEngine, PinFrame};
use v6502_sim::bus::{Bus, FlatMemory};
use v6502_sim::cpu::{Fetch, Signals};

use crate::engine::{HybridEngine, HybridNetlist};

pub struct HybridCpu<B: Bus> {
    engine: HybridEngine,
    sig: Signals,
    pub bus: B,
    half_cycle: u64,
    last_fetch: Option<Fetch>,
}

impl<B: Bus> HybridCpu<B> {
    pub fn new(hn: Arc<HybridNetlist>, bus: B) -> Self {
        let sig = Signals::resolve(hn.netlist()).expect("the 6502 netlist names every signal");
        HybridCpu { engine: HybridEngine::new(hn), sig, bus, half_cycle: 0, last_fetch: None }
    }

    /// Rung 1 built from what a `.pins` header says, the way
    /// `v6502_sim::pins::rung0` builds rung 0.
    pub fn rung1(loads: &[Load], reset_vector: u16) -> HybridCpu<FlatMemory> {
        let mut mem = FlatMemory::new();
        for l in loads {
            mem.load(l.org, &l.bytes);
        }
        mem.set_reset_vector(reset_vector);
        HybridCpu::new(Arc::new(HybridNetlist::new(Arc::new(mos6502()))), mem)
    }

    pub fn engine(&self) -> &HybridEngine {
        &self.engine
    }
    pub fn engine_mut(&mut self) -> &mut HybridEngine {
        &mut self.engine
    }
    pub fn signals(&self) -> &Signals {
        &self.sig
    }
    pub fn half_cycle(&self) -> u64 {
        self.half_cycle
    }
    pub fn set_half_cycle(&mut self, hc: u64) {
        self.half_cycle = hc;
    }
    pub fn last_fetch(&self) -> Option<Fetch> {
        self.last_fetch
    }
    pub fn set_last_fetch(&mut self, f: Option<Fetch>) {
        self.last_fetch = f;
    }

    /// `v6502_sim::Cpu::reset`, step for step.
    pub fn reset(&mut self) {
        self.last_fetch = None;
        self.engine.force_power_on_state();
        self.engine.drive_low(self.sig.res);
        self.engine.drive_low(self.sig.clk0);
        self.engine.drive_high(self.sig.rdy);
        self.engine.drive_low(self.sig.so);
        self.engine.drive_high(self.sig.irq);
        self.engine.drive_high(self.sig.nmi);
        self.engine.settle_all();
        for _ in 0..8 {
            self.engine.drive_high(self.sig.clk0);
            self.engine.drive_low(self.sig.clk0);
        }
        self.engine.drive_high(self.sig.res);
        for _ in 0..18 {
            self.half_step();
        }
        self.half_cycle = 0;
    }

    pub fn power_cycle(&mut self) {
        self.engine.restore_layout_pulls();
        self.reset();
    }

    pub fn half_step(&mut self) {
        if self.engine.is_high(self.sig.clk0) {
            self.engine.drive_low(self.sig.clk0);
            self.service_read();
        } else {
            self.engine.drive_high(self.sig.clk0);
            self.service_write();
        }
        self.half_cycle += 1;
    }

    fn service_read(&mut self) {
        if self.engine.is_high(self.sig.rw) {
            let addr = self.address_bus();
            let data = self.bus.read(addr);
            // `sync` marks this read as an opcode fetch, latched exactly as
            // rung 0 latches it, so the machine value's `last_fetch` is the
            // same bookkeeping on either rung.
            if self.engine.is_high(self.sig.sync) {
                self.last_fetch = Some(Fetch { addr, opcode: data });
            }
            for i in 0..8 {
                self.engine.set_pull(self.sig.db[i], value_bit(data, i));
            }
            let db = self.sig.db;
            self.engine.settle(&db);
        }
    }

    fn service_write(&mut self) {
        if !self.engine.is_high(self.sig.rw) {
            let addr = self.address_bus();
            let data = self.data_bus();
            self.bus.write(addr, data);
        }
    }

    fn drive(&mut self, n: NodeId, level: bool) {
        if level {
            self.engine.drive_high(n);
        } else {
            self.engine.drive_low(n);
        }
    }

    pub fn address_bus(&self) -> u16 {
        self.engine.read_bus(&self.sig.ab) as u16
    }
    pub fn data_bus(&self) -> u8 {
        self.engine.read_bus(&self.sig.db) as u8
    }
    pub fn rw_is_read(&self) -> bool {
        self.engine.is_high(self.sig.rw)
    }
    pub fn sync(&self) -> bool {
        self.engine.is_high(self.sig.sync)
    }
    pub fn clk0(&self) -> bool {
        self.engine.is_high(self.sig.clk0)
    }
    pub fn state_string(&self) -> String {
        self.engine.state_string()
    }
}

#[inline]
fn value_bit(v: u8, i: usize) -> bool {
    v >> i & 1 != 0
}

impl<B: Bus> PinEngine for HybridCpu<B> {
    fn power_cycle(&mut self) {
        HybridCpu::power_cycle(self);
    }
    fn set_inputs(&mut self, res: bool, irq: bool, nmi: bool, rdy: bool, so: bool) {
        self.drive(self.sig.res, res);
        self.drive(self.sig.irq, irq);
        self.drive(self.sig.nmi, nmi);
        self.drive(self.sig.rdy, rdy);
        self.drive(self.sig.so, so);
    }
    fn half_step(&mut self) {
        HybridCpu::half_step(self);
    }
    fn pins(&self) -> PinFrame {
        let e = &self.engine;
        let s = &self.sig;
        PinFrame {
            h: self.half_cycle,
            clk0: self.clk0(),
            ab: self.address_bus(),
            db: self.data_bus(),
            rw: self.rw_is_read(),
            sync: self.sync(),
            res: e.is_high(s.res),
            irq: e.is_high(s.irq),
            nmi: e.is_high(s.nmi),
            rdy: e.is_high(s.rdy),
            so: e.is_high(s.so),
        }
    }
    fn h(&self) -> u64 {
        self.half_cycle
    }
}
