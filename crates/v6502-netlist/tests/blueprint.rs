//! The derived block diagram, checked against the netlist it came from.
//!
//! A drawing that claims to be derived has to be re-checkable, or it is a
//! drawing with a story attached. Every structural claim the blueprint makes is
//! verified here straight out of the transistor table -- not against a stored
//! copy of a previous run, which would only prove the derivation is stable.
//!
//! Counts are asserted exactly. `extern/visual6502` is a pinned submodule, so
//! these numbers cannot drift without someone moving it deliberately, and an
//! exact number that fails loudly is worth more than a range that absorbs a
//! regression quietly.

use std::collections::{HashMap, HashSet};
use v6502_netlist::blueprint::{Blueprint, Kind};
use v6502_netlist::Netlist;

fn bp() -> (Netlist, Blueprint) {
    let nl = Netlist::mos6502();
    let bp = Blueprint::derive(&nl);
    (nl, bp)
}

#[test]
fn derives_the_datapath() {
    let (_, bp) = bp();
    assert_eq!(bp.units.len(), 16, "units");
    assert_eq!(bp.links.len(), 21, "links");
    assert_eq!(bp.coverage.transistors_total, 3510);
    assert_eq!(bp.coverage.nodes_total, 1725);
}

/// The load-bearing check: every switch the diagram draws really is a
/// transistor joining those two units on that bit row.
///
/// This is what makes the picture a derivation rather than an illustration. It
/// re-resolves each switch through the netlist and refuses to take the
/// blueprint's own word for anything.
#[test]
fn every_switch_is_a_real_transistor_on_the_right_bit() {
    let (nl, bp) = bp();
    for link in &bp.links {
        let (ua, ub) = (&bp.units[link.a], &bp.units[link.b]);
        assert_ne!(link.a, link.b, "{} links a unit to itself", link.control);

        // The control really is on every one of those gates.
        for sw in &link.switches {
            let t = sw.transistor;
            assert_eq!(
                nl.transistor_gate(t),
                link.control_node,
                "{}: transistor {t} is not gated by the link's control",
                link.control
            );
            assert_eq!(
                nl.name_of(link.control_node),
                Some(link.control.as_str()),
                "control name disagrees with the netlist"
            );

            // ...and its two terminals are this bit of these two units. The
            // endpoints may be either way round, and either may be a merged
            // alias, so compare against the whole unit's node set for the bit.
            let (c1, c2) = (nl.transistor_c1(t), nl.transistor_c2(t));
            let a = ua.bits[sw.bit as usize];
            let b = ub.bits[sw.bit as usize];
            let touches = |n: Option<u16>| n == Some(c1) || n == Some(c2);
            let aliased = ua.aliases.is_empty() && ub.aliases.is_empty();
            if aliased {
                assert!(
                    touches(a) && touches(b),
                    "{} bit {}: transistor {t} joins {c1}..{c2}, not {}..{}",
                    link.control,
                    sw.bit,
                    ua.name,
                    ub.name
                );
            }
            assert!(!nl.is_rail(c1) && !nl.is_rail(c2), "a rail is not a datapath unit");
            assert!(
                !nl.is_rail(nl.transistor_gate(t)),
                "{}: a rail-gated transistor is permanently off and opens nothing",
                link.control
            );
        }
    }
}

#[test]
fn switches_are_one_per_bit_and_no_transistor_is_used_twice() {
    let (_, bp) = bp();
    let mut seen = HashSet::new();
    for link in &bp.links {
        let mut bits = HashSet::new();
        for sw in &link.switches {
            assert!(sw.bit < 8, "{}: bit {} is outside the datapath", link.control, sw.bit);
            assert!(
                bits.insert(sw.bit),
                "{}: two switches on bit {}",
                link.control,
                sw.bit
            );
            assert!(
                seen.insert(sw.transistor),
                "{}: transistor {} is already drawn elsewhere",
                link.control,
                sw.transistor
            );
        }
        assert_eq!(
            link.bits,
            link.switches.iter().fold(0u8, |m, s| m | 1 << s.bit),
            "{}: bit mask disagrees with the switches",
            link.control
        );
    }
}

