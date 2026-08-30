//! Snapshot and restore for rung 1, in rung 0's own value.
//!
//! `v6502_sim::state::MachineState` is the machine as it travels: the four
//! bitsets, the half-cycle counter and the fetch bookkeeping. Rung 1 holds
//! the same four bitsets bit for bit (`tests/lockstep.rs`), so the SAME
//! value restores into either rung and the run continues identically. That
//! is what lets one console frame be answered by rung 0 and the next by
//! this rung: nothing rung-specific travels. `tests/state.rs` holds a
//! resume in both directions to every node at every half-cycle.
//!
//! The per-output counters this rung adds are derived from `trans_on` and
//! rebuilt on restore (`HybridEngine::restore_state`).

use v6502_sim::bus::Bus;
use v6502_sim::state::MachineState;

use crate::cpu::HybridCpu;

/// Take a snapshot, in the same shape rung 0's `snapshot` returns.
pub fn snapshot<B: Bus>(cpu: &HybridCpu<B>) -> MachineState {
    MachineState {
        half_cycle: cpu.half_cycle(),
        last_fetch: cpu.last_fetch(),
        chip: cpu.engine().chip_state(),
    }
}

/// Restore a snapshot, rung 0's or this rung's own, into any hybrid CPU
/// built on the same netlist.
pub fn restore<B: Bus>(cpu: &mut HybridCpu<B>, st: &MachineState) {
    cpu.engine_mut().restore_state(&st.chip);
    cpu.set_half_cycle(st.half_cycle);
    cpu.set_last_fetch(st.last_fetch);
}
