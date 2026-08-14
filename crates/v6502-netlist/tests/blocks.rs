//! The functional block derivation.
//!
//! These check the *partition* -- that every node lands somewhere, that the
//! seeds land where the die's own names say they should, and that the result is
//! spatially coherent enough for an exploded view to be meaningful rather than
//! decorative.
//!
//! The measured numbers are asserted at their current values on purpose. They
//! are not targets, and a change to them is not a failure -- it is a signal that
//! the classification moved, which is exactly the thing that should never happen
//! silently.

use std::collections::HashSet;

use v6502_netlist::blocks::{classify_name, Block, Blocks, Half, UNCLASSIFIED};
use v6502_netlist::blueprint::{centroid, Blueprint};
use v6502_netlist::{NodeId, Netlist};

fn setup() -> (Netlist, Blocks) {
    let nl = Netlist::mos6502();
    let b = Blocks::derive(&nl);
    (nl, b)
}

/// Normalised spread: RMS distance from a block's own centre, over the die
/// diagonal. Small means the block is a place on the chip; large means it is
/// scattered and would explode into confetti.
fn spread(b: &v6502_netlist::blocks::Block) -> f64 {
    let pts: Vec<(f64, f64)> =
        b.nodes.iter().filter_map(|n| centroid(*n)).map(|(x, y)| (x as f64, y as f64)).collect();
    if pts.is_empty() {
        return 0.0;
    }
    let diag = (8983f64 - 214.0).hypot(9807f64 - 179.0);
    let rms = (pts.iter().map(|p| (p.0 - b.die.0).powi(2) + (p.1 - b.die.1).powi(2)).sum::<f64>()
        / pts.len() as f64)
        .sqrt();
    rms / diag
}

#[test]
fn every_node_lands_in_exactly_one_block() {
    let (nl, b) = setup();
    let mut seen: HashSet<NodeId> = HashSet::new();
    for blk in &b.blocks {
        for n in &blk.nodes {
            assert!(seen.insert(*n), "node {n} appears in more than one block");
            assert_eq!(b.of_node(*n), blk.id, "node {n} disagrees with its block's id");
        }
    }
    let expected: usize =
        (0..nl.node_count() as NodeId).filter(|n| nl.exists(*n) && !nl.is_rail(*n)).count();
    assert_eq!(seen.len(), expected, "every real non-rail node must be placed");
    assert_eq!(expected, 1702);
}

/// The rails are excluded rather than filed somewhere. They blanket the die, so
/// putting them in a block would drag that block over the whole chip -- the same
/// reason the renderer mutes them in the state overlay.
#[test]
fn the_power_rails_belong_to_no_block() {
    let (nl, b) = setup();
    for rail in [nl.vss(), nl.vcc()] {
        assert!(
            !b.blocks.iter().any(|blk| blk.nodes.contains(&rail)),
            "a rail was filed into a block"
        );
    }
}

#[test]
fn every_transistor_is_placed() {
    let (nl, b) = setup();
    let total: usize = b.blocks.iter().map(|x| x.transistors.len()).sum();
    assert_eq!(total, nl.transistor_count());
    assert_eq!(total, 3510);
}

/// The seeds must land where the die's own names say. If any of these moves,
/// the name table has drifted away from the trace.
#[test]
fn the_seeds_land_where_the_names_say() {
    let (nl, b) = setup();
    let block_of = |name: &str| -> String {
        let n = nl.node(name).unwrap_or_else(|| panic!("{name} is not a node"));
        b.blocks[b.of_node(n) as usize].name.clone()
    };
    for (node, want) in [
        ("ir0", "Instruction register"),
        ("notir7", "Instruction register"),
        ("pd3", "Instruction register"),
        ("op-T0-lda", "Decode PLA"),
        ("op-branch-done", "Decode PLA"),
        ("dpc3_SBX", "Control pipeline"),
        ("cclk", "Control pipeline"),
        ("clock1", "Timing chain"),
        ("clock2", "Timing chain"),
        ("t2", "Timing chain"),
        ("t5", "Timing chain"),
        ("NMIP", "Interrupts & vectors"),
        ("RESP", "Interrupts & vectors"),
        ("pcl0", "Program counter"),
        ("pch7", "Program counter"),
        ("alua0", "ALU"),
        ("alub7", "ALU"),
        ("alucout", "ALU"),
        ("a0", "Registers"),
        ("x7", "Registers"),
        ("s3", "Registers"),
        ("p0", "Status register"),
        ("abl0", "Address latches"),
        ("adh7", "Address latches"),
        ("idb0", "Data bus"),
        ("sb7", "Data bus"),
        ("ab0", "Pads & I/O"),
        ("db7", "Pads & I/O"),
        ("sync", "Pads & I/O"),
        ("rw", "Pads & I/O"),
    ] {
        assert_eq!(block_of(node), want, "{node}");
    }
}

