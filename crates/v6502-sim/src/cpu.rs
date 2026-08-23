//! The 6502 layer: clocking, bus protocol, and register/state readout.
//!
//! [`Engine`] knows nothing about processors. This module supplies the parts
//! that make it a CPU: a two-phase clock, the read/write handshake, and named
//! access to the state a debugger or visualiser wants.

use std::sync::Arc;

use halfphi::netlist::{Netlist, NodeId};

use crate::bus::Bus;
use halfphi::engine::Engine;
use crate::timing::{Phase, TimingNodes, TimingState};

/// A signal the 6502 layer requires was absent from the netlist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissingSignal(pub String);

impl std::fmt::Display for MissingSignal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "netlist has no signal `{}`", self.0)
    }
}

impl std::error::Error for MissingSignal {}

/// Node handles for every signal the CPU layer touches, resolved once at
/// construction so the hot path never does a string lookup.
#[derive(Clone, Debug)]
pub struct Signals {
    pub clk0: NodeId,
    pub rw: NodeId,
    pub sync: NodeId,
    pub res: NodeId,
    pub irq: NodeId,
    pub nmi: NodeId,
    pub rdy: NodeId,
    pub so: NodeId,

    pub ab: [NodeId; 16],
    pub db: [NodeId; 8],

    pub a: [NodeId; 8],
    pub x: [NodeId; 8],
    pub y: [NodeId; 8],
    pub s: [NodeId; 8],
    pub pcl: [NodeId; 8],
    pub pch: [NodeId; 8],
    pub ir: [NodeId; 8],
    /// Status bits. Index 5 is `None`: the 6502 has no bit-5 storage node.
    pub p: [Option<NodeId>; 8],

    pub timing: TimingNodes,
}

impl Signals {
    pub fn resolve(nl: &Netlist) -> Result<Self, MissingSignal> {
        let node = |name: &str| nl.node(name).ok_or_else(|| MissingSignal(name.to_string()));
        let bus = |prefix: &str| -> Result<[NodeId; 8], MissingSignal> {
            nl.bus::<8>(prefix).ok_or_else(|| MissingSignal(format!("{prefix}0..7")))
        };
        Ok(Signals {
            clk0: node("clk0")?,
            rw: node("rw")?,
            sync: node("sync")?,
            res: node("res")?,
            irq: node("irq")?,
            nmi: node("nmi")?,
            rdy: node("rdy")?,
            so: node("so")?,
            ab: nl.bus::<16>("ab").ok_or_else(|| MissingSignal("ab0..15".into()))?,
            db: bus("db")?,
            a: bus("a")?,
            x: bus("x")?,
            y: bus("y")?,
            s: bus("s")?,
            pcl: bus("pcl")?,
            pch: bus("pch")?,
            ir: bus("ir")?,
            p: [
                nl.node("p0"),
                nl.node("p1"),
                nl.node("p2"),
                nl.node("p3"),
                nl.node("p4"),
                None, // no bit 5 exists on the die
                nl.node("p6"),
                nl.node("p7"),
            ],
            timing: TimingNodes::resolve(nl)
                .ok_or_else(|| MissingSignal("timing chain (clock1/t2../VEC0..)".into()))?,
        })
    }
}

/// Architectural registers, recovered from storage nodes.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Registers {
    pub pc: u16,
    pub a: u8,
    pub x: u8,
    pub y: u8,
    /// Stack pointer (the low byte; the high byte is hardwired to `$01`).
    pub s: u8,
    /// Status. Bit 5 is reported as 1 -- it has no storage node, and reads as 1
    /// on real silicon.
    pub p: u8,
    /// Instruction register: the opcode currently executing.
    pub ir: u8,
}

impl Registers {
    /// Flags as `NV-BDIZC`, uppercase where set.
    pub fn flags_string(&self) -> String {
        const NAMES: [(u8, char, char); 8] = [
            (7, 'N', 'n'),
            (6, 'V', 'v'),
            (5, '-', '-'),
            (4, 'B', 'b'),
            (3, 'D', 'd'),
            (2, 'I', 'i'),
            (1, 'Z', 'z'),
            (0, 'C', 'c'),
        ];
        NAMES
            .iter()
            .map(|&(bit, hi, lo)| if self.p >> bit & 1 != 0 { hi } else { lo })
            .collect()
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ReadWrite {
    Read,
    Write,
}

/// The external bus as the outside world sees it.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct BusState {
    pub addr: u16,
    pub data: u8,
    pub rw: ReadWrite,
    /// High during the cycle that fetches an opcode.
    pub sync: bool,
}

/// Everything worth knowing at one instant, in one struct.
///
/// This is the unit a visualiser renders and a trace stores: it pairs the
/// architectural view (registers, bus) with the microarchitectural one (clock
/// phase, timing chain) so both stay consistent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CycleState {
    /// Clock phases since reset. The fundamental unit -- the chip does work on
    /// both edges, so counting whole cycles loses half the story.
    pub half_cycle: u64,
    /// Whole clock cycles since reset.
    pub cycle: u64,
    /// Level of the `clk0` input pin.
    pub clk0: bool,
    /// Internal clock phase, which is *not* simply `clk0` -- it lags through the
    /// on-die clock generator.
    pub phase: Phase,
    pub bus: BusState,
    pub regs: Registers,
    pub timing: TimingState,
}

