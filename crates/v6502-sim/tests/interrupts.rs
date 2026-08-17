//! The interrupt sequence, and the BRK that gets lost.
//!
//! The 6502 has no separate interrupt sequencer. Its predecode logic forces the
//! instruction register to `$00` when an interrupt is pending, so the hardware
//! runs the *BRK* sequence for IRQ, NMI and reset alike -- push PCH, push PCL,
//! push P, fetch a vector -- and the only differences are which vector is used
//! and whether the B flag goes onto the stack set or clear.
//!
//! That is an elegant saving and it has a consequence: a real BRK opcode being
//! fetched at the moment an interrupt arrives has nothing left to distinguish
//! it, and is serviced as the interrupt instead. The bug is documented, and
//! Michael Steil's 27C3 talk explains the mechanism. These tests do not take
//! either on trust -- they ask this chip.
//!
//! Everything here is measured in offsets from the BRK's *own* opcode fetch,
//! found by running until `sync` with the right address on the bus. A remembered
//! half-cycle number would shift silently the first time reset timing moved.

use std::sync::Arc;

use v6502_netlist::mos6502;
use v6502_sim::{bus::Bus, bus::FlatMemory, cpu::Cpu};

const B: u8 = 0x10;

/// A memory that records what the chip pushes onto the stack page.
struct Stacked {
    inner: FlatMemory,
    pushes: Vec<u8>,
}

impl Bus for Stacked {
    fn read(&mut self, addr: u16) -> u8 {
        self.inner.read(addr)
    }
    fn write(&mut self, addr: u16, value: u8) {
        if (0x0100..0x0200).contains(&addr) {
            self.pushes.push(value);
        }
        self.inner.write(addr, value)
    }
    fn checkpoint(&mut self) -> Option<Vec<u8>> {
        self.inner.checkpoint()
    }
    fn rollback(&mut self, token: &[u8]) -> bool {
        self.inner.rollback(token)
    }
}

/// The address of the BRK in the fixture below.
const BRK_AT: u16 = 0x0203;

/// `CLI`, two `NOP`s, then `BRK` at [`BRK_AT`], then padding.
///
/// The `CLI` matters: reset leaves the interrupt disable flag set, so without it
/// no IRQ would ever be delivered and every trial would report a plain BRK.
fn boot() -> Cpu<Stacked> {
    let mut mem = FlatMemory::new();
    let mut prog = vec![0x58, 0xea, 0xea, 0x00];
    prog.extend([0xea; 8]);
    mem.load(0x0200, &prog);
    mem.set_reset_vector(0x0200);
    // IRQ and BRK share the vector at $FFFE. The handler only has to exist.
    mem.load(0x0300, &[0x4c, 0x00, 0x03]); // JMP $0300
    mem.load(0xfffe, &[0x00, 0x03]);
    let mut cpu = Cpu::new(Arc::new(mos6502()), Stacked { inner: mem, pushes: Vec::new() }).unwrap();
    cpu.reset();
    cpu
}

/// Step until the chip announces an opcode fetch at `addr`.
fn run_to_fetch(cpu: &mut Cpu<Stacked>, addr: u16) {
    for _ in 0..400 {
        cpu.half_step();
        if cpu.sync() && cpu.address_bus() == addr {
            return;
        }
    }
    panic!("never reached an opcode fetch at ${addr:04X}");
}

/// How many half-cycles separate the landmark fetch from the BRK's own fetch.
///
/// Measured rather than assumed, so the trials below can be expressed as "this
/// many half-cycles before the BRK is fetched" without anyone writing a number
/// down.
fn landmark_to_brk() -> u64 {
    let mut cpu = boot();
    run_to_fetch(&mut cpu, BRK_AT - 2);
    for n in 1..100 {
        cpu.half_step();
        if cpu.sync() && cpu.address_bus() == BRK_AT {
            return n;
        }
    }
    panic!("no BRK fetch after the landmark");
}