/// Stems are matched exactly, and this is the reason. `a0` is the accumulator
/// and `abl0` is the low address latch; a prefix match would put the address
/// path inside the register file and quietly hollow out both.
#[test]
fn stem_matching_does_not_confuse_a_with_abl() {
    assert_ne!(classify_name("a0"), classify_name("abl0"));
    assert_ne!(classify_name("s0"), classify_name("sb0"));
    assert_ne!(classify_name("p0"), classify_name("pcl0"));
    assert_ne!(classify_name("db0"), classify_name("dor0"));
    // ...and the accumulator really is the register block, not something that
    // merely failed to match anything else.
    assert!(classify_name("a0").is_some());
}

/// The trace decorates the two phases of a precharged pair and its duplicate
/// copies. Those are the same structure and must classify the same way.
#[test]
fn decoration_does_not_change_the_answer() {
    for (a, b) in [
        ("pclp0", "#pclp0"),
        ("pclp0", "~pclp0"),
        ("op-store", "#op-store"),
        ("op-T3-branch", "~op-T3-branch"),
        ("alucout", "##alucout"),
        ("op-jmp", "x-op-jmp"),
        ("op-T5-jsr", "xx-op-T5-jsr"),
        ("notRdy0", "notRdy0.delay"),
        ("TWOCYCLE", "#TWOCYCLE.phi1"),
    ] {
        assert_eq!(classify_name(a), classify_name(b), "{a} vs {b}");
        assert!(classify_name(a).is_some(), "{a} should classify at all");
    }
    // The adder's intermediate logic is named as the functions it computes, and
    // only reachable once the decoration is off.
    for n in ["#C01", "~C78", "A+B3", "#(AxB)4", "~(AxBxC)7", "#A.B0", "#aluresult5"] {
        let id = classify_name(n).unwrap_or_else(|| panic!("{n} did not classify"));
        assert_eq!(id, classify_name("alua0").unwrap(), "{n} should be ALU");
    }
}

/// A switch is filed by its channel, never by its gate. The gate is the control
/// line reaching in from the decoder; taking it would file every datapath pass
/// transistor under `Control pipeline` and empty the datapath of the switches
/// that are the whole point of it.
#[test]
fn switches_are_filed_by_channel_not_by_gate() {
    let (nl, b) = setup();
    let bp = Blueprint::derive(&nl);
    let pipeline = b.block("Control pipeline").unwrap().id;

    let mut in_datapath = 0;
    let mut total = 0;
    for link in &bp.links {
        for sw in &link.switches {
            total += 1;
            let id = b.of_transistor(sw.transistor);
            assert_ne!(
                id, pipeline,
                "a datapath bus switch was filed under the block that merely gates it"
            );
            if b.blocks[id as usize].half == Half::Datapath {
                in_datapath += 1;
            }
        }
    }
    assert_eq!(total, 159, "the blueprint's switch count");
    assert!(
        in_datapath >= 150,
        "only {in_datapath} of {total} bus switches landed in the datapath"
    );
}

/// Growth follows terminals, not gates. Following gates would let the decoder
/// reach every node it controls and swallow the chip, so this pins the outcome:
/// the decode PLA stays a part of the chip rather than becoming most of it.
#[test]
fn growth_does_not_let_the_decoder_swallow_the_chip() {
    let (_, b) = setup();
    let decode = b.block("Decode PLA").unwrap();
    assert!(
        decode.nodes.len() < 250,
        "Decode PLA has {} nodes, which suggests growth crossed gates",
        decode.nodes.len()
    );
    // ...and it is overwhelmingly named rather than grown, which is what makes
    // it the strongest claim on the page.
    assert!(
        decode.seeded_fraction() > 0.9,
        "Decode PLA is only {:.0}% seeded",
        100.0 * decode.seeded_fraction()
    );
}

