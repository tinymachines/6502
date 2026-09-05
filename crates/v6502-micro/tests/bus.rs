//! The bus hook: a host that is not flat memory serves every read and
//! write at the moment the core services it. Held to the golden two
//! ways: a bus that is flat memory in disguise replays the reference's
//! program exactly (so the hook changes nothing when it changes nothing),
//! and a bus that lies about one byte is seen at the pins on the very
//! read it lies on (so the hook is the path, not a bystander).
//!
//! SKIPS without the recorded files; REQUIRE_PINS=1 insists.

use std::cell::Cell;
use std::path::PathBuf;
use std::rc::Rc;

use v6502_micro::machine::{MicroBus, MicroCpu};
use v6502_pins::{compare, parse_trace, run};

struct Flat {
    mem: Vec<u8>,
    reads: Rc<Cell<u64>>,
    lie_at: Option<u16>,
}

impl MicroBus for Flat {
    fn read(&mut self, a: u16) -> u8 {
        self.reads.set(self.reads.get() + 1);
        let v = self.mem[a as usize];
        if self.lie_at == Some(a) {
            v ^ 0x01
        } else {
            v
        }
    }
    fn write(&mut self, a: u16, v: u8) {
        self.mem[a as usize] = v;
    }
}

fn golden() -> Option<v6502_pins::Trace> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools/pin-golden/golden.pins");
    let text = std::fs::read_to_string(p).ok()?;
    Some(parse_trace(&text).unwrap())
}

fn on_bus(trace: &v6502_pins::Trace, lie_at: Option<u16>) -> (Vec<v6502_pins::PinFrame>, u64) {
    let mut mem = vec![0u8; 0x10000];
    for l in &trace.header.loads {
        mem[l.org as usize..l.org as usize + l.bytes.len()].copy_from_slice(&l.bytes);
    }
    mem[0xfffc] = trace.header.reset_vector as u8;
    mem[0xfffd] = (trace.header.reset_vector >> 8) as u8;
    let reads = Rc::new(Cell::new(0));
    let mut cpu = MicroCpu::new();
    cpu.bus = Some(Box::new(Flat { mem, reads: reads.clone(), lie_at }));
    cpu.power_cycle();
    let frames = run(&mut cpu, trace.frames.len() as u64 - 1, &[]);
    (frames, reads.get())
}

#[test]
fn a_bus_that_is_flat_memory_replays_the_golden_and_is_asked_for_every_read() {
    let Some(trace) = golden() else {
        if std::env::var_os("REQUIRE_PINS").is_some() {
            panic!("REQUIRE_PINS=1 but no golden.pins");
        }
        eprintln!("SKIP: no pin golden");
        return;
    };
    let (frames, reads) = on_bus(&trace, None);
    compare(&trace.frames, &frames).unwrap_or_else(|m| panic!("through the bus: {m}"));
    let read_frames = trace.frames.iter().filter(|f| f.rw && !f.clk0).count() as u64;
    assert!(reads >= read_frames, "the bus answered {reads} reads for {read_frames} read half-cycles; it is not on the path");
    eprintln!("golden through a MicroBus: {} frames exact, {reads} bus reads", frames.len());
}

#[test]
fn a_bus_that_lies_about_one_byte_is_seen_on_that_read() {
    let Some(trace) = golden() else {
        if std::env::var_os("REQUIRE_PINS").is_some() {
            panic!("REQUIRE_PINS=1 but no golden.pins");
        }
        eprintln!("SKIP: no pin golden");
        return;
    };
    // The first operand the reference's program reads after its fetch.
    let target = trace.frames.iter().find(|f| f.rw && !f.sync && f.ab >= 0x0010).map(|f| f.ab).unwrap();
    let (frames, _) = on_bus(&trace, Some(target));
    let m = compare(&trace.frames, &frames).expect_err("a lying bus must be seen");
    assert_eq!(m.field, "db", "the lie shows as the data byte");
    assert_eq!(m.expected.ab, target, "on the very read it lied on");
    eprintln!("a lie at ${target:04x} surfaced at h={}: {}", m.h, m.field);
}