/// Run the BRK, optionally asserting IRQ `lead` half-cycles before its fetch.
///
/// Returns the pushed return address and the pushed status byte -- the two
/// things that say whether the chip serviced a BRK or an interrupt.
fn trial(lead: Option<u64>) -> (u16, u8) {
    let mut cpu = boot();
    run_to_fetch(&mut cpu, BRK_AT - 2);
    if let Some(lead) = lead {
        for _ in 0..landmark_to_brk().saturating_sub(lead) {
            cpu.half_step();
        }
        cpu.set_irq(false); // active low, so false asserts it
    } else {
        run_to_fetch(&mut cpu, BRK_AT);
    }
    cpu.bus.pushes.clear();
    for _ in 0..30 {
        cpu.step_cycle();
    }
    let p = &cpu.bus.pushes;
    assert!(p.len() >= 3, "expected three pushes, saw {}", p.len());
    (u16::from_le_bytes([p[1], p[0]]), p[2])
}

#[test]
fn brk_alone_pushes_its_own_address_plus_two_with_b_set() {
    let (pc, status) = trial(None);
    // BRK is a one-byte opcode that skips a second byte, so the return address
    // is two past it: the padding byte is the signature a handler may read.
    assert_eq!(pc, BRK_AT + 2, "BRK should push PC+2");
    assert_eq!(status & B, B, "BRK should push B set");
}

#[test]
fn an_irq_during_the_brk_fetch_loses_the_brk() {
    // The window is measured, not assumed: assert IRQ at every offset either
    // side of the BRK's fetch and record which reading each produces.
    let readings: Vec<(u64, u16, u8)> =
        (1..=10).map(|lead| { let (pc, s) = trial(Some(lead)); (lead, pc, s) }).collect();

    let lost: Vec<u64> = readings
        .iter()
        .filter(|(_, pc, s)| *pc == BRK_AT && s & B == 0)
        .map(|(lead, _, _)| *lead)
        .collect();

    // Asserted 3 to 6 half-cycles before the fetch, the chip pushes the address
    // of the BRK itself with B clear: the handler cannot tell a BRK happened,
    // and the BRK's own skip past its signature byte never occurs.
    assert_eq!(lost, vec![3, 4, 5, 6], "the window in which the BRK is lost");

    // Too late to be sampled: the BRK runs as a BRK.
    for &lead in &[1u64, 2] {
        let (pc, status) = trial(Some(lead));
        assert_eq!(pc, BRK_AT + 2, "IRQ {lead} half-cycles early should miss the sampling point");
        assert_eq!(status & B, B);
    }

    // Early enough to be an ordinary interrupt of the preceding instruction,
    // which returns to that instruction rather than to the BRK.
    for &lead in &[7u64, 8, 9, 10] {
        let (pc, status) = trial(Some(lead));
        assert_eq!(pc, BRK_AT - 1, "IRQ {lead} half-cycles early is an ordinary interrupt");
        assert_eq!(status & B, 0, "an ordinary IRQ pushes B clear");
    }
}

#[test]
fn reset_runs_the_same_sequence_but_writes_nothing() {
    // The strongest evidence that one sequence serves all four: reset performs
    // the same three pushes, with the writes suppressed. Nothing lands in the
    // stack page, but the stack pointer still moves by three.
    let mut cpu = boot();
    run_to_fetch(&mut cpu, 0x0200);
    let before = cpu.registers().s;
    cpu.bus.pushes.clear();

    cpu.set_res(false);
    for _ in 0..4 {
        cpu.step_cycle();
    }
    cpu.set_res(true);
    for _ in 0..12 {
        cpu.step_cycle();
    }

    assert!(cpu.bus.pushes.is_empty(), "reset must not write to the stack page");
    assert_eq!(
        before.wrapping_sub(cpu.registers().s),
        3,
        "reset should decrement S by three, one per suppressed push"
    );
}
