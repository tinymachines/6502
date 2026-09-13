//! A record is a memory image: rung 0 on the recorded bus, held to its own
//! pin golden.
//!
//! Every `.pins` file under `tools/pin-golden/` was recorded from rung 0
//! on a flat memory built from its `# load` lines. Here the same chip runs
//! each one again with those loads WITHHELD: the bus answers every read
//! from the record itself (`v6502_sim::recorded`), and every write is held
//! to the write the record shows. If the bus is the memory the program
//! ran on, the pins come out identical; `tests/replay.rs` has already shown
//! they do on flat memory, so a difference here is the recorded bus and
//! nothing else. The scripted RDY traces are in the set, so the rule for a
//! held read (the byte, not the address) is exercised as well.
//!
//! SKIPS without the files; `REQUIRE_PINS=1` insists. `MUTATE=1` flips one
//! bit of one recorded write, which the chip cannot know about, and the
//! bus MUST refuse at exactly that half-cycle: the proof the bus is on the
//! path, not beside it.

use std::path::PathBuf;

use v6502_pins::{parse_stim, parse_trace};
use v6502_sim::pins::{run_recorded, rung0_recorded, Replayed};

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools/pin-golden")
}

#[test]
fn rung0_on_the_recorded_bus_replays_its_own_golden_with_the_loads_withheld() {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir())
        .map(|d| d.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "pins")).collect())
        .unwrap_or_default();
    files.sort();
    if files.is_empty() {
        let msg = format!(
            "no .pins files under {}\n    record them with: cargo run --release -p v6502-pins --example pin-golden",
            dir().display()
        );
        assert!(std::env::var_os("REQUIRE_PINS").is_none(), "REQUIRE_PINS is set but {msg}");
        eprintln!("\n  SKIPPED (recorded bus): {msg}\n");
        return;
    }

    let mutate = std::env::var_os("MUTATE").is_some();
    let mut mutated = false;
    let mut failures = Vec::new();
    let mut steps = 0u64;
    let mut held = 0u64;
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
        // The mutation lands on the first trace that writes at all (the
        // first file in name order is a decimal chain that never does):
        // the last write it shows, so the whole run before it has agreed.
        let mut mutated_at = None;
        if mutate && !mutated {
            if let Some(k) = trace.frames.iter().rposition(|f| !f.rw && f.clk0) {
                trace.frames[k].db ^= 1;
                mutated_at = Some(trace.frames[k].h);
                mutated = true;
                eprintln!("MUTATE=1: flipped db bit 0 of the write at h={} of {}", trace.frames[k].h, trace.header.name);
            }
        }
        // The loads withheld: the reset vector alone serves the reset
        // sequence, and every byte after h = 0 comes from the record.
        let mut cpu = rung0_recorded(trace.frames, &[], trace.header.reset_vector);
        match run_recorded(&mut cpu, trace.header.half_cycles, &stim) {
            Replayed::Agrees { steps: n, held_reads } => {
                steps += n;
                held += held_reads;
                if let Some(m) = mutated_at {
                    failures.push(format!("{}: MUTATE=1 flipped a write at h={m} and the run agreed", trace.header.name));
                }
            }
            Replayed::Refused(r, _) => {
                if mutated_at == Some(r.h) {
                    eprintln!("MUTATE=1: refused at the mutated half-cycle, as it must: {r}");
                    failures.push(format!("{}: MUTATE=1 went red as required", trace.header.name));
                } else {
                    failures.push(format!("{}: refused at {r}", trace.header.name));
                }
            }
            Replayed::Differs { h, field, expected, got, .. } => {
                failures.push(format!("{}: differs at h={h} in {field}: record {} chip {}", trace.header.name, v6502_pins::line(&expected), v6502_pins::line(&got)));
            }
        }
    }
    assert!(!mutate || mutated, "MUTATE=1 found no trace with a write to flip");
    assert!(failures.is_empty(), "{} of {} traces:\n{}", failures.len(), files.len(), failures.join("\n"));
    assert!(held > 0, "no read was answered under RDY low: the scripted RDY traces are missing, so the held-read rule was not exercised");
    eprintln!("recorded bus: {} traces, {steps} half-cycles, loads withheld, all identical; {held} reads answered under RDY low", files.len());
}

