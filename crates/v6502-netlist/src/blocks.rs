//! Which functional part of the chip each node belongs to.
//!
//! The die is one dense rectangle. This splits it into the parts a person would
//! name -- the ALU, the decode PLA, the program counter -- so a view can pull
//! them apart and show them separately.
//!
//! # Where the answer comes from
//!
//! Almost entirely from the **names on the die**, and that is the whole reason
//! this is tractable. The trace names 846 nodes, and the names are not labels
//! for a handful of interesting signals: they describe entire structures. The
//! adder's carry chain is named bit by bit (`#C01` .. `~C78`), its intermediate
//! products are named as logic (`A+B3`, `#(AxB)4`, `#A.B7`), the program
//! counter's precharge nodes are named (`#pclp0`, `~pchp7`), and every product
//! term of the decode PLA is named after the instructions it serves.
//!
//! So the seeds are a name table, and the table is written from a dump of every
//! name the die carries rather than from what a 6502 is supposed to contain --
//! same discipline as the Lab's prose. Anything the names do not reach is then
//! grown outward through the netlist, and whatever is still unreached stays
//! **unclassified and is reported as such**. An exploded view that silently
//! folded the leftovers into the nearest labelled block would be inventing the
//! most interesting part of the picture.
//!
//! # What this is not
//!
//! It is not a floorplan from MOS. Nobody has the original, and this is an
//! inference from a photograph. It is reproducible, it is checked for spatial
//! coherence in `tests/blocks.rs`, and it states its own coverage -- but a block
//! boundary here is where the *names and the wiring* say one part stops, not
//! where a draughtsman drew a line in 1975.

use std::collections::HashMap;

use crate::blueprint::{centroid, split_bit};
use crate::{NodeId, Netlist, TransId};

/// Nodes no rule reached. Deliberately id 0 so an unwritten byte reads as
/// "unknown" rather than as a confident answer.
///
/// It currently holds four nodes and two transistors, and they are understood:
/// see `the_residue_is_two_inert_structures` in `tests/blocks.rs`. The block
/// keeps its catch-all name and its catch-all meaning even so, because it is
/// where anything a broken rule stops matching will land -- naming it after
/// today's contents would make it lie the first time something else fell in.
pub const UNCLASSIFIED: u8 = 0;

/// Rounds of connectivity growth. Each round can only reach one transistor
/// further, and the seeds are dense enough that this converges well before the
/// cap; it is a bound on runtime, not a tuning parameter.
const GROW_ROUNDS: usize = 12;

/// Rounds of "which block does this gate feed". Converges in five; the cap is a
/// bound on runtime rather than a tuning parameter.
const ATTRIBUTION_ROUNDS: usize = 8;

/// Which half of the chip a block belongs to. The die really is two machines
/// stacked -- transistors cluster below y≈5000 and above y≈7000 with a near
/// empty band between -- so this is measured, not editorial.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Half {
    /// Registers, buses, the adder: the part that moves and changes bytes.
    Datapath,
    /// Instruction decoding, timing, interrupts: the part that decides what the
    /// datapath does this cycle.
    Control,
    /// The pads and the wiring out to them.
    Io,
    /// Static gates, which sit everywhere rather than anywhere. Like
    /// [`Half::Unknown`], these do not translate when the view explodes -- they
    /// are distributed through both halves of the chip, so moving them as one
    /// body would scatter them across a place they do not occupy.
    Logic,
    /// Only [`UNCLASSIFIED`].
    Unknown,
}

/// One named part of the chip.
#[derive(Clone, Debug)]
pub struct Block {
    pub id: u8,
    pub name: String,
    /// One line saying what the part does, shown on the page.
    pub blurb: String,
    pub half: Half,
    pub nodes: Vec<NodeId>,
    pub transistors: Vec<TransId>,
    /// Nodes a name rule placed directly, before any growth. The rest arrived by
    /// connectivity, and the split is worth publishing: a block that is mostly
    /// grown is a weaker claim than one that is mostly named.
    pub seeded: usize,
    /// Mean die position of its nodes, and the box containing them.
    pub die: (f64, f64),
    pub bounds: (u16, u16, u16, u16),
}

impl Block {
    /// Fraction of this block's nodes that a name rule placed directly.
    pub fn seeded_fraction(&self) -> f64 {
        if self.nodes.is_empty() {
            return 0.0;
        }
        self.seeded as f64 / self.nodes.len() as f64
    }
}

