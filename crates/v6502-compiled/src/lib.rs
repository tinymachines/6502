//! Rung 2 of the engine ladder: the recognised network as straight-line code,
//! 64 machines per word.
//!
//! `build.rs` reads the die through `Schematic::derive` and emits the kernel
//! into `OUT_DIR`: every folded gate's ground drive as a sum of products
//! over its inputs, the switch network as an unrolled relaxation pass, and
//! the junction rule. Nothing from the engine crates runs here; the netlist
//! is gone at run time and what is left is the code it compiled to.
//!
//! The semantics are `halfphi::slice`'s, deliberately, so the two share an
//! oracle: the same thermometer planes (`max` is `|`), the same round
//! (switches follow gates; each node's own drive; spread to closure; resolve),
//! Jacobi within a round. Levelising the gates would take fewer rounds and
//! change trajectories; it is not done here, and the note says why.
//!
//! What the fold changes against the kernel: the 2637 absorbed transistors
//! leave the spread loop, which is the loop that runs to closure several
//! times a round. A gate's contribution is computed once per round as one
//! expression; only the switches are relaxed.
//!
//! **Not bit-exact with rung 0, by nature** (see the kernel's account in
//! `docs/notes/engine.md`): held to the pin golden and to program-level
//! checks, with the node agreement against rung 0 measured and reported by
//! `examples/agree.rs`, never asserted.
//!
//! Every node is exposed through the plane arrays and `value`, and lane 0
//! is a `PinEngine`.

#![forbid(unsafe_code)]
// The hot loops index several parallel per-node arrays by one index, which
// is the kernel's shape (one word per node per plane) and what a compute
// shader will do with the same index; the iterator form clippy prefers
// would zip five arrays to say the same thing.
#![allow(clippy::needless_range_loop)]

use v6502_pins::{Load, PinEngine, PinFrame};

/// Machines per word.
pub const LANES: usize = 64;

/// The kernel's loop limiter, the same as the reference's.
pub const MAX_ROUNDS: usize = 100;

/// One relaxation pass across a two-way switch: each end takes the other's
/// drive in the lanes where the switch conducts.
macro_rules! both {
    ($on:expr, $a:expr, $b:expr, $p:ident, $moved:ident) => {{
        let on = $on;
        if on != 0 {
            let mut k = 0;
            while k < 5 {
                let pa = $p[k][$a];
                let pb = $p[k][$b];
                let nb = pb | (pa & on);
                let na = pa | (pb & on);
                $moved |= (nb ^ pb) | (na ^ pa);
                $p[k][$b] = nb;
                $p[k][$a] = na;
                k += 1;
            }
        }
    }};
}

/// A switch with a rail on one end: the rail drives, nothing flows back.
macro_rules! oneway {
    ($on:expr, $from:expr, $to:expr, $p:ident, $moved:ident) => {{
        let on = $on;
        if on != 0 {
            let mut k = 0;
            while k < 5 {
                let pa = $p[k][$from];
                let pb = $p[k][$to];
                let nb = pb | (pa & on);
                $moved |= nb ^ pb;
                $p[k][$to] = nb;
                k += 1;
            }
        }
    }};
}

#[allow(unused_parens, clippy::all)]
pub mod kernel {
    include!(concat!(env!("OUT_DIR"), "/kernel.rs"));
}

/// The same kernel as a WebGPU compute shader, emitted by the same
/// `build.rs` from the same folds and switch list: one invocation owns one
/// `u32` word of 32 machines and runs a whole half-step, bus service
/// included, against per-lane memory in a storage buffer. `v6502-gpu` runs
/// it; the page can load the same text.
pub const KERNEL_WGSL: &str = include_str!(concat!(env!("OUT_DIR"), "/kernel.wgsl"));

use kernel::{sig, GATE_OF, NODES, TRANS, VCC, VSS};

