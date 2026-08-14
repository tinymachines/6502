//! The chip as gates rather than as transistors.
//!
//! Every other view here treats a transistor as the unit. This one recognises
//! the *shapes* transistors are wired into and replaces them with symbols, so a
//! signal can be read as a circuit rather than as a switch network.
//!
//! # Why this works at all
//!
//! NMOS builds logic exactly one way. A node has a depletion pullup holding it
//! high, and a network of pulldowns to ground that can win against it. So the
//! output is **low when the pulldown network conducts**, which makes every
//! static gate on the die an inverted sum of products:
//!
//! ```text
//!     out = NOT( (a AND b) OR (c) OR (d AND e) )
//! ```
//!
//! Transistors in parallel are the ORs, transistors in series are the ANDs.
//! An inverter is the one-term, one-literal case; a NOR is many single-literal
//! terms; a NAND is one multi-literal term. There is no separate AND gate on
//! this chip, and no OR: the inversion is not a design choice, it is what
//! happens when a pulldown fights a pullup.
//!
//! That is the whole recognition rule for *static* logic, and it resolves every
//! pullup node on the die but one. Nothing is pattern-matched against a library
//! of expected shapes.
//!
//! # The half that has no pullup
//!
//! Keying on pullups alone finds nothing behind the most interesting signals on
//! the chip. `dpc3_SBX`, `dpc23_SBAC` and `sync` have no pullup flag at all,
//! and a recogniser that wants one reports them as dead ends -- which is what
//! the first version of this did.
//!
//! They are **precharged**: a clocked transistor pulls the node to vcc, and the
//! pulldown network either discharges it or leaves it holding its charge
//! through the rest of the cycle. Same sum-of-products shape, different way of
//! being held high, and 150 nodes work this way. It is the same dynamic storage
//! the simulator models with `ChargedHigh`, and the reason the 6502 has a
//! *minimum* clock speed as well as a maximum.
//!
//! Together: 1168 gate symbols absorbing 2684 transistors, leaving 826 as
//! switches. 2684 + 826 is exactly 3510, and `every_transistor_is_accounted_for`
//! checks that rather than trusting it -- the first version summed the per-gate
//! lists and reported 3517, because four pulldowns are shared between two gates.
//!
//! # What is deliberately not attempted
//!
//! Collapsing repeated structure. The obvious hope -- that eight bits of a bus
//! are eight copies of one circuit, so the schematic can draw one and say "x8"
//! -- is **false on this chip, and measurably so**. Iterative structural
//! refinement over the whole netlist puts every bit of every bus in its own
//! class: `a0` is not `a7`, and the carry chain, the bit-7 shifter and `adh`'s
//! constant generators are why. The datapath is geometrically regular and
//! electrically irregular, and `bits_are_not_structurally_identical` in the
//! tests pins that, because it is the more interesting fact and the one a
//! reader is most likely to assume the other way round.

use std::collections::{HashMap, HashSet};

use crate::{NodeId, Netlist, TransId};

/// How deep a series chain this recognises. Two is enough for the whole die;
/// anything deeper is reported as unresolved rather than silently flattened.
const MAX_SERIES: usize = 2;

/// The shape of a recognised gate, named for what it computes.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Kind {
    /// One term, one literal.
    Inverter,
    /// Several single-literal terms in parallel.
    Nor,
    /// One term of several literals in series.
    Nand,
    /// A mix: and-or-invert. NMOS builds these as readily as the simple cases,
    /// which is why the decode PLA is so compact.
    Aoi,
    /// Not held high by a depletion pullup but *precharged* through a clocked
    /// transistor, then either pulled down or left holding its charge.
    ///
    /// The control lines are all of these, which is why they were dead ends
    /// until this case existed: `dpc3_SBX` has no pullup flag, so a recogniser
    /// keyed on pullups alone finds nothing behind the most interesting signals
    /// on the chip. It is also why the 6502 has a minimum clock speed — the
    /// charge is the state, and it leaks.
    Dynamic,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Inverter => "inverter",
            Kind::Nor => "nor",
            Kind::Nand => "nand",
            Kind::Aoi => "aoi",
            Kind::Dynamic => "dynamic",
        }
    }
}