#[derive(Clone, Debug)]
pub struct Blocks {
    pub blocks: Vec<Block>,
    of_node: Box<[u8]>,
    of_trans: Box<[u8]>,
    seeded: Box<[bool]>,
    drives: Box<[u8]>,
}

impl Blocks {
    #[inline]
    pub fn of_node(&self, n: NodeId) -> u8 {
        self.of_node.get(n as usize).copied().unwrap_or(UNCLASSIFIED)
    }

    /// Whether a name rule placed this node directly, rather than it being
    /// grown in from its neighbours.
    ///
    /// Worth publishing rather than keeping internal: the two are different
    /// strengths of claim. A named node is the die telling you what it is; a
    /// grown one is this code inferring it from what it is wired to, and the
    /// page should be able to say which it is showing.
    #[inline]
    pub fn was_seeded(&self, n: NodeId) -> bool {
        self.seeded.get(n as usize).copied().unwrap_or(false)
    }
    pub fn seeded_table(&self) -> &[bool] {
        &self.seeded
    }

    /// For a static-logic node, the functional block its output feeds, or
    /// [`UNCLASSIFIED`] if its fan-out has no clear majority.
    ///
    /// This says what a gate is *for*, not where it is. The two genuinely differ
    /// here -- a control signal is generated beside the decoder and consumed in
    /// the datapath -- so nothing should be positioned by this.
    #[inline]
    pub fn drives(&self, n: NodeId) -> u8 {
        self.drives.get(n as usize).copied().unwrap_or(UNCLASSIFIED)
    }
    #[inline]
    pub fn of_transistor(&self, t: TransId) -> u8 {
        self.of_trans.get(t as usize).copied().unwrap_or(UNCLASSIFIED)
    }
    pub fn node_table(&self) -> &[u8] {
        &self.of_node
    }
    pub fn transistor_table(&self) -> &[u8] {
        &self.of_trans
    }
    pub fn block(&self, name: &str) -> Option<&Block> {
        self.blocks.iter().find(|b| b.name == name)
    }
    /// Nodes that exist on the die but reached no block.
    pub fn unclassified_nodes(&self) -> usize {
        self.blocks[UNCLASSIFIED as usize].nodes.len()
    }
    pub fn unclassified_transistors(&self) -> usize {
        self.blocks[UNCLASSIFIED as usize].transistors.len()
    }
}

// ---------------------------------------------------------------------------
// The block table
// ---------------------------------------------------------------------------

/// `(name, half, blurb)`, in id order. Index into this *is* the block id, so
/// inserting in the middle renumbers everything -- append instead.
const DEFS: &[(&str, Half, &str)] = &[
    (
        "Unaccounted",
        Half::Unknown,
        "Two isolated structures that cannot affect the chip at all.",
    ),
    ("Pads & I/O", Half::Io, "The pins, and the drivers between them and the chip."),
    (
        "Instruction register",
        Half::Control,
        "Holds the opcode being executed, and predecodes it.",
    ),
    ("Decode PLA", Half::Control, "Turns the opcode into product terms."),
    ("Control pipeline", Half::Control, "Latches the terms and drives the control lines."),
    ("Timing chain", Half::Control, "Counts cycles within an instruction."),
    ("Interrupts & vectors", Half::Control, "Reset, NMI, IRQ, and the vector fetches."),
    ("Program counter", Half::Datapath, "Holds and increments the address of the next byte."),
    ("ALU", Half::Datapath, "Adds, shifts, and computes the logic operations."),
    ("Registers", Half::Datapath, "The accumulator, X, Y and the stack pointer."),
    ("Status register", Half::Datapath, "The flags, and the logic that sets them."),
    ("Address latches", Half::Datapath, "Assembles the address before it reaches the pads."),
    ("Data bus", Half::Datapath, "Moves bytes between the pads, the registers and the ALU."),
    (
        "Static logic",
        Half::Logic,
        "Inverters and NOR gates, wired only to the power rails.",
    ),
];

const PADS: u8 = 1;
const IR: u8 = 2;
const DECODE: u8 = 3;
const PIPELINE: u8 = 4;
const TIMING: u8 = 5;
const INTERRUPT: u8 = 6;
const PC: u8 = 7;
const ALU: u8 = 8;
const REGS: u8 = 9;
const STATUS: u8 = 10;
const ADDR: u8 = 11;
const DATA: u8 = 12;
const STATIC: u8 = 13;

