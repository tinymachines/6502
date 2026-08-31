//! Rung 3 beside rung 0: half-cycles per second, one machine.
//!
//!     cargo run --release -p v6502-micro --example bench [half-cycles]

use std::time::Instant;
use v6502_micro::machine::MicroCpu;
use v6502_pins::{Load, PinEngine};
use v6502_sim::pins::rung0;

fn main() {
    let n: u64 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(2_000_000);
    let loads = [Load { org: 0x200, bytes: vec![0xe6, 0x20, 0x4c, 0x00, 0x02] }];
    println!("rung 3  v6502-micro (the measured table through the authored datapath)");

    let mut b = MicroCpu::rung3(&loads, 0x200);
    let t = Instant::now();
    for _ in 0..n {
        PinEngine::half_step(&mut b);
    }
    let dt = t.elapsed().as_secs_f64();
    let r3 = n as f64 / dt;
    println!("rung 3: {:.0} half-cycles/s ($20 reached ${:02x})", r3, b.mem[0x20]);

    let n0 = (n / 50).max(10_000);
    let mut a = rung0(&loads, 0x200);
    a.power_cycle();
    let t = Instant::now();
    for _ in 0..n0 {
        a.half_step();
    }
    let dt = t.elapsed().as_secs_f64();
    let r0 = n0 as f64 / dt;
    println!("rung 0: {:.0} half-cycles/s over {n0}", r0);
    println!("per machine {:.0}x rung 0; a 1 MHz 6502 is {:.1}x real time", r3 / r0, r3 / 2_000_000.0);
}
