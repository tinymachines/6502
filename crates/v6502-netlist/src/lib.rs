//! The MOS 6502, as a netlist.
//!
//! The topology, the solver and the die-data parser are not here: they are
//! `halfphi`, which is about switch networks rather than about this chip. What
//! this crate adds is the part that genuinely is about the 6502 -- the die data
//! itself, compiled in by `build.rs`, and the analyses seeded from the names on
//! that particular die.
//!
//! The split is a licence boundary as well as a design one. `halfphi` is MIT and
//! embeds no die data; this crate embeds `netlist.bin`, derived from
//! CC BY-NC-SA 3.0 material, and NonCommercial and ShareAlike propagate from
//! here. See NOTICE.md.

#![forbid(unsafe_code)]

pub mod blocks;
pub mod blueprint;
pub mod pla;
pub mod schematic;

// The library's own vocabulary, re-exported so that every caller in this
// workspace keeps naming these types where it always did.
pub use halfphi::netlist::{BitSet, DecodeError, Netlist, NodeId, Terminal, TransId};

/// The generated blob. Built by `build.rs` from the visual6502 die data.
static BLOB: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/netlist.bin"));

/// Decode the embedded 6502 netlist.
///
/// Cheap enough to call once at startup: ~90 KiB of allocation and no parsing
/// of source text, because the parse happened at build time.
///
/// This is a free function rather than `mos6502()` because `Netlist`
/// now belongs to `halfphi`, and a type that knows how to construct itself as
/// one particular chip is exactly the coupling this split exists to remove.
pub fn mos6502() -> Netlist {
    Netlist::decode(BLOB).expect("embedded netlist blob is valid")
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_the_6502() {
        let nl = mos6502();
        // The revD die trace: these counts are a fixed property of the data and
        // a canary for the build-time parser silently dropping entries.
        assert_eq!(nl.node_count(), 1725);
        assert_eq!(nl.transistor_count(), 3510);
        assert_ne!(nl.vss(), nl.vcc());
    }

    #[test]
    fn resolves_names_and_buses() {
        let nl = mos6502();
        assert!(nl.node("clk0").is_some());
        assert!(nl.node("sync").is_some());
        assert_eq!(nl.bus_width("ab"), 16);
        assert_eq!(nl.bus_width("db"), 8);
        assert!(nl.bus::<16>("ab").is_some());
        assert!(nl.bus::<8>("db").is_some());
        // Quoted keys in the source data must survive the parser.
        assert!(nl.node("#pclp0").is_some());
    }

    #[test]
    fn adjacency_is_consistent() {
        let nl = mos6502();
        let mut terminal_entries = 0;
        for n in 0..nl.node_count() as NodeId {
            for t in nl.gates_of(n) {
                assert_eq!(nl.transistor_gate(*t), n);
            }
            for term in nl.terminals_of(n) {
                let (c1, c2) = (nl.transistor_c1(term.transistor), nl.transistor_c2(term.transistor));
                assert!(n == c1 || n == c2, "node {n} not a terminal of {}", term.transistor);
                assert!(term.other == c1 || term.other == c2);
                terminal_entries += 1;
            }
        }
        // Two entries per transistor, minus those suppressed on the power rails.
        assert!(terminal_entries <= nl.transistor_count() * 2);
        assert!(nl.terminals_of(nl.vss()).is_empty());
        assert!(nl.terminals_of(nl.vcc()).is_empty());
    }

    #[test]
    fn status_register_has_no_bit_five() {
        // `p5: -1` in the source data is a sentinel, not a node.
        let nl = mos6502();
        assert!(nl.node("p5").is_none());
        for b in [0, 1, 2, 3, 4, 6, 7] {
            assert!(nl.node(&format!("p{b}")).is_some(), "p{b} missing");
        }
    }
}
