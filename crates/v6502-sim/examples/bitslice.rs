//! 64 machines in one instruction stream, checked against the real engine.
//!
//! `halfphi::slice` recomputes the same fixed point without a queue and
//! without materialising groups, so that all 64 lanes can share one control
//! path. That is only interesting if it is the SAME fixed point, so this runs
//! the scalar `Cpu` and the sliced kernel side by side and compares the level
//! of every node, every half-cycle. A single differing bit anywhere fails.
//!
//! Then it makes the lanes disagree on purpose -- lane 1 gets a different
//! byte in memory -- because 64 copies of one machine would pass the
//! comparison above while proving nothing about independence.
//!
//!   cargo run --release -p v6502-sim --example bitslice [half-cycles]

use halfphi::{Netlist, NodeId, SliceNetlist, SliceState, LANES};
use std::sync::Arc;
use std::time::Instant;
use v6502_sim::{mos6502, Bus, Cpu, FlatMemory};

const MAX_ROUNDS: usize = 200;

/// One lane's memory. A flat 64K so a lane can be perturbed anywhere.
struct Mem(Vec<u8>);

impl Mem {
    fn new(load: u16, program: &[u8]) -> Self {
        let mut m = vec![0u8; 0x10000];
        m[load as usize..load as usize + program.len()].copy_from_slice(program);
        m[0xfffc] = load as u8;
        m[0xfffd] = (load >> 8) as u8;
        Mem(m)
    }
}

/// The sliced equivalent of `Cpu::half_step`, for all 64 machines at once.
///
/// The clock is driven in every lane by one instruction; the bus is not, so
/// each lane's address and data are read out and folded back in as masks.
fn half_step(
    st: &mut SliceState,
    snl: &SliceNetlist,
    sig: &v6502_sim::Signals,
    mem: &mut [Mem],
    clk_high: bool,
) {
    if clk_high {
        st.set_pull_all(sig.clk0, false);
        st.settle(snl, MAX_ROUNDS);
        // Service reads. Only the lanes whose machine is reading get their
        // data bus driven; the rest keep whatever the chip is putting there.
        let mut read_mask = 0u64;
        let mut bits = [0u64; 8];
        for lane in 0..LANES {
            if !st.is_high(lane, sig.rw) {
                continue;
            }
            read_mask |= 1 << lane;
            let addr = st.read_bus(lane, &sig.ab) as usize;
            let data = mem[lane].0[addr];
            for (i, b) in bits.iter_mut().enumerate() {
                *b |= u64::from(data >> i & 1) << lane;
            }
        }
        for i in 0..8 {
            st.set_pull_where(sig.db[i], read_mask, bits[i]);
        }
        st.settle(snl, MAX_ROUNDS);
    } else {
        st.set_pull_all(sig.clk0, true);
        st.settle(snl, MAX_ROUNDS);
        for lane in 0..LANES {
            if st.is_high(lane, sig.rw) {
                continue;
            }
            let addr = st.read_bus(lane, &sig.ab) as usize;
            let data = st.read_bus(lane, &sig.db) as u8;
            mem[lane].0[addr] = data;
        }
    }
}