/// Each block must be somewhere, not everywhere -- otherwise pulling them apart
/// shows nothing. `Pads & I/O` is exempt and tested separately: it is a ring.
#[test]
fn blocks_are_places_on_the_die() {
    let (_, b) = setup();
    for blk in &b.blocks {
        if blk.id == UNCLASSIFIED || blk.name == "Pads & I/O" || blk.nodes.is_empty()
            || blk.half == Half::Logic
        {
            continue;
        }
        let s = spread(blk);
        assert!(s < 0.25, "{} is scattered (spread {s:.3})", blk.name);
    }
    // The tightest are the bit-sliced ones, which is the datapath being a real
    // column structure rather than a label applied to a region.
    for name in ["Program counter", "Registers", "ALU", "Status register"] {
        let s = spread(b.block(name).unwrap());
        assert!(s < 0.12, "{name} should be a tight column, got {s:.3}");
    }
}

/// The pads are a ring around the edge, so their centroid is the middle of the
/// die and their spread is meaningless -- the right check is that none of them
/// is near the centre. This is the reason `Pads & I/O` is exempt from
/// [`blocks_are_places_on_the_die`], and the reason the view moves it radially
/// outward rather than translating it like the others.
///
/// The claim is about the **seeded** pads. Growth reaches inward along the
/// drivers -- an unnamed node behind `#WR` lands at radius 0.35 -- so asserting
/// this over every node in the block would be testing the growth rule while
/// appearing to test the pad ring.
#[test]
fn the_pads_are_a_ring_not_a_blob() {
    let (_, b) = setup();
    let pads = b.block("Pads & I/O").unwrap();
    let (cx, cy) = (4598.5f64, 4993.0f64);
    let half = ((8983f64 - 214.0) / 2.0).hypot((9807f64 - 179.0) / 2.0);
    let radius = |n: &NodeId| {
        centroid(*n).map(|(x, y)| (x as f64 - cx).hypot(y as f64 - cy) / half)
    };

    let seeded: Vec<f64> =
        pads.nodes.iter().filter(|n| b.was_seeded(**n)).filter_map(radius).collect();
    assert!(seeded.len() >= 30, "only {} seeded pads", seeded.len());
    let closest = seeded.iter().cloned().fold(f64::MAX, f64::min);
    assert!(
        closest > 0.40,
        "a named pad sits at radius {closest:.2}, so this is not a ring after all"
    );

    // Growth is allowed to soften the edge, but not to fill the middle.
    let grown_inside = pads
        .nodes
        .iter()
        .filter(|n| !b.was_seeded(**n))
        .filter_map(radius)
        .filter(|r| *r < 0.40)
        .count();
    assert!(grown_inside <= 3, "growth pulled {grown_inside} interior nodes into the pads");

    assert!(spread(pads) > 0.25, "if the pads ever became compact, this test is the wrong one");
}

/// Seeded and grown are different strengths of claim, and the split is
/// published so a view can show which it is drawing.
#[test]
fn the_seeded_flag_agrees_with_the_per_block_counts() {
    let (_, b) = setup();
    for blk in &b.blocks {
        let counted = blk.nodes.iter().filter(|n| b.was_seeded(**n)).count();
        assert_eq!(counted, blk.seeded, "{} seeded count", blk.name);
    }
    // Nothing unclassified can have been seeded: a name rule that matched would
    // have placed it somewhere.
    for n in &b.blocks[UNCLASSIFIED as usize].nodes {
        assert!(!b.was_seeded(*n), "node {n} is seeded but unclassified");
    }
    // Most of what lands in a *functional* block is named rather than inferred.
    //
    // Static logic is excluded from this ratio deliberately. The die names none
    // of it -- a gate output is not a signal anybody had reason to label -- and
    // it is identified by an electrical signature rather than by growth, so
    // counting it here would make an honest identification look like the growth
    // rule running away.
    let functional = |x: &&Block| x.id != UNCLASSIFIED && x.half != Half::Logic;
    let placed: usize = b.blocks.iter().filter(functional).map(|x| x.nodes.len()).sum();
    let named: usize = b.blocks.iter().filter(functional).map(|x| x.seeded).sum();
    assert!(
        named * 2 > placed,
        "only {named} of {placed} nodes in functional blocks are named; \
         growth is doing too much"
    );

    // The static logic is not named at all, and that is the expected result
    // rather than a shortfall.
    let logic = b.block("Static logic").unwrap();
    assert_eq!(logic.seeded, 0, "a name rule should never place static logic");
}

