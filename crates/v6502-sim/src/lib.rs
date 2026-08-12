//! Transistor-level simulation of the MOS 6502.
//!
//! Every register value this crate reports is *derived*, not stored: the
//! accumulator is eight storage nodes read back out of the network, and the
//! cycle count is the number of times the clock node has been toggled. Nothing
//! models the 6502's behaviour — the behaviour falls out of 3510 switches.
//!
//! # Layers
//!
//! - [`engine`] — the chip-agnostic switch-level solver.
//! - [`cpu`] — clocking, the bus handshake, register and timing readout.
//! - [`timing`] — decoding the internal T-state chain.
//! - [`bus`] — what the CPU is attached to.
//! - [`history`] — keyframed rewind.
//!
//! # Example
//!
//! ```no_run
//! use std::sync::Arc;
//! use v6502_netlist::Netlist;
//! use v6502_sim::{bus::FlatMemory, cpu::Cpu};
//!
//! let mut mem = FlatMemory::new();
//! mem.load(0x0000, &[0xa9, 0x42]); // LDA #$42
//! mem.set_reset_vector(0x0000);
//!
//! let mut cpu = Cpu::new(Arc::new(Netlist::mos6502()), mem)?;
//! cpu.reset();
//! for _ in 0..20 {
//!     cpu.step_cycle();
//! }
//! println!("A = {:02x}", cpu.registers().a);
//! # Ok::<(), v6502_sim::cpu::MissingSignal>(())
//! ```

#![forbid(unsafe_code)]

pub mod bus;
pub mod cpu;
pub mod engine;
pub mod history;
pub mod timing;

pub use v6502_netlist::{Netlist, NodeId, TransId};

pub use bus::{Bus, FlatMemory};
pub use cpu::{BusState, Cpu, CycleState, ReadWrite, Registers, Signals};
pub use engine::{ChipState, Drive, Engine, Stats};
pub use history::{History, RewindError};
pub use timing::{Hidden, Phase, StoreData, TimingState};

use std::sync::Arc;

/// Build a 6502 attached to 64 KiB of RAM, with `program` loaded at
/// `load_addr` and the reset vector pointing at it. Already reset and ready to
/// step.
pub fn boot(load_addr: u16, program: &[u8]) -> Cpu<FlatMemory> {
    let mut mem = FlatMemory::new();
    mem.load(load_addr, program);
    mem.set_reset_vector(load_addr);
    let mut cpu = Cpu::new(Arc::new(Netlist::mos6502()), mem)
        .expect("the embedded 6502 netlist has every required signal");
    cpu.reset();
    cpu
}