/// One static gate: `out = NOT(OR of ANDs)`.
#[derive(Clone, Debug)]
pub struct Gate {
    pub out: NodeId,
    pub kind: Kind,
    /// Products, OR'd together and then inverted. Each inner vector is a series
    /// leg; a single-element leg is a plain parallel pulldown.
    pub terms: Vec<Vec<NodeId>>,
    /// The pulldown transistors this symbol replaces.
    pub transistors: Vec<TransId>,
    /// For [`Kind::Dynamic`], the clock that precharges the node.
    pub precharge: Option<NodeId>,
}

impl Gate {
    /// Every distinct node feeding this gate.
    pub fn inputs(&self) -> Vec<NodeId> {
        let mut v: Vec<NodeId> = self.terms.iter().flatten().copied().collect();
        v.sort_unstable();
        v.dedup();
        v
    }
}

/// A pass transistor, kept as a switch because that is what it is: the die uses
/// them to steer signals, not to compute with them.
#[derive(Copy, Clone, Debug)]
pub struct Switch {
    /// The control line on its gate.
    pub control: NodeId,
    pub a: NodeId,
    pub b: NodeId,
    pub transistor: TransId,
}

/// A node that could not be reduced, and why. Published rather than hidden.
#[derive(Clone, Debug)]
pub struct Unresolved {
    pub node: NodeId,
    pub reason: String,
}

#[derive(Clone, Debug)]
pub struct Schematic {
    pub gates: Vec<Gate>,
    pub switches: Vec<Switch>,
    pub unresolved: Vec<Unresolved>,
    /// Output node -> index into `gates`.
    by_out: HashMap<NodeId, usize>,
    /// Node -> indices of switches touching it.
    by_node: HashMap<NodeId, Vec<usize>>,
}

impl Schematic {
    pub fn derive(nl: &Netlist) -> Schematic {
        let vss = nl.vss();
        let pu = nl.pullups();

        let mut gates = Vec::new();
        let mut unresolved = Vec::new();
        let mut absorbed: HashSet<TransId> = HashSet::new();

        let vcc = nl.vcc();
        for out in 0..nl.node_count() as NodeId {
            if !nl.exists(out) || nl.is_rail(out) {
                continue;
            }
            // Two families, and the second is not optional: a node is a gate if
            // a pullup holds it high, OR if a clocked transistor precharges it.
            let precharge = nl
                .terminals_of(out)
                .iter()
                .find(|t| t.other == vcc)
                .map(|t| nl.transistor_gate(t.transistor));
            let is_static = pu.get(out as usize);
            if !is_static && precharge.is_none() {
                continue;
            }
            let mut terms: Vec<Vec<NodeId>> = Vec::new();
            let mut used: Vec<TransId> = Vec::new();
            let mut deep = false;

            for t in nl.terminals_of(out) {
                if t.other == vss {
                    // Straight to ground: a term of one literal.
                    terms.push(vec![nl.transistor_gate(t.transistor)]);
                    used.push(t.transistor);
                    continue;
                }
                if nl.is_rail(t.other) || pu.get(t.other as usize) {
                    // vcc, or another gate's output -- not part of this gate's
                    // pulldown network. A pullup on the far side means the node
                    // is driven in its own right, so this is a switch between
                    // two gates rather than a series leg inside one.
                    continue;
                }
                // An intermediate node with its own path to ground is a series
                // leg. If the far side has several such paths, the product
                // distributes: (t AND (u1 OR u2)) is (t AND u1) OR (t AND u2).
                let below: Vec<TransId> = nl
                    .terminals_of(t.other)
                    .iter()
                    .filter(|u| u.other == vss)
                    .map(|u| u.transistor)
                    .collect();
                if below.is_empty() {
                    continue;
                }
                // Anything needing a third level is out of scope, and said so.
                if nl.terminals_of(t.other).iter().any(|u| {
                    u.transistor != t.transistor
                        && !nl.is_rail(u.other)
                        && !pu.get(u.other as usize)
                        && nl.terminals_of(u.other).iter().any(|v| v.other == vss)
                }) {
                    deep = true;
                }
                for u in below {
                    terms.push(vec![nl.transistor_gate(t.transistor), nl.transistor_gate(u)]);
                    used.push(u);
                }
                used.push(t.transistor);
            }

            if terms.is_empty() {
                // A precharged node with nothing to pull it down is storage,
                // not logic -- a dynamic latch. Not a gate, and not a failure.
                if is_static {
                    unresolved.push(Unresolved {
                        node: out,
                        reason: "a pullup with no pulldown network".into(),
                    });
                }
                continue;
            }
            if deep {
                unresolved.push(Unresolved {
                    node: out,
                    reason: format!("series deeper than {MAX_SERIES}"),
                });
                // Still emitted below: a partial reading is more useful than a
                // hole, as long as the page can say it is partial.
            }

            let widest = terms.iter().map(Vec::len).max().unwrap_or(0);
            let kind = if !is_static {
                Kind::Dynamic
            } else {
                match (terms.len(), widest) {
                    (1, 1) => Kind::Inverter,
                    (_, 1) => Kind::Nor,
                    (1, _) => Kind::Nand,
                    _ => Kind::Aoi,
                }
            };
            used.sort_unstable();
            used.dedup();
            for t in &used {
                absorbed.insert(*t);
            }
            gates.push(Gate {
                out,
                kind,
                terms,
                transistors: used,
                precharge: (!is_static).then_some(precharge).flatten(),
            });
        }

        // Whatever the gates did not take is a switch. Includes the transistors
        // that pull a node to vcc under a clock -- precharge is steering, not
        // computing, so it belongs here rather than in a gate symbol.
        let mut switches = Vec::new();
        for t in 0..nl.transistor_count() as TransId {
            if absorbed.contains(&t) {
                continue;
            }
            switches.push(Switch {
                control: nl.transistor_gate(t),
                a: nl.transistor_c1(t),
                b: nl.transistor_c2(t),
                transistor: t,
            });
        }

        let by_out = gates.iter().enumerate().map(|(i, g)| (g.out, i)).collect();
        let mut by_node: HashMap<NodeId, Vec<usize>> = HashMap::new();
        for (i, s) in switches.iter().enumerate() {
            for n in [s.a, s.b] {
                if !nl.is_rail(n) {
                    by_node.entry(n).or_default().push(i);
                }
            }
        }

        Schematic { gates, switches, unresolved, by_out, by_node }
    }

