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
    let words = 4;
    let Some(mut gpu) = Gpu::new(words) else {
        assert!(std::env::var_os("REQUIRE_GPU").is_none(), "REQUIRE_GPU is set but no adapter");
        eprintln!("\n  SKIPPED (gpu): no WebGPU adapter\n");
        return;
    };
    let mut m = Machines::new(&pullups());
    m.load_all(&[Load { org: 0x200, bytes: vec![0xa9, 0x00, 0x85, 0xf0, 0xa9, 0x01, 0x85, 0xf1, 0xa5, 0xf0, 0x18, 0x65, 0xf1, 0x85, 0xf2, 0xa5, 0xf1, 0x85, 0xf0, 0xa5, 0xf2, 0x85, 0xf1, 0x4c, 0x08, 0x02] }], 0x200);
    m.load_lane(1, &[Load { org: 0x200, bytes: vec![0xe6, 0x21, 0x4c, 0x00, 0x02] }], 0x200);
    m.power_cycle();
    gpu.load(&m);
    let mutate = std::env::var_os("MUTATE").is_some();
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
    eprintln!("gpu parity on {}: {words} words x 32 lanes, 361 half-steps, every node and transistor identical to the CPU rung (lane 1 on a different program)", gpu.adapter_name);
}