/// 64 machines' worth of electrical state. Bit `k` of every word is lane `k`.
#[derive(Clone)]
pub struct State {
    pub value: Vec<u64>,
    pub pullup: Vec<u64>,
    pub pulldown: Vec<u64>,
    pub trans_on: Vec<u64>,
    planes: [Vec<u64>; 5],
    next: Vec<u64>,
    /// Layout pullups, for `restore_layout_pulls`.
    layout_pullup: Vec<u64>,
    /// Power-on damping, see `settle_power_on`: lanes in which each node
    /// flipped last round, and lanes in which it is frozen for this settle.
    flipped: Vec<u64>,
    frozen: Vec<u64>,
    damping: bool,
}

/// Counters.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub settles: u64,
    pub rounds: u64,
    pub spreads: u64,
    pub nonconvergent_settles: u64,
    /// Node-lanes frozen by the power-on tie-break.
    pub frozen: u64,
}

impl State {
    /// Every node low but vcc, layout pullups in every lane, nothing
    /// conducting. `layout_pullup` says which nodes have a depletion pullup,
    /// one bit per node in a lane-agnostic bitmap.
    pub fn new(layout_pullup: &[bool]) -> Self {
        assert_eq!(layout_pullup.len(), NODES);
        let lp: Vec<u64> = layout_pullup.iter().map(|&b| if b { !0 } else { 0 }).collect();
        let mut s = State {
            value: vec![0; NODES],
            pullup: lp.clone(),
            pulldown: vec![0; NODES],
            trans_on: vec![0; TRANS],
            planes: std::array::from_fn(|_| vec![0; NODES]),
            next: vec![0; NODES],
            layout_pullup: lp,
            flipped: vec![0; NODES],
            frozen: vec![0; NODES],
            damping: false,
        };
        s.value[VCC] = !0;
        s
    }

    #[inline]
    pub fn is_high(&self, lane: usize, n: usize) -> bool {
        self.value[n] >> lane & 1 != 0
    }

    pub fn read_bus(&self, lane: usize, bus: &[usize]) -> u32 {
        let mut v = 0u32;
        for (i, &n) in bus.iter().enumerate() {
            v |= (self.is_high(lane, n) as u32) << i;
        }
        v
    }

    pub fn set_pull_all(&mut self, n: usize, high: bool) {
        self.pullup[n] = if high { !0 } else { 0 };
        self.pulldown[n] = if high { 0 } else { !0 };
    }

    pub fn set_pull_mask(&mut self, n: usize, high: u64) {
        self.pullup[n] = high;
        self.pulldown[n] = !high;
    }

    pub fn set_pull_where(&mut self, n: usize, lanes: u64, high: u64) {
        self.pullup[n] = (self.pullup[n] & !lanes) | (high & lanes);
        self.pulldown[n] = (self.pulldown[n] & !lanes) | (!high & lanes);
    }

    pub fn restore_layout_pulls(&mut self) {
        self.pullup.copy_from_slice(&self.layout_pullup);
        self.pulldown.iter_mut().for_each(|w| *w = 0);
    }

    pub fn force_power_on_state(&mut self) {
        self.value.iter_mut().for_each(|w| *w = 0);
        self.value[VCC] = !0;
        self.trans_on.iter_mut().for_each(|w| *w = 0);
    }

