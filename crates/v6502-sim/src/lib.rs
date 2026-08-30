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
//! - [`rows`] — the trace as columnar rows, one packer for every consumer.
//!
//! # Example
//!
//! ```no_run
//! use std::sync::Arc;
//! use v6502_netlist::mos6502;
//! use v6502_sim::{bus::FlatMemory, cpu::Cpu};
//!
//! let mut mem = FlatMemory::new();
//! mem.load(0x0000, &[0xa9, 0x42]); // LDA #$42
//! mem.set_reset_vector(0x0000);
//!
//! let mut cpu = Cpu::new(Arc::new(mos6502()), mem)?;
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
pub mod history;
pub mod pins;
pub mod rows;
pub mod state;
pub mod timing;

// The types are halfphi's and always available; only the chip is optional.
pub use halfphi::netlist::{Netlist, NodeId, TransId};

/// The 6502's own netlist, decoded from die data embedded at build time.
///
/// Behind the default `mos6502` feature, because that data is CC BY-NC-SA and
/// travels into anything that ships it. Without the feature this crate is a
/// clock, a bus and a timing readout with no chip in them, and a netlist
/// arrives through `Cpu::new` from wherever the caller got one.
#[cfg(feature = "mos6502")]
pub use v6502_netlist::mos6502;

pub use bus::{Bus, FlatMemory};
pub use cpu::{BusState, Cpu, CycleState, InternalNodes, Internals, ReadWrite, Registers, Signals};
// The solver lives in `halfphi`; re-exported so this crate's callers are
// unaffected by where it moved to.
pub use halfphi::engine::{ChipState, Drive, Engine, Stats};
pub use history::{History, RewindError};
pub use v6502_pins::{PinEngine, PinFrame};
pub use timing::{Hidden, Phase, StoreData, TimingState};

#[cfg(feature = "mos6502")]
use std::sync::Arc;

/// Build a 6502 attached to 64 KiB of RAM, with `program` loaded at
/// `load_addr` and the reset vector pointing at it. Already reset and ready to
/// step.
///
/// Needs the `mos6502` feature: it is the embedded netlist that makes this a
/// one-line convenience rather than a two-line one.
#[cfg(feature = "mos6502")]
pub fn boot(load_addr: u16, program: &[u8]) -> Cpu<FlatMemory> {
    let mut mem = FlatMemory::new();
    mem.load(load_addr, program);
    mem.set_reset_vector(load_addr);
    let mut cpu = Cpu::new(Arc::new(mos6502()), mem)
        .expect("the embedded 6502 netlist has every required signal");
    cpu.reset();
    cpu
}
