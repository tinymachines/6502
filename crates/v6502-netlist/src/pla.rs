//! The decode PLA's AND plane, located structurally.
//!
//! This module finds *where* the product terms are. It deliberately does not
//! decide *when* they fire — see `export-decode`, which runs the chip and reads
//! the answer out of the silicon.
//!
//! # Why the split
//!
//! A product term's opcode set looked like pure combinational logic worth
//! computing here, and two measurements said otherwise:
//!
//! 1. **`irline3` is a derived line, not an IR bit.** `op-T0-jsr` constrains
//!    bits 7..2 directly and leaves bits 1 and 0 to `irline3`, so a model that
//!    only understands `ir`/`notir` gates reports four opcodes where the chip
//!    decodes one. Modelling it means modelling the gate behind it, and then
//!    the gate behind that.
//! 2. **A row legitimately fires for undocumented opcodes.** `op-T0-lda` is
//!    high for sixteen opcodes: the eight documented `LDA` forms and the eight
//!    `LAX`/`LAS` ones. That is not the derivation over-matching, it is the
//!    reason those instructions exist — the LDA row and the LDX row both fire,
//!    and the chip does both. Checking a row against the documented ISA and
//!    "fixing" the difference would have deleted the most interesting thing the
//!    PLA has to show.
//!
//! So: structure from the netlist, behaviour from the engine. The same division
//! as the blueprint, for the same reason.
//!
//! # The shape being looked for
//!
//! An NMOS PLA row is precharged and pulled toward vss through one transistor
//! per input it must *not* see asserted. A node whose pulldowns are gated by at
//! least [`MIN_IR_INPUTS`] IR lines is a product term of the instruction
//! register; nothing else in this chip looks like that.

use crate::blueprint::centroid;
use crate::{NodeId, Netlist, TransId};

/// A node needs this many IR lines on its pulldown gates before it is believed
/// to be a product term. One would catch ordinary logic that happens to test a
/// single opcode bit; the real rows test between two and eight things.
pub const MIN_IR_INPUTS: usize = 2;

/// One input of a product term: the IR bit it tests, and the value that bit
/// must hold for the row to survive precharge.
///
/// A pulldown gated by `ir3` discharges the row when `ir3` is high, so the row
/// only stays high when that bit is **0**; a pulldown gated by `notir3` inverts
/// the sense.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct IrTerm {
    pub bit: u8,
    /// The value bit `bit` must have.
    pub required: bool,
}

/// One product term of the AND plane.
#[derive(Clone, Debug)]
pub struct Row {
    pub node: NodeId,
    /// The die's own name for the term, e.g. `op-T0-lda`. 121 of 122 have one,
    /// and they carry both the T-state and the instructions they serve.
    pub name: Option<String>,
    pub ir: Vec<IrTerm>,
    /// Named inputs that are not IR bits: the timing states (`clock1`, `t2`…)
    /// and `irline3`.
    pub other: Vec<(NodeId, String)>,
    /// Inputs with no name. Their presence is why the opcode set is measured
    /// rather than computed.
    pub unnamed: usize,
    pub die: (u16, u16),
    pub transistors: Vec<TransId>,
}

impl Row {
    /// Whether this term's opcode set is fully determined by IR bits alone.
    /// False means something else gates it and only the engine knows the truth.
    pub fn ir_only(&self) -> bool {
        self.unnamed == 0 && self.other.iter().all(|(_, n)| is_timing(n))
    }

    /// Opcodes this term admits *on its IR inputs alone*.
    ///
    /// Not the set the chip decodes unless [`Row::ir_only`] holds: `irline3` and
    /// any unnamed input constrain it further. Used to cross-check the measured
    /// answer, never to replace it.
    pub fn ir_candidates(&self) -> Vec<u8> {
        (0..=255u8)
            .filter(|op| self.ir.iter().all(|t| ((op >> t.bit) & 1 == 1) == t.required))
            .collect()
    }
}