/// What is left over, and *why* it is left over.
///
/// The residue is two structures, four nodes and two transistors, and neither
/// structure can influence the chip. A node affects the simulation only by
/// gating a transistor; a transistor matters only if something downstream of its
/// channel is gated by something. Every node here fails one of those tests
/// outright, so this is a proof rather than a sample.
#[test]
fn the_residue_is_two_inert_structures() {
    let (nl, b) = setup();
    let residue = &b.blocks[UNCLASSIFIED as usize];
    assert_eq!(residue.nodes.len(), 4, "residue nodes");
    assert_eq!(residue.transistors.len(), 2, "residue transistors");

    for &n in &residue.nodes {
        let gates = nl.gates_of(n).len();
        let terms = nl.terminals_of(n).len();
        assert!(
            gates == 0 || terms == 0,
            "node {n} gates {gates} transistors through {terms} terminals, so it is \
             not obviously inert and this test is now claiming more than it checks"
        );
    }

    // A transistor here can only move charge between nodes that gate nothing, so
    // switching it is unobservable.
    for &t in &residue.transistors {
        for c in [nl.transistor_c1(t), nl.transistor_c2(t)] {
            assert!(
                nl.is_rail(c) || nl.gates_of(c).is_empty(),
                "transistor {t} reaches node {c}, which gates something"
            );
        }
    }

    // One of the two cannot even switch: its gate has no terminals, so nothing
    // in the chip is able to drive it.
    let dead_gate = residue
        .transistors
        .iter()
        .filter(|&&t| nl.terminals_of(nl.transistor_gate(t)).is_empty())
        .count();
    assert_eq!(dead_gate, 1, "expected exactly one transistor with an undriveable gate");
}

/// Coverage, stated rather than implied.
#[test]
fn coverage_is_what_was_measured() {
    let (nl, b) = setup();
    assert_eq!(b.unclassified_transistors(), 2, "unclassified transistors");
    assert_eq!(b.unclassified_nodes(), 4, "unclassified nodes");

    let logic = b.block("Static logic").unwrap();
    assert_eq!(logic.nodes.len(), 674, "static logic nodes");
    assert_eq!(logic.transistors.len(), 1060, "static logic transistors");

    // The pass-transistor / static-gate split the die is known for. `CLAUDE.md`
    // puts the chip at roughly 76% pass transistors; the static logic found here
    // is the other side of that, and landing in the right neighbourhood is a
    // check on the electrical signature rather than a coincidence.
    let frac = logic.transistors.len() as f64 / nl.transistor_count() as f64;
    assert!((0.25..0.35).contains(&frac), "static logic is {frac:.3} of the chip");
}

/// What the static logic *is*, asserted from the electrical signature that
/// defines it rather than from where it happened to end up.
#[test]
fn the_static_logic_is_gates_wired_to_the_rails() {
    let (nl, b) = setup();
    let logic = b.block("Static logic").unwrap();
    let pu = nl.pullups();

    // Membership has two tiers, and conflating them would overstate the claim.
    // Most nodes carry the signature outright. The rest joined by sitting on the
    // far side of a pass transistor tapping one that does -- so the weaker tier
    // must still touch the stronger one, never merely touch each other.
    let members: HashSet<NodeId> = logic.nodes.iter().copied().collect();
    let signature = |n: NodeId| {
        pu.get(n as usize) || nl.terminals_of(n).iter().any(|t| t.other == nl.vss())
    };

    let mut by_signature = 0;
    for &n in &logic.nodes {
        if signature(n) {
            by_signature += 1;
            continue;
        }
        assert!(
            nl.terminals_of(n).iter().any(|t| members.contains(&t.other) && signature(t.other)),
            "node {n} is in the static logic without the signature and without \
             touching anything that has it"
        );
    }
    assert_eq!(by_signature, 587, "nodes carrying the gate signature outright");
    assert!(
        by_signature * 2 > logic.nodes.len(),
        "the block is now mostly adjacency rather than signature"
    );

    // Most of its transistors are pulldowns -- that is what the block is made of.
    let pulldowns = logic
        .transistors
        .iter()
        .filter(|&&t| nl.transistor_c1(t) == nl.vss() || nl.transistor_c2(t) == nl.vss())
        .count();
    assert!(
        pulldowns * 10 >= logic.transistors.len() * 7,
        "only {pulldowns} of {} static-logic transistors reach vss",
        logic.transistors.len()
    );
}

