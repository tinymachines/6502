//! Measures the decode PLA by running the chip, and writes `web/decode.json`.
//!
//!     cargo run --release -p v6502-sim --bin export-decode -- web/decode.json
//!
//! `v6502-netlist`'s `pla` module finds *where* the 122 product terms are. This
//! finds *when* they fire, by feeding the chip each of the 256 opcodes in turn
//! and reading the rows out of the silicon half-cycle by half-cycle.
//!
//! # Why measured and not computed
//!
//! Computing a row's opcode set from its IR gates is wrong twice over, and both
//! were found by trying it (see `pla.rs` for the detail): `irline3` is a derived
//! line that constrains the low opcode bits without appearing as an IR gate, and
//! a row legitimately fires for undocumented opcodes. The second is the whole
//! point of the exercise — `op-T0-lda` firing for the `LAX` opcodes is *why*
//! `LAX` loads both A and X — so a derivation that "corrected" it would destroy
//! the most interesting thing here.
//!
//! The engine is already checked bit-exact against the reference and against the
//! documented ISA, so asking it is the strongest available answer.

use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::sync::Arc;

use v6502_netlist::{mos6502, blueprint::Blueprint};
use v6502_netlist::pla::Pla;
use v6502_netlist::Netlist;
use v6502_sim::{bus::FlatMemory, cpu::Cpu};

/// A control line is asserted either by a term firing, or by no term firing.
///
/// The second is not a curiosity, it is most of them. `dpc39_PCLPCL` means
/// "PCL keeps its value" and `dpc7_SS` means "S keeps its value": the chip holds
/// unless something tells it otherwise, so those lines are asserted by the
/// *absence* of the terms that would override them. Fitting only the first sense
/// explained 30% of assertions; allowing both explains 93%.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
enum Mode {
    /// A term in the set fires -> the line asserts.
    Drive,
    /// A term in the set fires -> the line stops asserting.
    Override,
}

/// A fitted term-to-line relationship, kept only if it predicts the measurement.
struct Link {
    line: usize,
    terms: Vec<usize>,
    mode: Mode,
    /// Half-cycles between the term firing and the line responding: the
    /// pipeline latch. Measured per line, because the depth is not uniform.
    lag: usize,
    active_low: bool,
    explained: f64,
    unexplained: usize,
}

/// A fit must predict at least this share of a line's assertions to ship. The
/// residue is reported rather than rounded away.
const MIN_EXPLAINED: f64 = 0.95;

/// Row and control-line indices high at one half-cycle.
type Sample = (BTreeSet<usize>, BTreeSet<usize>);
/// One opcode: its half-cycle timeline, plus every term seen across scenarios.
type Record = (u8, Vec<Sample>, BTreeSet<usize>);

/// Half-cycles recorded after the opcode fetch begins. The longest documented
/// instruction is 7 cycles; 16 half-cycles covers it with room to show the
/// overlap into the next fetch, which is where several terms actually land.
const WINDOW: usize = 16;

/// Give up looking for the opcode fetch after this many half-cycles. Reset alone
/// takes several cycles, so this is generous rather than tight.
const FIND_LIMIT: usize = 60;

/// Each opcode is run under several scenarios: `(base address, preamble,
/// operand bytes)`. The opcode is placed just after the preamble.
///
/// One run from power-on is not enough, and each addition here closed a real
/// gap rather than being added speculatively:
///
/// - With the carry clear a `BCS` is not taken, so the terms belonging to a
///   taken branch never fire. Scenario 2 sets C and N.
/// - With a branch offset of zero the target is on the same page, so the
///   page-crossing fixup cycle never happens and `op-branch-done` still never
///   fires. Scenario 3 places the instruction near the end of a page and gives
///   it an offset that crosses one.
///
/// A term that never fires under any of these is reported as such rather than
/// quietly omitted -- an unfired term is a gap in the experiment, and saying so
/// is the difference between a measurement and a claim.
///
/// The displayed timeline stays the first scenario: one concrete history rather
/// than a blend, since a taken branch and an untaken one are not even the same
/// length. The others only widen the set of opcodes each term is known to fire
/// for.
const SCENARIOS: [(u16, &[u8], [u8; 3]); 3] = [
    (0x0200, &[], [0x00, 0x00, 0x00]),
    (0x0200, &[0x38, 0xa9, 0x80], [0x00, 0x00, 0x00]), // SEC; LDA #$80 -> C=1, N=1
    (0x02f0, &[0x38, 0xa9, 0x80], [0x7f, 0x02, 0x00]), // ...and a page-crossing operand
];