    pub fn gate_of(&self, out: NodeId) -> Option<&Gate> {
        self.by_out.get(&out).map(|i| &self.gates[*i])
    }
    pub fn switches_on(&self, node: NodeId) -> impl Iterator<Item = &Switch> {
        self.by_node.get(&node).into_iter().flatten().map(|i| &self.switches[*i])
    }

    pub fn count_of(&self, k: Kind) -> usize {
        self.gates.iter().filter(|g| g.kind == k).count()
    }
    pub fn counts(&self) -> (usize, usize, usize, usize, usize) {
        (
            self.count_of(Kind::Inverter),
            self.count_of(Kind::Nor),
            self.count_of(Kind::Nand),
            self.count_of(Kind::Aoi),
            self.count_of(Kind::Dynamic),
        )
    }
    /// Distinct transistors taken into gate symbols.
    ///
    /// Counted as a set, not as the sum of the per-gate lists: seven pulldowns
    /// are shared between two gates, where both outputs pull down through the
    /// same leg. Summing the lists double-counts those and reports more
    /// transistors than the die has, which is how this was noticed.
    pub fn absorbed(&self) -> usize {
        self.gates.iter().flat_map(|g| &g.transistors).collect::<HashSet<_>>().len()
    }

    /// Pulldowns that belong to more than one gate. A real structure, and small
    /// enough to state exactly.
    pub fn shared_pulldowns(&self) -> usize {
        let mut seen: HashMap<TransId, usize> = HashMap::new();
        for g in &self.gates {
            for t in &g.transistors {
                *seen.entry(*t).or_default() += 1;
            }
        }
        seen.values().filter(|c| **c > 1).count()
    }

