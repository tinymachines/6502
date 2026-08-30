//! Rung 1 against rung 0, every node, every half-cycle, on one memory image.
//!
//! The two engines are stepped together and their `state_string()` compared
//! after every half-cycle, plus `trans_on` bit for bit: the test that says
//! the counters compute the same level the walk computes. On the seven
//! programs, the interrupt fixture with an IRQ scripted into the lost-BRK
//! window, and the reference's program when `golden.txt` is there.
//!
//! `MUTATE=1` flips one node in rung 0's string at one half-cycle and the
//! test must go red.

use std::sync::Arc;
use v6502_hybrid::{HybridCpu, HybridNetlist};
use v6502_pins::{parse_trace, PinEngine};
use v6502_sim::pins::rung0;
use v6502_sim::{mos6502, Cpu, FlatMemory};

fn root() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len() / 2).map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap()).collect()
}

struct Case {
    name: String,
    loads: Vec<v6502_pins::Load>,
    vector: u16,
    steps: u64,
    irq_at: Option<u64>,
}

fn cases() -> Vec<Case> {
    let mut out = vec![Case {
        name: "inc-loop".into(),
        loads: vec![v6502_pins::Load { org: 0x200, bytes: vec![0xe6, 0x20, 0x4c, 0x00, 0x02] }],
        vector: 0x200,
        steps: 1500,
        irq_at: None,
    }];
    // The interrupt fixture, IRQ four half-cycles before the BRK's fetch
    // (h=12 on a free run: CLI, NOP, NOP at two cycles each).
    let mut prog = vec![0x58, 0xea, 0xea, 0x00];
    prog.extend([0xea; 8]);
    out.push(Case {
        name: "irq-lost-brk".into(),
        loads: vec![
            v6502_pins::Load { org: 0x0200, bytes: prog },
            v6502_pins::Load { org: 0x0300, bytes: vec![0x4c, 0x00, 0x03] },
            v6502_pins::Load { org: 0xfffe, bytes: vec![0x00, 0x03] },
        ],
        vector: 0x200,
        steps: 400,
        irq_at: Some(8),
    });
    if let Ok(text) = std::fs::read_to_string(root().join("web/programs.txt")) {
        for line in text.lines().filter(|l| !l.starts_with('#') && !l.trim().is_empty()) {
            let f: Vec<&str> = line.split('\t').collect();
            let org = u16::from_str_radix(f[1], 16).unwrap();
            out.push(Case {
                name: format!("program-{}", f[0]),
                loads: vec![v6502_pins::Load { org, bytes: hex(f[2]) }],
                vector: org,
                steps: 2000,
                irq_at: None,
            });
        }
    }
    if let Ok(text) = std::fs::read_to_string(root().join("tools/pin-golden/golden.pins")) {
        if let Ok(t) = parse_trace(&text) {
            out.push(Case { name: "golden".into(), loads: t.header.loads, vector: t.header.reset_vector, steps: 3000, irq_at: None });
        }
    }
    out
}

#[test]
fn every_node_every_half_cycle_matches_rung0() {
    let hn = Arc::new(HybridNetlist::new(Arc::new(mos6502())));
    assert_eq!(hn.gate_count(), 1160, "gates recognised");
    assert_eq!(hn.switch_count(), 873, "switches left");
    let mutate = std::env::var_os("MUTATE").is_some();
    let mut total = 0u64;

    for (ci, c) in cases().iter().enumerate() {
        let mut a: Cpu<FlatMemory> = rung0(&c.loads, c.vector);
        let mut mem = FlatMemory::new();
        for l in &c.loads {
            mem.load(l.org, &l.bytes);
        }
        mem.set_reset_vector(c.vector);
        let mut b = HybridCpu::new(Arc::clone(&hn), mem);
        a.power_cycle();
        b.power_cycle();
        let compare = |a: &Cpu<FlatMemory>, b: &HybridCpu<FlatMemory>, h: u64| {
            let mut sa = a.state_string();
            let sb = b.state_string();
            if mutate && ci == 0 && h == 40 {
                let i = sa.find('h').unwrap();
                sa.replace_range(i..i + 1, "l");
                eprintln!("MUTATE=1: flipped node {i} in rung 0's string at h=40");
            }
            if sa != sb {
                let diff: Vec<usize> = sa.chars().zip(sb.chars()).enumerate().filter(|(_, (x, y))| x != y).map(|(i, _)| i).collect();
                let names: Vec<String> = diff.iter().take(12).map(|&n| match a.engine().netlist().name_of(n as u16) {
                    Some(nm) => format!("{n} ({nm})"),
                    None => n.to_string(),
                }).collect();
                panic!("{}: h={h}: {} of {} nodes differ between rung 0 and rung 1; first: {}", c.name, diff.len(), sa.len(), names.join(", "));
            }
            assert!(a.engine().state().trans_on == *b.engine().trans_on(), "{}: h={h}: trans_on differs", c.name);
        };
        compare(&a, &b, 0);
        for h in 0..c.steps {
            if c.irq_at == Some(h) {
                a.set_irq(false);
                b.set_inputs(true, false, true, true, false);
            }
            a.half_step();
            b.half_step();
            compare(&a, &b, h + 1);
        }
        total += c.steps;
    }
    eprintln!("lockstep: {} cases, {total} half-cycles, every node identical", cases().len());
}