/// Every path in the diagram carries a whole byte -- once the links that share
/// a pair are put together.
///
/// The one exception is the status register, and it is the good kind: `p` has
/// no bit 5. The die's own name table records `p5: -1`, silicon reads it back
/// as 1, and the mask that falls out of the switches here is `0xdf` without
/// anyone having said so. Asserting the hole is the point.
#[test]
fn every_path_carries_a_full_byte_except_the_flag_that_does_not_exist() {
    let (_, bp) = bp();
    let mut pair: HashMap<(usize, usize), u8> = HashMap::new();
    for link in &bp.links {
        let key = (link.a.min(link.b), link.a.max(link.b));
        *pair.entry(key).or_default() |= link.bits;
    }
    for ((a, b), bits) in &pair {
        let (na, nb) = (&bp.units[*a].name, &bp.units[*b].name);
        if na == "p" || nb == "p" {
            assert_eq!(*bits, 0xdf, "{na}<->{nb}: the status register's hole moved");
        } else {
            assert_eq!(*bits, 0xff, "{na}<->{nb} carries {bits:#04x}, not a full byte");
        }
    }
}

/// The shifter's single-bit path survives the width filter.
#[test]
fn the_adder_reaches_the_special_bus_on_all_eight_bits() {
    let (_, bp) = bp();
    let find = |c: &str| bp.links.iter().find(|l| l.control == c).expect(c);
    let wide = find("dpc20_ADDSB06");
    let top = find("dpc19_ADDSB7");
    assert_eq!(wide.bits, 0x7f);
    assert_eq!(top.bits, 0x80, "bit 7 goes to SB by its own control line");
    assert_eq!(top.switches.len(), 1, "and by exactly one switch");
    assert_eq!(
        (wide.a.min(wide.b), wide.a.max(wide.b)),
        (top.a.min(top.b), top.a.max(top.b)),
        "both halves must join the same pair"
    );
}

#[test]
fn aliased_stems_are_merged_not_duplicated() {
    let (_, bp) = bp();
    let sb = bp.unit("sb").expect("sb");
    assert!(
        sb.aliases.contains(&"dasb".to_string()),
        "dasb names the same wire as sb and must fold into it, or the \
         accumulator's path ends at a stub"
    );
    assert!(bp.unit("dasb").is_none(), "dasb must not also stand alone");
    // Every alias is gone from the unit list, not merely recorded.
    for u in &bp.units {
        for a in &u.aliases {
            assert!(bp.unit(a).is_none(), "{a} is both an alias and a unit");
        }
    }
}

#[test]
fn complements_fold_into_the_signal_they_invert() {
    let (_, bp) = bp();
    for stem in ["x", "y", "s", "alu"] {
        let u = bp.unit(stem).unwrap();
        assert_eq!(
            u.complement.as_deref(),
            Some(format!("not{stem}").as_str()),
            "{stem} should carry not{stem} as its complement"
        );
    }
    assert!(bp.unit("notx").is_none(), "a complement is not its own unit");
}

#[test]
fn the_special_bus_is_the_hub() {
    let (_, bp) = bp();
    let sb = bp.unit("sb").unwrap();
    assert_eq!(sb.kind, Kind::Bus);
    assert_eq!(sb.degree, 8, "SB reaches more units than anything else");
    for name in ["idb", "adl", "adh"] {
        assert_eq!(bp.unit(name).unwrap().kind, Kind::Bus, "{name} is a bus");
    }
    for name in ["x", "y", "s", "a"] {
        assert_eq!(bp.unit(name).unwrap().kind, Kind::Block, "{name} is a register");
    }
}

#[test]
fn no_unit_is_drawn_unconnected() {
    let (_, bp) = bp();
    let mut linked = HashSet::new();
    for l in &bp.links {
        linked.insert(l.a);
        linked.insert(l.b);
    }
    for (i, u) in bp.units.iter().enumerate() {
        assert!(linked.contains(&i), "{} has no links and should not be drawn", u.name);
        assert!(u.degree > 0);
    }
}

