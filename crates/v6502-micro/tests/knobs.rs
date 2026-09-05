//! The two configuration knobs another chip's core needs from rung 3,
//! each proven to do what it says against the pin golden:
//!
//! - `set_decimal_adjust(false)`: the 2A03's core. The three decimal
//!   fixtures must then DIVERGE from the recording, and exactly at the
//!   stores of the results (the binary sum where the 6502 stored the
//!   adjusted one), while every non-decimal trace still replays exactly.
//!   A knob that changed nothing, or changed anything else, fails here.
//! - `set_stack_at_h0(Some(s))`: another die's measured power-on stack
//!   pointer. The BRK fixture's first push must land at $0100 + s, and
//!   every stack address in the trace must sit at the recording's
//!   address plus the seed's offset, nothing else differing.
//!
//! SKIPS without the recorded files; REQUIRE_PINS=1 insists.

use std::path::PathBuf;

use v6502_micro::machine::MicroCpu;
use v6502_pins::{compare, first_difference, parse_stim, parse_trace, run, Trace};

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools/pin-golden")
}

fn load(name: &str) -> Option<Trace> {
    let text = std::fs::read_to_string(dir().join(format!("{name}.pins"))).ok()?;
    Some(parse_trace(&text).unwrap())
}

fn skip_or_panic(what: &str) -> bool {
    if std::env::var_os("REQUIRE_PINS").is_some() {
        panic!("REQUIRE_PINS=1 but {what}");
    }
    eprintln!("SKIP: {what}");
    true
}

#[test]
fn the_decimal_adjust_disconnected_is_binary_at_the_stores_and_nowhere_else() {
    let Some(adc) = load("decimal-adc") else {
        if skip_or_panic("no pin golden") {
            return;
        }
        unreachable!()
    };
    // The decimal fixtures: every result lands in a STA (phi2 write to
    // $80..$83) and every flag set in a PHP. With the adjust off, the
    // differing frames must be exactly those writes, and the bytes the
    // binary sums of the program's own operands.
    let expect: &[(&str, &[(u16, u8)])] = &[
        // 19+28, 09+01, 99+99+1 (=0x133), 50+50; then the last PHP's C
        // clears (binary a0 carries nothing) and V stays set.
        ("decimal-adc", &[(0x0080, 0x41), (0x0081, 0x0a), (0x0082, 0x33), (0x0083, 0xa0), (0x01fa, 0xfc)]),
        // 42-13, 10-05, 00-01 with C set.
        ("decimal-sbc", &[(0x0080, 0x2f), (0x0081, 0x0b), (0x0082, 0xff)]),
        // 1f+01 binary; 9a-00, the compare and the post-CLD add already were.
        ("decimal-mixed", &[(0x0080, 0x20)]),
    ];
    let _ = adc;
    for (name, stores) in expect {
        let trace = load(name).unwrap();
        let mut cpu = MicroCpu::rung3(&trace.header.loads, trace.header.reset_vector);
        cpu.set_decimal_adjust(false);
        let got = run(&mut cpu, trace.frames.len() as u64 - 1, &[]);
        let mut diffs = Vec::new();
        for (e, g) in trace.frames.iter().zip(&got) {
            if let Some(f) = first_difference(e, g) {
                assert_eq!(f, "db", "{name} h={}: {f} differs, not a data byte", e.h);
                assert!(!e.rw && e.clk0, "{name} h={}: a byte differs off a write's phi2", e.h);
                diffs.push((e.ab, g.db, e.db));
            }
        }
        let want: Vec<(u16, u8)> = stores.to_vec();
        let got_pairs: Vec<(u16, u8)> = diffs.iter().map(|&(a, g, _)| (a, g)).collect();
        assert_eq!(got_pairs, want, "{name}: the binary stores (recorded decimal bytes {:02x?})", diffs.iter().map(|d| d.2).collect::<Vec<_>>());
        eprintln!("{name}: adjust off, {} stores binary, everything else as recorded", diffs.len());
    }
    // And a trace with no decimal in it is untouched by the knob.
    let plain = load("golden").unwrap();
    let mut cpu = MicroCpu::rung3(&plain.header.loads, plain.header.reset_vector);
    cpu.set_decimal_adjust(false);
    let got = run(&mut cpu, plain.frames.len() as u64 - 1, &[]);
    compare(&plain.frames, &got).unwrap_or_else(|m| panic!("golden with the adjust off: {m}"));
}

#[test]
fn a_seeded_stack_pointer_moves_every_stack_address_by_its_offset_and_nothing_else() {
    let Some(trace) = load("fixture-irq-ordinary") else {
        if skip_or_panic("no pin golden") {
            return;
        }
        unreachable!()
    };
    let stim = parse_stim(&std::fs::read_to_string(dir().join("fixture-irq-ordinary.stim")).unwrap()).unwrap();
    // The recorder's own S at h=0 is what the trace's first stack access
    // reveals; seed the 2A03's measured value and expect the offset.
    let first_stack = trace.frames.iter().find(|f| f.ab >> 8 == 1).expect("a stack access");
    let recorded_s = first_stack.ab as u8;
    let seed = 0xbdu8;
    let offset = recorded_s.wrapping_sub(seed);
    assert_ne!(offset, 0, "the seed must differ from the recorder's S for this to test anything");
    let mut cpu = MicroCpu::rung3(&trace.header.loads, trace.header.reset_vector);
    cpu.set_stack_at_h0(Some(seed));
    let got = run(&mut cpu, trace.frames.len() as u64 - 1, &stim);
    let mut moved = 0;
    for (e, g) in trace.frames.iter().zip(&got) {
        if e.ab >> 8 == 1 {
            assert_eq!(g.ab >> 8, 1, "h={}: a stack access left page 1", e.h);
            assert_eq!((e.ab as u8).wrapping_sub(g.ab as u8), offset, "h={}: stack address off by the wrong amount", e.h);
            moved += 1;
            let e2 = v6502_pins::PinFrame { ab: g.ab, ..*e };
            assert_eq!(first_difference(&e2, g), None, "h={}: something besides the stack address differs", e.h);
        } else {
            assert_eq!(first_difference(e, g), None, "h={}: a non-stack frame differs", e.h);
        }
    }
    assert!(moved >= 6, "too few stack accesses to mean anything: {moved}");
    eprintln!("stack seeded ${seed:02x}: {moved} stack frames moved by ${offset:02x}, nothing else differs");
}