/// The most recent opcode fetch: the opcode, and the address it came from.
///
/// Together these are enough to disassemble the instruction currently in
/// flight. The instruction register alone is not: by the time you read it, PC
/// has advanced past the operand bytes.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Fetch {
    pub addr: u16,
    pub opcode: u8,
}

/// A transistor-level 6502 wired to a bus.
pub struct Cpu<B: Bus> {
    engine: Engine,
    sig: Signals,
    pub bus: B,
    half_cycle: u64,
    last_fetch: Option<Fetch>,
}

impl<B: Bus> Cpu<B> {
    pub fn new(netlist: Arc<Netlist>, bus: B) -> Result<Self, MissingSignal> {
        let sig = Signals::resolve(&netlist)?;
        Ok(Cpu { engine: Engine::new(netlist), sig, bus, half_cycle: 0, last_fetch: None })
    }

    /// The most recent opcode fetch, or `None` if none has happened yet.
    pub fn last_fetch(&self) -> Option<Fetch> {
        self.last_fetch
    }

    /// Overwrite the fetch bookkeeping, for state restoration. The fetch is
    /// not silicon: it is the latched (address, opcode) pair a disassembler
    /// wants, so restoring a snapshot has to bring it along.
    pub fn set_last_fetch(&mut self, f: Option<Fetch>) {
        self.last_fetch = f;
    }

    pub fn engine(&self) -> &Engine {
        &self.engine
    }
    pub fn engine_mut(&mut self) -> &mut Engine {
        &mut self.engine
    }
    pub fn signals(&self) -> &Signals {
        &self.sig
    }
    pub fn half_cycle(&self) -> u64 {
        self.half_cycle
    }
    pub fn cycle(&self) -> u64 {
        self.half_cycle / 2
    }
    pub fn set_half_cycle(&mut self, hc: u64) {
        self.half_cycle = hc;
    }

    // -- reset ------------------------------------------------------------

    /// Bring the chip up, exactly as the reference implementation does:
    /// force everything low, settle the whole network, run eight clock pulses
    /// with `res` asserted, release `res`, then run 18 half-cycles so the reset
    /// sequence is underway before anyone looks.
    ///
    /// Loads from the bus during those 18 half-cycles, so install the program
    /// and reset vector first.
    ///
    /// This is a *warm* reset: node pull state carries over, including any pulls
    /// left on the data bus by a previous run. [`Cpu::power_cycle`] is the cold
    /// equivalent.
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

    /// Restore every node pull to the layout default, then reset. Use this to
    /// make repeated runs reproducible; `reset` alone inherits pull state from
    /// whatever ran before it.
    pub fn power_cycle(&mut self) {
        self.engine.restore_layout_pulls();
        self.reset();
    }

    // -- clocking ---------------------------------------------------------

    /// Advance one clock phase.
    ///
    /// The bus handshake is bound to clock edges the way the reference binds it:
    /// a read is serviced as `clk0` falls, a write as it rises. Reads therefore
    /// present data to the chip one phase before it latches them.
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

    /// Advance one whole clock cycle (two phases).
    pub fn step_cycle(&mut self) {
        self.half_step();
        self.half_step();
    }

    /// Run until the start of the next opcode fetch, i.e. until `sync` is high
    /// with `clk0` low. Returns the number of half-cycles taken.
    ///
    /// Bounded so a wedged chip (a `KIL` opcode, or a program in a tight
    /// stall) cannot hang the caller.
    pub fn step_instruction(&mut self, max_half_cycles: u64) -> Option<u64> {
        let start = self.half_cycle;
        self.half_step();
        while !(self.engine.is_high(self.sig.sync) && !self.engine.is_high(self.sig.clk0)) {
            if self.half_cycle - start >= max_half_cycles {
                return None;
            }
            self.half_step();
        }
        Some(self.half_cycle - start)
    }