fn is_timing(name: &str) -> bool {
    matches!(name, "clock1" | "clock2") || (name.starts_with('t') && name[1..].parse::<u8>().is_ok())
}

/// A control line the PLA ultimately drives.
#[derive(Clone, Debug)]
pub struct Output {
    pub node: NodeId,
    pub name: String,
    pub die: (u16, u16),
}

#[derive(Clone, Debug)]
pub struct Pla {
    pub rows: Vec<Row>,
    pub outputs: Vec<Output>,
}

impl Pla {
    pub fn derive(nl: &Netlist) -> Pla {
        let vss = nl.vss();

        // node -> (transistor, gate) for every transistor tying it to vss.
        // Terminal normalisation has already moved rails to c2.
        let mut pulldown: Vec<Vec<(TransId, NodeId)>> = vec![Vec::new(); nl.node_count()];
        for t in 0..nl.transistor_count() as TransId {
            let gate = nl.transistor_gate(t);
            if nl.is_rail(gate) {
                continue; // gated by a rail: permanently off, gates nothing
            }
            let (c1, c2) = (nl.transistor_c1(t), nl.transistor_c2(t));
            if c2 == vss && c1 != vss {
                pulldown[c1 as usize].push((t, gate));
            }
        }

        // IR lines, both polarities.
        let mut ir_of: Vec<Option<IrTerm>> = vec![None; nl.node_count()];
        for bit in 0..8u8 {
            if let Some(n) = nl.node(&format!("ir{bit}")) {
                // Pulled down when ir<bit> is high, so the row needs it low.
                ir_of[n as usize] = Some(IrTerm { bit, required: false });
            }
            if let Some(n) = nl.node(&format!("notir{bit}")) {
                ir_of[n as usize] = Some(IrTerm { bit, required: true });
            }
        }

        let mut rows = Vec::new();
        for (node, gates) in pulldown.iter().enumerate() {
            let ir: Vec<IrTerm> = gates.iter().filter_map(|(_, g)| ir_of[*g as usize]).collect();
            if ir.len() < MIN_IR_INPUTS {
                continue;
            }
            let mut other = Vec::new();
            let mut unnamed = 0;
            for (_, g) in gates {
                if ir_of[*g as usize].is_some() {
                    continue;
                }
                match nl.name_of(*g) {
                    Some(n) => other.push((*g, n.to_string())),
                    None => unnamed += 1,
                }
            }
            other.sort_by(|a, b| a.1.cmp(&b.1));
            other.dedup_by(|a, b| a.1 == b.1);
            rows.push(Row {
                node: node as NodeId,
                name: nl.name_of(node as NodeId).map(str::to_owned),
                ir,
                other,
                unnamed,
                die: centroid(node as NodeId).unwrap_or((0, 0)),
                transistors: gates.iter().map(|(t, _)| *t).collect(),
            });
        }
        // Name order groups the T-states together, which is also the order the
        // page wants; node order would be arbitrary.
        rows.sort_by(|a, b| a.name.cmp(&b.name).then(a.node.cmp(&b.node)));

        let mut outputs: Vec<Output> = nl
            .names()
            .filter(|(n, _)| n.starts_with("dpc"))
            .map(|(n, node)| Output {
                node,
                name: n.to_string(),
                die: centroid(node).unwrap_or((0, 0)),
            })
            .collect();
        outputs.sort_by(|a, b| dpc_index(&a.name).cmp(&dpc_index(&b.name)).then(a.name.cmp(&b.name)));
        outputs.dedup_by(|a, b| a.node == b.node);
        Pla { rows, outputs }
    }

    pub fn row(&self, name: &str) -> Option<&Row> {
        self.rows.iter().find(|r| r.name.as_deref() == Some(name))
    }
}

