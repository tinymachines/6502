//! A machine value crossing between rung 0 and rung 2, held at the pins.
//!
//! Rung 2 is not node-exact with rung 0 (the kernel's account in
//! `docs/notes/engine.md`), and the pin golden only covers it from
//! power-on, so the crossing has its own check: rung 0 runs a program
//! partway, its value is broadcast into every lane (`State::inject_all`,
//! memory beside it), and from the seam both engines must agree at every
//! half-cycle on all eleven pins AND on the eight datapath control lines
//! Die Runner's cartridge watches (the gates feed gameplay through the gate
//! mask, so they are part of the console contract even though they are not
//! pins), with the memory image identical at the end. Then the reverse:
//! rung 2's lane 0, extracted mid-run, resumes a COLD rung 0.
//!
//! What is deliberately NOT asserted: node equality. `examples/crossing.rs`
//! measured 13748/20000 half-cycles with some internal divergence (worst: 2
//! nodes) while the pins agreed on all 20000; asserting nodes here would
//! fail on what the rung is, not on a bug.
//!
//! `MUTATE=1` corrupts one opcode byte in the crossed machine's memory and
//! both directions must go red at the pins.

use v6502_compiled::{Machines, LANES};
use v6502_pins::{Load, PinEngine};
use v6502_sim::pins::rung0;
use v6502_sim::state::MachineState;
use v6502_sim::{mos6502, Cpu, FlatMemory};

const GATES: [&str; 8] = [
    "dpc25_SBDB", "dpc9_DBADD", "dpc10_ADLADD", "dpc21_ADDADL",
    "dpc23_SBAC", "dpc30_ADHPCH", "dpc40_ADLPCL", "dpc2_XSB",
];

/// Odd, so the seam lands mid-cycle.
const RUN_IN: u64 = 777;
const RUN_ON: u64 = 3000;

fn hex_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len() / 2).map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap()).collect()
}

fn programs() -> Vec<(&'static str, Vec<Load>)> {
    vec![
        ("inc-loop", vec![Load { org: 0x200, bytes: vec![0xe6, 0x20, 0x4c, 0x00, 0x02] }]),
        // Add two bytes, in a loop: LDA/STA/CLC/ADC across zero page.
        ("add-loop", vec![Load {
            org: 0x200,
            bytes: vec![
                0xa9, 0x2e, 0x85, 0x80, 0xa9, 0x14, 0x85, 0x81, 0x18, 0xa5, 0x80,
                0x65, 0x81, 0x85, 0x82, 0x4c, 0x00, 0x02,
            ],
        }]),
    ]
}

fn mutate() -> bool {
    std::env::var_os("MUTATE").is_some()
}

struct Watch {
    ids: Vec<usize>,
}

impl Watch {
    fn new(nl: &v6502_sim::Netlist) -> Watch {
        Watch { ids: GATES.iter().map(|g| nl.node(g).expect("a watched line is a node") as usize).collect() }
    }
}

fn hold_together(name: &str, a: &mut Cpu<FlatMemory>, b: &mut Machines, w: &Watch, from: u64) {
    for h in 0..RUN_ON {
        a.half_step();
        b.half_step();
        let (pa, pb) = (PinEngine::pins(a), Machines::pins(b, 0));
        assert_eq!(pa, pb, "{name}: pins differ at +{h} (h={})", from + h + 1);
        for (&g, gname) in w.ids.iter().zip(GATES) {
            assert_eq!(
                a.engine().is_high(g as u16),
                b.state.is_high(0, g),
                "{name}: gate {gname} differs at +{h}"
            );
        }
    }
    assert_eq!(a.bus.as_slice(), &b.mem[0][..], "{name}: memory after the run");
}

#[test]
fn rung0_value_resumes_on_rung2_at_the_pins() {
    let nl = mos6502();
    let pu: Vec<bool> = (0..nl.node_count()).map(|i| nl.pullups().get(i)).collect();
    let w = Watch::new(&nl);
    for (name, loads) in programs() {
        let mut a = rung0(&loads, 0x200);
        a.power_cycle();
        for _ in 0..RUN_IN {
            a.half_step();
        }
        let st = v6502_sim::state::snapshot(&a);
        let [value, pullup, pulldown, trans_on] = st.chip_hex();
        let mut b = Machines::new(&pu);
        for lane in 0..LANES {
            b.mem[lane].copy_from_slice(a.bus.as_slice());
        }
        b.state
            .inject_all(&hex_bytes(&value), &hex_bytes(&pullup), &hex_bytes(&pulldown), &hex_bytes(&trans_on))
            .expect("the codec's own lengths");
        b.set_half_cycle(st.half_cycle);
        if mutate() {
            b.mem[0][0x200] ^= 0xff;
            eprintln!("MUTATE=1: corrupted the opcode at $0200 in the crossed machine");
        }
        hold_together(name, &mut a, &mut b, &w, RUN_IN);
        assert!(b.mem[0][0x20] > 0 || name != "inc-loop", "{name}: the program ran");
        eprintln!("{name}: rung 0 -> rung 2 at h={RUN_IN}, {RUN_ON} half-cycles, pins and gates identical, memory identical");
    }
}

#[test]
fn rung2_lane0_resumes_on_a_cold_rung0_at_the_pins() {
    let nl = mos6502();
    let pu: Vec<bool> = (0..nl.node_count()).map(|i| nl.pullups().get(i)).collect();
    let w = Watch::new(&nl);
    for (name, loads) in programs() {
        let mut b = Machines::new(&pu);
        b.load_all(&loads, 0x200);
        b.power_cycle();
        for _ in 0..RUN_IN {
            b.half_step();
        }
        let (value, pullup, pulldown, trans_on) = b.state.extract_lane(0);
        let hex = |v: &[u8]| v.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let st = MachineState::from_hex(
            nl.node_count(),
            nl.transistor_count(),
            &hex(&value),
            &hex(&pullup),
            &hex(&pulldown),
            &hex(&trans_on),
            b.half_cycle(),
            None,
        )
        .expect("an extracted lane is a well-formed machine");
        let mut mem = FlatMemory::new();
        mem.load(0, &b.mem[0]);
        if mutate() {
            mem.load(0x200, &[b.mem[0][0x200] ^ 0xff]);
            eprintln!("MUTATE=1: corrupted the opcode at $0200 in the crossed machine");
        }
        let mut a = Cpu::new(std::sync::Arc::new(mos6502()), mem).expect("signals resolve");
        v6502_sim::state::restore(&mut a, &st);
        hold_together(name, &mut a, &mut b, &w, RUN_IN);
        eprintln!("{name}: rung 2 -> rung 0 at h={RUN_IN}, {RUN_ON} half-cycles, pins and gates identical, memory identical");
    }
}