    /// One round: (switches that moved, nodes that changed), lane-wise.
    #[inline(never)]
    pub fn round(&mut self, stats: &mut Stats) -> (u64, u64) {
        stats.rounds += 1;
        // 0. Switches follow their gates before anything propagates.
        let mut sw = 0u64;
        for t in 0..TRANS {
            let g = self.value[GATE_OF[t] as usize];
            sw |= g ^ self.trans_on[t];
            self.trans_on[t] = g;
        }
        // 1. Each node's own drive, thermometer-encoded, then the folded gates.
        {
            let p = &mut self.planes;
            for i in 0..NODES {
                let (pu, pd, v) = (self.pullup[i], self.pulldown[i], self.value[i]);
                p[4][i] = 0;
                p[3][i] = 0;
                p[2][i] = pu;
                p[1][i] = pu | pd;
                p[0][i] = pu | pd | v;
            }
            for k in 0..5 {
                p[k][VSS] = !0;
            }
            for k in 0..4 {
                p[k][VCC] = !0;
            }
            kernel::gate_planes(&self.value, p);
        }
        // 2. Spread across the switches to closure.
        let mut spread = 0;
        loop {
            spread += 1;
            stats.spreads += 1;
            let moved = kernel::spread_once(&self.trans_on, &mut self.planes);
            if moved == 0 || spread >= MAX_ROUNDS {
                break;
            }
        }
        // 3. Resolve, then the junctions, then commit.
        {
            let p = &self.planes;
            for i in 0..NODES {
                let high = (p[0][i] & !p[1][i]) | (p[2][i] & !p[3][i]) | (p[3][i] & !p[4][i]);
                self.next[i] = high;
            }
            self.next[VSS] = 0;
            self.next[VCC] = !0;
            for &m in kernel::MISSING.iter() {
                self.next[m] = 0;
            }
            kernel::junctions(&self.value, &mut self.next);
        }
        if self.damping {
            // A cross-coupled pair with nothing driving it flips together
            // every round under a simultaneous update, forever. A node that
            // flipped last round and would flip again is frozen at its
            // current level for the rest of this settle: the pair lands on
            // one of its two states, which is what the queue solver does by
            // visiting one of them first.
            for i in 0..NODES {
                let flipping = self.next[i] ^ self.value[i];
                let freeze = flipping & self.flipped[i] & !self.frozen[i];
                stats.frozen += freeze.count_ones() as u64;
                self.frozen[i] |= freeze;
                self.next[i] = (self.next[i] & !self.frozen[i]) | (self.value[i] & self.frozen[i]);
                self.flipped[i] = flipping & !self.frozen[i];
            }
        }
        let mut changed = 0u64;
        for i in 0..NODES {
            changed |= self.next[i] ^ self.value[i];
        }
        self.value.copy_from_slice(&self.next);
        (sw, changed)
    }

    /// The settle from the power-on condition, where every latch on the die
    /// is undefined and a simultaneous update oscillates. Damped by the
    /// tie-break in `round`; used nowhere else, and the run's settles are
    /// counted as never needing it.
    pub fn settle_power_on(&mut self, stats: &mut Stats) -> usize {
        self.flipped.iter_mut().for_each(|w| *w = 0);
        self.frozen.iter_mut().for_each(|w| *w = 0);
        self.damping = true;
        let r = self.settle(stats);
        self.damping = false;
        r
    }

    pub fn settle(&mut self, stats: &mut Stats) -> usize {
        stats.settles += 1;
        for round in 1..=MAX_ROUNDS {
            let (sw, changed) = self.round(stats);
            if sw == 0 && changed == 0 {
                return round;
            }
        }
        stats.nonconvergent_settles += 1;
        MAX_ROUNDS
    }

    /// One lane's four bitsets, packed LSB-first (bit `i` in byte `i / 8`
    /// at position `i % 8`), the codec's own byte order, so hex-encoding
    /// these bytes IS rung 0's wire encoding. Order: value, pullup,
    /// pulldown, trans_on.
    pub fn extract_lane(&self, lane: usize) -> (Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>) {
        let pack = |words: &[u64], bits: usize| -> Vec<u8> {
            let mut out = vec![0u8; bits.div_ceil(8)];
            for (i, w) in words.iter().enumerate().take(bits) {
                if w >> lane & 1 != 0 {
                    out[i / 8] |= 1 << (i % 8);
                }
            }
            out
        };
        (
            pack(&self.value, NODES),
            pack(&self.pullup, NODES),
            pack(&self.pulldown, NODES),
            pack(&self.trans_on, TRANS),
        )
    }

