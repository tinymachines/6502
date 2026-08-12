//! The 6502's internal timing state.
//!
//! The 6502 has no visible cycle counter. What it has is a chain of timing nodes
//! that behave *almost* like an inverted one-hot shift register, plus a couple
//! of extra bits that never reach the PLA. Decoding them is what turns "some
//! transistors changed" into "this is cycle 3 of an absolute-indexed read".
//!
//! The reconstruction below follows visual6502's, including its three magic node
//! numbers, which have no entry in the name table:
//! <http://visual6502.org/wiki/index.php?title=6502_Timing_States>

use v6502_netlist::{Netlist, NodeId};

/// Node 862 is the internal T1 state -- active while the *next* instruction's
/// first cycle overlaps the current one's last.
const NODE_T1_INTERNAL: NodeId = 862;
/// Nodes 440 and 1258 sit in the Random Control Logic and ground `~WR` during
/// the two store-data cycles. They are how a write cycle identifies itself.
const NODE_STORE_DATA_1: NodeId = 440;
const NODE_STORE_DATA_2: NodeId = 1258;

/// Which half of the two-phase clock the chip is in.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Phase {
    /// Internal phase 1 -- precharge and internal bus transfers.
    Phi1,
    /// Internal phase 2 -- evaluate; the external bus is valid.
    Phi2,
}

/// The "hidden" timing bits: exclusive states that do not drive the PLA.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Hidden {
    /// Internal T1.
    T1,
    /// Vector pull, cycle 0 (interrupt/reset vector fetch).
    Vec0,
    /// Vector pull, cycle 1. Canonically T6; a synonym for the VEC1 node.
    T6,
    None,
}

/// Random Control Logic store-data state, present only during writes.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum StoreData {
    Sd1,
    Sd2,
    None,
}

/// Node handles for everything in this module, resolved once.
#[derive(Clone, Debug)]
pub struct TimingNodes {
    clock1: NodeId,
    clock2: NodeId,
    t2: NodeId,
    t3: NodeId,
    t4: NodeId,
    t5: NodeId,
    vec0: NodeId,
    vec1: NodeId,
    cp1: NodeId,
    t1_internal: NodeId,
    sd1: NodeId,
    sd2: NodeId,
}

impl TimingNodes {
    /// The internal phase-1 node, which lags the `clk0` input pin.
    pub fn cp1(&self) -> NodeId {
        self.cp1
    }

    pub fn resolve(nl: &Netlist) -> Option<Self> {
        Some(TimingNodes {
            clock1: nl.node("clock1")?,
            clock2: nl.node("clock2")?,
            t2: nl.node("t2")?,
            t3: nl.node("t3")?,
            t4: nl.node("t4")?,
            t5: nl.node("t5")?,
            vec0: nl.node("VEC0")?,
            vec1: nl.node("VEC1")?,
            cp1: nl.node("cp1")?,
            // Unnamed in the die data; assert they at least exist.
            t1_internal: nl.exists(NODE_T1_INTERNAL).then_some(NODE_T1_INTERNAL)?,
            sd1: nl.exists(NODE_STORE_DATA_1).then_some(NODE_STORE_DATA_1)?,
            sd2: nl.exists(NODE_STORE_DATA_2).then_some(NODE_STORE_DATA_2)?,
        })
    }
}

/// A decoded snapshot of the timing chain.
///
/// The `t*` fields are presented active-high. On the die they are active-low,
/// which is a frequent source of confusion when reading traces next to a
/// datasheet.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct TimingState {
    pub t0: bool,
    /// Called `T+` in the PLA node names and `T1x` in most published timing
    /// diagrams. The same state under three names.
    pub t1x: bool,
    pub t2: bool,
    pub t3: bool,
    pub t4: bool,
    pub t5: bool,
    pub hidden: Hidden,
    pub store_data: StoreData,
}

impl TimingState {
    /// Read the timing chain out of a settled chip.
    pub fn read(nodes: &TimingNodes, is_high: impl Fn(NodeId) -> bool) -> Self {
        TimingState {
            // Active low on the die.
            t0: !is_high(nodes.clock1),
            t1x: !is_high(nodes.clock2),
            t2: !is_high(nodes.t2),
            t3: !is_high(nodes.t3),
            t4: !is_high(nodes.t4),
            t5: !is_high(nodes.t5),
            // These three are active high, and mutually exclusive.
            hidden: if is_high(nodes.t1_internal) {
                Hidden::T1
            } else if is_high(nodes.vec0) {
                Hidden::Vec0
            } else if is_high(nodes.vec1) {
                Hidden::T6
            } else {
                Hidden::None
            },
            store_data: if is_high(nodes.sd1) {
                StoreData::Sd1
            } else if is_high(nodes.sd2) {
                StoreData::Sd2
            } else {
                StoreData::None
            },
        }
    }

    /// The active T-states, e.g. `"T0+T1"`. More than one can be active: the
    /// chain overlaps the tail of one instruction with the head of the next.
    pub fn active(&self) -> String {
        let mut parts = Vec::new();
        for (on, name) in [
            (self.t0, "T0"),
            (self.t1x, "T1"),
            (self.t2, "T2"),
            (self.t3, "T3"),
            (self.t4, "T4"),
            (self.t5, "T5"),
        ] {
            if on {
                parts.push(name);
            }
        }
        parts.join("+")
    }

    /// Fixed-width rendering matching the reference's `allTCStates()`, for
    /// eyeballing traces side by side: `".. T+ T2 .. .. .. [..] ..."`.
    pub fn fixed_width(&self) -> String {
        let cell = |on: bool, name: &str| if on { name.to_string() } else { "..".to_string() };
        format!(
            "{} {} {} {} {} {} [{}] {}",
            cell(self.t0, "T0"),
            cell(self.t1x, "T+"),
            cell(self.t2, "T2"),
            cell(self.t3, "T3"),
            cell(self.t4, "T4"),
            cell(self.t5, "T5"),
            match self.hidden {
                Hidden::T1 => "T1",
                Hidden::Vec0 => "V0",
                Hidden::T6 => "T6",
                Hidden::None => "..",
            },
            match self.store_data {
                StoreData::Sd1 => "SD1",
                StoreData::Sd2 => "SD2",
                StoreData::None => "...",
            }
        )
    }
}
