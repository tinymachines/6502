//! What survives a mid-run crossing from rung 0 into rung 2: measured, not
//! asserted.
//!
//!     cargo run --release -p v6502-compiled --example crossing [run-in] [run-on]
//!
//! Rung 0 runs a program `run-in` half-cycles (odd by default, so the seam
//! lands mid-cycle), its machine value is broadcast into every lane of a
//! `Machines`, and both engines then run `run-on` half-cycles side by side.
//! The pin golden only covers rung 2 from power-on; this is the measurement
//! for resuming a foreign snapshot mid-run, which is what a console engine
//! switch does. Reported per half-cycle:
//!
//!   - the pins (the console's frames ride on these: memory only changes
//!     through them, so if the pins hold, the game holds)
//!   - the eight datapath control lines Die Runner's cartridge watches (the
//!     gates feed gameplay through the gate mask, so they matter even
//!     though they are internal nodes, not pins)
//!   - live-node agreement, for context (internal divergence is expected;
//!     the kernel's account says why)
//!
//! and the memory image at the end.

use v6502_compiled::{Machines, LANES};
use v6502_pins::{Load, PinEngine};
use v6502_sim::pins::rung0;

/// The eight lines Die Runner watches (games/roms/dierunner.toml).
const GATES: [&str; 8] = [
    "dpc25_SBDB", "dpc9_DBADD", "dpc10_ADLADD", "dpc21_ADDADL",
    "dpc23_SBAC", "dpc30_ADHPCH", "dpc40_ADLPCL", "dpc2_XSB",
];

fn hex_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len() / 2).map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap()).collect()
}

fn main() {
    let run_in: u64 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(777);
    let run_on: u64 = std::env::args().nth(2).and_then(|a| a.parse().ok()).unwrap_or(20000);
    let nl = v6502_netlist::mos6502();
    let pu: Vec<bool> = (0..nl.node_count()).map(|i| nl.pullups().get(i)).collect();
    let gate_ids: Vec<usize> = GATES.iter().map(|g| nl.node(g).expect("a watched line is a node") as usize).collect();
    let live: Vec<usize> = (0..nl.node_count()).filter(|&i| nl.exists(i as u16) && !nl.is_rail(i as u16)).collect();

    let loads = [Load { org: 0x200, bytes: vec![0xe6, 0x20, 0x4c, 0x00, 0x02] }];
    let mut a = rung0(&loads, 0x200);
    a.power_cycle();
    for _ in 0..run_in {
        a.half_step();
    }

    // The crossing: rung 0's value, in the codec's own encoding, into every
    // lane, with the memory beside it.
    let st = v6502_sim::state::snapshot(&a);
    let [value, pullup, pulldown, trans_on] = st.chip_hex();
    let mut b = Machines::new(&pu);
    for lane in 0..LANES {
        b.mem[lane].copy_from_slice(a.bus.as_slice());
    }
    b.state
        .inject_all(&hex_bytes(&value), &hex_bytes(&pullup), &hex_bytes(&pulldown), &hex_bytes(&trans_on))
        .expect("the codec's own lengths");
    b.set_half_cycle(st.half_cycle);

    let mut pin_ok = 0u64;
    let mut pin_first: Option<u64> = None;
    let mut pin_fields: std::collections::BTreeMap<&'static str, u64> = Default::default();
    let mut gates_ok = 0u64;
    let mut gate_first: Option<u64> = None;
    let mut node_ok = 0u64;
    let (mut node_first, mut worst) = (None::<u64>, 0usize);
    for h in 0..run_on {
        a.half_step();
        b.half_step();
        let (pa, pb) = (PinEngine::pins(&a), Machines::pins(&b, 0));
        if pa == pb {
            pin_ok += 1;
        } else {
            pin_first.get_or_insert(h);
            for (name, differ) in [
                ("clk0", pa.clk0 != pb.clk0), ("ab", pa.ab != pb.ab), ("db", pa.db != pb.db),
                ("rw", pa.rw != pb.rw), ("sync", pa.sync != pb.sync), ("h", pa.h != pb.h),
            ] {
                if differ {
                    *pin_fields.entry(name).or_default() += 1;
                }
            }
        }
        if gate_ids.iter().all(|&g| a.engine().is_high(g as u16) == b.state.is_high(0, g)) {
            gates_ok += 1;
        } else {
            gate_first.get_or_insert(h);
        }
        let d = live.iter().filter(|&&i| a.engine().is_high(i as u16) != b.state.is_high(0, i)).count();
        if d == 0 {
            node_ok += 1;
        } else {
            node_first.get_or_insert(h);
            worst = worst.max(d);
        }
    }

    println!("crossing at h={run_in}, then {run_on} half-cycles side by side");
    println!("pins:  {pin_ok}/{run_on} half-cycles identical at all 11 pins");
    match pin_first {
        None => println!("  no pin ever differed"),
        Some(h) => println!("  first pin difference at +{h}; fields: {pin_fields:?}"),
    }
    println!("gates: {gates_ok}/{run_on} half-cycles identical on Die Runner's eight lines");
    match gate_first {
        None => println!("  no gate ever differed"),
        Some(h) => println!("  first gate difference at +{h}"),
    }
    println!("nodes: {node_ok}/{run_on} half-cycles identical on all {} live nodes (context)", live.len());
    if let Some(h) = node_first {
        println!("  first node divergence at +{h}; worst half-cycle differed on {worst}");
    }
    let mem_same = a.bus.as_slice() == &b.mem[0][..];
    println!("memory after the run: {}", if mem_same { "IDENTICAL, all 64 KiB" } else { "DIFFERS" });
    println!("$20 is ${:02x} compiled, ${:02x} scalar", b.mem[0][0x20], a.bus.peek(0x20));
    println!("nonconvergent settles: {}", b.stats.nonconvergent_settles);
    // A sanity row so this can never pass on nothing: the program must have
    // kept counting after the seam.
    assert!(b.mem[0][0x20] > 0, "the program ran");
}