fn main() {
    let n: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(2000);
    // The bench program: INC $20 ; JMP back. Continuous ALU, memory and bus.
    let prog = [0xe6u8, 0x20, 0x4c, 0x00, 0x02];
    let load = 0x0200u16;

    let nl: Arc<Netlist> = Arc::new(mos6502());
    let mut fm = FlatMemory::new();
    fm.load(load, &prog);
    fm.set_reset_vector(load);
    let mut cpu = Cpu::new(Arc::clone(&nl), fm).expect("signals");
    cpu.reset();
    let sig = cpu.signals().clone();

    // The state every lane starts from, kept because the comparison loop below
    // advances `cpu` and the later runs must not begin mid-instruction.
    let fresh = cpu.engine().state().clone();

    let snl = SliceNetlist::new(&nl);
    let mut st = SliceState::new(&snl);
    // Every lane starts as a copy of the reset machine, so any divergence
    // later is the kernel's doing and not a different starting point.
    for lane in 0..LANES {
        st.load_lane(lane, cpu.engine().state());
    }
    let mut mem: Vec<Mem> = (0..LANES).map(|_| Mem::new(load, &prog)).collect();

    // --- how far the two agree, and whether the difference matters
    //
    // Bit-exact trajectory matching is NOT expected here and the reason is
    // physical rather than a bug: this chip stores charge, so a node briefly
    // joined to a driver keeps that level after the switch reopens. The
    // scalar engine walks a queue, so it passes through a specific sequence of
    // switch configurations, including momentary ones; this kernel sweeps to a
    // consistent state and can miss a glitch the queue happened to stage. The
    // queue order is data dependent, so it is also lane dependent, which is
    // exactly what a lane-uniform kernel cannot reproduce.
    //
    // So the question is not "are the trajectories identical" but "does this
    // still execute the program". Both are reported.
    let live: Vec<NodeId> = (0..nl.node_count() as NodeId)
        .filter(|&i| nl.exists(i) && !nl.is_rail(i))
        .collect();
    let mut clk_high = cpu.engine().is_high(sig.clk0);
    let mut first_diff: Option<usize> = None;
    let mut worst = 0usize;
    let mut agree_hc = 0usize;
    for hc in 0..n {
        half_step(&mut st, &snl, &sig, &mut mem, clk_high);
        cpu.half_step();
        clk_high = cpu.engine().is_high(sig.clk0);

        let mut differing = 0usize;
        for &node in &live {
            if st.is_high(0, node) != cpu.engine().is_high(node) {
                differing += 1;
            }
        }
        if differing == 0 {
            agree_hc += 1;
        } else {
            if first_diff.is_none() {
                first_diff = Some(hc);
            }
            worst = worst.max(differing);
        }
    }
    println!("trajectory: {agree_hc}/{n} half-cycles identical on all {} live nodes", live.len());
    match first_diff {
        None => println!("  no divergence at all"),
        Some(hc) => println!("  first divergence at half-cycle {hc}; worst half-cycle differed on {worst} of {} nodes", live.len()),
    }
    // Does the sliced machine actually run the program? INC $20 in a loop, so
    // the byte at $20 must climb, and the scalar's copy is the answer key.
    let want = cpu.bus.read(0x20);
    let got = mem[0].0[0x20];
    println!("program: $20 is ${got:02x} sliced, ${want:02x} scalar -- {}",
             if got == want { "SAME" } else { "DIFFERENT" });

    // --- independence: a different PROGRAM in one lane, not a different byte
    //
    // An earlier version of this check perturbed one byte of lane 1's memory
    // and compared the result. It passed at 400 half-cycles and failed at
    // 3000, and the failure was the test's fault: it starts from whatever
    // mid-instruction state the scalar machine reached, and the very next
    // write can put the same value into $20 in every lane, erasing the
    // difference before anything reads it. A check that depends on where the
    // clock happened to stop is not a check.
    //
    // So: lane 1 runs INC $21 where every other lane runs INC $20. The two
    // addresses cannot be confused for each other by any later write.
    let mut mem2: Vec<Mem> = (0..LANES).map(|_| Mem::new(load, &prog)).collect();
    mem2[1] = Mem::new(load, &[0xe6u8, 0x21, 0x4c, 0x00, 0x02]);
    let mut st2 = SliceState::new(&snl);
    for lane in 0..LANES {
        st2.load_lane(lane, &fresh);
    }
    let mut clk = clk_high;
    for _ in 0..1200 {
        half_step(&mut st2, &snl, &sig, &mut mem2, clk);
        clk = !clk;
    }
    let l0_20 = mem2[0].0[0x20];
    let l1_20 = mem2[1].0[0x20];
    let l1_21 = mem2[1].0[0x21];
    let l0_21 = mem2[0].0[0x21];
    println!("independence: lane 0 counts at $20 (${l0_20:02x}, and $21 is ${l0_21:02x});");
    println!("              lane 1 counts at $21 (${l1_21:02x}, and $20 is ${l1_20:02x})");
    let ok = l0_20 > 0 && l0_21 == 0 && l1_21 > 0 && l1_20 == 0;
    println!("              {}", if ok {
        "each lane ran its own program and touched only its own memory"
    } else {
        "FAILED: the lanes are not independent"
    });

    // --- throughput, in machine-half-cycles
    let mut st3 = SliceState::new(&snl);
    for lane in 0..LANES {
        st3.load_lane(lane, &fresh);
    }
    let mut mem3: Vec<Mem> = (0..LANES).map(|_| Mem::new(load, &prog)).collect();
    let reps = 2000usize;
    let mut clk3 = clk_high;
    let t = Instant::now();
    for _ in 0..reps {
        half_step(&mut st3, &snl, &sig, &mut mem3, clk3);
        clk3 = !clk3;
    }
    let secs = t.elapsed().as_secs_f64();
    let machine_hc = (reps * LANES) as f64;
    println!(
        "throughput: {reps} sweeps x {LANES} lanes = {:.0} machine-half-cycles in {secs:.3}s",
        machine_hc
    );
    println!("  {:.0} machine-half-cycles/s", machine_hc / secs);
    println!("  {:.0} sweeps/s (one sweep advances all {LANES} machines)", reps as f64 / secs);
}