/// A window cut from a golden trace stands on its own: rung 0 restored
/// into it agrees with the window's frames to the end, the text
/// round-trips, and `MUTATE=1` flips one frame of the window (a write's
/// byte) so the bus must refuse at that half-cycle. Every trace with room
/// for a window from its first third to its second is cut.
#[test]
fn a_window_cut_from_a_golden_trace_stands_on_its_own() {
    use v6502_pins::{parse_window, write_window};
    use v6502_sim::pins::{cut_window, run_window, rung0_window};
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir())
        .map(|d| d.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "pins")).collect())
        .unwrap_or_default();
    files.sort();
    if files.is_empty() {
        assert!(std::env::var_os("REQUIRE_PINS").is_none(), "REQUIRE_PINS is set but there is no pin golden");
        eprintln!("\n  SKIPPED (windows): no pin golden\n");
        return;
    }
    let mutate = std::env::var_os("MUTATE").is_some();
    let mut cut = 0;
    let mut mutated = false;
    let mut failures = Vec::new();
    for path in &files {
        let text = std::fs::read_to_string(path).unwrap();
        let trace = parse_trace(&text).unwrap();
        if trace.frames.len() < 60 {
            continue;
        }
        let stim = if trace.header.stim.is_empty() {
            vec![]
        } else {
            parse_stim(&std::fs::read_to_string(dir().join(&trace.header.stim)).unwrap()).unwrap()
        };
        let (from, to) = (trace.frames.len() as u64 / 3, trace.frames.len() as u64 * 2 / 3);
        let w = match cut_window(&trace.header.name, &trace, &stim, from, to) {
            Ok(w) => w,
            Err(e) => {
                failures.push(format!("{}: {e}", trace.header.name));
                continue;
            }
        };
        let text = write_window(&w);
        let mut back = parse_window(&text).unwrap_or_else(|e| panic!("{}: the window does not parse: {e}", trace.header.name));
        assert_eq!(back, w, "{}: the window round-trips", trace.header.name);
        let mut mutated_at = None;
        if mutate && !mutated {
            if let Some(k) = back.frames.iter().rposition(|f| !f.rw && f.clk0) {
                back.frames[k].db ^= 1;
                mutated_at = Some(back.frames[k].h);
                mutated = true;
                eprintln!("MUTATE=1: flipped db bit 0 of the write at h={} of {}'s window", back.frames[k].h, trace.header.name);
            }
        }
        let mut cpu = rung0_window(&back).unwrap();
        match run_window(&mut cpu, &back, u64::MAX) {
            Replayed::Agrees { steps, .. } => {
                cut += 1;
                // The cut ends on a phi2, so it may be one longer than asked.
                assert_eq!(steps, back.frames.len() as u64 - 1, "{}: the window is run to its end", trace.header.name);
                assert!(steps == to - from || steps == to - from + 1, "{}: the window is the cut asked for, at most one longer", trace.header.name);
                if let Some(m) = mutated_at {
                    failures.push(format!("{}: MUTATE=1 flipped a write at h={m} and the window agreed", trace.header.name));
                }
            }
            Replayed::Refused(r, _) => {
                if mutated_at == Some(r.h) {
                    failures.push(format!("{}: MUTATE=1 went red as required: {r}", trace.header.name));
                } else {
                    failures.push(format!("{}: window refused at {r}", trace.header.name));
                }
            }
            Replayed::Differs { h, field, expected, got, .. } => {
                failures.push(format!("{}: window differs at h={h} in {field}: record {} chip {}", trace.header.name, v6502_pins::line(&expected), v6502_pins::line(&got)));
            }
        }
    }
    assert!(!mutate || mutated, "MUTATE=1 found no window with a write to flip");
    assert!(failures.is_empty(), "{} failures over {} windows:\n{}", failures.len(), cut + failures.len(), failures.join("\n"));
    assert!(cut > 0, "no trace was long enough to cut");
    eprintln!("windows: {cut} cut from the golden, each restored into and agreed with to its end");
}