    /// The four bitsets of one machine, broadcast into EVERY lane: the
    /// machine-value crossing, in this rung's shape. Broadcast rather than
    /// per-lane because the clock is one instruction for all lanes
    /// (`half_step` branches on the whole clk0 word), so a single imported
    /// machine has to be all of them. Same byte order as `extract_lane`.
    /// The planes are scratch, rebuilt every round, and need nothing.
    ///
    /// Refused rather than guessed at on a wrong length: a blob that decodes
    /// to the wrong chip is worse than one that is refused.
    pub fn inject_all(
        &mut self,
        value: &[u8],
        pullup: &[u8],
        pulldown: &[u8],
        trans_on: &[u8],
    ) -> Result<(), String> {
        let want_n = NODES.div_ceil(8);
        let want_t = TRANS.div_ceil(8);
        for (name, blob, want) in [
            ("value", value, want_n),
            ("pullup", pullup, want_n),
            ("pulldown", pulldown, want_n),
            ("trans_on", trans_on, want_t),
        ] {
            if blob.len() != want {
                return Err(format!("{name}: expected {want} bytes, got {}", blob.len()));
            }
        }
        let unpack = |words: &mut Vec<u64>, blob: &[u8], bits: usize| {
            for (i, w) in words.iter_mut().enumerate().take(bits) {
                *w = if blob[i / 8] >> (i % 8) & 1 != 0 { !0 } else { 0 };
            }
        };
        unpack(&mut self.value, value, NODES);
        unpack(&mut self.pullup, pullup, NODES);
        unpack(&mut self.pulldown, pulldown, NODES);
        unpack(&mut self.trans_on, trans_on, TRANS);
        Ok(())
    }

    /// The reference's encoding for one lane: `x` missing, `g`/`v` rails,
    /// `h`/`l`.
    pub fn state_string(&self, lane: usize) -> String {
        (0..NODES)
            .map(|n| {
                if kernel::MISSING.contains(&n) {
                    'x'
                } else if n == VSS {
                    'g'
                } else if n == VCC {
                    'v'
                } else if self.is_high(lane, n) {
                    'h'
                } else {
                    'l'
                }
            })
            .collect()
    }
}

/// 64 machines, each with its own 64 KiB, clocked together.
pub struct Machines {
    pub state: State,
    pub mem: Vec<Vec<u8>>,
    pub stats: Stats,
    half_cycle: u64,
}

impl Machines {
    /// All 64 lanes with the same memory image; use `load_lane` to make one
    /// differ. `layout_pullup` comes from the netlist (the runtime does not
    /// carry it): `v6502_netlist::mos6502().pullups()`.
    pub fn new(layout_pullup: &[bool]) -> Self {
        Machines { state: State::new(layout_pullup), mem: (0..LANES).map(|_| vec![0u8; 0x10000]).collect(), stats: Stats::default(), half_cycle: 0 }
    }

    pub fn load_all(&mut self, loads: &[Load], reset_vector: u16) {
        for lane in 0..LANES {
            self.load_lane(lane, loads, reset_vector);
        }
    }

    pub fn load_lane(&mut self, lane: usize, loads: &[Load], reset_vector: u16) {
        let m = &mut self.mem[lane];
        m.iter_mut().for_each(|b| *b = 0);
        for l in loads {
            let o = l.org as usize;
            m[o..o + l.bytes.len()].copy_from_slice(&l.bytes);
        }
        m[0xfffc] = reset_vector as u8;
        m[0xfffd] = (reset_vector >> 8) as u8;
    }

    pub fn half_cycle(&self) -> u64 {
        self.half_cycle
    }
    /// For resuming an imported machine at its own count.
    pub fn set_half_cycle(&mut self, hc: u64) {
        self.half_cycle = hc;
    }

    fn drive_all(&mut self, n: usize, high: bool) {
        self.state.set_pull_all(n, high);
        self.state.settle(&mut self.stats);
    }

