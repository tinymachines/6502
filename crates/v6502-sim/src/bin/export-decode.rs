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

use v6502_netlist::pla::Pla;
use v6502_netlist::Netlist;
use v6502_sim::{bus::FlatMemory, cpu::Cpu};

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
    let nl = Arc::new(Netlist::mos6502());
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
    s.push_str("  ]\n}\n");

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
