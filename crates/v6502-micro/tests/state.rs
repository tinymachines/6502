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

/// A register a read changes: every read returns the next count, the way
/// the 2C02's $2002 clears its vblank flag. Everything else is flat
/// memory. Shared through a handle so a second machine can be given a
/// copy of the bus exactly as it stood at the snapshot.
#[derive(Clone)]
struct Counting {
    mem: Vec<u8>,
    next: u8,
    asked: u32,
}

struct Handle(std::rc::Rc<std::cell::RefCell<Counting>>);

const REG: u16 = 0x2002;

impl v6502_micro::machine::MicroBus for Handle {
    fn read(&mut self, a: u16) -> u8 {
        let mut c = self.0.borrow_mut();
        if a == REG {
            c.asked += 1;
            c.next = c.next.wrapping_add(1);
            c.next
        } else {
            c.mem[a as usize]
        }
    }
    fn write(&mut self, a: u16, v: u8) {
        self.0.borrow_mut().mem[a as usize] = v;
    }
    fn peek(&mut self, a: u16) -> u8 {
        self.0.borrow().mem[a as usize]
    }
}

/// A snapshot between the two halves of a read cycle. The byte is taken
/// from the bus as the clock falls and consumed at phi2, so a state that
/// dropped it would ask the bus AGAIN on resume: a second read of a
/// register a read changes, and the wrong byte on the pins. The golden
/// cannot see this, because re-reading flat memory is harmless; found by
/// the 2A03's own state test (tinymachines/2a03 a7fa5f5, split at h=74).
/// Every read cycle of `LDA $2002` is split, not one chosen point, so
/// the fetch, both operands and the register read are all covered.
/// MUTATE_PHI1=1 drops the byte from each restored state and must go red.
#[test]
fn a_snapshot_between_phi1_and_phi2_does_not_read_the_bus_twice() {
    use std::cell::RefCell;
    use std::rc::Rc;
    use v6502_pins::PinEngine;

    // $0200: LDA $2002 / STA $10 / JMP $0200
    let mut mem = vec![0u8; 0x10000];
    mem[0x200..0x208].copy_from_slice(&[0xad, 0x02, 0x20, 0x85, 0x10, 0x4c, 0x00, 0x02]);
    mem[0xfffc] = 0x00;
    mem[0xfffd] = 0x02;
    let boot = |mem: &Vec<u8>| {
        let bus = Rc::new(RefCell::new(Counting { mem: mem.clone(), next: 0, asked: 0 }));
        let mut cpu = MicroCpu::new();
        cpu.bus = Some(Box::new(Handle(bus.clone())));
        cpu.power_cycle();
        (cpu, bus)
    };

    // Where the phi1 reads fall: the half-steps whose frame is a read
    // with the clock low, so the NEXT half-step is the phi2 consuming it.
    const SPAN: u64 = 120;
    const TAIL: usize = 40;
    let (mut probe, _) = boot(&mem);
    let mut points = Vec::new();
    for n in 1..=SPAN {
        probe.half_step();
        let f = probe.pins();
        if f.rw && !f.clk0 {
            points.push((n, f.h, f.ab));
        }
    }

    let mutate = std::env::var_os("MUTATE_PHI1").is_some();
    let mut splits = 0;
    let mut on_register = 0;
    for &(n, h, ab) in &points {
        // The reference is a machine that is never interrupted: booted,
        // run to the split, and simply carried on.
        let (mut a, abus) = boot(&mem);
        for _ in 0..n {
            a.half_step();
        }
        #[allow(unused_mut)]
        let mut st = a.snapshot();
        if mutate {
            st.phi1_read = None;
        }
        // The resumed machine: that state, restored into a cold core, on
        // a copy of the bus exactly as it stood.
        let bbus = Rc::new(RefCell::new(abus.borrow().clone()));
        let mut b = MicroCpu::new();
        b.bus = Some(Box::new(Handle(bbus.clone())));
        b.restore(&st).unwrap();

        let (mut fa, mut fb) = (Vec::new(), Vec::new());
        for _ in 0..TAIL {
            a.half_step();
            b.half_step();
            fa.push(a.pins());
            fb.push(b.pins());
        }
        if let Err(m) = compare(&fa, &fb) {
            panic!("split at h={h} (ab {ab:04x}): {m}");
        }
        assert_eq!(
            bbus.borrow().asked,
            abus.borrow().asked,
            "split at h={h} (ab {ab:04x}): the register was asked a different number of times"
        );
        splits += 1;
        if ab == REG {
            on_register += 1;
        }
    }
    eprintln!("state: {splits} read cycles split between phi1 and phi2, {on_register} on the register");

    // The wire form carries the byte, and a version 1 value (which
    // predates it) still decodes, as None: what restoring it did then.
    let (mut a, _) = boot(&mem);
    let &(n, _, _) = points.iter().find(|p| p.2 == REG).unwrap();
    for _ in 0..n {
        a.half_step();
    }
    let st = a.snapshot();
    assert!(st.phi1_read.is_some(), "the split point holds no byte, so it checks nothing");
    let blob = st.encode();
    let mut d = v6502_micro::machine::MicroState::decode(&blob, 0).unwrap();
    d.mem.copy_from_slice(&st.mem);
    assert_eq!(d, st, "the wire codec drops the phi1 byte");
    let mut v1 = blob[..blob.len() - 2].to_vec();
    v1[0] = 1;
    let old = v6502_micro::machine::MicroState::decode(&v1, 0).unwrap();
    assert_eq!(old.phi1_read, None);
    let mut bad = blob.clone();
    let at = bad.len() - 2;
    bad[at] = 7;
    assert!(v6502_micro::machine::MicroState::decode(&bad, 0).unwrap_err().contains("phi1_read"));
    assert!(on_register >= 3, "the split never landed on the register read");
}
