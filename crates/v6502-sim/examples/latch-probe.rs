//! The ALU's A-input latch on rung 0 through ANC #$81 with A=$ff: what
//! one bit of the latch is shorted to, half-cycle by half-cycle, with
//! every conducting transistor named by its gate, and the group's
//! resolution. The question the unofficial-opcode note left open: why
//! the latch reads $ff at phi2 where the part holds the AND. Answered
//! under the `probe` feature, which lists every recalc of the phi2
//! settle that carried the bit: the data latch's low path (cp1) opens
//! at recalc 63 and A's pullup charges the joined buses, SBADD and
//! DBADD close at 246 and 253. See docs/notes/engine.md.
//!
//!     cargo run --release -p v6502-sim --features probe --example latch-probe -- [bit] [from] [to]
//!
//! OP=29 runs the official AND instead; ALLRECALCS=1 lists every change
//! in the settle; DEADTIME=1 tries to close the pass gates first (it
//! cannot: the node's own driver wins).
use std::sync::Arc;
use v6502_pins::PinEngine;
use v6502_sim::{bus::FlatMemory, cpu::Cpu};

fn main() {
    let bit: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(1);
    let from: u64 = std::env::args().nth(2).and_then(|a| a.parse().ok()).unwrap_or(11);
    let to: u64 = std::env::args().nth(3).and_then(|a| a.parse().ok()).unwrap_or(14);
    // CLC; LDA #$ff; ANC #$81; STA $80; spin (OP=29 for the official AND)
    let op: u8 =
        std::env::var("OP").ok().and_then(|v| u8::from_str_radix(&v, 16).ok()).unwrap_or(0x0b);
    let prog = [0x18u8, 0xa9, 0xff, op, 0x81, 0x85, 0x80, 0x4c, 0x07, 0x02];
    let mut mem = FlatMemory::new();
    mem.load(0x0200, &prog);
    mem.load(0xfffc, &[0x00, 0x02]);
    let mut cpu = Cpu::new(Arc::new(v6502_netlist::mos6502()), mem).expect("signals resolve");
    cpu.power_cycle();
    let nl = cpu.engine().netlist_arc().clone();
    let name = |n: u16| nl.name_of(n).map(str::to_string).unwrap_or_else(|| format!("n{n}"));
    let watched = [
        format!("alua{bit}"),
        format!("alub{bit}"),
        format!("sb{bit}"),
        format!("db{bit}"),
        format!("ac{bit}"),
        format!("idl{bit}"),
    ];
    // DEADTIME=1: the experiment that would move it. Before the phi2 edge
    // of the ALU cycle (h=12 to 13), close the input latches' pass gates
    // first by pulling SBADD and DBADD low and settling, the way the
    // part's non-overlapping phases order it, then flip the clock.
    let deadtime = std::env::var_os("DEADTIME").is_some();
    let sbadd = nl.node("dpc11_SBADD").unwrap();
    let dbadd = nl.node("dpc9_DBADD").unwrap();
    for h in 0..=to {
        if h > 0 {
            if deadtime && h == 13 {
                cpu.engine_mut().drive_low(sbadd);
                cpu.engine_mut().drive_low(dbadd);
                let e = cpu.engine();
                let a1 = nl.node(&format!("alua{bit}")).unwrap();
                println!("  after closing the latches, before the edge: SBADD={} DBADD={} alua{bit}={} group {:?}", e.is_high(sbadd) as u8, e.is_high(dbadd) as u8, e.is_high(a1) as u8, e.group_of(a1).iter().map(|&m| name(m)).collect::<Vec<_>>());
            }
            #[cfg(feature = "probe")]
            if h == 13 {
                cpu.engine_mut().probe_mut().on = true;
            }
            PinEngine::half_step(&mut cpu);
            #[cfg(feature = "probe")]
            if h == 13 {
                // Every recalc of the phi2 settle whose group held the
                // latch bit, in order, with the group's members: the one
                // that first holds a pullup and no rail is where it charges.
                let e = cpu.engine();
                let pr = e.probe();
                let a1 = nl.node(&format!("alua{bit}")).unwrap();
                for i in 0..pr.len() {
                    let g = pr.group(i);
                    if std::env::var_os("ALLRECALCS").is_some() && pr.changed[i] {
                        let names: Vec<String> = g.iter().map(|&m| name(m)).collect();
                        println!(
                            "  changed {i} (seed {}): [{}]",
                            name(pr.seed[i]),
                            names.join(" ")
                        );
                    }
                    if g.contains(&a1) {
                        let names: Vec<String> = g
                            .iter()
                            .map(|&m| {
                                format!(
                                    "{}{}",
                                    name(m),
                                    if nl.pullups().get(m as usize) { "^" } else { "" }
                                )
                            })
                            .collect();
                        println!(
                            "  recalc {i} (seed {}, changed {}): [{}]",
                            name(pr.seed[i]),
                            pr.changed[i],
                            names.join(" ")
                        );
                    }
                }
                cpu.engine_mut().probe_mut().on = false;
            }
        }
        {
            let i = cpu.internals().expect("internals");
            let r = cpu.registers();
            if h >= from {
                println!(
                    "h={h} a={:02x} add={:02x} ai={:02x} bi={:02x} sb={:02x}",
                    r.a, i.alu, i.alua, i.alub, i.sb
                );
            }
        }
        if h < from {
            continue;
        }
        let e = cpu.engine();
        let f = PinEngine::pins(&cpu);
        println!("h={h} clk0={} ab={:04x} db={:02x}", f.clk0 as u8, f.ab, f.db);
        for w in &watched {
            let Some(n) = nl.node(w) else { continue };
            let group = e.group_of(n);
            let members: Vec<String> = group
                .iter()
                .map(|&m| {
                    format!(
                        "{}{}{}",
                        name(m),
                        if nl.pullups().get(m as usize) { "^" } else { "" },
                        if e.is_high(m) { "=1" } else { "=0" }
                    )
                })
                .collect();
            let mut edges = Vec::new();
            for &m in &group {
                for t in nl.terminals_of(m) {
                    if e.state().trans_on.get(t.transistor as usize) && m < t.other {
                        edges.push(format!(
                            "{}-{} (gate {})",
                            name(m),
                            name(t.other),
                            name(nl.transistor_gate(t.transistor))
                        ));
                    }
                }
            }
            println!("  {w}={}: group [{}]", e.is_high(n) as u8, members.join(" "));
            if !edges.is_empty() {
                println!("    via {}", edges.join("; "));
            }
        }
    }
}
