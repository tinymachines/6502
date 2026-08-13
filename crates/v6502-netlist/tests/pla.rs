//! The decode PLA's AND plane, located structurally.
//!
//! These check the *shape* only. Whether a term fires for a given opcode is a
//! question for the engine, and is asserted in `v6502-sim/tests/decode.rs`.

use v6502_netlist::pla::{Pla, MIN_IR_INPUTS};
use v6502_netlist::Netlist;

fn pla() -> Pla {
    Pla::derive(&Netlist::mos6502())
}

#[test]
fn finds_the_whole_and_plane() {
    let p = pla();
    assert_eq!(p.rows.len(), 122, "product terms");
    assert_eq!(p.rows.iter().filter(|r| r.name.is_some()).count(), 121, "named terms");
    assert_eq!(p.outputs.len(), 46, "control lines");
}

/// The die names its own product terms, and the names carry the T-state and the
/// instructions each one serves. That is the single fact this page rests on --
/// without it there would be 122 anonymous nodes and nothing to say about them.
#[test]
fn the_terms_are_named_by_the_die() {
    let p = pla();
    for want in ["op-T0-lda", "op-T0-jsr", "op-T0-brk/rti", "op-T+-adc/sbc", "op-branch-done"] {
        assert!(p.row(want).is_some(), "{want} is missing");
    }
    // The names split the plane in two, and the split is the interesting part:
    // 88 terms name the T-state they belong to (`op-T0-lda`), and 33 do not
    // (`op-implied`, `op-jsr`, `op-branch-done`) because they are not tied to
    // one cycle -- they say something about the instruction that other logic
    // then combines with timing.
    let staged = p
        .rows
        .iter()
        .filter(|r| r.name.as_deref().is_some_and(|n| n.starts_with("op-T")))
        .count();
    assert_eq!(staged, 88, "terms naming a T-state");
    assert_eq!(121 - staged, 33, "named terms that are stage-independent");
}

#[test]
fn every_term_tests_at_least_two_opcode_bits() {
    let p = pla();
    for r in &p.rows {
        assert!(
            r.ir.len() >= MIN_IR_INPUTS,
            "{:?} has {} IR inputs",
            r.name,
            r.ir.len()
        );
        assert!(r.ir.len() <= 8, "{:?} tests more bits than an opcode has", r.name);
        // A term cannot require a bit to be both high and low.
        for t in &r.ir {
            assert!(
                !r.ir.iter().any(|u| u.bit == t.bit && u.required != t.required),
                "{:?} constrains bit {} both ways",
                r.name,
                t.bit
            );
        }
    }
}

/// The one term the die does not name turns out to be the thing that makes the
/// others work: it tests IR bits 0 and 1 and drives `irline3`, which is how a
/// term like `op-T0-jsr` pins the low two opcode bits without gating them.
#[test]
fn the_unnamed_term_is_the_irline3_generator() {
    let p = pla();
    let anon: Vec<_> = p.rows.iter().filter(|r| r.name.is_none()).collect();
    assert_eq!(anon.len(), 1, "expected exactly one unnamed term");
    let r = anon[0];
    let mut bits: Vec<u8> = r.ir.iter().map(|t| t.bit).collect();
    bits.sort();
    assert_eq!(bits, vec![0, 1], "it should test only the low two opcode bits");
    assert!(r.ir.iter().all(|t| !t.required), "both bits low");
    assert!(r.ir_only(), "nothing else gates it");
}

/// `ir_candidates` is an upper bound and must be treated as one. `op-T0-jsr`
/// admits four opcodes on its IR gates alone and the chip decodes exactly one,
/// the difference being `irline3` -- which is precisely why the real answer is
/// measured rather than computed.
#[test]
fn ir_candidates_is_an_upper_bound_not_an_answer() {
    let p = pla();
    let jsr = p.row("op-T0-jsr").unwrap();
    let candidates = jsr.ir_candidates();
    assert!(candidates.contains(&0x20), "JSR must be among the candidates");
    assert!(
        candidates.len() > 1,
        "if this ever narrows to one, irline3 has been folded in and the \
         measured/computed split should be revisited"
    );
    assert!(
        jsr.other.iter().any(|(_, n)| n == "irline3"),
        "the extra constraint should be irline3"
    );
    assert!(!jsr.ir_only(), "so the term is not decided by IR bits alone");
}

#[test]
fn rows_sit_in_the_control_section_of_the_die() {
    let p = pla();
    // The datapath is the lower half; the decode PLA is not part of it. If a
    // "term" ever turns up down there, the detector has caught something else.
    for r in &p.rows {
        assert!(
            r.die.1 > 6000,
            "{:?} at y={} is outside the control section",
            r.name,
            r.die.1
        );
    }
}

#[test]
fn control_lines_sort_the_way_they_read() {
    let p = pla();
    let names: Vec<&str> = p.outputs.iter().map(|o| o.name.as_str()).collect();
    // dpc-1 and dpc-2 are real, and text order would put dpc10 before dpc2.
    let first = names[0];
    assert!(first.starts_with("dpc-"), "negative indices sort first, got {first}");
    let pos = |want: &str| names.iter().position(|n| n.starts_with(want)).unwrap();
    assert!(pos("dpc2_") < pos("dpc10_"), "dpc2 must precede dpc10");
    assert!(pos("dpc9_") < pos("dpc10_"), "dpc9 must precede dpc10");
}

/// The OR plane: a control line's candidate terms.
///
/// These are candidates only — `export-decode` throws away any set that fails to
/// predict the measured runs, and 14 of the 46 lines do not survive that. What
/// is asserted here is that the walk finds the *right* terms where the answer is
/// independently obvious.
#[test]
fn the_trace_reaches_the_terms_that_make_sense() {
    let nl = Netlist::mos6502();
    let p = pla();
    let bp = v6502_netlist::blueprint::Blueprint::derive(&nl);
    let blocked: Vec<u16> =
        bp.units.iter().flat_map(|u| u.bits.iter().flatten().copied()).collect();
    let cands = p.candidate_terms(&nl, &blocked);

    let named = |line: &str| -> Vec<&str> {
        let i = p.outputs.iter().position(|o| o.name == line).expect(line);
        let mut v: Vec<&str> =
            cands[i].iter().filter_map(|t| p.rows[*t].name.as_deref()).collect();
        v.sort();
        v
    };

    // SBX puts the special bus into X, so the terms behind it should be exactly
    // the operations that write X -- and they are.
    assert_eq!(
        named("dpc3_SBX"),
        ["op-T+-dex", "op-T+-inx", "op-T0-ldx/tax/tsx"],
        "the terms reaching SBX should be the ones that write X"
    );

    // SBAC writes the accumulator; every term reaching it should be an
    // accumulator-writing operation.
    let ac = named("dpc23_SBAC");
    assert!(ac.contains(&"op-T0-lda"), "LDA writes A: {ac:?}");
    assert!(ac.contains(&"op-T0-txa"), "TXA writes A: {ac:?}");
    assert!(ac.len() >= 5 && ac.len() <= 12, "unexpected fan-in {}: {ac:?}", ac.len());

    // Blocking the datapath matters: without it the walk escapes along the
    // buses and drags in terms that have nothing to do with the line.
    let loose = p.candidate_terms(&nl, &[]);
    let tight: usize = cands.iter().map(Vec::len).sum();
    let wide: usize = loose.iter().map(Vec::len).sum();
    assert!(
        wide > tight,
        "blocking the datapath should narrow the candidate sets ({wide} vs {tight})"
    );
}