/// Names that decompose into `stem` + bit index. Matched on the stem, exactly:
/// prefix matching would put `abl0` in the same place as `a0`, which is the
/// address latch mistaken for the accumulator.
const STEM_RULES: &[(&str, u8)] = &[
    // Pins. `db` is the data *pins*; the internal bus is `idb`.
    ("ab", PADS),
    ("db", PADS),
    // Instruction register and predecode.
    ("ir", IR),
    ("notir", IR),
    ("irline", IR),
    ("pd", IR),
    // Control.
    ("pipeUNK", PIPELINE),
    ("pipedpc", PIPELINE),
    ("pipeVectorA", INTERRUPT),
    ("clock", TIMING),
    ("t", TIMING),
    ("cp", TIMING),
    ("clk", TIMING),
    ("notRdy", TIMING),
    ("Reset", INTERRUPT),
    ("VEC", INTERRUPT),
    // Datapath.
    ("pcl", PC),
    ("pch", PC),
    ("pclp", PC),
    ("pchp", PC),
    ("alu", ALU),
    ("alua", ALU),
    ("alub", ALU),
    ("notalu", ALU),
    ("AxB", ALU),
    ("C", ALU),
    ("DC", ALU),
    ("a", REGS),
    ("x", REGS),
    ("y", REGS),
    ("s", REGS),
    ("notx", REGS),
    ("noty", REGS),
    ("nots", REGS),
    ("p", STATUS),
    ("Pout", STATUS),
    ("abl", ADDR),
    ("abh", ADDR),
    ("adl", ADDR),
    ("adh", ADDR),
    ("idb", DATA),
    ("idl", DATA),
    ("notidl", DATA),
    ("dor", DATA),
    ("notdor", DATA),
    ("sb", DATA),
    ("dasb", DATA),
];

/// Whole names, matched exactly after decoration is stripped.
const EXACT_RULES: &[(&str, u8)] = &[
    ("res", PADS),
    ("rw", PADS),
    ("sync", PADS),
    ("so", PADS),
    ("rdy", PADS),
    ("nmi", PADS),
    ("irq", PADS),
    ("clk1out", PADS),
    ("clk2out", PADS),
    ("DBE", PADS),
    ("RnWstretched", PADS),
    ("notRnWprepad", PADS),
    ("WR", PADS),
    ("clearIR", IR),
    ("ONEBYTE", IR),
    ("cclk", PIPELINE),
    ("ADL/ABL", PIPELINE),
    ("ADH/ABH", PIPELINE),
    ("fetch", TIMING),
    ("TWOCYCLE", TIMING),
    ("TWOCYCLE.phi1", TIMING),
    ("C1x5Reset", TIMING),
    ("D1x1", TIMING),
    ("H1x1", TIMING),
    ("INTG", INTERRUPT),
    ("NMIP", INTERRUPT),
    ("NMIG", INTERRUPT),
    ("NMIL", INTERRUPT),
    ("IRQP", INTERRUPT),
    ("RESP", INTERRUPT),
    ("RESG", INTERRUPT),
    ("brk-done", INTERRUPT),
    ("BRtaken", INTERRUPT),
    ("branch-back", INTERRUPT),
    ("branch-forward", INTERRUPT),
    ("branch-back.phi1", INTERRUPT),
    ("branch-forward.phi1", INTERRUPT),
    ("nnT2BR", INTERRUPT),
    ("alucin", ALU),
    ("notalucin", ALU),
    ("alucout", ALU),
    ("notalucout", ALU),
    ("alurawcout", ALU),
    ("aluvout", ALU),
    ("notaluvout", ALU),
    ("DBZ", STATUS),
    ("DBNeg", STATUS),
];

