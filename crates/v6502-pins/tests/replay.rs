//! Rung 0 against its own pin golden.
//!
//! Every `.pins` file under `tools/pin-golden/` is replayed through the
//! switch-level `Cpu`, script and all, and compared frame for frame. This is
//! the test every other rung copies: swap the engine constructor and nothing
//! else changes.
//!
//! The files are generated (`cargo run --release -p v6502-pins --example
//! pin-golden`) and gitignored, so without them this SKIPS; `REQUIRE_PINS=1`
//! makes their absence a failure, the same convention as `V6502_REQUIRE_GOLDEN`.
//!
//! `MUTATE=1` flips one bit of one replayed frame (bit 0 of `db`, halfway
//! through the first trace) and the test MUST go red. A comparison that has
//! never been seen to fail is not a test.

use std::path::PathBuf;
use v6502_pins::{compare, parse_stim, parse_trace, run};
use v6502_sim::pins::rung0;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools/pin-golden")
}

#[test]
fn rung0_replays_its_own_pin_golden() {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir())
        .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "pins")).collect())
        .unwrap_or_default();
    files.sort();
    if files.is_empty() {
        let msg = format!(
            "no .pins files under {}\n    record them with: cargo run --release -p v6502-pins --example pin-golden",
            dir().display()
        );
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
            let s = std::fs::read_to_string(dir().join(&trace.header.stim))
                .unwrap_or_else(|e| panic!("{}: {}: {e}", path.display(), trace.header.stim));
            parse_stim(&s).unwrap_or_else(|e| panic!("{}: {e}", trace.header.stim))
        };
        if mutate && i == 0 {
            let k = trace.frames.len() / 2;
            trace.frames[k].db ^= 1;
            eprintln!("MUTATE=1: flipped db bit 0 at h={} of {}", trace.frames[k].h, trace.header.name);
        }

        let mut cpu = rung0(&trace.header.loads, trace.header.reset_vector);
        let got = run(&mut cpu, trace.header.half_cycles, &stim);
        assert_eq!(got.len(), trace.frames.len(), "{}: replay length", trace.header.name);
        frames += got.len();
        if let Err(m) = compare(&trace.frames, &got) {
            failures.push(format!("{}: {m}", trace.header.name));
        }
    }
    assert!(failures.is_empty(), "{} of {} traces differ:\n{}", failures.len(), files.len(), failures.join("\n"));
    eprintln!("pin golden: {} traces, {frames} frames, all identical", files.len());
}
