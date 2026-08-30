//! A machine value crossing rungs mid-run, proven at every node.
//!
//! Rung 0 runs a program partway, its machine is snapshotted with
//! `v6502_sim::state::snapshot`, and the value is restored into a COLD rung 1
//! (never reset, standing in for a worker that just booted) holding a copy of
//! the memory. From there both engines step together, and every node's level
//! and every transistor's state must match at every half-cycle, exactly as
//! `tests/lockstep.rs` holds them from power-on. Then the same crossing the
//! other way: rung 1's snapshot into a cold rung 0.
//!
//! This is the exchangeability the console's engine switch rests on: the
//! machine is a value, and either rung continues the same run.
//!
//! `MUTATE=1` flips one node's level in the value before the restore and the
//! test must go red at the first comparison.

use std::sync::Arc;

use v6502_hybrid::{HybridCpu, HybridNetlist};
use v6502_pins::Load;
use v6502_sim::pins::rung0;
use v6502_sim::{mos6502, Cpu, FlatMemory};

/// INC $20 / JMP $0200: two bytes of work in a loop, so any resume point is
/// mid-instruction somewhere.
fn loads() -> Vec<Load> {
    vec![Load { org: 0x200, bytes: vec![0xe6, 0x20, 0x4c, 0x00, 0x02] }]
}

const VECTOR: u16 = 0x200;
/// Odd, so the crossing lands mid-cycle, not on a phase boundary.
const RUN_IN: u64 = 777;
const RUN_ON: u64 = 600;

fn mutate() -> bool {
    std::env::var_os("MUTATE").is_some()
}

/// Flip one node's level in the value, so the first comparison must see it.
fn flip(st: &mut v6502_sim::state::MachineState) {
    let n = 100usize;
    st.chip.value.put(n, !st.chip.value.get(n));
    eprintln!("MUTATE=1: flipped node {n}'s level in the travelling value");
}

fn compare(a: &Cpu<FlatMemory>, b: &HybridCpu<FlatMemory>, h: u64) {
    let sa = a.state_string();
    let sb = b.state_string();
    if sa != sb {
        let diff = sa.chars().zip(sb.chars()).filter(|(x, y)| x != y).count();
        panic!("h={h}: {diff} of {} nodes differ between rung 0 and rung 1 after the crossing", sa.len());
    }
    assert!(a.engine().state().trans_on == *b.engine().trans_on(), "h={h}: trans_on differs");
}

#[test]
fn rung0_snapshot_resumes_on_a_cold_rung1() {
    let mut a = rung0(&loads(), VECTOR);
    a.power_cycle();
    for _ in 0..RUN_IN {
        a.half_step();
    }
    let mut st = v6502_sim::state::snapshot(&a);
    if mutate() {
        flip(&mut st);
    }

    let mut mem = FlatMemory::new();
    mem.load(0, a.bus.as_slice());
    let hn = Arc::new(HybridNetlist::new(Arc::new(mos6502())));
    let mut b = HybridCpu::new(hn, mem);
    v6502_hybrid::state::restore(&mut b, &st);

    assert_eq!(b.half_cycle(), a.half_cycle(), "half_cycle travels");
    assert_eq!(
        b.last_fetch().map(|f| (f.addr, f.opcode)),
        a.last_fetch().map(|f| (f.addr, f.opcode)),
        "last_fetch travels"
    );
    compare(&a, &b, RUN_IN);
    for h in 0..RUN_ON {
        a.half_step();
        b.half_step();
        compare(&a, &b, RUN_IN + h + 1);
    }
    eprintln!("rung 0 -> rung 1: resumed at h={RUN_IN}, {RUN_ON} half-cycles, every node identical");
}

#[test]
fn rung1_snapshot_resumes_on_a_cold_rung0() {
    let mut mem = FlatMemory::new();
    for l in &loads() {
        mem.load(l.org, &l.bytes);
    }
    mem.set_reset_vector(VECTOR);
    let hn = Arc::new(HybridNetlist::new(Arc::new(mos6502())));
    let mut b = HybridCpu::new(hn, mem);
    b.power_cycle();
    for _ in 0..RUN_IN {
        b.half_step();
    }
    let mut st = v6502_hybrid::state::snapshot(&b);
    if mutate() {
        flip(&mut st);
    }

    let mut mem = FlatMemory::new();
    mem.load(0, b.bus.as_slice());
    let mut a = Cpu::new(Arc::new(mos6502()), mem).expect("signals resolve");
    v6502_sim::state::restore(&mut a, &st);

    assert_eq!(a.half_cycle(), b.half_cycle(), "half_cycle travels");
    compare(&a, &b, RUN_IN);
    for h in 0..RUN_ON {
        a.half_step();
        b.half_step();
        compare(&a, &b, RUN_IN + h + 1);
    }
    eprintln!("rung 1 -> rung 0: resumed at h={RUN_IN}, {RUN_ON} half-cycles, every node identical");
}