/// Prefixes, tried after the two exact tables. Order matters here: the first
/// match wins, so anything that is a prefix of another must come first.
const PREFIX_RULES: &[(&str, u8)] = &[
    ("PD-", IR),
    ("op-", DECODE),
    ("dpc", PIPELINE),
    ("pipe", PIPELINE),
    ("short-circuit-branch", INTERRUPT),
    ("short-circuit-idx", ALU),
    // The adder's intermediate logic, all named as the functions they compute.
    // Matched on the opening bracket rather than the closed form: the carry
    // network names its per-bit terms `(AxB1).C01`, with the bit index *inside*
    // the parentheses, so a rule reading `(AxB)` misses the four nodes that
    // actually carry between bit pairs.
    ("A+B", ALU),
    ("(A+B", ALU),
    ("(AxB", ALU),
    ("A.B", ALU),
    ("DA-", ALU),
    ("aluresult", ALU),
    ("0/ADL", ADDR),
    ("ABL", ADDR),
    ("ABH", ADDR),
];

/// Strip the decoration the trace uses for complements and staged copies:
/// `#`, `~` for the two phases of a precharged pair, `x-`/`xx-` for a second
/// node carrying the same signal. `#pclp0` and `pclp0` are the same structure.
fn undecorate(name: &str) -> &str {
    let mut s = name;
    loop {
        let next = s
            .strip_prefix("##")
            .or_else(|| s.strip_prefix("~~"))
            .or_else(|| s.strip_prefix('#'))
            .or_else(|| s.strip_prefix('~'))
            .or_else(|| s.strip_prefix("xx-"))
            .or_else(|| s.strip_prefix("x-"))
            .or_else(|| s.strip_prefix("nn"));
        match next {
            Some(t) if !t.is_empty() => s = t,
            _ => return s,
        }
    }
}

/// Where a switch sits: decided by its channel, never by its gate.
///
/// The gate is the control line reaching in from the decoder; `c1`/`c2` are the
/// wires it actually joins. Filing by gate would put every datapath pass
/// transistor under `Control pipeline` and empty the datapath of the switches
/// that are the point of it.
fn of_trans_block(nl: &Netlist, of_node: &[u8], t: TransId) -> u8 {
    let (c1, c2) = (nl.transistor_c1(t), nl.transistor_c2(t));
    let (b1, b2) = (of_node[c1 as usize], of_node[c2 as usize]);
    match (b1, b2) {
        (UNCLASSIFIED, b) | (b, UNCLASSIFIED) => b,
        (a, b) if a == b => a,
        (a, b) => {
            // Spanning two blocks: prefer the gate's block if it is one of them,
            // else the lower id, so the choice is stable across runs.
            let g = of_node[nl.transistor_gate(t) as usize];
            if g == a || g == b {
                g
            } else {
                a.min(b)
            }
        }
    }
}

