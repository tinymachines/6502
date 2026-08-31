//! The sequencer: the measured table played through the authored datapath.
//!
//! One instruction is one recorded span (from its own h=2 through the two
//! overlap half-cycles of the fetch after it); the reset tail covers h=0
//! and h=1 of the first fetch, so the streams tile the timeline exactly.
//! At each boundary the finished opcode's flags are applied (authored,
//! `flags.rs`) and the next span is selected with the same selector the
//! recorder used, this machine's own memory standing where the recorder's
//! image stood. A key the table does not hold is refused by name.
//!
//! What is authored beyond the flags, each listed in the ladder's note:
//! the ALU carry-in at the overlap is this machine's not-yet-updated C
//! (the recorder masked it there; see build.rs); P travels to and from the
//! stack by position (PHP and BRK's third push write P, PLP and RTI's
//! second read loads it), because `P/DB` has no named node to record; and
//! a KIL repeats its recorded tail forever, which is a reading of "never
//! reaches a second fetch", not a measurement of the loop.
//!
//! Interrupts and the RDY stall are authored against the scripted fixture
//! traces (`fixture-irq-ordinary` and the rest), from what those traces
//! measured of rung 0:
//!
//! - An interrupt is the recorded BRK span hijacked, which is how the
//!   silicon does it (the predecode forces BRK): the poll at the coming
//!   fetch turns the next instruction into op 00's span with `#IPC` held
//!   asserted through the fetch's and T1's phi2 (so the pins re-read the
//!   fetch address and push the un-incremented PC), the pushed P carries B
//!   clear, and an NMI asserts `0/ADL2` beside the span's own `0/ADL0` so
//!   the vector reads land on fffa (fffb follows through the increment).
//! - The IRQ level is sampled at every phi2 except the final cycle's (the
//!   documented poll: the last look that can still hijack the coming fetch
//!   is the second-to-last cycle's); the NMI edge latches until serviced.
//!   Neither trace exercises the too-late assertion, so the exclusion is
//!   the manual's rule, not a measurement.
//! - RDY low holds a read cycle: the stall latches at the phi1 that would
//!   begin a new cycle after a read, the clock keeps toggling while every
//!   other pin holds, and a write cycle ignores it (NMOS). Release takes
//!   effect at the next phi1.
//! - The SO pin's false-to-true transition sets V, the polarity the pin
//!   contract records (`fixture-so-pulse`: the pushed P gains bit 6).
//! - A reset asserted mid-run was measured first (`v6502-sim`'s
//!   `reset-probe` example, run over the fixture's own script) and then
//!   authored from what the probe showed: RES steals a BRK's T6 vector
//!   read to fffd through a two-phi2 latch, kills the fetch (sync
//!   suppressed, `#IPC` forced), and the machine then REPLAYS the overlap
//!   word-pair, the datapath freewheeling through the measured junk
//!   addresses on the pair's own `ADDADL` and `DL/ADH` drives; one pair
//!   after release the same words play with sync, the warm reset's fetch,
//!   and the BRK span follows in the Res flavour: rw forced to read (the
//!   pushes read), `0/ADL1` through both vector cycles (fffc, fffd), I
//!   set. What res does mid-way through a NON-BRK instruction is the same
//!   machinery by construction and is not separately measured; and a
//!   KIL'd machine ignores res here (its loop never reaches a boundary),
//!   where real silicon recovers, a gap no trace exercises.

use crate::datapath::{Datapath, Phase};
use crate::flags::{self, Caps};
use crate::lines::{BIT_ALUCIN, BIT_RW, BIT_SYNC};
use crate::lines::bit;
use crate::select;
use crate::table;
use v6502_pins::{Load, PinEngine, PinFrame};

#[derive(Copy, Clone, PartialEq, Eq)]
enum Stream {
    Tail,
    Span,
}

/// Which line hijacked the coming instruction into the BRK span.
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
enum Intr {
    Irq,
    Nmi,
    Res,
}

