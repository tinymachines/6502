//! Rung 1 throughput on the seven programs, beside rung 0 on the same run.
//!
//!     cargo run --release -p v6502-hybrid --example bench [half-cycles]
//!
//! Best of REPEAT (default 3) for the timed column; the counted columns are
//! bit-identical between runs. The first line names the rung and the crate
//! version, because four engines behind one trait are four ways to time the
//! wrong one.

use std::sync::Arc;
use std::time::Instant;
use v6502_hybrid::{HybridCpu, HybridNetlist};
use v6502_pins::Load;
use v6502_sim::pins::rung0;
use v6502_sim::{mos6502, FlatMemory};

fn main() {
    println!("rung 1  v6502-hybrid {}  (rung 0 is v6502-sim {})", env!("CARGO_PKG_VERSION"), env!("CARGO_PKG_VERSION"));
    let n: u64 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(20_000);
    let repeat: usize = std::env::var("REPEAT").ok().and_then(|r| r.parse().ok()).unwrap_or(3);
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let text = std::fs::read_to_string(root.join("web/programs.txt")).unwrap_or_else(|_| {
        eprintln!("no web/programs.txt: node tools/export-programs.mjs");
        std::process::exit(1)
    });
    let hn = Arc::new(HybridNetlist::new(Arc::new(mos6502())));
    println!("{} gates folded ({} transistors), {} switches walked", hn.gate_count(), hn.absorbed(), hn.switch_count());
    println!("{:<12} {:>9} {:>9} {:>6} | {:>9} {:>9} {:>9} {:>9}", "program", "r0 hc/s", "r1 hc/s", "ratio", "recalcs0", "recalcs1", "probes0", "probes1");
    for line in text.lines().filter(|l| !l.starts_with('#') && !l.trim().is_empty()) {
        let f: Vec<&str> = line.split('\t').collect();
        let org = u16::from_str_radix(f[1], 16).unwrap();
        let bytes: Vec<u8> = (0..f[2].len() / 2).map(|i| u8::from_str_radix(&f[2][i * 2..i * 2 + 2], 16).unwrap()).collect();
        let loads = [Load { org, bytes }];

        let mut best0 = 0f64;
        let mut best1 = 0f64;
        for _ in 0..repeat {
            let mut a = rung0(&loads, org);
            a.power_cycle();
            let t = Instant::now();
            for _ in 0..n {
                a.half_step();
            }
            best0 = best0.max(n as f64 / t.elapsed().as_secs_f64());

            let mut mem = FlatMemory::new();
            mem.load(org, &loads[0].bytes);
            mem.set_reset_vector(org);
            let mut b = HybridCpu::new(Arc::clone(&hn), mem);
            b.power_cycle();
            let t = Instant::now();
            for _ in 0..n {
                b.half_step();
            }
            best1 = best1.max(n as f64 / t.elapsed().as_secs_f64());
        }
        // Counted columns, one instrumented pass each.
        let mut a = rung0(&loads, org);
        a.power_cycle();
        a.engine_mut().reset_stats();
        for _ in 0..n {
            a.half_step();
        }
        let s0 = *a.engine().stats();
        let mut mem = FlatMemory::new();
        mem.load(org, &loads[0].bytes);
        mem.set_reset_vector(org);
        let mut b = HybridCpu::new(Arc::clone(&hn), mem);
        b.power_cycle();
        b.engine_mut().reset_stats();
        for _ in 0..n {
            b.half_step();
        }
        let s1 = *b.engine().stats();
        // The scalar engine does not count probes; its group_members is the
        // nearest counted thing and is printed as such.
        println!(
            "{:<12} {:>9.0} {:>9.0} {:>6.2} | {:>9.1} {:>9.1} {:>9} {:>9.1}",
            f[0],
            best0,
            best1,
            best1 / best0,
            s0.node_recalcs as f64 / n as f64,
            s1.node_recalcs as f64 / n as f64,
            format!("({:.1}m)", s0.group_members as f64 / n as f64),
            s1.probes as f64 / n as f64,
        );
    }
    println!("(probes0 shown as group members per half-cycle, the scalar's counted column)");
}
