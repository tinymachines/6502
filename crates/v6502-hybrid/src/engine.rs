//! The solver, with gate outputs read off counters instead of walked.

use std::sync::Arc;

use halfphi::netlist::{BitSet, Netlist, NodeId, TransId};
use halfphi::{Drive, MAX_SETTLE_ROUNDS};
use v6502_netlist::schematic::Schematic;

/// A pulldown transistor's place in its gate: straight to ground, the top of
/// a series leg (its far end is a junction), or the bottom of one (its far
/// end is ground, its near end the junction). Bottoms are ordinary adjacency
/// at the junction and need no slot of their own.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
enum Slot {
    /// Not part of any gate's pulldown network.
    None,
    /// Conducting means the output is at ground.
    Single(u16),
    /// Conducting means the junction joins the output's group.
    Top(u16),
}

/// `Slot` packed into four bytes, because it is read on every toggle and the
/// unpacked enum doubled the engine's L1 misses: bits 0..1 the kind, the rest
/// the gate index.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
struct PackedSlot(u32);

impl PackedSlot {
    const NONE: PackedSlot = PackedSlot(0);
    fn pack(s: Slot) -> Self {
        match s {
            Slot::None => PackedSlot::NONE,
            Slot::Single(o) => PackedSlot(1 | (o as u32) << 2),
            Slot::Top(o) => PackedSlot(2 | (o as u32) << 2),
        }
    }
    #[inline]
    fn get(self) -> Slot {
        match self.0 & 3 {
            0 => Slot::None,
            1 => Slot::Single((self.0 >> 2) as u16),
            _ => Slot::Top((self.0 >> 2) as u16),
        }
    }
}

/// `out_of`'s "no gate" value.
const NO_GATE: u16 = u16::MAX;

/// One recognised gate output: which transistors pull it and how.
#[derive(Clone, Debug)]
struct Out {
    tops: Vec<(TransId, NodeId)>,
}

/// The netlist read through the schematic: the same nodes and transistors,
/// with each gate output's pulldown network folded into a slot table.
pub struct HybridNetlist {
    nl: Arc<Netlist>,
    /// Per transistor, its role in a gate, or none for a switch.
    slot: Vec<PackedSlot>,
    /// Per node, the gate whose output it is, as an index into `outs`, or
    /// `NO_GATE`.
    out_of: Vec<u16>,
    outs: Vec<Out>,
    /// Adjacency for the walk: every terminal of the scalar netlist EXCEPT the
    /// pulldown transistors at their gate's output. CSR like the original.
    adj_start: Vec<u32>,
    adj: Vec<(TransId, NodeId)>,
    gates: usize,
    switches: usize,
    absorbed: usize,
}