/// Where the machine stands with respect to a reset asserted mid-run
/// (`reset-probe.rs` is the measurement all of this is written from).
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
enum ResPhase {
    Run,
    /// RES held: the fetch never registers, and the machine replays the
    /// overlap word-pair with sync suppressed; the datapath freewheels
    /// through the junk addresses the probe measured (5801, 0057) on the
    /// pair's own `ADDADL` and `DL/ADH` drives.
    Freewheel,
    /// RES released: the same pair plays once more WITH sync (the warm
    /// reset's own fetch, at whatever address the freewheel left), and
    /// its boundary starts the BRK span in the Res flavour.
    Fetch,
}

pub struct MicroCpu {
    dp: Datapath,
    p: u8,
    pub mem: Vec<u8>,
    half_cycle: u64,
    stream: Stream,
    span: &'static [u64],
    pos: usize,
    next_phase: Phase,
    op: u8,
    kil: bool,
    cin_from_c: bool,
    /// The finished instruction's write-back, played into this span's h=2.
    seam: u64,
    /// Captured while the current span plays.
    caps: Caps,
    reads: u32,
    writes: u32,
    next_op: u8,
    fetch_pc: u16,
    cur_key: u8,
    /// The pins as of the last played half-cycle, and the last byte READ,
    /// which is what the external data pin shows through a write's phi1
    /// (BRK's pushes show the operand byte, not the pushed bytes).
    pin_w: u64,
    pin_db: u8,
    pin_hold: u8,
    /// The five input pins as driven, echoed at the pins and consumed by
    /// the authored interrupt and stall logic above.
    in_res: bool,
    in_irq: bool,
    in_nmi: bool,
    in_rdy: bool,
    in_so: bool,
    /// The IRQ level as of the last effective poll (every phi2 except the
    /// final cycle's), and the NMI edge, latched until serviced.
    irq_seen: bool,
    nmi_pending: bool,
    /// Decided at the poll as the fetch begins; consumed at the boundary.
    hijack_next: Option<Intr>,
    /// The current span is an interrupt sequence, not a fetched BRK.
    hijacked: Option<Intr>,
    /// RDY is holding a read cycle still.
    stalled: bool,
    /// The RES level as of the last played phi1: what the boundary and
    /// the overlap-entry decisions consult (rung 0's release takes one
    /// extra pair to act, and this latch is what reproduces that).
    res_seen: bool,
    /// The res vector-select arm, double-latched at phi2: the in-flight
    /// BRK's T6 turns to fffd one full cycle after assertion (measured:
    /// fffe still reads at h=22 with res low since h=21).
    res_pend: bool,
    res_sel: bool,
    res_phase: ResPhase,
    /// Suppress the sync pin (and the fetch it would register) while the
    /// freewheel plays.
    mask_sync: bool,
}

impl MicroCpu {
    pub fn new() -> MicroCpu {
        MicroCpu {
            dp: Datapath::default(),
            p: 0x20,
            mem: vec![0; 0x10000],
            half_cycle: 0,
            stream: Stream::Tail,
            span: &table::RESET_TAIL,
            pos: 0,
            next_phase: Phase::Phi1,
            op: 0,
            kil: false,
            cin_from_c: false,
            seam: 0,
            caps: Caps::default(),
            reads: 0,
            writes: 0,
            next_op: 0,
            fetch_pc: 0,
            cur_key: 0,
            pin_w: 0,
            pin_db: 0,
            pin_hold: 0,
            in_res: true,
            in_irq: true,
            in_nmi: true,
            in_rdy: true,
            in_so: false,
            irq_seen: false,
            nmi_pending: false,
            hijack_next: None,
            hijacked: None,
            stalled: false,
            res_seen: true,
            res_pend: false,
            res_sel: false,
            res_phase: ResPhase::Run,
            mask_sync: false,
        }
    }

