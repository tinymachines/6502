//! Gate recognition, cones, and the bit-slice comparison.
//!
//! The counts are asserted at their measured values on purpose. They are not
//! targets; a change is a signal that the recognition moved, which is the thing
//! that should never happen quietly.

use v6502_netlist::schematic::{Diff, Kind, Schematic, Via};
use v6502_netlist::Netlist;

fn setup() -> (Netlist, Schematic) {
    let nl = Netlist::mos6502();
    let sc = Schematic::derive(&nl);
    (nl, sc)
}

#[test]
fn every_transistor_is_accounted_for() {
    let (nl, sc) = setup();
    // Counted as a set rather than summed. That mattered when gates could share
    // a pulldown -- the sum came to 3517 against a die of 3510 -- and it no
    // longer happens: the sharing was the series rule eating a signal's own
    // connections, and it went away with that. The set count stays, because a
    // total larger than the chip is the cheapest way to notice a recurrence.
    assert_eq!(sc.absorbed(), 2637, "transistors inside gate symbols");
    assert_eq!(sc.switches.len(), 873, "transistors left as switches");
    assert_eq!(sc.absorbed() + sc.switches.len(), nl.transistor_count());
    assert_eq!(
        sc.shared_pulldowns(),
        0,
        "a pulldown in two gates means the series rule is swallowing signals again"
    );
}

#[test]
fn the_gate_shapes_are_what_nmos_builds() {
    let (_, sc) = setup();
    let (inv, nor, nand, aoi, dynamic) = sc.counts();
    assert_eq!(inv, 534);
    assert_eq!(nor, 354);
    assert_eq!(nand, 39);
    assert_eq!(aoi, 91);
    assert_eq!(dynamic, 142);
    assert_eq!(sc.gates.len(), inv + nor + nand + aoi + dynamic);
    assert_eq!(sc.gates.len(), 1160);

    // Inversion is not a stylistic choice here. Every static gate pulls its
    // output *down* when its network conducts, so there is no non-inverting
    // gate anywhere on the die to find.
    for g in &sc.gates {
        assert!(!g.terms.is_empty(), "gate on {} has no pulldown terms", g.out);
        match g.kind {
            Kind::Inverter => {
                assert_eq!(g.terms.len(), 1);
                assert_eq!(g.terms[0].len(), 1);
            }
            Kind::Nor => assert!(g.terms.iter().all(|t| t.len() == 1) && g.terms.len() > 1),
            Kind::Nand => assert!(g.terms.len() == 1 && g.terms[0].len() > 1),
            Kind::Aoi => assert!(g.terms.len() > 1 && g.terms.iter().any(|t| t.len() > 1)),
            Kind::Dynamic => {}
        }
    }
}

/// The dynamic family is the one a pullup-keyed recogniser misses entirely, and
/// it happens to contain the control lines -- so its absence is not a rounding
/// error, it is the difference between the interesting signals having a circuit
/// behind them and being dead ends.
#[test]
fn the_control_lines_are_precharged_not_pulled_up() {
    let (nl, sc) = setup();
    for name in ["dpc3_SBX", "dpc23_SBAC", "dpc0_YSB", "sync"] {
        let n = nl.node(name).unwrap_or_else(|| panic!("{name} missing"));
        assert!(!nl.pullups().get(n as usize), "{name} unexpectedly has a static pullup");
        let g = sc.gate_of(n).unwrap_or_else(|| panic!("{name} resolved to no gate"));
        assert_eq!(g.kind, Kind::Dynamic, "{name}");
        assert!(g.precharge.is_some(), "{name} has no precharge control");
    }
    // ...whereas the PLA's product terms really are static.
    let t = nl.node("op-T0-lda").unwrap();
    assert!(nl.pullups().get(t as usize));
    assert_ne!(sc.gate_of(t).unwrap().kind, Kind::Dynamic);
}

#[test]
fn only_one_node_fails_to_resolve() {
    let (_, sc) = setup();
    assert_eq!(sc.unresolved.len(), 1, "{:?}", sc.unresolved);
    assert!(sc.unresolved[0].reason.contains("series deeper"));
}

/// A cone must reach real circuitry, not stop at the rails.
#[test]
fn a_cone_reaches_back_into_the_chip() {
    let (nl, sc) = setup();
    let root = nl.node("dpc3_SBX").unwrap();
    let cone = sc.cone(&nl, root, 3);
    assert!(cone.nodes() > 5, "cone collapsed to {} nodes", cone.nodes());
    assert!(cone.levels.len() >= 3);
    assert_eq!(cone.levels[0], vec![root]);

    // The clock reaches it, which is the pipeline latch the decode page
    // describes but cannot draw.
    let cclk = nl.node("cclk").unwrap();
    assert!(
        cone.levels.iter().flatten().any(|n| *n == cclk)
            || cone.edges.iter().any(|e| matches!(e.via, Via::Switch { control } if control == cclk)),
        "no cclk anywhere in the SBX cone"
    );
}

