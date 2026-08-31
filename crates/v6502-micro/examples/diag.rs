//! Both sides of a replay divergence, rows around the first mismatch.
//!
//!     cargo run -p v6502-micro --example diag -- op-00

use v6502_micro::machine::MicroCpu;
use v6502_pins::{parse_trace, run};

fn main() {
    let name = std::env::args().nth(1).expect("a trace name");
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tools/pin-golden")
        .join(format!("{name}.pins"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let trace = parse_trace(&text).unwrap();
    let mut cpu = MicroCpu::rung3(&trace.header.loads, trace.header.reset_vector);
    let frames = run(&mut cpu, trace.frames.len() as u64 - 1, &[]);
    let Some(first) = trace.frames.iter().zip(&frames).position(|(a, b)| a != b) else {
        println!("{name}: identical");
        return;
    };
    let lo = first.saturating_sub(6);
    let hi = (first + 4).min(trace.frames.len() - 1).min(frames.len() - 1);
    println!("{name}: first mismatch at h={first}");
    println!("  h    rung0: ab   db rw sy   |  rung3: ab   db rw sy");
    #[allow(clippy::needless_range_loop)] // h is the row label
    for h in lo..=hi {
        let (a, b) = (&trace.frames[h], &frames[h]);
        println!(
            "  {h:3}{} {:04x} {:02x}  {}  {}   |  {:04x} {:02x}  {}  {}",
            if h == first { "*" } else { " " },
            a.ab, a.db, a.rw as u8, a.sync as u8,
            b.ab, b.db, b.rw as u8, b.sync as u8
        );
    }
}