    pub fn rung3(loads: &[Load], reset_vector: u16) -> MicroCpu {
        let mut m = MicroCpu::new();
        for l in loads {
            let o = l.org as usize;
            m.mem[o..o + l.bytes.len()].copy_from_slice(&l.bytes);
        }
        m.mem[0xfffc] = reset_vector as u8;
        m.mem[0xfffd] = (reset_vector >> 8) as u8;
        m.power_cycle();
        m
    }

    /// Seed from the measured h=0 state and play the tail's first
    /// half-cycle, so the pins show what rung 0's show at h=0.
    pub fn power_cycle(&mut self) {
        let vec = self.mem[0xfffc] as u16 | (self.mem[0xfffd] as u16) << 8;
        let mut r = [0u8; 16];
        for (i, slot) in r.iter_mut().enumerate() {
            *slot = match table::RESET_KINDS[i] {
                0 => table::RESET_REGS[i],
                1 => vec as u8,
                2 => (vec >> 8) as u8,
                _ => self.mem[vec as usize],
            };
        }
        let r = &r;
        self.dp = Datapath {
            a: r[0], x: r[1], y: r[2], s_in: r[3], s_out: r[3],
            pcl: r[5], pch: r[6], pclp: r[7], pchp: r[8],
            abl: r[9], abh: r[10], dl: r[11], dor: r[12], add: r[13],
            ai: r[14], bi: r[15],
            sb: 0xff, db: 0xff, adl: 0xff, adh: 0xff,
        };
        self.p = r[4] | 0x20;
        self.stream = Stream::Tail;
        self.span = &table::RESET_TAIL;
        self.pos = 0;
        self.next_phase = Phase::Phi1;
        self.kil = false;
        self.caps = Caps::default();
        self.reads = 0;
        self.writes = 0;
        self.in_res = true;
        self.in_irq = true;
        self.in_nmi = true;
        self.in_rdy = true;
        self.in_so = false;
        self.irq_seen = false;
        self.nmi_pending = false;
        self.hijack_next = None;
        self.hijacked = None;
        self.stalled = false;
        self.res_seen = true;
        self.res_pend = false;
        self.res_sel = false;
        self.res_phase = ResPhase::Run;
        self.mask_sync = false;
        self.play_one();
        self.half_cycle = 0;
    }

    pub fn registers(&self) -> (u8, u8, u8, u8, u8, u16) {
        (self.dp.a, self.dp.x, self.dp.y, self.dp.s_in, self.p, self.dp.pc())
    }

    fn in_overlap(&self) -> bool {
        // The tail IS an overlap (the first fetch); a span's last two
        // half-cycles are the next one's.
        self.stream == Stream::Tail || (!self.kil && self.pos + 2 >= self.span.len())
    }

