//! Snapshot and restore, proven bit-exact.
//!
//! The claim a stateless service rests on: a machine's whole mutable state is
//! the four bitsets plus the half-cycle counter and the fetch bookkeeping, so
//! restoring them into a FRESH machine -- one that has never run a reset,
//! standing in for a different process on a different day -- resumes the
//! simulation exactly. "Exactly" is asserted the way the golden test asserts
//! it: every node at every half-cycle, not just the registers.

use std::sync::Arc;

use v6502_netlist::mos6502;
use v6502_sim::bus::FlatMemory;
use v6502_sim::cpu::{Cpu, Fetch};
use v6502_sim::state::{hex_to_bits, restore, snapshot, MachineState};

/// The programs page's "Add two bytes", hand-assembled. $2E + $14 lands at
/// $82 as $42; the JMP keeps it looping so any resume point is mid-work.
const ADD: &[u8] = &[
    0xa9, 0x2e, // LDA #$2E
    0x85, 0x80, // STA $80
    0xa9, 0x14, // LDA #$14
    0x85, 0x81, // STA $81
    0x18, //       CLC
    0xa5, 0x80, // LDA $80
    0x65, 0x81, // ADC $81
    0x85, 0x82, // STA $82
    0x4c, 0x00, 0x02, // JMP $0200
];

fn machine() -> Cpu<FlatMemory> {
    let mut mem = FlatMemory::new();
    mem.load(0x0200, ADD);
    mem.set_reset_vector(0x0200);
    let mut cpu = Cpu::new(Arc::new(mos6502()), mem).expect("signals resolve");
    cpu.power_cycle();
    cpu
}

/// A fresh CPU that has never been reset, with `image` as its memory: the
/// stand-in for a cold process receiving a state blob.
fn cold(image: &[u8]) -> Cpu<FlatMemory> {
    let mut mem = FlatMemory::new();
    mem.load(0, image);
    Cpu::new(Arc::new(mos6502()), mem).expect("signals resolve")
}

#[test]
fn restore_into_a_fresh_machine_is_bit_exact() {
    let mut a = machine();
    for _ in 0..100 {
        a.half_step();
    }

    // Snapshot through the WIRE FORMAT, not through Clone: what is proven
    // bit-exact must be what actually travels.
    let hex = snapshot(&a).chip_hex();
    let st = MachineState::from_hex(
        1725,
        3510,
        &hex[0],
        &hex[1],
        &hex[2],
        &hex[3],
        a.half_cycle(),
        a.last_fetch(),
    )
    .expect("wire round trip");
    let image: Vec<u8> = a.bus.as_slice().to_vec();

    let mut b = cold(&image);
    restore(&mut b, &st);

    assert_eq!(b.half_cycle(), 100);
    assert_eq!(b.state_string(), a.state_string(), "restored chip differs at rest");
    assert_eq!(b.registers(), a.registers());
    assert_eq!(b.last_fetch(), a.last_fetch());

    // Lockstep: every node, every half-cycle, for 600 half-cycles.
    for h in 0..600u32 {
        a.half_step();
        b.half_step();
        assert_eq!(
            b.state_string(),
            a.state_string(),
            "chips diverge {h} half-cycles after restore"
        );
    }
    assert_eq!(b.registers(), a.registers());
    assert_eq!(b.bus.as_slice(), a.bus.as_slice(), "memories diverge after restore");
    assert_eq!(a.bus.peek(0x0082), 0x42, "the program computed its answer");
}

#[test]
fn a_restored_machine_can_be_snapshotted_again_mid_flight() {
    // The service's actual life: boot -> step -> serialize -> step -> ...
    // with a fresh machine at every hop. Three hops of 41 half-cycles must
    // land exactly where one run of 123 does.
    let a = machine();
    let image0: Vec<u8> = a.bus.as_slice().to_vec();
    let mut st = snapshot(&a);
    let mut image = image0;

    for _ in 0..3 {
        let mut m = cold(&image);
        restore(&mut m, &st);
        for _ in 0..41 {
            m.half_step();
        }
        st = snapshot(&m);
        image = m.bus.as_slice().to_vec();
    }

    let mut oracle = machine();
    for _ in 0..123 {
        oracle.half_step();
    }
    let mut fin = cold(&image);
    restore(&mut fin, &st);
    assert_eq!(fin.state_string(), oracle.state_string());
    assert_eq!(fin.registers(), oracle.registers());
    assert_eq!(fin.bus.as_slice(), oracle.bus.as_slice());
}

#[test]
fn hex_codec_round_trips_and_refuses_corruption() {
    let mut a = machine();
    for _ in 0..37 {
        a.half_step();
    }
    let st = snapshot(&a);
    let [v, pu, pd, t] = st.chip_hex();
    assert_eq!(v.len(), 216 * 2, "1725 node bits pack to 216 bytes");
    assert_eq!(t.len(), 439 * 2, "3510 transistor bits pack to 439 bytes");

    let back = hex_to_bits(&v, 1725).expect("round trip");
    for i in 0..1725 {
        assert_eq!(back.get(i), st.chip.value.get(i), "bit {i}");
    }

    // Wrong length, bad character, and a set bit in the padding: refused.
    assert!(hex_to_bits(&v[..v.len() - 2], 1725).is_err());
    assert!(hex_to_bits(&v.replace('a', "g"), 1725).is_err() || !v.contains('a'));
    let mut padded = v.clone();
    padded.replace_range(v.len() - 2.., "80"); // bit 1727, past 1725
    assert!(hex_to_bits(&padded, 1725).is_err(), "padding bit must be refused");
    let _ = (pu, pd);
}

#[test]
fn restore_carries_the_fetch_bookkeeping() {
    let mut a = machine();
    for _ in 0..20 {
        a.half_step();
    }
    let f = a.last_fetch().expect("something fetched by half-cycle 20");
    let mut b = cold(&[]);
    restore(&mut b, &snapshot(&a));
    assert_eq!(b.last_fetch(), Some(Fetch { addr: f.addr, opcode: f.opcode }));
}