fn main() -> std::io::Result<()> {
    let path = std::env::args().nth(1).unwrap_or_else(|| "web/decode.json".into());
    let nl = Arc::new(mos6502());
    let pla = Pla::derive(&nl);

    eprintln!("{} product terms, {} control lines", pla.rows.len(), pla.outputs.len());

    let mut records: Vec<Record> = Vec::with_capacity(256);
    for opcode in 0..=255u8 {
        let mut any = BTreeSet::new();
        let mut timeline = None;
        for (base, preamble, operands) in SCENARIOS {
            let window = trace_opcode(&nl, &pla, opcode, base, preamble, &operands);
            for (rows, _) in &window {
                any.extend(rows.iter().copied());
            }
            if timeline.is_none() {
                timeline = Some(window);
            }
        }
        records.push((opcode, timeline.unwrap(), any));
    }

    // --- fit term -> control line ----------------------------------------
    // The netlist proposes which terms can reach each line; the 768 runs above
    // decide whether that set actually predicts it.
    let blueprint = Blueprint::derive(&nl);
    let blocked: Vec<u16> = blueprint
        .units
        .iter()
        .flat_map(|u| u.bits.iter().flatten().copied())
        .collect();
    let candidates = pla.candidate_terms(&nl, &blocked);

    // Polarity, measured rather than assumed: a line high in most samples is
    // idling high and asserts low. Six of the 46 are like that.
    let samples = records.len() * WINDOW;
    let mut high_count = vec![0usize; pla.outputs.len()];
    for (_, window, _) in &records {
        for (_, outs) in window {
            for o in outs {
                high_count[*o] += 1;
            }
        }
    }
    let active_low: Vec<bool> =
        high_count.iter().map(|c| *c * 2 > samples).collect();

    let mut links: Vec<Link> = Vec::new();
    let mut unresolved: Vec<usize> = Vec::new();
    for (line, terms) in candidates.iter().enumerate() {
        if terms.is_empty() {
            unresolved.push(line);
            continue;
        }
        let set: std::collections::BTreeSet<usize> = terms.iter().copied().collect();
        let mut best: Option<Link> = None;
        for mode in [Mode::Drive, Mode::Override] {
            for lag in 0..=4usize {
                let (mut ok, mut bad) = (0usize, 0usize);
                for (_, window, _) in &records {
                    for t in lag..window.len() {
                        let asserted = window[t].1.contains(&line) != active_low[line];
                        if !asserted {
                            continue;
                        }
                        let hit = window[t - lag].0.iter().any(|r| set.contains(r));
                        let good = if mode == Mode::Override { !hit } else { hit };
                        if good { ok += 1 } else { bad += 1 }
                    }
                }
                if ok == 0 {
                    continue;
                }
                let explained = ok as f64 / (ok + bad) as f64;
                if best.as_ref().is_none_or(|b| explained > b.explained) {
                    best = Some(Link {
                        line,
                        terms: terms.clone(),
                        mode,
                        lag,
                        active_low: active_low[line],
                        explained,
                        unexplained: bad,
                    });
                }
            }
        }
        match best {
            Some(l) if l.explained >= MIN_EXPLAINED => links.push(l),
            _ => unresolved.push(line),
        }
    }
    eprintln!(
        "term -> line: {} of {} lines fitted ({} drive, {} override), {} unresolved",
        links.len(),
        pla.outputs.len(),
        links.iter().filter(|l| l.mode == Mode::Drive).count(),
        links.iter().filter(|l| l.mode == Mode::Override).count(),
        unresolved.len()
    );

    // --- serialise -------------------------------------------------------
    let mut s = String::with_capacity(1 << 20);
    s.push_str("{\n  \"rows\": [\n");
    for (i, r) in pla.rows.iter().enumerate() {
        let ir: Vec<String> = r
            .ir
            .iter()
            .map(|t| format!("[{},{}]", t.bit, if t.required { 1 } else { 0 }))
            .collect();
        let other: Vec<String> = r.other.iter().map(|(_, n)| format!("\"{n}\"")).collect();
        let _ = writeln!(
            s,
            "    {{\"name\":{},\"node\":{},\"ir\":[{}],\"other\":[{}],\"unnamed\":{},\
             \"irOnly\":{},\"dieX\":{},\"dieY\":{}}}{}",
            r.name.as_ref().map_or("null".into(), |n| format!("\"{n}\"")),
            r.node,
            ir.join(","),
            other.join(","),
            r.unnamed,
            r.ir_only(),
            r.die.0,
            r.die.1,
            if i + 1 < pla.rows.len() { "," } else { "" }
        );
    }
    s.push_str("  ],\n  \"outputs\": [\n");
    for (i, o) in pla.outputs.iter().enumerate() {
        let _ = writeln!(
            s,
            "    {{\"name\":\"{}\",\"node\":{},\"dieX\":{},\"dieY\":{}}}{}",
            o.name,
            o.node,
            o.die.0,
            o.die.1,
            if i + 1 < pla.outputs.len() { "," } else { "" }
        );
    }
    // Per opcode: for each half-cycle, the row and output indices that are high.
    // Sparse, because typically a handful of 122 rows are up at once.
    s.push_str("  ],\n  \"opcodes\": [\n");
    for (n, (op, window, any)) in records.iter().enumerate() {
        let hcs: Vec<String> = window
            .iter()
            .map(|(rows, outs)| {
                format!(
                    "{{\"r\":[{}],\"o\":[{}]}}",
                    rows.iter().map(usize::to_string).collect::<Vec<_>>().join(","),
                    outs.iter().map(usize::to_string).collect::<Vec<_>>().join(",")
                )
            })
            .collect();
        let _ = writeln!(
            s,
            "    {{\"op\":{},\"hc\":[{}],\"any\":[{}]}}{}",
            op,
            hcs.join(","),
            any.iter().map(usize::to_string).collect::<Vec<_>>().join(","),
            if n + 1 < records.len() { "," } else { "" }
        );
    }
    s.push_str("  ],\n  \"links\": [\n");
    for (i, l) in links.iter().enumerate() {
        let _ = writeln!(
            s,
            "    {{\"line\":{},\"mode\":\"{}\",\"lag\":{},\"activeLow\":{},\
             \"explained\":{:.4},\"unexplained\":{},\"terms\":[{}]}}{}",
            l.line,
            if l.mode == Mode::Override { "override" } else { "drive" },
            l.lag,
            l.active_low,
            l.explained,
            l.unexplained,
            l.terms.iter().map(usize::to_string).collect::<Vec<_>>().join(","),
            if i + 1 < links.len() { "," } else { "" }
        );
    }
    let _ = writeln!(
        s,
        "  ],\n  \"unresolvedLines\": [{}]",
        unresolved.iter().map(usize::to_string).collect::<Vec<_>>().join(",")
    );
    s.push_str("}\n");

    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, &s)?;

    let fired: BTreeSet<usize> = records.iter().flat_map(|(_, _, any)| any.iter().copied()).collect();
    println!(
        "wrote {path} ({:.0} KiB): 256 opcodes x {} half-cycles; \
         {} of {} terms observed firing",
        s.len() as f64 / 1024.0,
        WINDOW,
        fired.len(),
        pla.rows.len()
    );
    Ok(())
}