    fn play_one(&mut self) {
        // The poll, as the fetch begins: an NMI edge outranks a held IRQ,
        // and a held IRQ is gated by I. The decision has to land before
        // the overlap plays, because the suppression of the fetch's PC
        // increment rides the overlap's own phi2. A RES seen here kills
        // the fetch instead (the freewheel begins at the boundary), and
        // while the reset sequence owns the machine nothing else polls.
        if self.stream == Stream::Span && !self.kil && self.pos == self.span.len() - 2
            && self.res_phase == ResPhase::Run
        {
            if !self.res_seen {
                self.mask_sync = true;
                self.hijack_next = None;
            } else {
                self.hijack_next = if self.nmi_pending {
                    self.nmi_pending = false;
                    Some(Intr::Nmi)
                } else if self.irq_seen && self.p & 0x04 == 0 {
                    Some(Intr::Irq)
                } else {
                    None
                };
            }
        }
        let mut w = self.span[self.pos];
        if self.pos == 0 && self.stream == Stream::Span {
            w |= self.seam;
        }
        // The freewheel never fetches: the sync pin (and the fetch it
        // would register) is masked out of the word itself.
        if self.mask_sync {
            w &= !(1 << BIT_SYNC);
        }
        // The hijack's word edits, where the silicon's interrupt logic
        // overrides the instruction's own lines: no PC increment through
        // the fetch (the overlap, freewheel pairs included) and T1, and
        // the pending flavour's vector select beside the recorded lines.
        if (self.hijack_next.is_some() || self.mask_sync) && self.pos + 2 >= self.span.len() {
            w |= 1 << bit::IPC_N;
        }
        if self.hijacked.is_some() && self.pos < 2 {
            w |= 1 << bit::IPC_N;
        }
        // The flavour's select line holds through BOTH vector cycles (T5
        // and T6, the two before the overlap), the way the probe measured
        // res holding `0/ADL1` at fffc and fffd: T6's low byte is
        // undriven precharge in the recorded span, so keying off `0/ADL0`
        // alone would read ffff where the chip reads fffb (or fffd).
        let vector_cycle = self.pos + 6 >= self.span.len() && self.pos + 3 < self.span.len();
        if self.hijacked == Some(Intr::Nmi) && vector_cycle {
            w |= 1 << bit::VADL2;
        }
        if self.hijacked == Some(Intr::Res) && vector_cycle {
            w |= 1 << bit::VADL1;
        }
        // A RES landing while a BRK's own vector reads are in flight
        // steals T6 to fffd, one full cycle after assertion (the double
        // latch: fffe still reads at h=22 with res low since h=21).
        if self.res_sel && self.op == 0x00 && vector_cycle {
            w |= 1 << bit::VADL1;
        }
        // The warm reset performs its pushes as reads, whatever the RES
        // pin shows by then: rw is forced high through the whole span.
        if self.hijacked == Some(Intr::Res) {
            w |= 1 << BIT_RW;
        }
        let phase = self.next_phase;
        let overlap = self.in_overlap();
        let rw_read = w >> BIT_RW & 1 != 0;
        // At the overlap, an increment's +1 is recorded; only where the
        // recording proved data-ridden does the C flag stand in.
        let cin = if overlap && self.cin_from_c { self.p & 1 != 0 } else { w >> BIT_ALUCIN & 1 != 0 };

        let db;
        if phase == Phase::Phi1 {
            self.dp.step(w, Phase::Phi1, 0, cin);
            if rw_read {
                // The bus is serviced as the clock falls: a read half-cycle
                // shows its data from here on.
                db = self.mem[self.dp.address() as usize];
                self.pin_hold = db;
            } else {
                // A write drives DOR only as the clock rises; through phi1
                // the external pin shows the LAST BYTE READ (0x34 through
                // BRK's pushes, the old value through an RMW's dummy
                // write). Not DL: the input latch takes each written byte
                // too (measured through BRK, 34 -> 02 -> 09 -> 34), which
                // is what DCP's compare consumes, while the pin holds.
                db = self.pin_hold;
            }
        } else {
            let addr = self.dp.address() as usize;
            if rw_read {
                db = self.mem[addr];
                self.pin_hold = db;
                self.reads += 1;
                if !overlap {
                    self.caps.last_read = db;
                    // P from the stack, by position: PLP's and RTI's
                    // second read. Authored; P/DB has no named node.
                    if (self.op == 0x28 || self.op == 0x40) && self.reads == 2 {
                        self.p = (db & 0xcf) | 0x20;
                    }
                } else if w >> BIT_SYNC & 1 != 0 {
                    self.next_op = db;
                    self.fetch_pc = self.dp.address();
                }
            } else {
                self.writes += 1;
                // P to the stack, by position: PHP's only write, BRK's
                // third. The B bit rides only on the pushed copy, and a
                // hijacked sequence pushes it clear (the one bit that
                // tells an IRQ's push from BRK's at the pins). I sets
                // right after the push, before the vector reads, so the
                // pushed copy carries the old I and the handler runs with
                // it set.
                let data = if (self.op == 0x08 && self.writes == 1) || (self.op == 0x00 && self.writes == 3) {
                    let b = if self.hijacked.is_some() { 0x20 } else { 0x30 };
                    (self.p & 0xcf) | b
                } else {
                    self.dp.dor
                };
                if self.op == 0x00 && self.writes == 3 {
                    self.p |= 0x04;
                }
                self.mem[addr] = data;
                db = data;
                if !overlap {
                    self.caps.last_write = data;
                }
            }
            self.dp.step(w, Phase::Phi2, db, cin);
            // ALU captures, kept apart by where they ran: the overlap is
            // the accumulator path's compute, mid-span is an RMW's.
            let (ai, bi, r) = (self.dp.ai, self.dp.bi, self.dp.add);
            if w >> bit::SUMS & 1 != 0 {
                if overlap {
                    self.caps.sum = Some((ai, bi, cin, r));
                } else {
                    self.caps.sum_pre = Some((ai, bi, cin, r));
                }
            }
            if overlap && w >> bit::ANDS & 1 != 0 || overlap && w >> bit::ORS & 1 != 0 || overlap && w >> bit::EORS & 1 != 0 {
                self.caps.logic = Some(r);
            }
            if w >> bit::SRS & 1 != 0 {
                // The shifted operand is the B input alone, like the shift.
                let _ = ai;
                if overlap {
                    self.caps.srs = Some((bi, r));
                } else {
                    self.caps.srs_pre = Some((bi, r));
                }
            }
        }
        // The IRQ level, sampled at every phi2 except the final cycle's:
        // the last poll that can still hijack the coming fetch is the
        // second-to-last cycle's (the manual's rule; an assertion arriving
        // in the final cycle waits one instruction).
        if phase == Phase::Phi2 && !(self.stream == Stream::Span && self.pos + 3 == self.span.len()) {
            self.irq_seen = !self.in_irq;
        }
        // The RES latches: the phi1 level is what boundaries consult, and
        // the vector-select arm takes two phi2s to bite (both measured;
        // see the field notes).
        if phase == Phase::Phi1 {
            self.res_seen = self.in_res;
        } else {
            self.res_sel = self.res_pend;
            self.res_pend = !self.in_res;
        }
        self.pin_w = w;
        self.pin_db = db;
        self.next_phase = if phase == Phase::Phi1 { Phase::Phi2 } else { Phase::Phi1 };
        self.pos += 1;
        if self.pos == self.span.len() {
            if self.kil {
                // "Never reaches a second fetch": hold the recorded loop.
                self.pos = self.span.len() - 2;
                return;
            }
            self.boundary();
        }
    }

