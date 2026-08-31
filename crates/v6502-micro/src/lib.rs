//! Rung 3 of the engine ladder: no nodes. A cycle-accurate state machine
//! whose control tables are MEASURED out of rung 0 at build time
//! (`build.rs`, which is why `v6502-sim` is a build-dependency and nothing
//! is one at run time), with the parts that cannot be measured authored
//! and labelled (`docs/engine-ladder.md`, "Rung 3").
//!
//! This is the latency rung: the other rungs settle a network per
//! half-cycle, this one looks a vector up. What is held is the same pin
//! contract as everything else on the ladder.
//!
//! Layers, in the order they were built:
//!   - `lines`: the vector's columns and the selector-bit meanings, authored.
//!   - `table` (generated): the measured spans, one per (opcode, selector
//!     key), plus the reset tail. Never committed; NC-SA-derived like
//!     `v6502-compiled`'s kernel.

#![forbid(unsafe_code)]

pub mod lines;

pub mod table {
    include!(concat!(env!("OUT_DIR"), "/table.rs"));

    /// The span for one opcode under one selector key. The key is masked
    /// to the bits the recorder proved this opcode cares about, so an
    /// irrelevant bit (the carry, for most) cannot miss. None only where a
    /// relevant combination was never recorded, which the coverage test
    /// exists to keep empty (the caller refuses rather than guesses).
    pub fn span(op: u8, key: u8) -> Option<&'static [u64]> {
        let (first, count) = OPS[op as usize];
        let vs = &VARIANTS[first..first + count];
        let k = key & MASKS[op as usize];
        vs.iter().find(|(vk, ..)| *vk == k).map(|&(_, off, len, _)| &SPANS[off..off + len])
    }

    pub fn is_kil(op: u8) -> bool {
        KILS.contains(&op)
    }
}