    /// Everything feeding `root`, back `depth` levels.
    ///
    /// Follows gates through their inputs and switches through their far side,
    /// and stops at the rails. Breadth-first so the level a node first appears
    /// at is its shortest distance from the root, which is the level the
    /// drawing should place it on.
    pub fn cone(&self, nl: &Netlist, root: NodeId, depth: usize) -> Cone {
        let mut levels: Vec<Vec<NodeId>> = vec![vec![root]];
        let mut seen: HashSet<NodeId> = [root].into_iter().collect();
        let mut edges: Vec<ConeEdge> = Vec::new();

        for level in 0..depth {
            let mut next = Vec::new();
            for &node in &levels[level] {
                if let Some(g) = self.gate_of(node) {
                    for (ti, term) in g.terms.iter().enumerate() {
                        for &input in term {
                            edges.push(ConeEdge {
                                from: input,
                                to: node,
                                via: Via::Gate { kind: g.kind, term: ti },
                            });
                            if !nl.is_rail(input) && seen.insert(input) {
                                next.push(input);
                            }
                        }
                    }
                }
                for s in self.switches_on(node) {
                    let far = if s.a == node { s.b } else { s.a };
                    edges.push(ConeEdge {
                        from: far,
                        to: node,
                        via: Via::Switch { control: s.control },
                    });
                    // The far side joins the cone; the control line does not.
                    //
                    // It rides on the edge as a label instead. Expanding it
                    // pulls the entire clock tree and decode PLA into the
                    // picture within two levels -- `cclk` alone gates 273
                    // transistors -- and the answer to "how is this signal
                    // made" drowns in the answer to "how is everything timed".
                    // Re-rooting on a control line is one click away, which is
                    // the right way to ask that question when it is the
                    // question being asked.
                    if !nl.is_rail(far) && seen.insert(far) {
                        next.push(far);
                    }
                }
            }
            if next.is_empty() {
                break;
            }
            levels.push(next);
        }
        Cone { root, levels, edges }
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Via {
    Gate { kind: Kind, term: usize },
    Switch { control: NodeId },
}

#[derive(Clone, Debug)]
pub struct ConeEdge {
    pub from: NodeId,
    pub to: NodeId,
    pub via: Via,
}

#[derive(Clone, Debug)]
pub struct Cone {
    pub root: NodeId,
    /// Nodes by distance from the root.
    pub levels: Vec<Vec<NodeId>>,
    pub edges: Vec<ConeEdge>,
}

impl Cone {
    pub fn nodes(&self) -> usize {
        self.levels.iter().map(Vec::len).sum()
    }

    /// A shape signature that ignores *which* nodes are involved and keeps only
    /// how they are wired: the multiset of (level, via-kind) over the edges.
    ///
    /// This is what makes "is bit 0 the same circuit as bit 7" answerable
    /// without asserting that the two use the same wires, which they obviously
    /// do not.
    pub fn signature(&self, nl: &Netlist) -> Vec<String> {
        let level_of: HashMap<NodeId, usize> = self
            .levels
            .iter()
            .enumerate()
            .flat_map(|(i, v)| v.iter().map(move |n| (*n, i)))
            .collect();
        let mut sig: Vec<String> = self
            .edges
            .iter()
            .map(|e| {
                let l = level_of.get(&e.to).copied().unwrap_or(usize::MAX);
                match e.via {
                    Via::Gate { kind, .. } => format!("{l}:gate:{}", kind.as_str()),
                    // The control line's *name* is part of the shape: a switch
                    // opened by ADDSB7 is not the same element as one opened by
                    // ADDSB06, and that difference is exactly the shifter.
                    Via::Switch { control } => {
                        format!("{l}:switch:{}", nl.name_of(control).unwrap_or("?"))
                    }
                }
            })
            .collect();
        sig.sort();
        sig
    }
}

/// What two cones have in common and where they part.
#[derive(Clone, Debug)]
pub struct Diff {
    pub shared: Vec<String>,
    pub only_a: Vec<String>,
    pub only_b: Vec<String>,
}

impl Diff {
    pub fn of(nl: &Netlist, a: &Cone, b: &Cone) -> Diff {
        let (sa, sb) = (a.signature(nl), b.signature(nl));
        let mut counts: HashMap<&String, i32> = HashMap::new();
        for s in &sa {
            *counts.entry(s).or_default() += 1;
        }
        for s in &sb {
            *counts.entry(s).or_default() -= 1;
        }
        let mut shared = Vec::new();
        let mut only_a = Vec::new();
        let mut only_b = Vec::new();
        for (s, n) in counts {
            match n.cmp(&0) {
                std::cmp::Ordering::Equal => shared.push(s.clone()),
                std::cmp::Ordering::Greater => only_a.push(s.clone()),
                std::cmp::Ordering::Less => only_b.push(s.clone()),
            }
        }
        shared.sort();
        only_a.sort();
        only_b.sort();
        Diff { shared, only_a, only_b }
    }

    pub fn identical(&self) -> bool {
        self.only_a.is_empty() && self.only_b.is_empty()
    }
}
