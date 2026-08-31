//! The datapath port, proved the way the Python model was proved.
//!
//! Rung 0 runs the experiment's four programs; each half-cycle the model is
//! stepped from the chip's OWN control-line levels (and the chip's own ALU
//! carry-in, a data signal), so only the SEMANTICS are under test, and the
//! nine fields `m4-datapath.py` reached 100% on are held exact at every
//! half-cycle: abl abh pc pclp pchp a x y s. The hold registers the model
//! reads early or late (alu, dor, idl) are measured and floored, not held.
//!
//! `MUTATE=1` flips one control bit at one half-cycle and the nine must go
//! red.
//!
//! `bits_match_names` is the drift guard for `lines::bit`: every index
//! against `LINE_NAMES`.

use std::sync::Arc;

use v6502_micro::datapath::{Datapath, Phase};
use v6502_micro::lines::*;
use v6502_sim::bus::FlatMemory;
use v6502_sim::cpu::Cpu;

include!("../src/harness.rs");

const PROGS: &[(&str, &[u8])] = &[
    ("loads/alu", &[0xa9, 0x2e, 0x69, 0x14, 0x85, 0x82, 0xa2, 0x03, 0xa0, 0x05, 0x8a, 0xa8, 0x98, 0x4c, 0x00, 0x02]),
    ("logic/shift", &[0xa9, 0x5a, 0x09, 0x0f, 0x29, 0x3c, 0x49, 0xff, 0x4a, 0x0a, 0x6a, 0x2a, 0xe9, 0x11, 0x4c, 0x00, 0x02]),
    ("stack/calls", &[0xa2, 0xff, 0x9a, 0xba, 0x48, 0x68, 0x08, 0x28, 0x20, 0x10, 0x02, 0x4c, 0x00, 0x02, 0xea, 0xea, 0x60]),
    ("indexed/br", &[0xa2, 0x02, 0xa0, 0x03, 0xbd, 0x00, 0x03, 0xb9, 0x00, 0x03, 0x9d, 0x20, 0x03, 0xc9, 0x00, 0xd0, 0x02, 0xe6, 0x10, 0x4c, 0x00, 0x02]),
];

const N: usize = 600;

#[test]
fn bits_match_names() {
    use v6502_micro::lines::bit::*;
    for (b, name) in [
        (ADH_ABH, "dpc-2_ADH/ABH"), (ADL_ABL, "dpc-1_ADL/ABL"), (YSB, "dpc0_YSB"), (SBY, "dpc1_SBY"),
        (XSB, "dpc2_XSB"), (SBX, "dpc3_SBX"), (SSB, "dpc4_SSB"), (SADL, "dpc5_SADL"), (SBS, "dpc6_SBS"),
        (SS, "dpc7_SS"), (NDBADD, "dpc8_nDBADD"), (DBADD, "dpc9_DBADD"), (ADLADD, "dpc10_ADLADD"),
        (SBADD, "dpc11_SBADD"), (ZADD, "dpc12_0ADD"), (ORS, "dpc13_ORS"), (SRS, "dpc14_SRS"),
        (ANDS, "dpc15_ANDS"), (EORS, "dpc16_EORS"), (SUMS, "dpc17_SUMS"), (DAA_N, "dpc18_#DAA"),
        (ADDSB7, "dpc19_ADDSB7"), (ADDSB06, "dpc20_ADDSB06"), (ADDADL, "dpc21_ADDADL"), (DSA_N, "dpc22_#DSA"),
        (SBAC, "dpc23_SBAC"), (ACSB, "dpc24_ACSB"), (SBDB, "dpc25_SBDB"), (ACDB, "dpc26_ACDB"),
        (SBADH, "dpc27_SBADH"), (ZADH0, "dpc28_0ADH0"), (ZADH17, "dpc29_0ADH17"), (ADHPCH, "dpc30_ADHPCH"),
        (PCHPCH, "dpc31_PCHPCH"), (PCHADH, "dpc32_PCHADH"), (PCHDB, "dpc33_PCHDB"), (IPC_N, "dpc36_#IPC"),
        (PCLDB, "dpc37_PCLDB"), (PCLADL, "dpc38_PCLADL"), (PCLPCL, "dpc39_PCLPCL"), (ADLPCL, "dpc40_ADLPCL"),
        (DL_ADL, "dpc41_DL/ADL"), (DL_ADH, "dpc42_DL/ADH"), (DL_DB, "dpc43_DL/DB"),
        (VADL0, "0/ADL0"), (VADL1, "0/ADL1"), (VADL2, "0/ADL2"),
    ] {
        assert_eq!(LINE_NAMES[b], name, "bit {b}");
    }
    assert_eq!(BIT_PCLC, 36);
    assert_eq!(BIT_PCHC, 37);
}