/// `dpc-1_ADL/ABL` and `dpc-2_ADH/ABH` exist, so the index is signed. Sorting
/// these as text puts `dpc10` before `dpc2`, which is not how anyone reads them.
fn dpc_index(name: &str) -> i32 {
    let rest = &name[3..];
    let end = rest
        .char_indices()
        .find(|(i, c)| !(c.is_ascii_digit() || (*i == 0 && *c == '-')))
        .map_or(rest.len(), |(i, _)| i);
    rest[..end].parse().unwrap_or(i32::MAX)
}

// ---------------------------------------------------------------------------
// The OR plane: which product terms can reach which control line
// ---------------------------------------------------------------------------

/// How deep the backward walk from a control line goes.
///
/// Measured: the path is row -> OR plane -> a `cclk` pipeline latch -> two or
/// three inverters -> the line, so the terms sit five to eight hops back. Ten
/// covers every line that resolves at all; raising it further only adds paths
/// that wander.
const TRACE_DEPTH: usize = 10;

impl Pla {
    /// Product terms that can structurally reach each control line.
    ///
    /// **Candidates, not conclusions.** A backward walk can leave the control
    /// path entirely -- out along a data bus and back in somewhere unrelated --
    /// and the number of edges it finds is not evidence that they are right.
    /// `export-decode` checks every one of these against 768 measured runs and
    /// keeps only the sets that actually predict the line.
    ///
    /// Two kinds of hop are followed:
    /// - the gate of a transistor pulling the node toward vss (a logic input);
    /// - the far side of a pass transistor (the pipeline latches are pass
    ///   transistors gated by `cclk`, so the path does not exist without this).
    ///
    /// Datapath wires are refused as intermediate nodes. A control path does not
    /// run along the special bus; allowing it produces edges that verification
    /// then has to throw away.
    pub fn candidate_terms(&self, nl: &Netlist, blocked: &[NodeId]) -> Vec<Vec<usize>> {
        let vss = nl.vss();
        let mut pulldown: Vec<Vec<NodeId>> = vec![Vec::new(); nl.node_count()];
        let mut passes: Vec<Vec<NodeId>> = vec![Vec::new(); nl.node_count()];
        for t in 0..nl.transistor_count() as TransId {
            let gate = nl.transistor_gate(t);
            if nl.is_rail(gate) {
                continue;
            }
            let (c1, c2) = (nl.transistor_c1(t), nl.transistor_c2(t));
            if c2 == vss && c1 != vss {
                pulldown[c1 as usize].push(gate);
            } else if !nl.is_rail(c1) && !nl.is_rail(c2) {
                passes[c1 as usize].push(c2);
                passes[c2 as usize].push(c1);
            }
        }

        let mut is_blocked = vec![false; nl.node_count()];
        for n in blocked {
            is_blocked[*n as usize] = true;
        }
        let mut term_at = vec![usize::MAX; nl.node_count()];
        for (i, r) in self.rows.iter().enumerate() {
            term_at[r.node as usize] = i;
        }

        self.outputs
            .iter()
            .map(|o| {
                let mut seen = vec![false; nl.node_count()];
                let mut queue = std::collections::VecDeque::new();
                let mut hits = Vec::new();
                seen[o.node as usize] = true;
                queue.push_back((o.node, 0usize));
                while let Some((n, d)) = queue.pop_front() {
                    if d >= TRACE_DEPTH {
                        continue;
                    }
                    let next = pulldown[n as usize]
                        .iter()
                        .chain(passes[n as usize].iter())
                        .copied();
                    for m in next {
                        if seen[m as usize] || is_blocked[m as usize] {
                            continue;
                        }
                        seen[m as usize] = true;
                        // Stop at a term rather than walking through it: what
                        // feeds a product term is the IR, not another line.
                        if term_at[m as usize] != usize::MAX {
                            hits.push(term_at[m as usize]);
                        } else {
                            queue.push_back((m, d + 1));
                        }
                    }
                }
                hits.sort_unstable();
                hits.dedup();
                hits
            })
            .collect()
    }
}