    /// `v6502_sim::Cpu::reset`, in every lane at once.
    pub fn reset(&mut self) {
        self.state.force_power_on_state();
        self.state.set_pull_all(sig::RES, false);
        self.state.set_pull_all(sig::CLK0, false);
        self.state.set_pull_all(sig::RDY, true);
        self.state.set_pull_all(sig::SO, false);
        self.state.set_pull_all(sig::IRQ, true);
        self.state.set_pull_all(sig::NMI, true);
        self.state.settle_power_on(&mut self.stats);
        for _ in 0..8 {
            self.drive_all(sig::CLK0, true);
            self.drive_all(sig::CLK0, false);
        }
        self.drive_all(sig::RES, true);
        for _ in 0..18 {
            self.half_step();
        }
        self.half_cycle = 0;
    }

    pub fn power_cycle(&mut self) {
        self.state.restore_layout_pulls();
        self.reset();
    }

    /// One half-cycle for all lanes: the clock edge, then the bus, serviced
    /// per lane where that lane's chip is reading or writing.
    pub fn half_step(&mut self) {
        let clk_high = self.state.value[sig::CLK0] != 0;
        if clk_high {
            self.drive_all(sig::CLK0, false);
            let mut read_mask = 0u64;
            let mut bits = [0u64; 8];
            for lane in 0..LANES {
                if !self.state.is_high(lane, sig::RW) {
                    continue;
                }
                read_mask |= 1 << lane;
                let addr = self.state.read_bus(lane, &sig::AB) as usize;
                let data = self.mem[lane][addr];
                for (i, b) in bits.iter_mut().enumerate() {
                    *b |= u64::from(data >> i & 1) << lane;
                }
            }
            if read_mask != 0 {
                for i in 0..8 {
                    self.state.set_pull_where(sig::DB[i], read_mask, bits[i]);
                }
                self.state.settle(&mut self.stats);
            }
        } else {
            self.drive_all(sig::CLK0, true);
            for lane in 0..LANES {
                if self.state.is_high(lane, sig::RW) {
                    continue;
                }
                let addr = self.state.read_bus(lane, &sig::AB) as usize;
                let data = self.state.read_bus(lane, &sig::DB) as u8;
                self.mem[lane][addr] = data;
            }
        }
        self.half_cycle += 1;
    }

    pub fn pins(&self, lane: usize) -> PinFrame {
        let s = &self.state;
        PinFrame {
            h: self.half_cycle,
            clk0: s.is_high(lane, sig::CLK0),
            ab: s.read_bus(lane, &sig::AB) as u16,
            db: s.read_bus(lane, &sig::DB) as u8,
            rw: s.is_high(lane, sig::RW),
            sync: s.is_high(lane, sig::SYNC),
            res: s.is_high(lane, sig::RES),
            irq: s.is_high(lane, sig::IRQ),
            nmi: s.is_high(lane, sig::NMI),
            rdy: s.is_high(lane, sig::RDY),
            so: s.is_high(lane, sig::SO),
        }
    }

    pub fn reg(&self, lane: usize, bus: &[usize]) -> u8 {
        self.state.read_bus(lane, bus) as u8
    }
}

/// Lane 0 of a `Machines` as the pin contract; the other 63 lanes run the
/// same inputs. The clock is one instruction for all of them anyway.
impl PinEngine for Machines {
    fn power_cycle(&mut self) {
        Machines::power_cycle(self);
    }
    fn set_inputs(&mut self, res: bool, irq: bool, nmi: bool, rdy: bool, so: bool) {
        self.drive_all(sig::RES, res);
        self.drive_all(sig::IRQ, irq);
        self.drive_all(sig::NMI, nmi);
        self.drive_all(sig::RDY, rdy);
        self.drive_all(sig::SO, so);
    }
    fn half_step(&mut self) {
        Machines::half_step(self);
    }
    fn pins(&self) -> PinFrame {
        Machines::pins(self, 0)
    }
    fn h(&self) -> u64 {
        self.half_cycle
    }
}