#[test]
fn nine_fields_exact_over_four_programs() {
    let mut mutate = std::env::var_os("MUTATE").is_some();
    let nl = v6502_netlist::mos6502();
    let mut ids: Vec<u16> = LINE_NAMES[..49].iter().map(|n| nl.node(n).expect("a line is a node")).collect();
    ids.push(nl.node("alucin").expect("alucin is a node"));
    let mut total = 0u64;
    let mut soft_ok = [0u64; 3]; // alu, dor, idl
    for (pname, code) in PROGS {
        let mut image = vec![0xeau8; 0x10000];
        image[0x0200..0x0200 + code.len()].copy_from_slice(code);
        image[0xfffc] = 0x00;
        image[0xfffd] = 0x02;
        let mut cpu = boot(&image);
        let regs = cpu.registers();
        let ints = cpu.internals().expect("the netlist names the internal buses");
        let mut m = Datapath {
            a: regs.a, x: regs.x, y: regs.y, s_in: regs.s, s_out: regs.s,
            pcl: regs.pc as u8, pch: (regs.pc >> 8) as u8,
            pclp: ints.pclp, pchp: ints.pchp, abl: ints.abl, abh: ints.abh,
            dl: ints.idl, dor: ints.dor, add: ints.alu, ai: ints.alua, bi: ints.alub,
            sb: 0xff, db: 0xff, adl: 0xff, adh: 0xff,
        };
        for i in 0..N {
            cpu.half_step();
            let mut w = vector(&cpu, &ids);
            let phase = match cpu.phase() {
                v6502_sim::Phase::Phi1 => Phase::Phi1,
                v6502_sim::Phase::Phi2 => Phase::Phi2,
            };
            // The mutation goes where the nine MUST see it: suppressing one
            // PC increment corrupts pclp at that very half-cycle. An earlier
            // draft flipped XSB, which only drives a bus nothing held, and
            // the mutant passed.
            if mutate && i >= 100 && phase == Phase::Phi2 {
                w ^= 1 << bit::IPC_N;
                mutate = false;
                eprintln!("MUTATE=1: inverted #IPC at half-cycle {} of {pname}", cpu.half_cycle());
            }
            let bus = cpu.bus_state();
            let data_in = if bus.rw == v6502_sim::ReadWrite::Read { bus.data } else { m.dor };
            m.step(w, phase, data_in, w >> BIT_ALUCIN & 1 != 0);
            total += 1;
            let regs = cpu.registers();
            let ints = cpu.internals().unwrap();
            for (name, got, want) in [
                ("abl", m.abl, ints.abl), ("abh", m.abh, ints.abh),
                ("pclp", m.pclp, ints.pclp), ("pchp", m.pchp, ints.pchp),
                ("a", m.a, regs.a), ("x", m.x, regs.x), ("y", m.y, regs.y), ("s", m.s_in, regs.s),
            ] {
                assert_eq!(got, want, "{pname} hc {} ({phase:?}): {name}", cpu.half_cycle());
            }
            assert_eq!(m.pc(), regs.pc, "{pname} hc {} ({phase:?}): pc", cpu.half_cycle());
            for (k, (got, want)) in [(m.add, ints.alu), (m.dor, ints.dor), (m.dl, ints.idl)].into_iter().enumerate() {
                soft_ok[k] += (got == want) as u64;
            }
        }
    }
    let pct = |k: usize| 100.0 * soft_ok[k] as f64 / total as f64;
    eprintln!(
        "datapath: {total} half-cycles over {} programs, nine fields exact; alu {:.1}%, dor {:.1}%, idl {:.1}% (hold registers read off-phase)",
        PROGS.len(), pct(0), pct(1), pct(2)
    );
    // The soft three are measured, but a floor keeps the measurement
    // load-bearing: the Python run sat at 95/98/99.
    assert!(pct(0) > 90.0 && pct(1) > 90.0 && pct(2) > 90.0, "a hold register fell below its measured floor");
}