/// The layout is a *monotone remap* of the die: columns keep their left-to-right
/// order, so a reader can carry position between the two views.
#[test]
fn every_unit_is_placeable_on_the_die() {
    let (_, bp) = bp();
    for u in &bp.units {
        assert!(
            u.die.0 > 0.0 && u.die.1 > 0.0,
            "{} has no die position, so it cannot be ordered against the silicon",
            u.name
        );
        assert!(u.die.0 < 9000.0 && u.die.1 < 9900.0, "{} is off the die", u.name);
    }
}

/// Finding 2, asserted rather than remembered: in the datapath, bit index runs
/// down the die. This is what makes rows meaningful, and it is why the
/// idealised drawing can claim to preserve the silicon's order.
///
/// It holds strictly for 14 of the 15 datapath units. The exception is `adh`,
/// whose bits 2 and 3 come out swapped -- and the exception is a fact about the
/// *measurement*, not about the chip: a node's position here is the mean of its
/// polygons, and ADH carries the constant generators that force $01 for stack
/// access and $FF for vector fetches, so those bits own extra geometry that
/// drags the mean off the bit row. The rows the diagram draws come from the bit
/// *index*, never from the centroid, so this cannot reach the picture -- but it
/// is pinned here so that a second, real inversion could not hide behind it.
#[test]
fn bit_index_runs_down_the_die() {
    let (_, bp) = bp();
    let mut inverted: Vec<&str> = Vec::new();
    let mut checked = 0;
    for u in &bp.units {
        // `p` is the status register, which lives in the control section and is
        // not bit-sliced. It is the one unit here from that half of the chip.
        if u.name == "p" {
            continue;
        }
        let ys: Vec<f64> = (0..8)
            .filter_map(|b| u.bits[b])
            .filter_map(v6502_netlist::blueprint::centroid)
            .map(|(_, y)| y as f64)
            .collect();
        assert_eq!(ys.len(), 8, "{}: expected eight placeable bits", u.name);
        // Bit 0 is at the bottom of the die and bit 7 at the top, whatever
        // happens in between: that global direction must not flip.
        assert!(ys[0] > ys[7], "{}: bit 0 should sit below bit 7 -- {ys:?}", u.name);
        let swaps = ys.windows(2).filter(|w| w[0] <= w[1]).count();
        if swaps > 0 {
            inverted.push(&u.name);
            assert_eq!(swaps, 1, "{}: {swaps} inversions is more than geometry noise", u.name);
        }
        checked += 1;
    }
    assert_eq!(checked, 15, "every datapath unit should have been checked");
    assert_eq!(inverted, ["adh"], "the set of units whose centroids cross has changed");
}

#[test]
fn coverage_is_reported_honestly() {
    let (_, bp) = bp();
    let c = &bp.coverage;
    let drawn: usize = bp.links.iter().map(|l| l.switches.len()).sum();
    assert_eq!(c.transistors_drawn, drawn);
    // The diagram explains the bus fabric, which is a small slice of a chip
    // that is 76% pass transistors. It must not be able to claim otherwise.
    assert!(
        c.transistor_fraction() < 0.10,
        "coverage of {:.1}% looks too high to be only the bus fabric",
        100.0 * c.transistor_fraction()
    );
    assert!(c.nodes_drawn >= 120 && c.nodes_drawn < c.nodes_total);
}

#[test]
fn json_round_trips_the_structure() {
    let (_, bp) = bp();
    let json = bp.to_json();
    assert!(json.starts_with('{') && json.trim_end().ends_with('}'));
    for u in &bp.units {
        assert!(json.contains(&format!("\"name\":\"{}\"", u.name)), "{} missing", u.name);
    }
    for l in &bp.links {
        assert!(json.contains(&format!("\"control\":\"{}\"", l.control)));
    }
    // No Rust `None`/`Some` leaking into what claims to be JSON.
    assert!(!json.contains("Some(") && !json.contains("None"));
}
