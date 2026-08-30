//! The lanes are independent, and 64 copies of one machine are one machine.
//!
//! Lane 1 runs `INC $21` against everyone else's `INC $20`, the check
//! `examples/bitslice.rs` settled on after a perturbed byte proved to pass
//! by accident; then every lane's state string is compared with lane 0's on
//! the plain run, which is what says the clock really is one instruction
//! for all of them.

use v6502_compiled::{kernel, Machines, LANES};
use v6502_pins::Load;

fn pullups() -> Vec<bool> {
    let nl = v6502_netlist::mos6502();
    (0..nl.node_count()).map(|i| nl.pullups().get(i)).collect()
}

#[test]
fn a_lane_runs_its_own_program_and_touches_only_its_own_memory() {
    let mut m = Machines::new(&pullups());
    m.load_all(&[Load { org: 0x200, bytes: vec![0xe6, 0x20, 0x4c, 0x00, 0x02] }], 0x200);
    m.load_lane(1, &[Load { org: 0x200, bytes: vec![0xe6, 0x21, 0x4c, 0x00, 0x02] }], 0x200);
    m.power_cycle();
    for _ in 0..3000 {
        m.half_step();
    }
    let (l0_20, l0_21) = (m.mem[0][0x20], m.mem[0][0x21]);
    let (l1_20, l1_21) = (m.mem[1][0x20], m.mem[1][0x21]);
    assert!(l0_20 > 0 && l0_21 == 0, "lane 0 counts at $20: ${l0_20:02x}, $21 is ${l0_21:02x}");
    assert!(l1_21 > 0 && l1_20 == 0, "lane 1 counts at $21: ${l1_21:02x}, $20 is ${l1_20:02x}");
    assert_eq!(l0_20, l1_21, "the two lanes ran the same number of increments");
    assert_eq!(m.mem[2][0x20], l0_20, "lane 2 is a copy of lane 0");
    let s0 = m.state.state_string(0);
    assert_ne!(s0, m.state.state_string(1), "lane 1 differs from lane 0 in state, as it must");
    for lane in 2..LANES {
        assert_eq!(m.state.state_string(lane), s0, "lane {lane} against lane 0");
    }
    assert_eq!(m.stats.nonconvergent_settles, 0);
    eprintln!("fold: {} gates, {} absorbed, {} switches, {} junctions, {} left as switches", kernel::FOLDED_GATES, kernel::ABSORBED, kernel::SWITCHES, kernel::JUNCTIONS, kernel::GATES_LEFT_AS_SWITCHES);
}

/// The one program-level check that needs registers: the ISA says what the
/// accumulator holds after `LDA #$41 / ADC #$01`, and rung 2 has to hold it,
/// one cycle after `sync` because the ALU result sits in the hold register
/// through the opcode fetch (the lag this whole project exists to show).
#[test]
fn the_accumulator_carries_the_alu_result_one_cycle_late() {
    let mut m = Machines::new(&pullups());
    m.load_all(&[Load { org: 0x200, bytes: vec![0xa9, 0x41, 0x69, 0x01, 0x4c, 0x04, 0x02] }], 0x200);
    m.power_cycle();
    let mut seen_a = Vec::new();
    for _ in 0..40 {
        m.half_step();
        seen_a.push(m.reg(0, &kernel::sig::A));
    }
    assert!(seen_a.contains(&0x41), "A never held $41: {seen_a:02x?}");
    assert_eq!(*seen_a.last().unwrap(), 0x42, "A after ADC: {seen_a:02x?}");
}