/// Which block a name belongs to, or `None` if no rule reaches it.
pub fn classify_name(name: &str) -> Option<u8> {
    // Try the raw name first, then the undecorated one. `#DBE` and `DBE` both
    // land on the pads; `#C01` only matches once the `#` is gone.
    for candidate in [name, undecorate(name)] {
        // A dotted suffix qualifies a node rather than naming it: `.phi1` and
        // `.phi2` say *when* a copy is valid, `.delay` says it is the delayed
        // one, and `.clearIR` says which predecode line clears the instruction
        // register. In every case the structure is named by what comes before
        // the dot, so the general rule is to try the stem as well.
        //
        // Enumerating the known suffixes instead missed `pd0.clearIR`..`pd7`,
        // which left eight predecode nodes unplaced -- they are `pd`, and the
        // die says so.
        let base = candidate.split_once('.').map_or(candidate, |(a, _)| a);

        for probe in [candidate, base] {
            if let Some(&(_, id)) = EXACT_RULES.iter().find(|(n, _)| *n == probe) {
                return Some(id);
            }
            if let Some((stem, _)) = split_bit(probe) {
                if let Some(&(_, id)) = STEM_RULES.iter().find(|(n, _)| *n == stem) {
                    return Some(id);
                }
            }
        }
        if let Some(&(_, id)) = PREFIX_RULES.iter().find(|(p, _)| candidate.starts_with(p)) {
            return Some(id);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

impl Blocks {
    pub fn derive(nl: &Netlist) -> Blocks {
        let n_nodes = nl.node_count();
        let mut of_node = vec![UNCLASSIFIED; n_nodes];

        // --- seed from the names -------------------------------------------
        for node in 0..n_nodes as NodeId {
            if !nl.exists(node) || nl.is_rail(node) {
                continue;
            }
            if let Some(name) = nl.name_of(node) {
                if let Some(id) = classify_name(name) {
                    of_node[node as usize] = id;
                }
            }
        }
        let seeded_flags: Vec<bool> = of_node.iter().map(|&b| b != UNCLASSIFIED).collect();

        // --- grow along the wiring ------------------------------------------
        //
        // An unnamed node sitting between two ALU nodes is part of the adder.
        // Growth follows *terminals* -- an actual electrical path through a
        // switch -- and never gates: a node gated by a decode line is being
        // told what to do by the decoder, which is the opposite of belonging
        // to it, and following gates merges the whole chip into `Decode PLA`.
        //
        // vss and vcc are already absent from the terminal CSR, so the rails
        // cannot act as a bridge here. That is load-bearing: they touch
        // hundreds of transistors and would join every block into one.
        for _ in 0..GROW_ROUNDS {
            let mut changed = false;
            let snapshot = of_node.clone();
            for node in 0..n_nodes as NodeId {
                if snapshot[node as usize] != UNCLASSIFIED
                    || !nl.exists(node)
                    || nl.is_rail(node)
                {
                    continue;
                }
                // Majority vote over classified neighbours, ties broken by the
                // lower block id so the result does not depend on CSR order.
                let mut tally = [0u16; 256];
                for t in nl.terminals_of(node) {
                    let b = snapshot[t.other as usize];
                    if b != UNCLASSIFIED {
                        tally[b as usize] += 1;
                    }
                }
                let best = tally
                    .iter()
                    .enumerate()
                    .skip(1)
                    .max_by_key(|(id, &c)| (c, std::cmp::Reverse(*id)))
                    .filter(|(_, &c)| c > 0)
                    .map(|(id, _)| id as u8);
                if let Some(id) = best {
                    of_node[node as usize] = id;
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }

        // --- the static logic ------------------------------------------------
        //
        // What is left after growth is overwhelmingly one thing, and it is not a
        // ragged edge: 526 islands, the largest holding four nodes, 405 of them
        // single nodes. Those are individual logic gates.
        //
        // They survive growth for a structural reason rather than by accident.
        // A static NMOS gate's output touches nothing but its pullup to vcc and
        // its pulldown to vss, and growth refuses to cross a rail -- so no path
        // exists from a named wire to a gate output, however close together they
        // sit. The bus fabric is connected and reachable; the logic is 526
        // islands surrounded by power.
        //
        // So this is not "the part that failed to classify". It is the 24% of
        // the chip that is not pass transistors, identified by the electrical
        // signature that defines it: a pullup, or a terminal on vss.
        for node in 0..n_nodes as NodeId {
            if of_node[node as usize] != UNCLASSIFIED || !nl.exists(node) || nl.is_rail(node) {
                continue;
            }
            let has_pullup = nl.pullups().get(node as usize);
            let pulls_down = nl.terminals_of(node).iter().any(|t| t.other == nl.vss());
            if has_pullup || pulls_down {
                of_node[node as usize] = STATIC;
            }
        }

        // --- growth, once more, now that the gates are seeds --------------------
        //
        // Growth ran before the static logic existed as a block, so a node whose
        // only neighbour was a gate output saw nothing classified and stopped.
        // Once the gates are identified those nodes have a seed beside them, and
        // 89 of them turn out to be sitting on one -- the far side of a pass
        // transistor tapping a gate output.
        //
        // Deliberately narrower than the first pass: a node joins only if *every*
        // classified neighbour it has is static logic. A majority vote here would
        // let the logic compete with the functional blocks for genuinely
        // ambiguous nodes, and the logic would win on sheer count -- which would
        // quietly hollow out the blocks this whole derivation exists to find.
        for _ in 0..GROW_ROUNDS {
            let mut changed = false;
            let snapshot = of_node.clone();
            for node in 0..n_nodes as NodeId {
                if snapshot[node as usize] != UNCLASSIFIED || !nl.exists(node) || nl.is_rail(node)
                {
                    continue;
                }
                let mut saw_logic = false;
                let mut saw_other = false;
                for t in nl.terminals_of(node) {
                    match snapshot[t.other as usize] {
                        UNCLASSIFIED => {}
                        STATIC => saw_logic = true,
                        _ => saw_other = true,
                    }
                }
                if saw_logic && !saw_other {
                    of_node[node as usize] = STATIC;
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }

        // --- what each gate drives --------------------------------------------
        //
        // A gate output is not *in* a functional block, but it feeds one, and
        // that is worth recording: it is the difference between "some logic" and
        // "the logic that drives the program counter".
        //
        // Deliberately kept apart from `of_node`, and deliberately **not** used
        // to place anything. A quarter of these attributions land more than 3000
        // die units from the block they feed -- which is correct, since control
        // signals are generated in the control section and consumed in the
        // datapath, but it means affiliation is not location. Moving a gate to
        // the block it drives would invent a floorplan.
        let mut drives = vec![UNCLASSIFIED; n_nodes];
        for _ in 0..ATTRIBUTION_ROUNDS {
            let mut changed = false;
            for node in 0..n_nodes as NodeId {
                if of_node[node as usize] != STATIC || drives[node as usize] != UNCLASSIFIED {
                    continue;
                }
                let mut tally = [0u16; 256];
                for &t in nl.gates_of(node) {
                    // Where the driven transistor sits, or -- once known -- what
                    // the gate on the far side of it goes on to drive.
                    let mut b = of_trans_block(nl, &of_node, t);
                    if b == STATIC || b == UNCLASSIFIED {
                        for c in [nl.transistor_c1(t), nl.transistor_c2(t)] {
                            if drives[c as usize] != UNCLASSIFIED {
                                b = drives[c as usize];
                                break;
                            }
                        }
                    }
                    if b != UNCLASSIFIED && b != STATIC {
                        tally[b as usize] += 1;
                    }
                }
                let total: u16 = tally.iter().sum();
                if total == 0 {
                    continue;
                }
                let (best, count) = tally
                    .iter()
                    .enumerate()
                    .skip(1)
                    .max_by_key(|(id, &c)| (c, std::cmp::Reverse(*id)))
                    .map(|(id, &c)| (id as u8, c))
                    .unwrap();
                // A clear majority only. A gate feeding three blocks equally is
                // shared logic, and naming one of them would be a guess.
                if count * 4 >= total * 3 {
                    drives[node as usize] = best;
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }

        // --- transistors ----------------------------------------------------
        //
        // A switch belongs where its *channel* is, not where its gate is. The
        // gate is the control line reaching in from the decoder; c1/c2 are the
        // wires it actually joins. Taking the gate would file all 159 datapath
        // pass transistors under `Control pipeline` and empty the datapath of
        // the switches that are the point of it.
        let mut of_trans = vec![UNCLASSIFIED; nl.transistor_count()];
        for t in 0..nl.transistor_count() as TransId {
            of_trans[t as usize] = of_trans_block(nl, &of_node, t);
        }

        // --- assemble --------------------------------------------------------
        let mut blocks: Vec<Block> = DEFS
            .iter()
            .enumerate()
            .map(|(i, (name, half, blurb))| Block {
                id: i as u8,
                name: (*name).into(),
                blurb: (*blurb).into(),
                half: *half,
                nodes: Vec::new(),
                transistors: Vec::new(),
                seeded: 0,
                die: (0.0, 0.0),
                bounds: (u16::MAX, 0, u16::MAX, 0),
            })
            .collect();

        for node in 0..n_nodes as NodeId {
            if !nl.exists(node) || nl.is_rail(node) {
                continue;
            }
            let b = &mut blocks[of_node[node as usize] as usize];
            b.nodes.push(node);
            if seeded_flags[node as usize] {
                b.seeded += 1;
            }
        }
        for t in 0..nl.transistor_count() as TransId {
            blocks[of_trans[t as usize] as usize].transistors.push(t);
        }

        for b in &mut blocks {
            let pts: Vec<(u16, u16)> = b.nodes.iter().filter_map(|n| centroid(*n)).collect();
            if pts.is_empty() {
                b.bounds = (0, 0, 0, 0);
                continue;
            }
            b.die = (
                pts.iter().map(|p| p.0 as f64).sum::<f64>() / pts.len() as f64,
                pts.iter().map(|p| p.1 as f64).sum::<f64>() / pts.len() as f64,
            );
            b.bounds = pts.iter().fold((u16::MAX, 0, u16::MAX, 0), |acc, p| {
                (acc.0.min(p.0), acc.1.max(p.0), acc.2.min(p.1), acc.3.max(p.1))
            });
        }

        Blocks {
            blocks,
            of_node: of_node.into_boxed_slice(),
            of_trans: of_trans.into_boxed_slice(),
            seeded: seeded_flags.into_boxed_slice(),
            drives: drives.into_boxed_slice(),
        }
    }

    /// Nodes whose name a rule reached, per block. Used by the tests to check
    /// that growth has not swamped the seeds.
    pub fn seed_counts(&self) -> HashMap<&str, usize> {
        self.blocks.iter().map(|b| (b.name.as_str(), b.seeded)).collect()
    }

    /// Serialise for the web front end.
    ///
    /// The two big arrays are indexed by node and by transistor, so the page can
    /// upload `nodeBlock` straight into an R8 texture and let the vertex shader
    /// look up a per-block offset by node id -- the same trick the die view uses
    /// for live node levels.
    pub fn to_json(&self, nl: &Netlist) -> String {
        use std::fmt::Write as _;
        let mut s = String::with_capacity(1 << 16);

        let total_t: usize = self.blocks.iter().map(|b| b.transistors.len()).sum();
        let total_n: usize = self.blocks.iter().map(|b| b.nodes.len()).sum();
        s.push_str("{\n  \"blocks\": [\n");
        for (i, b) in self.blocks.iter().enumerate() {
            let half = match b.half {
                Half::Datapath => "datapath",
                Half::Control => "control",
                Half::Io => "io",
                Half::Logic => "logic",
                Half::Unknown => "unknown",
            };
            let _ = writeln!(
                s,
                "    {{\"id\":{},\"name\":{:?},\"blurb\":{:?},\"half\":\"{}\",\
                 \"nodes\":{},\"seeded\":{},\"transistors\":{},\
                 \"die\":[{:.1},{:.1}],\"bounds\":[{},{},{},{}]}}{}",
                b.id,
                b.name,
                b.blurb,
                half,
                b.nodes.len(),
                b.seeded,
                b.transistors.len(),
                b.die.0,
                b.die.1,
                b.bounds.0,
                b.bounds.1,
                b.bounds.2,
                b.bounds.3,
                if i + 1 < self.blocks.len() { "," } else { "" }
            );
        }
        s.push_str("  ],\n");

        let _ = writeln!(
            s,
            "  \"coverage\": {{\"nodes\":{},\"nodesPlaced\":{},\"transistors\":{},\
             \"transistorsPlaced\":{},\"nodesNamed\":{}}},",
            total_n,
            total_n - self.unclassified_nodes(),
            total_t,
            total_t - self.unclassified_transistors(),
            self.blocks.iter().skip(1).map(|b| b.seeded).sum::<usize>()
        );

        // Node -> block, with bit 7 flagging "a name rule placed this, it was
        // not inferred". Block ids reach 12, so the high bit is free, and one
        // array is one texture upload rather than two.
        s.push_str("  \"nodeBlock\": [");
        for n in 0..nl.node_count() {
            if n > 0 {
                s.push(',');
            }
            let id = self.of_node(n as NodeId);
            let flag = if self.was_seeded(n as NodeId) { 0x80 } else { 0 };
            let _ = write!(s, "{}", id | flag);
        }
        // For each static-logic node, the block its output feeds. Kept as its
        // own array rather than folded into `nodeBlock`, because it answers a
        // different question -- what a gate is for, not where it is -- and the
        // page must not be able to position anything by it.
        s.push_str("],\n  \"nodeDrives\": [");
        for n in 0..nl.node_count() {
            if n > 0 {
                s.push(',');
            }
            let _ = write!(s, "{}", self.drives(n as NodeId));
        }
        s.push_str("],\n  \"transistorBlock\": [");
        for t in 0..nl.transistor_count() {
            if t > 0 {
                s.push(',');
            }
            let _ = write!(s, "{}", self.of_transistor(t as TransId));
        }
        // The gate node of each transistor, so a view drawing one filament per
        // switch can light the ones that are conducting. It is netlist data
        // rather than block data, but it is indexed by transistor exactly like
        // the array above, and a second fetch to pair the two would be a second
        // chance for them to disagree about ordering.
        s.push_str("],\n  \"transistorGate\": [");
        for t in 0..nl.transistor_count() {
            if t > 0 {
                s.push(',');
            }
            let _ = write!(s, "{}", nl.transistor_gate(t as TransId));
        }
        s.push_str("]\n}\n");
        s
    }
}