    fn service_read(&mut self) {
        if self.engine.is_high(self.sig.rw) {
            let addr = self.address_bus();
            let data = self.bus.read(addr);
            // `sync` marks this read as an opcode fetch. Latch it here: a caller
            // that steps in batches would otherwise have to sample at exactly
            // the right phase to catch it, and would silently miss fetches.
            if self.engine.is_high(self.sig.sync) {
                self.last_fetch = Some(Fetch { addr, opcode: data });
            }
            self.write_data_bus(data);
        }
    }

    fn service_write(&mut self) {
        if !self.engine.is_high(self.sig.rw) {
            let addr = self.address_bus();
            let data = self.data_bus();
            self.bus.write(addr, data);
        }
    }

    /// Drive all eight data lines, then settle once.
    ///
    /// Settling per bit would expose the chip to a partially-updated bus, which
    /// can latch a value that never existed on a real device.
    fn write_data_bus(&mut self, value: u8) {
        for i in 0..8 {
            self.engine.set_pull(self.sig.db[i], value >> i & 1 != 0);
        }
        let db = self.sig.db;
        self.engine.settle(&db);
    }

    // -- input pins -------------------------------------------------------

    /// Set `res`. Active low: `false` asserts reset.
    pub fn set_res(&mut self, level: bool) {
        self.drive(self.sig.res, level);
    }
    /// Set `irq`. Active low.
    pub fn set_irq(&mut self, level: bool) {
        self.drive(self.sig.irq, level);
    }
    /// Set `nmi`. Active low, edge triggered.
    pub fn set_nmi(&mut self, level: bool) {
        self.drive(self.sig.nmi, level);
    }
    /// Set `rdy`. Low stalls the CPU on read cycles.
    pub fn set_rdy(&mut self, level: bool) {
        self.drive(self.sig.rdy, level);
    }
    /// Set `so` (set overflow).
    pub fn set_so(&mut self, level: bool) {
        self.drive(self.sig.so, level);
    }

    fn drive(&mut self, n: NodeId, level: bool) {
        if level {
            self.engine.drive_high(n);
        } else {
            self.engine.drive_low(n);
        }
    }

    // -- observation ------------------------------------------------------

    pub fn address_bus(&self) -> u16 {
        self.engine.read_bus(&self.sig.ab) as u16
    }
    pub fn data_bus(&self) -> u8 {
        self.engine.read_bus(&self.sig.db) as u8
    }
    pub fn rw(&self) -> ReadWrite {
        if self.engine.is_high(self.sig.rw) {
            ReadWrite::Read
        } else {
            ReadWrite::Write
        }
    }
    pub fn sync(&self) -> bool {
        self.engine.is_high(self.sig.sync)
    }
    pub fn clk0(&self) -> bool {
        self.engine.is_high(self.sig.clk0)
    }

    /// Internal clock phase, read from the on-die phase-1 node rather than
    /// inferred from the input pin.
    pub fn phase(&self) -> Phase {
        if self.engine.is_high(self.sig.timing.cp1()) {
            Phase::Phi1
        } else {
            Phase::Phi2
        }
    }

    pub fn registers(&self) -> Registers {
        Registers {
            pc: ((self.engine.read_bus(&self.sig.pch) as u16) << 8)
                | self.engine.read_bus(&self.sig.pcl) as u16,
            a: self.engine.read_bus(&self.sig.a) as u8,
            x: self.engine.read_bus(&self.sig.x) as u8,
            y: self.engine.read_bus(&self.sig.y) as u8,
            s: self.engine.read_bus(&self.sig.s) as u8,
            p: self.status(),
            ir: self.engine.read_bus(&self.sig.ir) as u8,
        }
    }

    fn status(&self) -> u8 {
        // Bit 5 has no storage node. Real silicon presents it as 1, so do that
        // rather than leave a hole that looks like a cleared flag.
        let mut p = 0x20;
        for (bit, node) in self.sig.p.iter().enumerate() {
            if let Some(n) = node {
                if self.engine.is_high(*n) {
                    p |= 1 << bit;
                }
            }
        }
        p
    }

    pub fn bus_state(&self) -> BusState {
        BusState {
            addr: self.address_bus(),
            data: self.data_bus(),
            rw: self.rw(),
            sync: self.sync(),
        }
    }

    pub fn timing(&self) -> TimingState {
        TimingState::read(&self.sig.timing, |n| self.engine.is_high(n))
    }

    /// A complete, consistent snapshot of the observable state.
    pub fn observe(&self) -> CycleState {
        CycleState {
            half_cycle: self.half_cycle,
            cycle: self.half_cycle / 2,
            clk0: self.clk0(),
            phase: self.phase(),
            bus: self.bus_state(),
            regs: self.registers(),
            timing: self.timing(),
        }
    }

    /// Per-node state in the reference's `x/g/v/l/h` encoding, for differential
    /// testing against the original implementation.
    pub fn state_string(&self) -> String {
        self.engine.state_string()
    }
}
