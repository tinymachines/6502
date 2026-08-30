//! Rung 1 of the engine ladder: the switch-level solver with the recognised
//! gates folded out of the group walk.
//!
//! `halfphi::Engine` settles the chip by rebuilding, for each queued node,
//! the group of nodes shorted to it through conducting transistors and taking
//! the maximum drive over the group. On the 6502 most of what that walk
//! touches is a gate's own pulldown network: a decode term has dozens of
//! pulldown transistors on its output, every one of them is probed on every
//! walk, and none of them ever leads anywhere but a junction or vss.
//!
//! This engine keeps the queue, the seeds, the queue order, the drive
//! lattice and the write set of the scalar solver exactly, and changes one
//! thing: at a gate output the pulldown network is not walked. Two counters
//! per output, maintained where transistors toggle, say how many
//! straight-to-ground pulldowns and how many series tops are conducting, so
//! "is this output pulled to ground" is a comparison and the walk only goes
//! into the network when a series top is actually on. Everything the scalar
//! walk would have found (a rail, a charged junction) is found here too, so
//! the resolved level is the same level, and `tests/lockstep.rs` holds every
//! node at every half-cycle to that.
//!
//! **Every node survives**, including the junctions inside series legs, and
//! `state_string()` is the reference's encoding, so the golden comparison
//! against the JavaScript engine can run against this rung unchanged.
//!
//! What it is built from: `v6502_netlist::schematic::Schematic::derive`, the
//! same recognition the schematic pages draw (1160 gates, 873 switches, one
//! node it cannot resolve, which stays in the switch network and is not
//! special-cased).

#![forbid(unsafe_code)]

pub mod cpu;
pub mod engine;
pub mod state;

pub use cpu::HybridCpu;
pub use engine::{HybridEngine, HybridNetlist, Stats};