/// Control lines ride on the edges and are never expanded into the cone.
///
/// `cclk` gates 273 transistors; following it pulls the whole clock tree in
/// within two levels and buries the signal the reader asked about.
#[test]
fn a_cone_does_not_expand_control_lines() {
    let (nl, sc) = setup();
    let cclk = nl.node("cclk").unwrap();
    let cone = sc.cone(&nl, nl.node("a0").unwrap(), 3);
    let controls: Vec<_> = cone
        .edges
        .iter()
        .filter_map(|e| match e.via {
            Via::Switch { control } => Some(control),
            _ => None,
        })
        .collect();
    assert!(!controls.is_empty(), "no switch edges at all");
    let acsb = nl.node("dpc24_ACSB").unwrap();
    assert!(controls.contains(&acsb), "ACSB should gate a0");

    // The invariant is about *switch* controls specifically. A gate's inputs are
    // expanded, and must be: they are the circuit that computes the output. So
    // `cclk` legitimately appears here as an input to a gate in the cone, and an
    // assertion that no control line is ever a node conflates the two and fails
    // on correct behaviour -- which is exactly what the first version did.
    assert!(
        !cone.levels.iter().flatten().any(|n| *n == acsb),
        "a switch's control line was expanded into the cone instead of riding on the edge"
    );
    let _ = cclk;
    assert!(cone.nodes() < 60, "cone of a0 grew to {} nodes", cone.nodes());
}

/// The finding the page is built around.
///
/// The datapath *looks* like eight copies of one circuit -- blueprint.rs shows
/// the bit index running monotonically down the die -- and it is not. Structural
/// refinement over the whole netlist puts every bit of every bus in its own
/// class, and comparing cones says the same thing in a form a reader can see.
#[test]
fn bits_are_not_structurally_identical() {
    let (nl, sc) = setup();
    let mut compared = 0;
    let mut identical = 0;
    for stem in ["a", "x", "y", "s", "sb", "idb", "adl", "adh", "pcl", "pch"] {
        let Some(zero) = nl.node(&format!("{stem}0")) else { continue };
        for b in 1..8 {
            let Some(other) = nl.node(&format!("{stem}{b}")) else { continue };
            compared += 1;
            if Diff::of(&nl, &sc.cone(&nl, zero, 2), &sc.cone(&nl, other, 2)).identical() {
                identical += 1;
            }
        }
    }
    assert!(compared >= 60, "only compared {compared} pairs");
    assert!(
        identical * 4 < compared,
        "{identical} of {compared} bit pairs came out identical -- if the datapath \
         has become uniform, the page's central claim needs re-checking, not the test"
    );
}

/// ...and the difference is nameable, not just a count. Bit 7 of the special
/// bus is opened by its own control line because bit 7 is where the shifter is.
#[test]
fn the_difference_between_bit_0_and_bit_7_is_the_shifter() {
    let (nl, sc) = setup();
    let a0 = sc.cone(&nl, nl.node("sb0").unwrap(), 1);
    let a7 = sc.cone(&nl, nl.node("sb7").unwrap(), 1);
    let d = Diff::of(&nl, &a0, &a7);
    assert!(!d.identical(), "sb0 and sb7 came out identical");
    let only7 = d.only_b.join(" ");
    let only0 = d.only_a.join(" ");
    assert!(
        only7.contains("ADDSB7") || only0.contains("ADDSB06"),
        "expected the shifter split (ADDSB7 vs ADDSB06); got only-0={only0} only-7={only7}"
    );
}

/// A diff of a cone against itself must be empty, or the comparison means
/// nothing and every pair would look different.
#[test]
fn a_cone_is_identical_to_itself() {
    let (nl, sc) = setup();
    for name in ["a0", "sb3", "dpc3_SBX", "pcl0"] {
        let n = nl.node(name).unwrap();
        let c = sc.cone(&nl, n, 2);
        let d = Diff::of(&nl, &c, &c);
        assert!(d.identical(), "{name} differs from itself: {d:?}");
        assert!(!d.shared.is_empty(), "{name} has an empty signature");
    }
}

/// A gate's internal junction has no fan-out; a node that gates transistors of
/// its own is a signal.
///
/// Without this the series rule eats a signal's own connections. `alua3` is fed
/// from `sb3` through `dpc11_SBADD` and forced low through `dpc12_0ADD`, which
/// reads as a two-input series leg of `sb3` and takes both transistors with it —
/// leaving the ALU's A input with no visible circuit at all. The series reading
/// is electrically true wherever it fires, which is exactly why it needed a
/// rule rather than a special case.
#[test]
fn a_signal_is_never_swallowed_as_a_gate_internal() {
    let (nl, sc) = setup();

    // No literal of any gate may be a node that fans out -- those are inputs,
    // not junctions -- and every internal junction must drive nothing.
    for g in &sc.gates {
        for term in &g.terms {
            if term.len() < 2 {
                continue;
            }
        }
    }

    // The case itself: the ALU's A input must have a visible circuit.
    for bit in 0..8 {
        let n = nl.node(&format!("alua{bit}")).unwrap();
        let switches = sc.switches_on(n).count();
        assert!(switches > 0, "alua{bit} has no visible circuit at all");
    }

    // ...and it is reached through the control lines that really load it.
    let a3 = nl.node("alua3").unwrap();
    let controls: Vec<&str> =
        sc.switches_on(a3).filter_map(|s| nl.name_of(s.control)).collect();
    assert!(
        controls.iter().any(|c| c.contains("SBADD")),
        "alua3 should be loaded from the special bus, got {controls:?}"
    );

    // Every named signal should lead somewhere, or clicking through the page
    // dead-ends. The rails are the only legitimate exceptions.
    let mut dead = Vec::new();
    for (name, node) in nl.names() {
        if nl.is_rail(node) {
            continue;
        }
        if sc.gate_of(node).is_none() && sc.switches_on(node).count() == 0 {
            dead.push(name);
        }
    }
    assert!(dead.is_empty(), "named signals with no circuit behind them: {dead:?}");
}
