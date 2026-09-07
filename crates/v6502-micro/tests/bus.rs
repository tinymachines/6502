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
use v6502_pins::PinEngine;
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
    /// The selector's looks: not counted, not lied to (the lie is about
    /// what crosses the pins).
    fn peek(&mut self, a: u16) -> u8 {
        self.mem[a as usize]
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
    // Every read cycle asks the bus exactly once (a PPU status register
    // cleared by a read must see one read); the reset sequence's vector
    // and seed reads come before h=0 and are the surplus.
    let read_cycles = trace.frames.iter().filter(|f| f.rw && !f.clk0).count() as u64;
    assert!(reads >= read_cycles && reads <= read_cycles + 8, "the bus answered {reads} reads for {read_cycles} read cycles; each cycle must ask once");

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

/// A bus whose byte at the latch differs from the byte on the pins: the
/// pins must show the phi1 byte and the register the late one.
struct Late {
    mem: Vec<u8>,
    at: u16,
    late: u8,
}

impl MicroBus for Late {
    fn read(&mut self, a: u16) -> u8 {
        self.mem[a as usize]
    }
    fn write(&mut self, a: u16, v: u8) {
        self.mem[a as usize] = v;
    }
    fn read_late(&mut self, a: u16) -> Option<u8> {
        (a == self.at).then_some(self.late)
    }
}

#[test]
fn a_bus_that_hands_a_different_byte_at_the_latch_keeps_the_pins_and_moves_the_register() {
    // LDA $0010; STA $0020; spin. The bus shows $11 at $0010 on the pins
    // and hands $ee at the latch.
    let prog = vec![0xad, 0x10, 0x00, 0x8d, 0x20, 0x00, 0x4c, 0x06, 0x02];
    let mut mem = vec![0u8; 0x10000];
    mem[0x0200..0x0200 + prog.len()].copy_from_slice(&prog);
    mem[0x0010] = 0x11;
    mem[0xfffc] = 0x00;
    mem[0xfffd] = 0x02;
    let mut cpu = MicroCpu::new();
    cpu.bus = Some(Box::new(Late { mem, at: 0x0010, late: 0xee }));
    cpu.power_cycle();
    let mut read_frames = Vec::new();
    let mut stored = None;
    for _ in 0..40 {
        PinEngine::half_step(&mut cpu);
        let f = PinEngine::pins(&cpu);
        if f.rw && f.ab == 0x0010 {
            read_frames.push(f.db);
        }
        if !f.rw && f.clk0 && f.ab == 0x0020 {
            stored = Some(f.db);
        }
    }
    assert_eq!(read_frames, vec![0x11, 0x11], "the pins show the bus's phi1 byte through both halves of the read");
    assert_eq!(stored, Some(0xee), "the register took the byte handed at the latch");
}

/// A bus that answers a read of one address with a byte that changes on
/// every ask: what a port with side effects looks like.
struct Counting {
    mem: Vec<u8>,
    at: u16,
    asks: u8,
}

impl MicroBus for Counting {
    fn read(&mut self, a: u16) -> u8 {
        if a == self.at {
            self.asks += 1;
            return 0x10 + self.asks;
        }
        self.mem[a as usize]
    }
    fn write(&mut self, a: u16, v: u8) {
        self.mem[a as usize] = v;
    }
}

#[test]
fn a_read_held_by_rdy_asks_the_bus_at_every_held_phi2_and_keeps_the_last_byte() {
    // LDA $0010; STA $0020; spin. RDY falls on the read's first frame
    // and rises four half-cycles later, so the cycle is held for two
    // more phi2s: the 6502 latches DL on each, and the register takes
    // the last (measured on the 2A03's die through its joypad port:
    // the re-run read clocks the pad again and the core takes the next
    // bit). MUTATE_HELD=1 keeps the first byte and must go red.
    let prog = vec![0xad, 0x10, 0x00, 0x8d, 0x20, 0x00, 0x4c, 0x06, 0x02];
    let mut mem = vec![0u8; 0x10000];
    mem[0x0200..0x0200 + prog.len()].copy_from_slice(&prog);
    mem[0xfffc] = 0x00;
    mem[0xfffd] = 0x02;
    let mut cpu = MicroCpu::new();
    cpu.bus = Some(Box::new(Counting { mem, at: 0x0010, asks: 0 }));
    cpu.power_cycle();
    let mut fell_at = None;
    let mut stored = None;
    let mut held_frames = 0;
    for h in 0..60u64 {
        let f = PinEngine::pins(&cpu);
        if f.rw && f.ab == 0x0010 && fell_at.is_none() {
            fell_at = Some(h);
            cpu.set_inputs(true, true, true, false, false);
        }
        if let Some(t) = fell_at {
            if h == t + 4 {
                cpu.set_inputs(true, true, true, true, false);
            }
            if f.rw && f.ab == 0x0010 {
                held_frames += 1;
            }
        }
        PinEngine::half_step(&mut cpu);
        let f = PinEngine::pins(&cpu);
        if !f.rw && f.clk0 && f.ab == 0x0020 {
            stored = Some(f.db);
        }
    }
    assert!(held_frames >= 6, "the read was held: {held_frames} frames at $0010 (two, plus the held ones)");
    let stored = stored.expect("the store happened");
    assert!(stored > 0x11, "the register took a later ask: stored {stored:02x}, the first byte was 11 (MUTATE_HELD keeps it)");
    let asks = stored - 0x10;
    assert_eq!(asks as usize, (held_frames - 2) / 2 + 1, "one ask per phi2 the cycle was on the bus: {asks} asks over {held_frames} frames");
    eprintln!("held read: {held_frames} frames at $0010, the register took ask #{}", stored - 0x10);
}