impl HybridNetlist {
    pub fn new(nl: Arc<Netlist>) -> Self {
        let sch = Schematic::derive(&nl);
        let (vss, vcc) = (nl.vss(), nl.vcc());
        let mut slot = vec![PackedSlot::NONE; nl.transistor_count()];
        let mut out_of = vec![NO_GATE; nl.node_count()];
        let mut outs = Vec::with_capacity(sch.gates.len());
        let mut absorbed = 0usize;

        for g in &sch.gates {
            let idx = outs.len() as u16;
            out_of[g.out as usize] = idx;
            let mut tops = Vec::new();
            // Re-read the network from the die for the transistor ids the
            // schematic does not carry per term, and check it against the
            // schematic's own absorbed list so the two readings cannot drift.
            let mut used: Vec<TransId> = Vec::new();
            for t in nl.terminals_of(g.out) {
                if !g.transistors.contains(&t.transistor) {
                    continue;
                }
                if t.other == vss {
                    slot[t.transistor as usize] = PackedSlot::pack(Slot::Single(idx));
                } else {
                    debug_assert!(t.other != vcc);
                    slot[t.transistor as usize] = PackedSlot::pack(Slot::Top(idx));
                    tops.push((t.transistor, t.other));
                }
                used.push(t.transistor);
            }
            // The bottoms: every absorbed transistor not at the output.
            for &t in &g.transistors {
                if !used.contains(&t) {
                    used.push(t);
                }
            }
            used.sort_unstable();
            let mut want = g.transistors.clone();
            want.sort_unstable();
            assert_eq!(used, want, "gate at node {}: the pulldown network read here is not the schematic's", g.out);
            absorbed += g.transistors.len();
            outs.push(Out { tops });
        }
        assert_eq!(absorbed, sch.absorbed(), "absorbed transistor count");

        // Adjacency: the scalar netlist's terminals, minus pulldown entries at
        // their own output. A junction keeps its entries (up to the output
        // through the top, down to ground through the bottom), so a walk
        // seeded at a junction goes exactly where the scalar's would.
        let mut adj_start = Vec::with_capacity(nl.node_count() + 1);
        let mut adj = Vec::new();
        for n in 0..nl.node_count() as NodeId {
            adj_start.push(adj.len() as u32);
            for t in nl.terminals_of(n) {
                let skip = match slot[t.transistor as usize].get() {
                    Slot::None => false,
                    Slot::Single(o) | Slot::Top(o) => out_of[n as usize] == o,
                };
                if !skip {
                    adj.push((t.transistor, t.other));
                }
            }
        }
        adj_start.push(adj.len() as u32);

        HybridNetlist {
            slot,
            out_of,
            outs,
            adj_start,
            adj,
            gates: sch.gates.len(),
            switches: sch.switches.len(),
            absorbed,
            nl,
        }
    }

    pub fn netlist(&self) -> &Netlist {
        &self.nl
    }
    pub fn gate_count(&self) -> usize {
        self.gates
    }
    pub fn switch_count(&self) -> usize {
        self.switches
    }
    pub fn absorbed(&self) -> usize {
        self.absorbed
    }
    #[inline]
    fn adjacency(&self, n: NodeId) -> &[(TransId, NodeId)] {
        &self.adj[self.adj_start[n as usize] as usize..self.adj_start[n as usize + 1] as usize]
    }
}

/// Counters, the same shape as `halfphi::Stats` where the meaning is the
/// same, plus what this rung exists to reduce.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub settles: u64,
    pub rounds: u64,
    pub node_recalcs: u64,
    pub group_members: u64,
    /// Adjacency entries probed by the walk: the scalar's cost, counted.
    pub probes: u64,
    pub nonconvergent_settles: u64,
    pub contested_groups: u64,
}

pub struct HybridEngine {
    hn: Arc<HybridNetlist>,
    value: BitSet,
    pullup: BitSet,
    pulldown: BitSet,
    trans_on: BitSet,
    /// Per gate output: conducting straight-to-ground pulldowns, and
    /// conducting series tops.
    singles_on: Vec<u16>,
    tops_on: Vec<u16>,

    current: Vec<NodeId>,
    next: Vec<NodeId>,
    queued: BitSet,
    group: Vec<NodeId>,
    group_len: usize,
    in_group: BitSet,
    stats: Stats,
}

impl HybridEngine {
    pub fn new(hn: Arc<HybridNetlist>) -> Self {
        let nl = &hn.nl;
        let nodes = nl.node_count();
        HybridEngine {
            value: BitSet::new(nodes),
            pullup: nl.pullups().clone(),
            pulldown: BitSet::new(nodes),
            trans_on: BitSet::new(nl.transistor_count()),
            singles_on: vec![0; hn.outs.len()],
            tops_on: vec![0; hn.outs.len()],
            current: Vec::with_capacity(nodes),
            next: Vec::with_capacity(nodes),
            queued: BitSet::new(nodes),
            group: vec![0; nodes + 1],
            group_len: 0,
            in_group: BitSet::new(nodes),
            stats: Stats::default(),
            hn,
        }
    }