    /// The instruction boundary: the finished opcode's flags, then the
    /// next span, selected the way the recorder selected it.
    fn boundary(&mut self) {
        if self.stream == Stream::Span {
            flags::update(self.op, &mut self.p, self.dp.a, self.dp.x, self.dp.y, self.dp.s_out, &self.caps);
        }
        // The warm reset's state machine (reset-probe.rs is the whole
        // measurement): while RES is seen the overlap pair replays with
        // sync masked and the datapath freewheels; on release the same
        // pair plays once more WITH sync, the reset's own fetch, and its
        // boundary starts the BRK span in the Res flavour.
        match self.res_phase {
            ResPhase::Freewheel => {
                if !self.res_seen {
                    self.replay_pair(true);
                    return;
                }
                self.res_phase = ResPhase::Fetch;
                self.hijack_next = Some(Intr::Res);
                self.replay_pair(false);
                return;
            }
            ResPhase::Fetch => {
                self.res_phase = ResPhase::Run;
            }
            ResPhase::Run => {
                if !self.res_seen {
                    self.res_phase = ResPhase::Freewheel;
                    self.hijack_next = None;
                    self.replay_pair(true);
                    return;
                }
            }
        }
        // A hijacked fetch read and discarded its opcode: the predecode
        // forces BRK, and the span edits above make it the interrupt.
        self.hijacked = self.hijack_next.take();
        if self.hijacked == Some(Intr::Res) {
            // Reset sets I (documented; the fixture cannot see it, its
            // program starts with CLI) and drops any latched NMI edge.
            self.p |= 0x04;
            self.nmi_pending = false;
        }
        let op = if self.hijacked.is_some() { 0x00 } else { self.next_op };
        // The finished op's seam travels into the next span's first
        // half-cycle; computed before the switch, from the op that owns it.
        self.seam = if self.stream == Stream::Span {
            table::seam(self.op, self.cur_key)
        } else {
            0
        };
        let key = select::selector(op, self.p, self.dp.x, self.dp.y, self.fetch_pc, &self.mem);
        let span = table::span(op, key).unwrap_or_else(|| {
            panic!(
                "op {op:02x} at {:04x}: no recorded variant for key {key:#04x} (mask {:#04x})",
                self.fetch_pc,
                table::MASKS[op as usize]
            )
        });
        self.stream = Stream::Span;
        self.span = span;
        self.pos = 0;
        self.op = op;
        self.kil = table::is_kil(op);
        self.cin_from_c = table::overlap_cin_from_c(op, key);
        self.cur_key = key;
        self.caps = Caps::default();
        self.reads = 0;
        self.writes = 0;
        self.mask_sync = false;
    }

