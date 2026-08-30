//! Machine-half-cycles per second on the GPU, against the CPU rungs.
//!
//!     cargo run --release -p v6502-gpu --example bench [words] [half-cycles]
//!
//! One word is 32 machines. Timed end to end, including one readback at
//! the end so the submission is known to have finished.

use std::time::Instant;
use v6502_compiled::Machines;
use v6502_gpu::{Gpu, LANES_PER_WORD};
use v6502_pins::Load;

fn main() {
    let words: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(256);
    let n: u64 = std::env::args().nth(2).and_then(|a| a.parse().ok()).unwrap_or(2000);
    let nl = v6502_netlist::mos6502();
    let pu: Vec<bool> = (0..nl.node_count()).map(|i| nl.pullups().get(i)).collect();
    let Some(mut gpu) = Gpu::new(words) else {
        eprintln!("no adapter");
        std::process::exit(1)
    };
    println!("rung 2 on {}: {words} words x {LANES_PER_WORD} lanes = {} machines", gpu.adapter_name, words * LANES_PER_WORD);
    let mut m = Machines::new(&pu);
    m.load_all(&[Load { org: 0x200, bytes: vec![0xe6, 0x20, 0x4c, 0x00, 0x02] }], 0x200);
    m.power_cycle();
    gpu.load(&m);
    gpu.half_steps(2);
    gpu.sync();
    let t = Instant::now();
    let batch = 200;
    let mut done = 0;
    while done < n {
        let k = batch.min(n - done);
        gpu.half_steps(k);
        done += k;
    }
    let _ = gpu.values();
    let secs = t.elapsed().as_secs_f64();
    let machines = (words * LANES_PER_WORD) as f64;
    println!("{n} half-cycles in {secs:.3}s: {:.0} sweeps/s, {:.0} machine-half-cycles/s", n as f64 / secs, n as f64 * machines / secs);
}