    pub fn netlist(&self) -> &Netlist {
        &self.hn.nl
    }
    pub fn hybrid_netlist(&self) -> &HybridNetlist {
        &self.hn
    }
    pub fn stats(&self) -> &Stats {
        &self.stats
    }
    pub fn reset_stats(&mut self) {
        self.stats = Stats::default();
    }
    pub fn value(&self) -> &BitSet {
        &self.value
    }
    pub fn trans_on(&self) -> &BitSet {
        &self.trans_on
    }

    #[inline]
    pub fn is_high(&self, n: NodeId) -> bool {
        self.value.get(n as usize)
    }

    #[inline]
    pub fn read_bus(&self, nodes: &[NodeId]) -> u32 {
        let mut v = 0u32;
        for (i, &n) in nodes.iter().enumerate() {
            if self.is_high(n) {
                v |= 1 << i;
            }
        }
        v
    }

    pub fn drive_high(&mut self, n: NodeId) {
        self.pullup.set(n as usize);
        self.pulldown.clear(n as usize);
        self.settle(&[n]);
    }

    pub fn drive_low(&mut self, n: NodeId) {
        self.pullup.clear(n as usize);
        self.pulldown.set(n as usize);
        self.settle(&[n]);
    }

    pub fn set_pull(&mut self, n: NodeId, high: bool) {
        self.pullup.put(n as usize, high);
        self.pulldown.put(n as usize, !high);
    }

    pub fn restore_layout_pulls(&mut self) {
        self.pullup.copy_from(self.hn.nl.pullups());
        self.pulldown.clear_all();
    }

    pub fn force_power_on_state(&mut self) {
        self.value.clear_all();
        self.value.set(self.hn.nl.vcc() as usize);
        self.trans_on.clear_all();
        self.singles_on.iter_mut().for_each(|c| *c = 0);
        self.tops_on.iter_mut().for_each(|c| *c = 0);
    }

    pub fn settle_all(&mut self) {
        let nl = &self.hn.nl;
        let seeds: Vec<NodeId> =
            (0..nl.node_count() as NodeId).filter(|&n| nl.exists(n) && !nl.is_rail(n)).collect();
        self.settle(&seeds);
    }

    pub fn settle(&mut self, seeds: &[NodeId]) {
        let hn = Arc::clone(&self.hn);
        self.stats.settles += 1;
        self.current.clear();
        self.current.extend_from_slice(seeds);
        for _ in 0..MAX_SETTLE_ROUNDS {
            if self.current.is_empty() {
                return;
            }
            self.stats.rounds += 1;
            self.next.clear();
            let mut i = 0;
            while i < self.current.len() {
                let n = self.current[i];
                i += 1;
                self.recalc_node(&hn, n);
            }
            self.queued.clear_only(&self.next);
            std::mem::swap(&mut self.current, &mut self.next);
        }
        self.stats.nonconvergent_settles += 1;
        self.current.clear();
    }

    fn recalc_node(&mut self, hn: &HybridNetlist, n: NodeId) {
        let nl = &hn.nl;
        if nl.is_rail(n) {
            return;
        }
        self.stats.node_recalcs += 1;
        let level = self.build_group(hn, n).level();
        for gi in 0..self.group_len {
            let m = self.group[gi];
            if nl.is_rail(m) {
                continue;
            }
            if self.value.get(m as usize) == level {
                continue;
            }
            self.value.put(m as usize, level);
            // The same transistors in the same order as the scalar engine,
            // so the queue fills in the same order.
            for &t in nl.gates_of(m) {
                if level {
                    self.transistor_on(hn, t);
                } else {
                    self.transistor_off(hn, t);
                }
            }
        }
        self.in_group.clear_only(&self.group[..self.group_len]);
    }

