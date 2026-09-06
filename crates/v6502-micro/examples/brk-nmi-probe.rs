//! An NMI edge at every half-cycle around a BRK, on rung 0 and rung 3:
//! where the NMI vector read lands, in half-cycles after the BRK's
//! fetch. The console's gate 1 found the two rungs parting when the
//! edge falls inside the BRK's vector reads; this is the measurement
//! the authored rule comes from.
//!
//!     cargo run --release -p v6502-micro --example brk-nmi-probe [op] [nmi|irq]
//!
//! The program: NOP x4, the opcode (BRK by default), NOP x6, then a
//! spin; the BRK/IRQ handler and the NMI handler are NOP; RTI.

use v6502_micro::machine::MicroCpu;
use v6502_pins::{run, Load, PinEngine, Stim};
use v6502_sim::pins::rung0;

fn lead() -> usize {
    std::env::var("NOPS").ok().and_then(|v| v.parse().ok()).unwrap_or(4)
}

fn loads(op: u8) -> Vec<Load> {
    let mut prog = vec![0xea; lead()];
    prog.push(op);
    prog.extend([0xea; 6]);
    let here = 0x0200 + prog.len() as u16;
    prog.extend([0x4c, here as u8, (here >> 8) as u8]);
    vec![
        Load { org: 0x0200, bytes: prog },
        Load { org: 0x0300, bytes: vec![0xea, 0x40] },
        Load { org: 0x0340, bytes: vec![0xea, 0x40] },
        Load { org: 0xfffa, bytes: vec![0x40, 0x03, 0x00, 0x02, 0x00, 0x03] },
    ]
}

fn measure<E: PinEngine>(e: &mut E, off: i64, irq: bool) -> (i64, i64) {
    let plain = run(e, 200, &[]);
    let k_op = plain.iter().position(|f| f.sync && f.ab == 0x0200 + lead() as u16).unwrap() as i64;
    let h = (k_op + off - 1).max(0) as u64;
    // The IRQ level stays low; the handler's CLI is not there, so the
    // FIRST vector read is what is timed.
    // PULSE=n releases the input n half-cycles later (a short pulse: what
    // a $2002 read that consumes the flag leaves on the PPU's /INT).
    let pulse: u64 = std::env::var("PULSE").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut stim = vec![Stim { h, res: true, irq: !irq, nmi: irq, rdy: true, so: false }];
    if pulse > 0 {
        stim.push(Stim { h: h + pulse, res: true, irq: true, nmi: true, rdy: true, so: false });
    }
    let frames = run(e, 200, &stim);
    if std::env::var("DUMP").ok().and_then(|v| v.parse::<i64>().ok()) == Some(off) {
        for k in (k_op - 6).max(0)..(k_op + 30).min(frames.len() as i64) {
            let f = &frames[k as usize];
            eprintln!("    {:>3} {}{}", k - k_op, v6502_pins::line(f), if k as u64 > h { " nmi=0" } else { "" });
        }
    }
    let vec = if irq { 0xfffe } else { 0xfffa };
    let hand = if irq { 0x0300 } else { 0x0340 };
    let vec_read = frames.iter().position(|f| f.rw && f.ab == vec).map(|k| k as i64 - k_op).unwrap_or(-999);
    let handler = frames.iter().position(|f| f.sync && f.ab == hand).map(|k| k as i64 - k_op).unwrap_or(-999);
    (vec_read, handler)
}

fn main() {
    let op = std::env::args().nth(1).map(|a| u8::from_str_radix(&a, 16).unwrap()).unwrap_or(0x00);
    let irq = std::env::args().nth(2).as_deref() == Some("irq");
    let l = loads(op);
    let mut r0 = rung0(&l, 0x0200);
    let mut r3 = MicroCpu::rung3(&l, 0x0200);
    // The program's CLI is its first byte when the IRQ level is probed.
    if irq {
        r0 = rung0(&{ let mut l = l.clone(); l[0].bytes[0] = 0x58; l }, 0x0200);
        r3 = MicroCpu::rung3(&{ let mut l = l.clone(); l[0].bytes[0] = 0x58; l }, 0x0200);
    }
    println!("op {op:02x}, {}: edge at (op fetch + off) half-cycles; vector read and handler fetch, half-cycles after the op fetch", if irq { "IRQ level" } else { "NMI edge" });
    println!("  off   rung0 vec/handler   rung3 vec/handler");
    for off in -14i64..=20 {
        let a = measure(&mut r0, off, irq);
        let b = measure(&mut r3, off, irq);
        println!("  {off:>3}   {:>5}/{:<7}         {:>5}/{:<7}{}", a.0, a.1, b.0, b.1, if a != b { "   <-- differ" } else { "" });
    }
}