/// Run one opcode and record which terms and control lines are high, per
/// half-cycle, starting from the half-cycle in which it is fetched.
fn trace_opcode(
    nl: &Arc<Netlist>,
    pla: &Pla,
    opcode: u8,
    base: u16,
    preamble: &[u8],
    operands: &[u8; 3],
) -> Vec<Sample> {
    let mut mem = FlatMemory::new();
    // Which product term fires is selected by the IR, not by operand values --
    // but operands decide whether a branch is taken and whether an address
    // calculation crosses a page, and those change which *cycles* happen.
    let at = base + preamble.len() as u16;
    mem.load(base, preamble);
    mem.load(at, &[opcode, operands[0], operands[1], operands[2]]);
    mem.set_reset_vector(base);
    let mut cpu = Cpu::new(nl.clone(), mem).expect("signals resolve");
    cpu.power_cycle();

    // Step to the half-cycle where this opcode is the one being fetched. Found
    // by watching `sync` and the fetch address, never by counting -- reset
    // timing is not something to hardcode.
    let mut found = false;
    for _ in 0..FIND_LIMIT {
        if cpu.sync() && cpu.last_fetch().map(|f| f.addr) == Some(at) {
            found = true;
            break;
        }
        cpu.half_step();
    }
    if !found {
        // Some undocumented opcodes jam the chip; that is a real property and
        // is recorded as an empty window rather than hidden.
        return vec![(BTreeSet::new(), BTreeSet::new()); WINDOW];
    }

    let mut out = Vec::with_capacity(WINDOW);
    for _ in 0..WINDOW {
        let engine = cpu.engine();
        let rows: BTreeSet<usize> = pla
            .rows
            .iter()
            .enumerate()
            .filter(|(_, r)| engine.is_high(r.node))
            .map(|(i, _)| i)
            .collect();
        let outs: BTreeSet<usize> = pla
            .outputs
            .iter()
            .enumerate()
            .filter(|(_, o)| engine.is_high(o.node))
            .map(|(i, _)| i)
            .collect();
        out.push((rows, outs));
        cpu.half_step();
    }
    out
}
