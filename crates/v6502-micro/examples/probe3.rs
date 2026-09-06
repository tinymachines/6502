//! Rung 3 alone through a short program: the register file and the
//! stack page after it runs, so an authored instruction can be checked
//! against a documented result where rung 0 is not the oracle (the
//! immediate-mode unofficial opcodes with their bus fights).
//!
//!     cargo run --release -p v6502-micro --example probe3 -- <hex bytes> [half-cycles]

use v6502_micro::machine::MicroCpu;
use v6502_pins::{Load, PinEngine};

fn main() {
    let h = std::env::args().nth(1).expect("hex bytes");
    let prog: Vec<u8> = (0..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i + 2], 16).expect("hex")).collect();
    let n: u64 = std::env::args().nth(2).and_then(|a| a.parse().ok()).unwrap_or(200);
    let loads = [Load { org: 0x0200, bytes: prog }];
    let mut m = MicroCpu::rung3(&loads, 0x0200);
    for _ in 0..n {
        PinEngine::half_step(&mut m);
    }
    let (a, x, y, s, p, pc) = m.registers();
    println!("a {a:02x} x {x:02x} y {y:02x} s {s:02x} p {p:02x} pc {pc:04x}");
    let stack: Vec<String> = (s as usize + 1..=0xff).map(|i| format!("{:02x}", m.mem[0x100 + i])).collect();
    println!("stack from S+1: {}", stack.join(" "));
    println!("zp 00..07: {}", (0..8).map(|i| format!("{:02x}", m.mem[i])).collect::<Vec<_>>().join(" "));
}