    /// Re-enter the current span's overlap pair: the freewheel's unit,
    /// and the warm reset's fetch. The op is the forced BRK from here on
    /// (the predecode under res), which also keeps the pair boundaries
    /// from re-applying the interrupted instruction's flags.
    fn replay_pair(&mut self, mask: bool) {
        let n = self.span.len();
        self.span = &self.span[n - 2..];
        self.pos = 0;
        self.op = 0x00;
        self.mask_sync = mask;
        self.seam = 0;
        self.caps = Caps::default();
        self.reads = 0;
        self.writes = 0;
    }
}

impl Default for MicroCpu {
    fn default() -> Self {
        Self::new()
    }
}

impl PinEngine for MicroCpu {
    fn power_cycle(&mut self) {
        MicroCpu::power_cycle(self);
    }
    fn set_inputs(&mut self, res: bool, irq: bool, nmi: bool, rdy: bool, so: bool) {
        // The two edges live here: NMI latches on assertion (high to low,
        // active low) until serviced, and SO's false-to-true transition
        // sets V, the polarity `fixture-so-pulse` measured of rung 0.
        // A reset asserted mid-run is not authored yet (module note).
        if self.in_nmi && !nmi {
            self.nmi_pending = true;
        }
        if so && !self.in_so {
            self.p |= 0x40;
        }
        self.in_res = res;
        self.in_irq = irq;
        self.in_nmi = nmi;
        self.in_rdy = rdy;
        self.in_so = so;
    }
    fn half_step(&mut self) {
        // RDY holds a read cycle still while the clock keeps running:
        // the stall latches at the phi1 that would begin a new cycle
        // after a read (a write cycle ignores RDY, NMOS), and release
        // takes effect at the next phi1.
        if self.next_phase == Phase::Phi1 && !self.in_rdy && self.pin_w >> BIT_RW & 1 != 0 {
            self.stalled = true;
        }
        if self.stalled {
            if self.next_phase == Phase::Phi1 && self.in_rdy {
                self.stalled = false;
            } else {
                self.next_phase =
                    if self.next_phase == Phase::Phi1 { Phase::Phi2 } else { Phase::Phi1 };
                self.half_cycle += 1;
                return;
            }
        }
        self.play_one();
        self.half_cycle += 1;
    }
    fn pins(&self) -> PinFrame {
        PinFrame {
            h: self.half_cycle,
            clk0: self.next_phase == Phase::Phi1,
            ab: self.dp.address(),
            db: self.pin_db,
            rw: self.pin_w >> BIT_RW & 1 != 0,
            sync: self.pin_w >> BIT_SYNC & 1 != 0,
            res: self.in_res,
            irq: self.in_irq,
            nmi: self.in_nmi,
            rdy: self.in_rdy,
            so: self.in_so,
        }
    }
    fn h(&self) -> u64 {
        self.half_cycle
    }
}
