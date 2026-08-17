//! Behavioural tests against the documented 6502, independent of the reference.
//!
//! The golden trace proves this engine agrees with visual6502. That is not the
//! same as agreeing with a 6502 -- a shared misreading of the die data would
//! pass both. These tests check the other oracle: published instruction timings,
//! bus transaction patterns and flag semantics.
//!
//! Cycle counts come from the standard tables (e.g. the NMOS 6502 datasheet):
//! they are properties of the silicon, and nothing here can be tuned to make
//! them pass.

use std::sync::Arc;

use v6502_netlist::mos6502;
use v6502_sim::{bus::Bus, bus::FlatMemory, cpu::Cpu};

const C: u8 = 0x01;
const Z: u8 = 0x02;
const D: u8 = 0x08;
const V: u8 = 0x40;
const N: u8 = 0x80;

/// Wraps a bus and records the transactions the CPU actually issues.
struct Recording {
    inner: FlatMemory,
    log: Vec<Txn>,
    recording: bool,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
struct Txn {
    addr: u16,
    value: u8,
    write: bool,
}

impl Recording {
    fn new(inner: FlatMemory) -> Self {
        Recording { inner, log: Vec::new(), recording: false }
    }
}

impl Bus for Recording {
    fn read(&mut self, addr: u16) -> u8 {
        let value = self.inner.read(addr);
        if self.recording {
            self.log.push(Txn { addr, value, write: false });
        }
        value
    }
    fn write(&mut self, addr: u16, value: u8) {
        if self.recording {
            self.log.push(Txn { addr, value, write: true });
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

/// Boot a CPU with `program` at $0200 and the reset vector pointing at it.
fn boot(program: &[u8]) -> Cpu<Recording> {
    let mut mem = FlatMemory::new();
    mem.load(0x0200, program);
    mem.set_reset_vector(0x0200);
    let mut cpu = Cpu::new(Arc::new(mos6502()), Recording::new(mem)).unwrap();
    cpu.reset();
    cpu
}

/// Execute `count` instructions, returning the cycle count of each.
///
/// Instruction boundaries are taken from the `sync` pin, which is exactly how
/// the chip announces an opcode fetch -- no instruction decoding on our side.
fn run(cpu: &mut Cpu<Recording>, count: usize) -> Vec<u64> {
    (0..count)
        .map(|i| {
            let half = cpu.step_instruction(400).unwrap_or_else(|| {
                panic!("instruction {i} never reached the next opcode fetch")
            });
            assert_eq!(half % 2, 0, "instruction {i} took a half-integral cycle count");
            half / 2
        })
        .collect()
}

/// Run `count` instructions, then advance one further cycle so the last
/// instruction's result is actually in the register file.
///
/// The 6502 overlaps the tail of one instruction with the opcode fetch of the
/// next. An ALU result is not in the accumulator when `sync` rises: it is held
/// in the ALU's hold register and transferred during the following cycle.
/// Sampling registers exactly at `sync` therefore reports the state *before*
/// the last writeback. This is real silicon behaviour -- behavioural emulators
/// hide it by committing results at instruction boundaries -- so tests that
/// assert on register contents have to wait for it.
///
/// Callers must leave at least one harmless instruction (a `NOP`) after the
/// sequence under test for that extra cycle to run in.
fn run_to_writeback(cpu: &mut Cpu<Recording>, count: usize) -> Vec<u64> {
    let cycles = run(cpu, count);
    cpu.step_cycle();
    cycles
}

#[test]
fn reset_fetches_from_the_reset_vector() {
    let cpu = boot(&[0xea]);
    // After reset the chip is at the first opcode fetch of the vectored address.
    assert!(cpu.sync(), "should be fetching an opcode");
    assert_eq!(cpu.address_bus(), 0x0200);
    assert_eq!(cpu.data_bus(), 0xea);
    // Reset sets the interrupt disable flag.
    assert_eq!(cpu.registers().p & 0x04, 0x04, "I flag should be set after reset");
}

#[test]
fn instruction_cycle_counts_match_the_datasheet() {
    // Set up X=1, Y=1 first, then exercise one addressing mode per instruction.
    let program = [
        0xa2, 0x01, //       LDX #$01          2
        0xa0, 0x01, //       LDY #$01          2
        0xea, //             NOP               2
        0xa9, 0x42, //       LDA #$42          2
        0xa5, 0x10, //       LDA $10           3
        0xb5, 0x10, //       LDA $10,X         4
        0xad, 0x34, 0x12, // LDA $1234         4
        0xbd, 0x00, 0x12, // LDA $1200,X       4  (no page cross)
        0xbd, 0xff, 0x12, // LDA $12FF,X       5  (page cross)
        0xb9, 0xff, 0x12, // LDA $12FF,Y       5  (page cross)
        0x85, 0x10, //       STA $10           3  (stores never get a penalty)
        0x9d, 0xff, 0x12, // STA $12FF,X       5  (fixed 5, cross or not)
        0xe6, 0x10, //       INC $10           5  (read-modify-write)
        0xee, 0x34, 0x12, // INC $1234         6
        0x48, //             PHA               3
        0x68, //             PLA               4
    ];
    let mut cpu = boot(&program);
    let cycles = run(&mut cpu, 16);
    assert_eq!(
        cycles,
        vec![2, 2, 2, 2, 3, 4, 4, 4, 5, 5, 3, 5, 5, 6, 3, 4],
        "instruction cycle counts"
    );
}

#[test]
fn branch_timing_depends_on_taken_and_page_crossing() {
    // BEQ with Z clear: not taken, 2 cycles. Then set Z and branch: 3 cycles.
    let program = [
        0xa9, 0x01, // LDA #$01   (Z clear)
        0xf0, 0x02, // BEQ +2     not taken -> 2
        0xa9, 0x00, // LDA #$00   (Z set)
        0xf0, 0x02, // BEQ +2     taken, same page -> 3
        0xea, 0xea, // NOP NOP    (skipped)
        0xea, //       NOP
    ];
    let mut cpu = boot(&program);
    let cycles = run(&mut cpu, 4);
    assert_eq!(cycles[1], 2, "untaken branch");
    assert_eq!(cycles[3], 3, "taken branch within the same page");
}

#[test]
fn taken_branch_across_a_page_costs_an_extra_cycle() {
    // Place the branch so its target lands on the next page.
    let mut mem = FlatMemory::new();
    mem.load(0x02f8, &[0xa9, 0x00, 0xf0, 0x0a, 0xea]); // LDA #$00 ; BEQ +10
    mem.set_reset_vector(0x02f8);
    let mut cpu = Cpu::new(Arc::new(mos6502()), Recording::new(mem)).unwrap();
    cpu.reset();
    let cycles = run(&mut cpu, 2);
    assert_eq!(cycles[1], 4, "taken branch crossing a page boundary");
}

#[test]
fn read_modify_write_does_the_6502_double_write() {
    // INC $10 is documented as read, write-back-unmodified, write-modified.
    // Emulators that skip the first write break hardware that watches the bus,
    // so this is a real behaviour and not an artefact.
    let mut cpu = boot(&[0xe6, 0x10]);
    cpu.bus.inner.load(0x10, &[0x41]);
    cpu.bus.recording = true;
    run(&mut cpu, 1);

    let writes: Vec<_> = cpu.bus.log.iter().filter(|t| t.write).collect();
    assert_eq!(writes.len(), 2, "RMW should write twice, got {:?}", cpu.bus.log);
    assert_eq!(writes[0], &Txn { addr: 0x10, value: 0x41, write: true }, "unmodified write-back");
    assert_eq!(writes[1], &Txn { addr: 0x10, value: 0x42, write: true }, "modified write");
}

#[test]
fn jsr_pushes_the_return_address_and_rts_pops_it() {
    let program = [
        0xa2, 0xff, //       LDX #$FF
        0x9a, //             TXS          (S = $FF)
        0x20, 0x08, 0x02, // JSR $0208
        0xea, //             NOP
        0xea, //             NOP
        0x60, //             RTS          (at $0208)
    ];
    let mut cpu = boot(&program);
    let cycles = run(&mut cpu, 4); // LDX, TXS, JSR, RTS

    assert_eq!(cycles[2], 6, "JSR");
    assert_eq!(cycles[3], 6, "RTS");

    // JSR pushes the address of its own last byte, i.e. return - 1 = $0205.
    assert_eq!(cpu.bus.inner.peek(0x01ff), 0x02, "return address high byte");
    assert_eq!(cpu.bus.inner.peek(0x01fe), 0x05, "return address low byte");
    assert_eq!(cpu.registers().s, 0xff, "RTS should restore the stack pointer");
    assert_eq!(cpu.registers().pc, 0x0206, "execution resumes after the JSR");
}

#[test]
fn adc_sets_overflow_and_negative() {
    // $50 + $50 = $A0: two positives producing a negative, so V and N set.
    let mut cpu = boot(&[0xa9, 0x50, 0x18, 0x69, 0x50, 0xea, 0xea]);
    run_to_writeback(&mut cpu, 3);
    let r = cpu.registers();
    assert_eq!(r.a, 0xa0);
    assert_eq!(r.p & V, V, "overflow, flags = {}", r.flags_string());
    assert_eq!(r.p & N, N, "negative, flags = {}", r.flags_string());
    assert_eq!(r.p & C, 0, "no carry out");
}

#[test]
fn adc_carries_and_sets_zero() {
    // $FF + $01 = $00 with carry out.
    let mut cpu = boot(&[0xa9, 0xff, 0x18, 0x69, 0x01, 0xea, 0xea]);
    run_to_writeback(&mut cpu, 3);
    let r = cpu.registers();
    assert_eq!(r.a, 0x00);
    assert_eq!(r.p & C, C, "carry, flags = {}", r.flags_string());
    assert_eq!(r.p & Z, Z, "zero, flags = {}", r.flags_string());
    assert_eq!(r.p & V, 0, "no signed overflow");
}

#[test]
fn decimal_mode_adjusts_the_result() {
    // The NMOS 6502's BCD path is in the silicon, not in a lookup table:
    // 09 + 01 = 10 in decimal mode.
    let mut cpu = boot(&[0xf8, 0xa9, 0x09, 0x18, 0x69, 0x01, 0xea, 0xea]);
    run_to_writeback(&mut cpu, 4);
    let r = cpu.registers();
    assert_eq!(r.p & D, D, "decimal mode should be set");
    assert_eq!(r.a, 0x10, "BCD addition, flags = {}", r.flags_string());
}

#[test]
fn indexed_registers_wrap_and_set_flags() {
    // INX and DEX both go through the ALU, so both need the extra writeback
    // cycle. Separate programs keep each assertion unambiguous.
    let mut inc = boot(&[0xa2, 0xff, 0xe8, 0xea, 0xea]); // LDX #$FF ; INX
    run_to_writeback(&mut inc, 2);
    assert_eq!(inc.registers().x, 0x00, "INX should wrap $FF -> $00");
    assert_eq!(inc.registers().p & Z, Z, "INX to zero sets Z");

    let mut dec = boot(&[0xa2, 0x00, 0xca, 0xea, 0xea]); // LDX #$00 ; DEX
    run_to_writeback(&mut dec, 2);
    assert_eq!(dec.registers().x, 0xff, "DEX should wrap $00 -> $FF");
    assert_eq!(dec.registers().p & N, N, "DEX to $FF sets N");
}

#[test]
fn timing_chain_advances_through_an_instruction() {
    // T-states are the microarchitectural clock. A 4-cycle instruction should
    // walk the chain rather than sit still.
    let mut cpu = boot(&[0xad, 0x34, 0x12]); // LDA $1234
    let mut seen = Vec::new();
    for _ in 0..8 {
        cpu.step_cycle();
        seen.push(cpu.timing().active());
    }
    assert!(
        seen.iter().filter(|s| !s.is_empty()).count() >= 4,
        "timing chain looks stuck: {seen:?}"
    );
    assert!(seen.iter().any(|s| s.contains("T2")), "T2 never asserted: {seen:?}");
    assert!(seen.iter().any(|s| s.contains("T3")), "T3 never asserted: {seen:?}");
}

#[test]
fn the_network_always_settles() {
    let mut cpu = boot(&[
        0xa9, 0x55, 0x18, 0x69, 0x33, 0x85, 0x20, 0xe6, 0x20, 0x4c, 0x00, 0x02,
    ]);
    for _ in 0..400 {
        cpu.step_cycle();
    }
    let stats = *cpu.engine().stats();
    assert_eq!(stats.nonconvergent_settles, 0, "network oscillated");
    assert_eq!(stats.contested_groups, 0, "pullup fought pulldown");
    assert!(stats.node_recalcs > 0);
}
