//! Measures the timing chain, and writes `web/timing.json`.
//!
//!     cargo run --release -p v6502-sim --bin export-timing -- web/timing.json
//!
//! The 6502 has no cycle counter. It has a chain of timing nodes that advances
//! one stage per cycle, and instructions finish when the decode PLA asserts a
//! term that sends the chain back to the start. So an instruction's length is
//! not stored anywhere — it is the number of cycles that happened to elapse
//! before something reset the chain.
//!
//! Which means every cycle count in every 6502 datasheet is, from the silicon's
//! point of view, an *observation*. This runs all 256 opcodes and takes that
//! observation, from `sync` to `sync`, with no instruction table involved.

use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::sync::Arc;

use v6502_netlist::blueprint::Blueprint;
use v6502_netlist::pla::Pla;
use v6502_netlist::Netlist;
use v6502_sim::{bus::FlatMemory, cpu::Cpu};

const BASE: u16 = 0x0200;
/// Long enough for the slowest instruction plus the overlap into the next
/// fetch. Nothing here should reach it; if something does it is reported as
/// unterminated rather than silently truncated.
const LIMIT: u64 = 40;

fn main() -> std::io::Result<()> {
    let path = std::env::args().nth(1).unwrap_or_else(|| "web/timing.json".into());
    let nl = Arc::new(Netlist::mos6502());
    let pla = Pla::derive(&nl);

    // The chain itself, and what can reach it. Same trace as the control lines:
    // the stages are clocked latches, so the walk has to cross pass transistors.
    let bp = Blueprint::derive(&nl);
    let blocked: Vec<u16> =
        bp.units.iter().flat_map(|u| u.bits.iter().flatten().copied()).collect();
    let stages: Vec<(&str, u16)> = ["clock1", "clock2", "t2", "t3", "t4", "t5"]
        .iter()
        .filter_map(|n| nl.node(n).map(|id| (*n, id)))
        .collect();
    let reach = pla.trace_terms(&nl, &stages.iter().map(|(_, n)| *n).collect::<Vec<_>>(), &blocked);

    let mut records = Vec::with_capacity(256);
    for opcode in 0..=255u8 {
        records.push(trace(&nl, &pla, opcode));
    }

    let mut s = String::with_capacity(1 << 18);
    s.push_str("{\n  \"stages\": [\n");
    for (i, (name, node)) in stages.iter().enumerate() {
        let terms: Vec<String> = reach[i].iter().map(usize::to_string).collect();
        let _ = writeln!(
            s,
            "    {{\"name\":\"{}\",\"node\":{},\"terms\":[{}]}}{}",
            name,
            node,
            terms.join(","),
            if i + 1 < stages.len() { "," } else { "" }
        );
    }
    s.push_str("  ],\n  \"opcodes\": [\n");
    for (i, r) in records.iter().enumerate() {
        let seq: Vec<String> = r.states.iter().map(|s| format!("\"{s}\"")).collect();
        let ending: Vec<String> = r.ending.iter().map(usize::to_string).collect();
        let _ = writeln!(
            s,
            "    {{\"op\":{},\"cycles\":{},\"states\":[{}],\"ending\":[{}],\"jam\":{}}}{}",
            r.opcode,
            r.cycles,
            seq.join(","),
            ending.join(","),
            r.jam,
            if i + 1 < records.len() { "," } else { "" }
        );
    }
    s.push_str("  ]\n}\n");

    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, &s)?;

    let jams = records.iter().filter(|r| r.jam).count();
    let mut hist = std::collections::BTreeMap::new();
    for r in records.iter().filter(|r| !r.jam) {
        *hist.entry(r.cycles).or_insert(0usize) += 1;
    }
    println!(
        "wrote {path} ({:.0} KiB): {} opcodes timed, {jams} that never finish; \
         cycle counts {hist:?}",
        s.len() as f64 / 1024.0,
        256 - jams
    );
    Ok(())
}

struct Timed {
    opcode: u8,
    /// Cycles from this opcode's fetch to the next one: measured sync to sync,
    /// with no instruction table consulted.
    cycles: u64,
    /// The timing state at each cycle, as the chain reports it.
    states: Vec<String>,
    /// Product terms high during the final cycle -- the ones present when the
    /// chain goes back to the start.
    ending: BTreeSet<usize>,
    /// True for the opcodes that never reach another fetch. These are real:
    /// the undocumented JAM/KIL opcodes hang the chip, and the timing chain
    /// simply stops advancing.
    jam: bool,
}

fn trace(nl: &Arc<Netlist>, pla: &Pla, opcode: u8) -> Timed {
    let mut mem = FlatMemory::new();
    mem.load(BASE, &[opcode, 0x00, 0x00, 0x00]);
    mem.set_reset_vector(BASE);
    let mut cpu = Cpu::new(nl.clone(), mem).expect("signals resolve");
    cpu.power_cycle();

    // Find this opcode's own fetch by watching sync, never by counting.
    let mut found = false;
    for _ in 0..60 {
        if cpu.sync() && cpu.last_fetch().map(|f| f.addr) == Some(BASE) {
            found = true;
            break;
        }
        cpu.half_step();
    }
    if !found {
        return Timed { opcode, cycles: 0, states: Vec::new(), ending: BTreeSet::new(), jam: true };
    }

    let mut states = Vec::new();
    let mut half = 0u64;
    let mut jam = true;
    // `loop` breaks with the value, so nothing has to be pre-seeded with a
    // placeholder that is never read.
    let ending = loop {
        states.push(cpu.timing().active());
        let terms: BTreeSet<usize> = pla
            .rows
            .iter()
            .enumerate()
            .filter(|(_, r)| cpu.engine().is_high(r.node))
            .map(|(i, _)| i)
            .collect();
        cpu.step_cycle();
        half += 2;
        // The set that survives is the final cycle's: the terms present when
        // the chain goes back to the start.
        if cpu.sync() {
            jam = false;
            break terms;
        }
        if half >= LIMIT {
            break terms;
        }
    };
    Timed { opcode, cycles: half / 2, states, ending, jam }
}
