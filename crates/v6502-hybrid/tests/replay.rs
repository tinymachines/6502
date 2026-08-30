//! Rung 1 against the pin golden: `v6502-pins/tests/replay.rs` with the
//! constructor swapped, and nothing else.

use std::path::PathBuf;
use v6502_hybrid::HybridCpu;
use v6502_pins::{compare, parse_stim, parse_trace, run};
use v6502_sim::FlatMemory;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools/pin-golden")
}

#[test]
fn rung1_replays_the_pin_golden() {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir())
        .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "pins")).collect())
        .unwrap_or_default();
    files.sort();
    if files.is_empty() {
        let msg = format!("no .pins files under {}\n    record them with: cargo run --release -p v6502-pins --example pin-golden", dir().display());
        assert!(std::env::var_os("REQUIRE_PINS").is_none(), "REQUIRE_PINS is set but {msg}");
        eprintln!("\n  SKIPPED (pin golden): {msg}\n");
        return;
    }
    let mutate = std::env::var_os("MUTATE").is_some();
    let mut failures = Vec::new();
    let mut frames = 0usize;
    for (i, path) in files.iter().enumerate() {
        let text = std::fs::read_to_string(path).unwrap();
        let mut trace = parse_trace(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let stim = if trace.header.stim.is_empty() {
            vec![]
        } else {
            parse_stim(&std::fs::read_to_string(dir().join(&trace.header.stim)).unwrap()).unwrap()
        };
        if mutate && i == 0 {
            let k = trace.frames.len() / 2;
            trace.frames[k].db ^= 1;
            eprintln!("MUTATE=1: flipped db bit 0 at h={} of {}", trace.frames[k].h, trace.header.name);
        }
        let mut cpu: HybridCpu<FlatMemory> = HybridCpu::<FlatMemory>::rung1(&trace.header.loads, trace.header.reset_vector);
        let got = run(&mut cpu, trace.header.half_cycles, &stim);
        assert_eq!(got.len(), trace.frames.len(), "{}: replay length", trace.header.name);
        frames += got.len();
        if let Err(m) = compare(&trace.frames, &got) {
            failures.push(format!("{}: {m}", trace.header.name));
        }
    }
    assert!(failures.is_empty(), "{} of {} traces differ:\n{}", failures.len(), files.len(), failures.join("\n"));
    eprintln!("pin golden through rung 1: {} traces, {frames} frames, all identical", files.len());
}
