//! GPU lane k equals CPU lane k, bit for bit, after the same half-steps.
//!
//! SKIPS without an adapter; REQUIRE_GPU=1 makes that a failure. MUTATE=1
//! flips one bit of one CPU word and the test must go red.

use v6502_compiled::kernel::NODES;
use v6502_compiled::Machines;
use v6502_gpu::{Gpu, LANES_PER_WORD};
use v6502_pins::Load;

fn pullups() -> Vec<bool> {
    let nl = v6502_netlist::mos6502();
    (0..nl.node_count()).map(|i| nl.pullups().get(i)).collect()
}

#[test]
fn gpu_lanes_match_cpu_lanes_bit_for_bit() {
    parity(false);
}

/// The lite variant (four planes on chip, the fifth in storage, for
/// adapters at the 32 KB workgroup-storage floor) is the SAME claim: it
/// exists for other people's GPUs, and it is proven on this one.
#[test]
fn the_lite_variant_matches_the_cpu_lanes_too() {
    parity(true);
}

fn parity(lite: bool) {
    let words = 4;
    let Some(mut gpu) = Gpu::new_with_entry(words, words * 32 * 16, lite) else {
        assert!(std::env::var_os("REQUIRE_GPU").is_none(), "REQUIRE_GPU is set but no adapter");
        eprintln!("\n  SKIPPED (gpu): no WebGPU adapter\n");
        return;
    };
    let mut m = Machines::new(&pullups());
    m.load_all(&[Load { org: 0x200, bytes: vec![0xa9, 0x00, 0x85, 0xf0, 0xa9, 0x01, 0x85, 0xf1, 0xa5, 0xf0, 0x18, 0x65, 0xf1, 0x85, 0xf2, 0xa5, 0xf1, 0x85, 0xf0, 0xa5, 0xf2, 0x85, 0xf1, 0x4c, 0x08, 0x02] }], 0x200);
    m.load_lane(1, &[Load { org: 0x200, bytes: vec![0xe6, 0x21, 0x4c, 0x00, 0x02] }], 0x200);
    m.power_cycle();
    gpu.load(&m);
    let mutate = std::env::var_os("MUTATE").is_some() && !lite;
    let mut checked = 0u64;
    for batch in 0..6 {
        let n = [1u64, 1, 2, 7, 50, 300][batch];
        for _ in 0..n {
            m.half_step();
        }
        gpu.half_steps(n);
        let v = gpu.values();
        let mask = (1u64 << LANES_PER_WORD) - 1;
        let mut cpu: Vec<u32> = m.state.value.iter().map(|&w| (w & mask) as u32).collect();
        if mutate && batch == 3 {
            cpu[100] ^= 1;
            eprintln!("MUTATE=1: flipped node 100 lane 0 on the CPU side at h={}", m.half_cycle());
        }
        for w in 0..words {
            let g = &v[w * NODES..(w + 1) * NODES];
            let diff: Vec<usize> = (0..NODES).filter(|&i| g[i] != cpu[i]).collect();
            assert!(diff.is_empty(), "h={}: word {w}: {} of {NODES} nodes differ, first {:?} (gpu {:08x} cpu {:08x})",
                m.half_cycle(), diff.len(), &diff[..diff.len().min(8)], g[diff[0]], cpu[diff[0]]);
        }
        let t = gpu.trans_on();
        let cpu_t: Vec<u32> = m.state.trans_on.iter().map(|&w| (w & mask) as u32).collect();
        assert_eq!(&t[..cpu_t.len()], &cpu_t[..], "trans_on word 0 at h={}", m.half_cycle());
        checked += n;
    }
    assert_eq!(checked, 361);

    // The sparse memory, reconstructed per lane, equals what the dense CPU
    // lane holds: lane 0 (the base image's own lane, dirtied by its
    // writes), lane 1 (loaded DIFFERENT, so its pre-seeded pages are what
    // reconstruction must find), and lane 1 of word 1 (the same program
    // evolving in another word's pool pages). The programs write zero page
    // and stack, so a reconstruction that only ever returned the base
    // would fail here by address.
    let (taken, cap, spent) = gpu.pool_state();
    assert!(!spent && taken > 0, "pool: {taken} of {cap}, spent {spent}");
    for lane in [0usize, 1, 2, 33] {
        let g = gpu.memory(lane);
        let c = &m.mem[lane % 32];
        let diff: Vec<usize> = (0..0x10000).filter(|&i| g[i] != c[i]).collect();
        assert!(diff.is_empty(), "lane {lane}: {} bytes differ, first at {:04x} (gpu {:02x} cpu {:02x})",
            diff.len(), diff[0], g[diff[0]], c[diff[0]]);
    }
    eprintln!("gpu parity ({}) on {}: {words} words x 32 lanes, 361 half-steps, every node and transistor identical to the CPU rung (lane 1 on a different program); {taken} pool pages of {cap} carry every lane's memory exactly", if lite { "half_step_lite" } else { "half_step" }, gpu.adapter_name);
}

#[test]
fn a_spent_pool_refuses_the_run_by_the_numbers() {
    // Four pages for 32 lanes that each write two: the pool WILL be spent,
    // and the refusal has to happen at readback rather than the memory
    // quietly serving a run whose writes were dropped.
    let Some(mut gpu) = Gpu::new_with_pool(1, 4) else {
        assert!(std::env::var_os("REQUIRE_GPU").is_none(), "REQUIRE_GPU is set but no adapter");
        eprintln!("\n  SKIPPED (gpu): no WebGPU adapter\n");
        return;
    };
    let mut m = Machines::new(&pullups());
    m.load_all(&[Load { org: 0x200, bytes: vec![0xe6, 0x20, 0x4c, 0x00, 0x02] }], 0x200);
    m.power_cycle();
    gpu.load(&m);
    gpu.half_steps(120);
    gpu.sync();
    let (_, _, spent) = gpu.pool_state();
    assert!(spent, "the pool was sized to be spent and was not; this test is testing nothing");
    let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| gpu.values()));
    let msg = match refused {
        Ok(_) => panic!("a spent pool served node values anyway"),
        Err(e) => e.downcast_ref::<String>().cloned().unwrap_or_default(),
    };
    assert!(msg.contains("pool is spent"), "the refusal does not name the pool: {msg:?}");
}
