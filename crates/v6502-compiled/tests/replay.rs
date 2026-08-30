//! Rung 2 against the pin golden, lane 0. The constructor swapped, nothing
//! else; the layout pullups come from the netlist crate as a dev-dependency
//! because the runtime carries no netlist.

use std::path::PathBuf;
use v6502_compiled::Machines;
use v6502_pins::{compare, parse_stim, parse_trace, run};

fn pullups() -> Vec<bool> {
    let nl = v6502_netlist::mos6502();
    (0..nl.node_count()).map(|i| nl.pullups().get(i)).collect()
}

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools/pin-golden")
}

#[test]
fn rung2_replays_the_pin_golden() {
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
    let pu = pullups();
    let mutate = std::env::var_os("MUTATE").is_some();
    let only = std::env::var("ONLY").ok();
    let mut failures = Vec::new();
    let mut frames = 0usize;
    let mut ran = 0usize;
    for (i, path) in files.iter().enumerate() {
        let text = std::fs::read_to_string(path).unwrap();
        let mut trace = parse_trace(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        if let Some(o) = &only {
            if !trace.header.name.contains(o.as_str()) {
                continue;
            }
        }
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
        let mut m = Machines::new(&pu);
        m.load_all(&trace.header.loads, trace.header.reset_vector);
        let got = run(&mut m, trace.header.half_cycles, &stim);
        assert_eq!(got.len(), trace.frames.len(), "{}: replay length", trace.header.name);
        frames += got.len();
        ran += 1;
        if let Err(e) = compare(&trace.frames, &got) {
            failures.push(format!("{}: {e}", trace.header.name));
        }
    }
    assert!(failures.is_empty(), "{} of {ran} traces differ:\n{}", failures.len(), failures.join("\n"));
    eprintln!("pin golden through rung 2: {ran} traces, {frames} frames, all identical");
}
