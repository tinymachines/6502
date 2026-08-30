//! One engine, one program, N half-cycles, nothing printed but the rung:
//! the shape `perf stat` wants for an A/B on counters.
//!
//!     cargo run --release -p v6502-hybrid --example run -- 0 200000   # rung 0
//!     cargo run --release -p v6502-hybrid --example run -- 1 200000   # rung 1

use std::sync::Arc;
use v6502_hybrid::{HybridCpu, HybridNetlist};
use v6502_pins::Load;
use v6502_sim::pins::rung0;
use v6502_sim::{mos6502, FlatMemory};

fn main() {
    let rung: u32 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(0);
    let n: u64 = std::env::args().nth(2).and_then(|a| a.parse().ok()).unwrap_or(200_000);
    // The Fibonacci program from web/programs.txt, so both rungs run the same bytes.
    let bytes = vec![0xa9, 0x00, 0x85, 0xf0, 0xa9, 0x01, 0x85, 0xf1, 0xa5, 0xf0, 0x18, 0x65, 0xf1, 0x85, 0xf2, 0xa5, 0xf1, 0x85, 0xf0, 0xa5, 0xf2, 0x85, 0xf1, 0x4c, 0x08, 0x02];
    println!("rung {rung}, {n} half-cycles");
    match rung {
        0 => {
            let mut a = rung0(&[Load { org: 0x200, bytes }], 0x200);
            a.power_cycle();
            for _ in 0..n {
                a.half_step();
            }
            println!("a={:02x}", a.registers().a);
        }
        _ => {
            let mut mem = FlatMemory::new();
            mem.load(0x200, &bytes);
            mem.set_reset_vector(0x200);
            let mut b = HybridCpu::new(Arc::new(HybridNetlist::new(Arc::new(mos6502()))), mem);
            b.power_cycle();
            for _ in 0..n {
                b.half_step();
            }
            println!("ab={:04x}", b.address_bus());
        }
    }
}
