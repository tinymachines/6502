//! Time travel.
//!
//! Stepping backwards is what turns a simulator into an instrument. The
//! reference bought it by storing, at every half-cycle, a ~1.7 KB string of the
//! whole chip plus 512 bytes of RAM -- roughly 2 KB per phase, growing without
//! bound.
//!
//! Here the same capability costs ~1.1 KiB per *keyframe*, taken every `stride`
//! half-cycles, plus an O(1) bus checkpoint. Reaching an arbitrary point means
//! restoring the nearest earlier keyframe and re-simulating forward, which is
//! exact because the simulation is deterministic.

use std::collections::VecDeque;

use crate::bus::Bus;
use crate::cpu::Cpu;
use halfphi::engine::ChipState;

/// A restorable point in time.
#[derive(Clone, Debug)]
pub struct Keyframe {
    pub half_cycle: u64,
    chip: ChipState,
    /// Bus rewind token, if the attached bus supports it.
    bus_token: Option<Vec<u8>>,
}

/// A bounded ring of keyframes.
#[derive(Clone, Debug)]
pub struct History {
    stride: u64,
    capacity: usize,
    frames: VecDeque<Keyframe>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RewindError {
    /// The target is newer than the present.
    InFuture,
    /// The target predates the oldest retained keyframe.
    TooOld,
    /// The bus could not be rolled back, so memory would be inconsistent.
    BusNotRewindable,
}

impl std::fmt::Display for RewindError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RewindError::InFuture => write!(f, "target half-cycle is in the future"),
            RewindError::TooOld => write!(f, "target half-cycle predates retained history"),
            RewindError::BusNotRewindable => write!(f, "attached bus cannot be rolled back"),
        }
    }
}

impl std::error::Error for RewindError {}

impl History {
    /// Keep `capacity` keyframes, one every `stride` half-cycles. The reachable
    /// window is `stride * capacity` half-cycles; the worst-case cost of
    /// reaching a point inside it is `stride` half-cycles of re-simulation.
    pub fn new(stride: u64, capacity: usize) -> Self {
        assert!(stride > 0, "stride must be positive");
        assert!(capacity > 0, "capacity must be positive");
        History { stride, capacity, frames: VecDeque::with_capacity(capacity) }
    }

    pub fn len(&self) -> usize {
        self.frames.len()
    }
    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }
    pub fn stride(&self) -> u64 {
        self.stride
    }

    /// Oldest reachable half-cycle, if any history has been recorded.
    pub fn earliest(&self) -> Option<u64> {
        self.frames.front().map(|f| f.half_cycle)
    }

    pub fn clear(&mut self) {
        self.frames.clear();
    }

    /// Record a keyframe if the CPU is on a stride boundary. Call once per
    /// half-step; it is cheap to call and a no-op most of the time.
    pub fn maybe_capture<B: Bus>(&mut self, cpu: &mut Cpu<B>) {
        if cpu.half_cycle().is_multiple_of(self.stride) {
            self.capture(cpu);
        }
    }

    /// Record a keyframe unconditionally.
    pub fn capture<B: Bus>(&mut self, cpu: &mut Cpu<B>) {
        let half_cycle = cpu.half_cycle();
        // Re-capturing a point we already hold (after a rewind) would leave two
        // frames with the same timestamp and a stale successor chain.
        while self.frames.back().is_some_and(|f| f.half_cycle >= half_cycle) {
            self.frames.pop_back();
        }
        let bus_token = cpu.bus.checkpoint();
        let chip = cpu.engine().state().clone();
        if self.frames.len() == self.capacity {
            self.frames.pop_front();
        }
        self.frames.push_back(Keyframe { half_cycle, chip, bus_token });
    }

    /// Restore the CPU to `target`, re-simulating forward from the nearest
    /// earlier keyframe.
    ///
    /// On success the CPU is exactly as it was at that half-cycle -- chip state
    /// and memory both. History newer than `target` is discarded, so the caller
    /// can step forward again along a different path (after changing an input
    /// pin, say) without stale frames.
    pub fn rewind_to<B: Bus>(&mut self, cpu: &mut Cpu<B>, target: u64) -> Result<(), RewindError> {
        if target > cpu.half_cycle() {
            return Err(RewindError::InFuture);
        }

        let idx = self
            .frames
            .iter()
            .rposition(|f| f.half_cycle <= target)
            .ok_or(RewindError::TooOld)?;

        // Validate the bus rollback before touching chip state, so a failure
        // leaves the CPU untouched rather than half-restored.
        if let Some(token) = &self.frames[idx].bus_token {
            if !cpu.bus.rollback(token) {
                return Err(RewindError::BusNotRewindable);
            }
        } else if cpu.bus.checkpoint().is_some() {
            return Err(RewindError::BusNotRewindable);
        }

        let frame = &self.frames[idx];
        cpu.engine_mut().state_mut().copy_from(&frame.chip);
        cpu.set_half_cycle(frame.half_cycle);

        // Anything after the frame we landed on is now a future that did not
        // happen.
        self.frames.truncate(idx + 1);

        while cpu.half_cycle() < target {
            cpu.half_step();
        }
        Ok(())
    }

    /// Step back one half-cycle.
    pub fn step_back<B: Bus>(&mut self, cpu: &mut Cpu<B>) -> Result<(), RewindError> {
        let now = cpu.half_cycle();
        if now == 0 {
            return Err(RewindError::TooOld);
        }
        self.rewind_to(cpu, now - 1)
    }
}
