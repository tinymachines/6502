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

use v6502_netlist::{mos6502, blueprint::Blueprint};
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
    let nl = Arc::new(mos6502());
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

    let dpc = dpc_phases(&nl);

    let mut records = Vec::with_capacity(256);
    for opcode in 0..=255u8 {
        records.push(trace(&nl, &pla, opcode));
    }

    let mut s = String::with_capacity(1 << 18);
    // Term names travel with the file. Both this and decode.json index the same
    // `Pla::rows` order, but coupling two published files by index alone is the
    // kind of thing that silently mislabels everything the day the order moves.
    s.push_str("{\n  \"terms\": [\n");
    for (i, r) in pla.rows.iter().enumerate() {
        let _ = writeln!(
            s,
            "    {}{}",
            r.name.as_ref().map_or("null".into(), |n| format!("\"{n}\"")),
            if i + 1 < pla.rows.len() { "," } else { "" }
        );
    }
    s.push_str("  ],\n  \"stages\": [\n");
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
    s.push_str("  ],\n  \"dpc\": [\n");
    for (i, (name, node, phase)) in dpc.iter().enumerate() {
        let _ = writeln!(
            s,
            "    {{\"name\":\"{}\",\"node\":{},\"phase\":{}}}{}",
            name,
            node,
            phase.map_or_else(|| "null".to_string(), |p| format!("\"{p}\"")),
            if i + 1 < dpc.len() { "," } else { "" }
        );
    }
    s.push_str("  ],\n  \"opcodes\": [\n");
    for (i, r) in records.iter().enumerate() {
        let seq: Vec<String> = r.states.iter().map(|s| format!("\"{s}\"")).collect();
        let ending: Vec<String> = r.ending.iter().map(usize::to_string).collect();
        let arrived: Vec<String> = r.arrived.iter().map(usize::to_string).collect();
        let _ = writeln!(
            s,
            "    {{\"op\":{},\"cycles\":{},\"bytes\":{},\"states\":[{}],\
             \"ending\":[{}],\"arrived\":[{}],\"jam\":{}}}{}",
            r.opcode,
            r.cycles,
            // `null` rather than a number for an instruction whose next fetch
            // was somewhere else: a plausible figure there would be a claim.
            r.advance.map_or_else(|| "null".to_string(), |b| b.to_string()),
            seq.join(","),
            ending.join(","),
            arrived.join(","),
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
    /// Product terms high during the final cycle.
    ending: BTreeSet<usize>,
    /// Terms high in the final cycle that were **not** high in any earlier one.
    ///
    /// This is the set worth showing. Simply listing what is high at the end
    /// includes every term describing the instruction's *class* --
    /// `op-implied`, `op-store`, `op-shift` -- which were high the whole time
    /// and end nothing. What arrived in the last cycle is what stopped it.
    arrived: BTreeSet<usize>,
    /// How far the program counter moved, measured as the distance from this
    /// opcode's own fetch to the next one.
    ///
    /// That distance IS the instruction's length in bytes, for every
    /// instruction that does not transfer control. For the ones that do -- a
    /// jump, a subroutine call, a return, a break -- the next fetch is
    /// somewhere else entirely and the distance says nothing about how long the
    /// instruction was. Those are recorded as `None` rather than as a number,
    /// because a plausible figure beside an instruction that does not have one
    /// is worse than an admission.
    ///
    /// Nothing here consults a table of instruction lengths, exactly as nothing
    /// in the cycle count does. The operands are all `$00`, which is also why a
    /// branch is measurable: an offset of zero lands on the following byte
    /// whether the branch is taken or not, and either way it moved two.
    advance: Option<u16>,
    /// True for the opcodes that never reach another fetch. These are real:
    /// the undocumented JAM/KIL opcodes hang the chip, and the timing chain
    /// simply stops advancing.
    jam: bool,
}

/// The datapath control lines, and the clock phase each is effective in.
///
/// The chip has no phase register. A control line is "effective on phi1" only
/// in the sense that it is high while `clk1out` is, so this watches every
/// `dpc*` node against the two clock outputs while four programs run and
/// reports the phases it was ever high in. Nothing consults a table.
///
/// The visual6502 wiki states the answer for 37 of the 44, in Hanson's names,
/// and `tools/check-dpc-vs-wiki.py` compares the two: 37 of 37 agree. A line
/// no program here raises is `null` rather than a guess.
fn dpc_phases(nl: &Arc<Netlist>) -> Vec<(String, u16, Option<&'static str>)> {
    // Chosen to reach as many lines as possible: loads and the adder, the
    // logic and shift ops, the stack and calls, indexed addressing and a
    // branch. Two lines stay unreached (`dpc34_PCLC`, `dpc35_PCHC`, the
    // program counter's carry detects) and are reported as such.
    const PROGS: [&[u8]; 4] = [
        &[0xa9, 0x2e, 0x69, 0x14, 0x85, 0x82, 0xa2, 0x03, 0xa0, 0x05, 0x8a, 0xa8, 0x98, 0x4c, 0x00,
          0x02],
        &[0xa9, 0x5a, 0x09, 0x0f, 0x29, 0x3c, 0x49, 0xff, 0x4a, 0x0a, 0x6a, 0x2a, 0xe9, 0x11, 0x4c,
          0x00, 0x02],
        &[0xa2, 0xff, 0x9a, 0xba, 0x48, 0x68, 0x08, 0x28, 0x20, 0x10, 0x02, 0x4c, 0x00, 0x02, 0xea,
          0xea, 0x60],
        &[0xa2, 0x02, 0xa0, 0x03, 0xbd, 0x00, 0x03, 0xb9, 0x00, 0x03, 0x9d, 0x20, 0x03, 0xc9, 0x00,
          0xd0, 0x02, 0xe6, 0x10, 0x4c, 0x00, 0x02],
    ];
    const STEPS: usize = 900;

    let mut lines: Vec<(String, u16)> =
        nl.names().filter(|(n, _)| n.starts_with("dpc")).map(|(n, i)| (n.to_string(), i)).collect();
    // The `dpc` prefix is a position across the die, so sorting by it is
    // sorting the datapath left to right. Sorting the strings would put 10
    // before 2.
    // The `dpc` prefix is a position across the die, and two of them are
    // NEGATIVE: `dpc-1_ADL/ABL` and `dpc-2_ADH/ABH` are the address latch
    // loads, which sit to the left of where the datapath's own numbering
    // starts. Parsing as unsigned puts them last; parsing as signed puts them
    // where the die does. Sorting the strings would put 10 before 2.
    lines.sort_by_key(|(n, _)| {
        n.trim_start_matches("dpc").split('_').next().unwrap_or("").parse::<i32>().unwrap_or(i32::MAX)
    });

    let (c1, c2) = match (nl.node("clk1out"), nl.node("clk2out")) {
        (Some(a), Some(b)) => (a, b),
        _ => return Vec::new(),
    };
    let mut hi1 = vec![false; lines.len()];
    let mut hi2 = vec![false; lines.len()];
    for prog in PROGS {
        let mut page = vec![0xeau8; 256];
        page[..prog.len()].copy_from_slice(prog);
        let mut mem = FlatMemory::new();
        mem.load(BASE, &page);
        mem.set_reset_vector(BASE);
        let mut cpu = Cpu::new(nl.clone(), mem).expect("signals resolve");
        cpu.power_cycle();
        for _ in 0..STEPS {
            let (a, b) = (cpu.engine().is_high(c1), cpu.engine().is_high(c2));
            // The two phases are non-overlapping and total, which the check
            // tool asserts rather than assumes; a half-cycle in neither would
            // be a clock generator that had stopped.
            if a != b {
                for (k, (_, id)) in lines.iter().enumerate() {
                    if cpu.engine().is_high(*id) {
                        if a { hi1[k] = true } else { hi2[k] = true }
                    }
                }
            }
            cpu.half_step();
        }
    }
    lines
        .into_iter()
        .enumerate()
        .map(|(k, (name, id))| {
            let phase = match (hi1[k], hi2[k]) {
                (true, true) => Some("both"),
                (true, false) => Some("phi1"),
                (false, true) => Some("phi2"),
                (false, false) => None,
            };
            (name, id, phase)
        })
        .collect()
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
        return Timed {
            opcode,
            cycles: 0,
            states: Vec::new(),
            ending: BTreeSet::new(),
            arrived: BTreeSet::new(),
            advance: None,
            jam: true,
        };
    }

    let mut states = Vec::new();
    let mut half = 0u64;
    let mut jam = true;
    let mut next_addr: Option<u16> = None;
    // `loop` breaks with the value, so nothing has to be pre-seeded with a
    // placeholder that is never read.
    let mut seen_earlier: BTreeSet<usize> = BTreeSet::new();
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
            next_addr = cpu.last_fetch().map(|f| f.addr);
            break terms;
        }
        if half >= LIMIT {
            break terms;
        }
        // Only reached when this was not the last cycle.
        seen_earlier.extend(terms);
    };
    let arrived: BTreeSet<usize> = ending.difference(&seen_earlier).copied().collect();
    // A step of one to three bytes forward from this opcode is its length. Any
    // other landing place means control went somewhere, and the distance is
    // not a length.
    let advance = next_addr
        .map(|a| a.wrapping_sub(BASE))
        .filter(|d| (1..=3).contains(d));
    Timed { opcode, cycles: half / 2, states, ending, arrived, advance, jam }
}
