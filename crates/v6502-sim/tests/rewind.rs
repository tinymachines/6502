//! Time travel must be exact, not approximate.
//!
//! A rewind that restores the chip but not memory (or vice versa) produces a
//! state the hardware could never have been in, which is worse than no rewind
//! at all -- it silently invalidates everything downstream.

use std::sync::Arc;

use v6502_netlist::mos6502;
use v6502_sim::{bus::FlatMemory, cpu::Cpu, history::History, RewindError};

/// LDA #$00 ; loop { INC $20 ; JMP loop } -- memory changes continuously, so a
/// rewind that ignores the bus is immediately visible.
const PROGRAM: &[u8] = &[
    0xa9, 0x00, // LDA #$00
    0xe6, 0x20, // INC $20      <- loop
    0x4c, 0x02, 0x02, // JMP $0202
];

fn boot() -> Cpu<FlatMemory> {
    let mut mem = FlatMemory::new();
    mem.load(0x0200, PROGRAM);
    mem.set_reset_vector(0x0200);
    let mut cpu = Cpu::new(Arc::new(mos6502()), mem).unwrap();
    cpu.reset();
    // Reset itself performs bus cycles; start history from a clean journal so
    // checkpoints refer only to post-reset writes.
    cpu.bus.clear_journal();
    cpu
}

/// (half-cycle, full chip state, contents of $20)
type Mark = (u64, String, u8);

fn mark(cpu: &Cpu<FlatMemory>) -> Mark {
    (cpu.half_cycle(), cpu.state_string(), cpu.bus.peek(0x20))
}

#[test]
fn rewind_restores_chip_and_memory_exactly() {
    let mut cpu = boot();
    let mut history = History::new(16, 128);
    let mut marks: Vec<Mark> = Vec::new();

    for _ in 0..800 {
        history.maybe_capture(&mut cpu);
        marks.push(mark(&cpu));
        cpu.half_step();
    }

    // $20 must actually have been counting, or this test proves nothing.
    assert!(marks.last().unwrap().2 > 3, "program did not modify memory");

    // Rewind to a mixture of keyframe-aligned and off-keyframe targets.
    for &target in &[736u64, 500, 499, 256, 255, 129, 64] {
        history.rewind_to(&mut cpu, target).expect("target is within history");
        let (hc, state, mem) = &marks[target as usize];
        assert_eq!(cpu.half_cycle(), *hc);
        assert_eq!(&cpu.state_string(), state, "chip state at half-cycle {target}");
        assert_eq!(cpu.bus.peek(0x20), *mem, "memory at half-cycle {target}");
    }
}

#[test]
fn replay_after_rewind_is_deterministic() {
    let mut cpu = boot();
    let mut history = History::new(16, 128);
    let mut marks: Vec<Mark> = Vec::new();
    for _ in 0..400 {
        history.maybe_capture(&mut cpu);
        marks.push(mark(&cpu));
        cpu.half_step();
    }

    history.rewind_to(&mut cpu, 100).unwrap();
    // Re-simulating the same interval must reproduce it exactly.
    for expected in &marks[100..400] {
        assert_eq!(mark(&cpu), *expected, "divergence after rewind");
        history.maybe_capture(&mut cpu);
        cpu.half_step();
    }
}

#[test]
fn step_back_walks_backwards_one_phase_at_a_time() {
    let mut cpu = boot();
    let mut history = History::new(8, 64);
    let mut marks: Vec<Mark> = Vec::new();
    for _ in 0..200 {
        history.maybe_capture(&mut cpu);
        marks.push(mark(&cpu));
        cpu.half_step();
    }

    for expected in marks[150..200].iter().rev() {
        history.step_back(&mut cpu).expect("within history");
        assert_eq!(mark(&cpu), *expected);
    }
}

#[test]
fn rewinding_outside_the_window_fails_rather_than_lying() {
    let mut cpu = boot();
    // Deliberately tiny window: 4 keyframes at stride 8 covers 32 half-cycles.
    let mut history = History::new(8, 4);
    for _ in 0..300 {
        history.maybe_capture(&mut cpu);
        cpu.half_step();
    }

    assert_eq!(history.rewind_to(&mut cpu, 0), Err(RewindError::TooOld));
    assert_eq!(history.rewind_to(&mut cpu, 9_999), Err(RewindError::InFuture));

    // ...but a target inside the retained window still works.
    let earliest = history.earliest().unwrap();
    assert!(history.rewind_to(&mut cpu, earliest).is_ok());
}

#[test]
fn history_stays_bounded() {
    let mut cpu = boot();
    let mut history = History::new(4, 16);
    for _ in 0..1000 {
        history.maybe_capture(&mut cpu);
        cpu.half_step();
    }
    assert_eq!(history.len(), 16, "ring buffer should not grow");
}
