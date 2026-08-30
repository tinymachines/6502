//! Rung 2 throughput: per machine and per 64 machines, beside rung 0.
//!
//!     cargo run --release -p v6502-compiled --example bench [half-cycles]
//!
//! Best of REPEAT (default 3). First line names the rung and the crate.

use std::time::Instant;
use v6502_compiled::{kernel, Machines, LANES};
use v6502_pins::Load;
use v6502_sim::pins::rung0;

fn main() {
    println!("rung 2  v6502-compiled {}  ({} gates folded, {} switches swept)", env!("CARGO_PKG_VERSION"), kernel::FOLDED_GATES, kernel::SWITCHES);
    let n: u64 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(3000);
    let repeat: usize = std::env::var("REPEAT").ok().and_then(|r| r.parse().ok()).unwrap_or(3);
    let nl = v6502_netlist::mos6502();
    let pu: Vec<bool> = (0..nl.node_count()).map(|i| nl.pullups().get(i)).collect();
    let loads = [Load { org: 0x200, bytes: vec![0xe6, 0x20, 0x4c, 0x00, 0x02] }];

    let mut best0 = 0f64;
    let mut best2 = 0f64;
    for _ in 0..repeat {
        let mut a = rung0(&loads, 0x200);
        a.power_cycle();
        let t = Instant::now();
        for _ in 0..n {
            a.half_step();
        }
        best0 = best0.max(n as f64 / t.elapsed().as_secs_f64());
        let mut b = Machines::new(&pu);
        b.load_all(&loads, 0x200);
        b.power_cycle();
        let t = Instant::now();
        for _ in 0..n {
            b.half_step();
        }
        best2 = best2.max(n as f64 / t.elapsed().as_secs_f64());
    }
    println!("rung 0: {best0:.0} half-cycles/s (one machine)");
    println!("rung 2: {best2:.0} sweeps/s = {:.0} machine-half-cycles/s over {LANES} lanes", best2 * LANES as f64);
    println!("  per machine {:.2}x rung 0; per sweep {:.2}x", best2 * LANES as f64 / best0, best2 / best0);
}
