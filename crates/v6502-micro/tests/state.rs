//! Rung 3's machine value, proven the way the other rungs' are: run to a
//! half-cycle, snapshot, restore into a COLD machine, and the rest of the
//! recorded trace must replay exactly at the pins. The snapshot points sit
//! inside the states most likely to be lost: an interrupt's pushes, a RDY
//! stall, the reset freewheel and the Res-flavoured span, so a field that
//! failed to travel fails a named trace rather than hiding.
//!
//! The comparison is against the RECORDED trace, not against the machine
//! that took the snapshot: the pin golden stays the oracle across the
//! restore boundary. `MUTATE=1` flips one P bit in one restored state and
//! must go red at the push that exposes it.
//!
//! SKIPS without the recorded files; REQUIRE_PINS=1 insists.

use std::path::PathBuf;

use v6502_micro::machine::MicroCpu;
use v6502_pins::{compare, parse_stim, parse_trace, PinEngine, Stim};

/// (trace, snapshot half-cycles). Each h names the frame the snapshot is
/// taken at; the resumed machine must reproduce every later frame.
const POINTS: &[(&str, &[u64])] = &[
    ("fixture-irq-ordinary", &[7, 15, 30]),
    ("fixture-reset-mid-run", &[23, 29, 33, 40]),
    ("fixture-rdy-stall", &[11, 18]),
    ("op-00", &[25]),
];

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools/pin-golden")
}

/// `run` from the pin contract, but from half-cycle `from` on a machine
/// already standing there: stimulus entries the snapshot has absorbed
/// (h < from) are skipped, the rest apply on their recorded schedule.
fn continue_run(cpu: &mut MicroCpu, from: u64, to: u64, stim: &[Stim]) -> Vec<v6502_pins::PinFrame> {
    let mut frames = Vec::new();
    let mut next = stim.iter().position(|s| s.h >= from).unwrap_or(stim.len());
    for h in from..to {
        while next < stim.len() && stim[next].h <= h {
            let s = stim[next];
            cpu.set_inputs(s.res, s.irq, s.nmi, s.rdy, s.so);
            next += 1;
        }
        cpu.half_step();
        frames.push(cpu.pins());
    }
    frames
}

#[test]
fn a_snapshot_resumes_cold_and_the_golden_still_holds() {
    let dir = dir();
    if !dir.join("fixture-irq-ordinary.pins").exists() {
        if std::env::var_os("REQUIRE_PINS").is_some() {
            panic!("REQUIRE_PINS=1 but {} is missing", dir.display());
        }
        eprintln!("SKIP: no pin golden at {}", dir.display());
        return;
    }
    let mutate = std::env::var_os("MUTATE").is_some();
    let mut checked = 0usize;

    for &(name, hs) in POINTS {
        let text = std::fs::read_to_string(dir.join(format!("{name}.pins"))).unwrap();
        let trace = parse_trace(&text).unwrap();
        let stim = if trace.header.stim.is_empty() {
            Vec::new()
        } else {
            parse_stim(&std::fs::read_to_string(dir.join(&trace.header.stim)).unwrap()).unwrap()
        };
        let steps = trace.frames.len() as u64 - 1;

        for &at in hs {
            // Run a machine to the snapshot point the way the replay does.
            let mut a = MicroCpu::rung3(&trace.header.loads, trace.header.reset_vector);
            let head = v6502_pins::run(&mut a, at, &stim);
            assert_eq!(head.len() as u64, at + 1, "{name}: short head");
            let mut st = a.snapshot();
            if mutate && checked == 0 {
                st.p ^= 0x02;
            }

            // A cold machine, restored: the snapshot must round-trip and
            // the rest of the recorded trace must hold at the pins.
            let mut b = MicroCpu::new();
            b.restore(&st).unwrap_or_else(|e| panic!("{name} h={at}: {e}"));
            if !mutate {
                assert_eq!(b.snapshot(), st, "{name} h={at}: snapshot does not round-trip");
                // The wire codec: everything but the memory through the
                // byte form and back, bit for bit.
                let mut d = v6502_micro::machine::MicroState::decode(&st.encode(), 0)
                    .unwrap_or_else(|e| panic!("{name} h={at}: {e}"));
                d.mem.copy_from_slice(&st.mem);
                assert_eq!(d, st, "{name} h={at}: the wire codec does not round-trip");
            }
            let tail = continue_run(&mut b, at, steps, &stim);
            if let Err(m) = compare(&trace.frames[at as usize + 1..], &tail) {
                panic!("{name} resumed at h={at}: {m}");
            }
            checked += 1;
        }
    }
    eprintln!("state: {checked} snapshot points resumed cold against the golden");
    assert!(checked >= 10);

    // Refusals, by name: a state the table cannot stand behind.
    let mut cpu = MicroCpu::new();
    let good = cpu.snapshot();
    let mut bad = good.clone();
    bad.stream = 7;
    assert!(cpu.restore(&bad).unwrap_err().contains("stream 7"));
    let mut bad = good.clone();
    bad.pos = 9999;
    assert!(cpu.restore(&bad).unwrap_err().contains("9999"));
    let mut bad = good.clone();
    bad.hijacked = 9;
    assert!(cpu.restore(&bad).unwrap_err().contains("flavour 9"));
    let mut bad = good.clone();
    bad.mem.truncate(10);
    assert!(cpu.restore(&bad).unwrap_err().contains("65536"));
}