/// Why the static logic survives growth at all, which is the whole reason it
/// needed identifying separately: a gate output touches nothing but its pullup
/// and its pulldown, and growth refuses to cross a rail. So the logic is not a
/// region that was missed -- it is hundreds of islands surrounded by power.
#[test]
fn the_static_logic_is_islands_not_a_region() {
    let (nl, b) = setup();
    let logic = b.block("Static logic").unwrap();
    let members: HashSet<NodeId> = logic.nodes.iter().copied().collect();

    let mut seen: HashSet<NodeId> = HashSet::new();
    let mut sizes = Vec::new();
    for &start in &logic.nodes {
        if !seen.insert(start) {
            continue;
        }
        let mut stack = vec![start];
        let mut size = 0;
        while let Some(n) = stack.pop() {
            size += 1;
            for t in nl.terminals_of(n) {
                if members.contains(&t.other) && seen.insert(t.other) {
                    stack.push(t.other);
                }
            }
        }
        sizes.push(size);
    }
    sizes.sort_unstable_by(|a, c| c.cmp(a));
    assert!(sizes.len() > 300, "expected many islands, got {}", sizes.len());
    assert!(sizes[0] <= 12, "largest island has {} nodes -- this is a region, not gates", sizes[0]);

    // ...and therefore it is scattered, which is why it does not translate when
    // the view explodes. Moving it as one body would put gates where there are
    // none. This is the same reasoning that exempts it from
    // `blocks_are_places_on_the_die`.
    assert!(spread(logic) > 0.20, "static logic is unexpectedly compact");
}

/// A gate's output feeds a functional block, and that is recorded -- but it is
/// never used to place anything, because affiliation is not location.
#[test]
fn what_a_gate_drives_is_recorded_but_never_positions_it() {
    let (_, b) = setup();
    let logic = b.block("Static logic").unwrap();

    let attributed = logic.nodes.iter().filter(|n| b.drives(**n) != UNCLASSIFIED).count();
    assert!(attributed > 300, "only {attributed} gates could be attributed");

    // Only static logic gets an attribution: a node already in a functional
    // block does not need one, and giving it one would invite double-counting.
    for blk in &b.blocks {
        if blk.name == "Static logic" {
            continue;
        }
        for &n in &blk.nodes {
            assert_eq!(b.drives(n), UNCLASSIFIED, "{} node {n} was attributed", blk.name);
        }
    }

    // An attribution never points at the static block or at nothing.
    for &n in &logic.nodes {
        let d = b.drives(n);
        if d != UNCLASSIFIED {
            assert_ne!(b.blocks[d as usize].half, Half::Logic);
            assert_ne!(d, UNCLASSIFIED);
        }
    }

    // A quarter of attributed gates sit a long way from what they drive, which
    // is real -- control signals are made by the decoder and consumed in the
    // datapath. It is also exactly why `Half::Logic` does not translate.
    let far = logic
        .nodes
        .iter()
        .filter(|n| b.drives(**n) != UNCLASSIFIED)
        .filter_map(|n| centroid(*n).map(|c| (c, b.drives(*n))))
        .filter(|((x, y), d)| {
            let t = b.blocks[*d as usize].die;
            (*x as f64 - t.0).hypot(*y as f64 - t.1) > 3000.0
        })
        .count();
    assert!(far > 20, "expected some gates to sit far from what they drive, got {far}");
}

/// The two halves the transistor distribution already shows: a datapath below
/// y≈5000 and a control section above y≈7000, with a near-empty band between.
#[test]
fn the_halves_sit_where_the_transistors_say_they_do() {
    let (_, b) = setup();
    for blk in &b.blocks {
        if blk.nodes.is_empty() {
            continue;
        }
        match blk.half {
            Half::Datapath => assert!(
                blk.die.1 < 6000.0,
                "{} is called datapath but sits at y={:.0}",
                blk.name,
                blk.die.1
            ),
            Half::Control => assert!(
                blk.die.1 > 5000.0,
                "{} is called control but sits at y={:.0}",
                blk.name,
                blk.die.1
            ),
            _ => {}
        }
    }
}
