//! Rung 3 beside rung 0 on one program, until the pins disagree.
//!
//!     cargo run --release -p v6502-micro --example diverge -- image.nes [half-cycles]
//!
//! An iNES image is placed at $8000 (16 KiB mirrored at $C000), $2002 is
//! pinned high so a shell's vblank wait falls through, and both rungs run
//! from a power cycle on the same bytes. The first half-cycle whose pin
//! line differs is printed with the sixty before it; a program that
//! misbehaves on rung 3 alone is located this way rather than reasoned
//! about. PINS_ONLY=1 compares the pins alone (a register readout that
//! differs without ever reaching a pin is a question about the readout,
//! not the program).

use v6502_micro::machine::MicroCpu;
use v6502_pins::{line, Load, PinEngine};
use v6502_sim::pins::rung0;

fn main() {
    let path = std::env::args().nth(1).expect("an iNES image");
    let n: u64 = std::env::args().nth(2).and_then(|a| a.parse().ok()).unwrap_or(2_000_000);
    let bytes = std::fs::read(&path).expect("read the image");
    let prg_len = bytes[4] as usize * 16384;
    let prg = bytes[16..16 + prg_len].to_vec();
    let mut loads = vec![Load { org: 0x8000, bytes: prg.clone() }];
    if prg_len == 16384 {
        loads.push(Load { org: 0xc000, bytes: prg.clone() });
    }
    loads.push(Load { org: 0x2002, bytes: vec![0x80] });
    let reset = u16::from_le_bytes([prg[prg.len() - 4], prg[prg.len() - 3]]);

    let mut b = MicroCpu::rung3(&loads, reset);
    // RUNG3_ONLY=1: no oracle, just the run and blargg's report window
    // ($6000 result, DE B0 61, text), for a ROM whose oracle is its own
    // checksum rather than rung 0.
    if std::env::var_os("RUNG3_ONLY").is_some() {
        for _ in 0..n {
            PinEngine::half_step(&mut b);
        }
        let m = &b.mem;
        if m[0x6001..0x6004] == [0xde, 0xb0, 0x61] {
            let text: String = m[0x6004..0x6200].iter().take_while(|&&x| x != 0).map(|&x| x as char).collect();
            println!("$6000 result: {:02x}; text: {:?}", m[0x6000], text.trim());
        } else {
            println!("no report at $6000 after {n} half-cycles; pc {:04x}", b.registers().5);
        }
        return;
    }
    let mut a = rung0(&loads, reset);
    a.power_cycle();
    let mut recent: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    // Register files are compared too, tolerating the cycle in which a
    // result is still in flight on one rung: only a disagreement that
    // persists for six half-cycles is a divergence, reported from its start.
    let mut reg_since: Option<u64> = None;
    for i in 0..n {
        let r = a.registers();
        let (a3, x3, y3, s3, p3, _) = b.registers();
        let regs_agree = r.a == a3 && r.x == x3 && r.y == y3 && r.s == s3 && (r.p | 0x30) == (p3 | 0x30);
        let ra = format!("a {:02x} x {:02x} y {:02x} s {:02x} p {:02x}", r.a, r.x, r.y, r.s, r.p);
        let (op3, key3) = b.playing();
        let rb = format!("a {a3:02x} x {x3:02x} y {y3:02x} s {s3:02x} p {p3:02x} [{op3:02x}/{key3:02x}]");
        let fa = line(&a.pins());
        let fb = line(&b.pins());
        if !regs_agree && std::env::var_os("PINS_ONLY").is_none() {
            let since = *reg_since.get_or_insert(i);
            if i - since >= 6 {
                for l in &recent {
                    println!("   {l}");
                }
                println!("registers disagree since step {since}\nrung 0: {ra}\nrung 3: {rb}");
                std::process::exit(1);
            }
        } else {
            reg_since = None;
        }
        let fa = format!("{fa}   {}", if regs_agree { format!("{ra} [{op3:02x}/{key3:02x}]") } else { format!("{ra} | rung 3 {rb}") });
        if fa.split("   ").next() != fb.split("   ").next() {
            for l in &recent {
                println!("   {l}");
            }
            let r = a.registers();
            println!("rung 0: {fa}\nrung 3: {fb}\ndiverged at step {i}");
            println!("rung 0 regs: a {:02x} x {:02x} y {:02x} s {:02x} p {:02x} pc {:04x}", r.a, r.x, r.y, r.s, r.p, r.pc);
            let (a3, x3, y3, s3, p3, pc3) = b.registers();
            println!("rung 3 regs: a {a3:02x} x {x3:02x} y {y3:02x} s {s3:02x} p {p3:02x} pc {pc3:04x}");
            std::process::exit(1);
        }
        if recent.len() == 60 {
            recent.pop_front();
        }
        recent.push_back(fa);
        a.half_step();
        PinEngine::half_step(&mut b);
    }
    println!("agree over {n} half-cycles; last {}", line(&a.pins()));
}
