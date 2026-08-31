//! Rung 3 against the pin golden: every pin, every half-cycle.
//!
//! The stimulus traces (scripted res/irq/nmi/rdy runs, a `.stim` beside
//! the `.pins`) replay through the authored input logic like any other
//! trace, except the ones in `UNAUTHORED_STIM`, each skipped with its
//! reason; a trace that leaves that list must replay exactly. Everything
//! else must match rung 0's recording exactly, except the opcodes in
//! `EXPECTED_FAILURES`, which are listed by number per the ladder's rule
//! for undocumented behaviour the datapath cannot express; an unexpected
//! pass there fails too, so the list cannot rot.
//!
//! SKIPS without the recorded files; REQUIRE_PINS=1 insists.

use std::path::PathBuf;

use v6502_micro::machine::MicroCpu;
use v6502_pins::{compare, parse_stim, parse_trace, run};

/// Opcode traces known not to replay, each with the reason measured.
const EXPECTED_FAILURES: &[u8] = &[];

/// Stimulus traces whose inputs are not authored yet, each with why.
/// Empty since the reset freewheel was measured (`reset-probe`) and
/// authored; the machinery stays so a future stimulus can be landed
/// before its authoring, named.
const UNAUTHORED_STIM: &[(&str, &str)] = &[];

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools/pin-golden")
}

#[test]
fn the_pin_golden_replays_through_rung3() {
    let dir = dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        if std::env::var_os("REQUIRE_PINS").is_some() {
            panic!("REQUIRE_PINS=1 but {} is missing", dir.display());
        }
        eprintln!("SKIP: no pin golden at {}", dir.display());
        return;
    };
    let mut names: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "pins"))
        .collect();
    names.sort();
    assert!(!names.is_empty() || std::env::var_os("REQUIRE_PINS").is_none());
    let mutate = std::env::var_os("MUTATE").is_some();

    let (mut ran, mut skipped) = (0usize, 0usize);
    let mut failed: Vec<(String, String)> = Vec::new();
    for path in &names {
        let name = path.file_stem().unwrap().to_string_lossy().to_string();
        if let Some((_, why)) = UNAUTHORED_STIM.iter().find(|(n, _)| *n == name) {
            assert!(path.with_extension("stim").exists(), "{name} is listed as an unauthored stimulus but has no .stim; take it off the list");
            eprintln!("  SKIP {name}: {why}");
            skipped += 1;
            continue;
        }
        let text = std::fs::read_to_string(path).unwrap();
        let trace = parse_trace(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let stim = if trace.header.stim.is_empty() {
            Vec::new()
        } else {
            let stext = std::fs::read_to_string(path.with_extension("stim")).unwrap();
            parse_stim(&stext).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
        };
        let mut cpu = MicroCpu::rung3(&trace.header.loads, trace.header.reset_vector);
        let mut frames = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run(&mut cpu, trace.frames.len() as u64 - 1, &stim)
        }))
        .unwrap_or_default();
        if mutate && ran == 0 && !frames.is_empty() {
            frames[40].db ^= 1;
        }
        ran += 1;
        if frames.is_empty() {
            failed.push((name, "refused mid-run".into()));
            continue;
        }
        if let Err(m) = compare(&trace.frames, &frames) {
            failed.push((name, format!("{m}")));
        }
    }
    eprintln!("replay: {ran} traces through rung 3, {skipped} stimulus trace(s) skipped (listed unauthored)");
    // Split the failures: opcode traces in the expected list are the
    // recorded gap; anything else is a regression.
    let mut unexpected = Vec::new();
    let mut expected_hit = std::collections::HashSet::new();
    for (name, why) in &failed {
        let op = name.strip_prefix("op-").and_then(|s| u8::from_str_radix(s, 16).ok());
        match op {
            Some(o) if EXPECTED_FAILURES.contains(&o) => {
                expected_hit.insert(o);
            }
            _ => unexpected.push(format!("{name}: {why}")),
        }
    }
    for f in &unexpected {
        eprintln!("  FAIL {f}");
    }
    for &o in EXPECTED_FAILURES {
        assert!(expected_hit.contains(&o), "op {o:02x} is listed as failing but replayed clean; take it off the list");
    }
    assert!(unexpected.is_empty(), "{} trace(s) diverged (first: {})", unexpected.len(), unexpected[0]);
}