    fn build_group(&mut self, hn: &HybridNetlist, n: NodeId) -> Drive {
        let HybridEngine { value, pullup, pulldown, trans_on, singles_on, tops_on, group, in_group, stats, group_len, .. } =
            self;
        let nl = &hn.nl;
        group[0] = n;
        let mut len: usize = 1;
        in_group.set(n as usize);
        let (vss, vcc) = (nl.vss(), nl.vcc());
        let mut drive = Drive::Floating;
        let (mut saw_up, mut saw_down) = (false, false);

        let mut i = 0;
        while i < len {
            let m = group[i];
            i += 1;
            if m == vss {
                drive = drive.max(Drive::Vss);
                continue;
            }
            if m == vcc {
                drive = drive.max(Drive::Vcc);
                continue;
            }
            if pullup.get(m as usize) {
                drive = drive.max(Drive::PullUp);
                saw_up = true;
            }
            if pulldown.get(m as usize) {
                drive = drive.max(Drive::PullDown);
                saw_down = true;
            }
            if value.get(m as usize) {
                drive = drive.max(Drive::ChargedHigh);
            }

            // A gate output: the pulldown network as counters. A conducting
            // single is ground in the group, which is what the scalar walk
            // records when it steps through that transistor to vss. A
            // conducting top puts its junction in the group, and the
            // junction's own adjacency (bottom to ground) is walked as normal.
            let o = hn.out_of[m as usize];
            if o != NO_GATE {
                let o = o as usize;
                if singles_on[o] > 0 {
                    drive = Drive::Vss;
                }
                if tops_on[o] > 0 {
                    for &(t, j) in &hn.outs[o].tops {
                        let on = trans_on.get(t as usize);
                        let fresh = in_group.insert_if(j as usize, on);
                        group[len] = j;
                        len += fresh as usize;
                    }
                }
            }

            let a = hn.adjacency(m);
            stats.probes += a.len() as u64;
            for &(t, other) in a {
                let on = trans_on.get(t as usize);
                let fresh = in_group.insert_if(other as usize, on);
                group[len] = other;
                len += fresh as usize;
            }
        }
        *group_len = len;
        stats.group_members += len as u64;
        if saw_up && saw_down {
            stats.contested_groups += 1;
        }
        drive
    }

    #[inline]
    fn transistor_on(&mut self, hn: &HybridNetlist, t: TransId) {
        if self.trans_on.test_and_set(t as usize) {
            return;
        }
        match hn.slot[t as usize].get() {
            Slot::Single(o) => self.singles_on[o as usize] += 1,
            Slot::Top(o) => self.tops_on[o as usize] += 1,
            Slot::None => {}
        }
        self.queue(hn, hn.nl.transistor_c1(t));
    }

    #[inline]
    fn transistor_off(&mut self, hn: &HybridNetlist, t: TransId) {
        if !self.trans_on.get(t as usize) {
            return;
        }
        self.trans_on.clear(t as usize);
        match hn.slot[t as usize].get() {
            Slot::Single(o) => self.singles_on[o as usize] -= 1,
            Slot::Top(o) => self.tops_on[o as usize] -= 1,
            Slot::None => {}
        }
        self.queue(hn, hn.nl.transistor_c1(t));
        self.queue(hn, hn.nl.transistor_c2(t));
    }

    #[inline]
    fn queue(&mut self, hn: &HybridNetlist, n: NodeId) {
        if hn.nl.is_rail(n) {
            return;
        }
        if !self.queued.test_and_set(n as usize) {
            self.next.push(n);
        }
    }

    /// The reference's encoding, identical to `halfphi::Engine::state_string`.
    pub fn state_string(&self) -> String {
        let nl = &self.hn.nl;
        (0..nl.node_count() as NodeId)
            .map(|n| {
                if !nl.exists(n) {
                    'x'
                } else if n == nl.vss() {
                    'g'
                } else if n == nl.vcc() {
                    'v'
                } else if self.is_high(n) {
                    'h'
                } else {
                    'l'
                }
            })
            .collect()
    }
}
