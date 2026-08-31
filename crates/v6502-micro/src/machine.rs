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

    /// The last opcode fetch the machine saw: address and byte, the same
    /// bookkeeping rung 0 latches in `service_read` on sync.
    pub fn last_fetch(&self) -> (u16, u8) {
        (self.fetch_pc, self.next_op)
    }

    /// The control word as of the last played half-cycle, `lines.rs`
    /// order: what the console's gate sampling reads on this rung.
    pub fn control_word(&self) -> u64 {
        self.pin_w
    }

    /// The opcode whose span is playing: the IR's reading on this rung.
    pub fn opcode(&self) -> u8 {
        self.op
    }

    /// The datapath's registers and latches, for observation.
    pub fn datapath(&self) -> &Datapath {
        &self.dp
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

/// Rung 3's machine value: its own codec, smaller than the four bitsets,
/// and it does not pretend to be them. Every field of the sequencer, the
/// datapath and the authored input latches, plus the memory; the span
/// pointer is NOT here, it is reconstructed from `(op, cur_key)` (or the
/// reset tail, or the overlap pair) on restore, so a state cannot smuggle
/// in control words the table never measured.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct MicroState {
    pub mem: Vec<u8>,
    pub half_cycle: u64,
    pub p: u8,
    pub dp: Datapath,
    /// 0 = the reset tail, 1 = the span for `(op, cur_key)`, 2 = that
    /// span's overlap pair (the freewheel's unit).
    pub stream: u8,
    pub pos: usize,
    /// The phase the NEXT half-cycle plays in: true = phi1.
    pub phi1_next: bool,
    pub op: u8,
    pub cur_key: u8,
    pub kil: bool,
    pub cin_from_c: bool,
    pub seam: u64,
    pub caps: Caps,
    pub reads: u32,
    pub writes: u32,
    pub next_op: u8,
    pub fetch_pc: u16,
    pub pin_w: u64,
    pub pin_db: u8,
    pub pin_hold: u8,
    /// res irq nmi rdy so, as driven.
    pub inputs: [bool; 5],
    pub irq_seen: bool,
    pub nmi_pending: bool,
    /// 0 = none, 1 = irq, 2 = nmi, 3 = res.
    pub hijack_next: u8,
    pub hijacked: u8,
    pub stalled: bool,
    pub res_seen: bool,
    pub res_pend: bool,
    pub res_sel: bool,
    /// 0 = run, 1 = freewheel, 2 = fetch.
    pub res_phase: u8,
    pub mask_sync: bool,
}

impl MicroState {
    /// The wire form of everything but the memory, which travels as the
    /// API's own sparse pages beside it: a version byte, then each field
    /// in declaration order. About 90 bytes against rung 0's 1.3 KB of
    /// node planes; a different value for a different kind of machine,
    /// and it says so with its own field name on the wire.
    pub fn encode(&self) -> Vec<u8> {
        let mut b = Vec::with_capacity(96);
        b.push(1u8);
        b.extend_from_slice(&self.half_cycle.to_le_bytes());
        b.push(self.p);
        let d = &self.dp;
        b.extend_from_slice(&[
            d.a, d.x, d.y, d.s_in, d.s_out, d.pcl, d.pch, d.pclp, d.pchp, d.abl, d.abh, d.dl,
            d.dor, d.add, d.ai, d.bi, d.sb, d.db, d.adl, d.adh,
        ]);
        b.push(self.stream);
        b.extend_from_slice(&(self.pos as u16).to_le_bytes());
        b.push(self.phi1_next as u8);
        b.push(self.op);
        b.push(self.cur_key);
        b.push(self.kil as u8);
        b.push(self.cin_from_c as u8);
        b.extend_from_slice(&self.seam.to_le_bytes());
        let c = &self.caps;
        b.push(c.last_read);
        b.push(c.last_write);
        let opt4 = |b: &mut Vec<u8>, o: Option<(u8, u8, bool, u8)>| match o {
            Some((x, y, z, r)) => b.extend_from_slice(&[1, x, y, z as u8, r]),
            None => b.extend_from_slice(&[0, 0, 0, 0, 0]),
        };
        opt4(&mut b, c.sum);
        opt4(&mut b, c.sum_pre);
        let opt2 = |b: &mut Vec<u8>, o: Option<(u8, u8)>| match o {
            Some((x, r)) => b.extend_from_slice(&[1, x, r]),
            None => b.extend_from_slice(&[0, 0, 0]),
        };
        opt2(&mut b, c.srs);
        opt2(&mut b, c.srs_pre);
        match c.logic {
            Some(r) => b.extend_from_slice(&[1, r]),
            None => b.extend_from_slice(&[0, 0]),
        }
        b.extend_from_slice(&self.reads.to_le_bytes());
        b.extend_from_slice(&self.writes.to_le_bytes());
        b.push(self.next_op);
        b.extend_from_slice(&self.fetch_pc.to_le_bytes());
        b.extend_from_slice(&self.pin_w.to_le_bytes());
        b.push(self.pin_db);
        b.push(self.pin_hold);
        for i in self.inputs {
            b.push(i as u8);
        }
        b.extend_from_slice(&[
            self.irq_seen as u8,
            self.nmi_pending as u8,
            self.hijack_next,
            self.hijacked,
            self.stalled as u8,
            self.res_seen as u8,
            self.res_pend as u8,
            self.res_sel as u8,
            self.res_phase,
            self.mask_sync as u8,
        ]);
        b
    }

    /// The inverse of `encode`, with `mem` set to `fill`: the caller lays
    /// the sparse pages over it, the way every engine's import does.
    pub fn decode(blob: &[u8], fill: u8) -> Result<MicroState, String> {
        let mut at = 0usize;
        let mut take = |n: usize| -> Result<&[u8], String> {
            if at + n > blob.len() {
                return Err(format!("micro state blob is {} bytes, short at offset {at}", blob.len()));
            }
            let s = &blob[at..at + n];
            at += n;
            Ok(s)
        };
        let version = take(1)?[0];
        if version != 1 {
            return Err(format!("micro state version {version} is not 1"));
        }
        let half_cycle = u64::from_le_bytes(take(8)?.try_into().unwrap());
        let p = take(1)?[0];
        let d = take(20)?;
        let dp = Datapath {
            a: d[0], x: d[1], y: d[2], s_in: d[3], s_out: d[4], pcl: d[5], pch: d[6],
            pclp: d[7], pchp: d[8], abl: d[9], abh: d[10], dl: d[11], dor: d[12], add: d[13],
            ai: d[14], bi: d[15], sb: d[16], db: d[17], adl: d[18], adh: d[19],
        };
        let bit = |b: u8, what: &str| -> Result<bool, String> {
            match b {
                0 => Ok(false),
                1 => Ok(true),
                n => Err(format!("{what}: {n} is not a flag")),
            }
        };
        let stream = take(1)?[0];
        let pos = u16::from_le_bytes(take(2)?.try_into().unwrap()) as usize;
        let phi1_next = bit(take(1)?[0], "phi1_next")?;
        let op = take(1)?[0];
        let cur_key = take(1)?[0];
        let kil = bit(take(1)?[0], "kil")?;
        let cin_from_c = bit(take(1)?[0], "cin_from_c")?;
        let seam = u64::from_le_bytes(take(8)?.try_into().unwrap());
        let last_read = take(1)?[0];
        let last_write = take(1)?[0];
        let mut opt4 = |what: &str| -> Result<Option<(u8, u8, bool, u8)>, String> {
            let s = take(5)?;
            match s[0] {
                0 => Ok(None),
                1 => Ok(Some((s[1], s[2], s[3] != 0, s[4]))),
                n => Err(format!("{what}: {n} is not an option tag")),
            }
        };
        let sum = opt4("sum")?;
        let sum_pre = opt4("sum_pre")?;
        let mut opt2 = |what: &str| -> Result<Option<(u8, u8)>, String> {
            let s = take(3)?;
            match s[0] {
                0 => Ok(None),
                1 => Ok(Some((s[1], s[2]))),
                n => Err(format!("{what}: {n} is not an option tag")),
            }
        };
        let srs = opt2("srs")?;
        let srs_pre = opt2("srs_pre")?;
        let logic = {
            let s = take(2)?;
            match s[0] {
                0 => None,
                1 => Some(s[1]),
                n => return Err(format!("logic: {n} is not an option tag")),
            }
        };
        let reads = u32::from_le_bytes(take(4)?.try_into().unwrap());
        let writes = u32::from_le_bytes(take(4)?.try_into().unwrap());
        let next_op = take(1)?[0];
        let fetch_pc = u16::from_le_bytes(take(2)?.try_into().unwrap());
        let pin_w = u64::from_le_bytes(take(8)?.try_into().unwrap());
        let pin_db = take(1)?[0];
        let pin_hold = take(1)?[0];
        let inp = take(5)?.to_vec();
        let tail = take(10)?.to_vec();
        if at != blob.len() {
            return Err(format!("micro state blob has {} trailing bytes", blob.len() - at));
        }
        let mut inputs = [false; 5];
        for (i, &v) in inp.iter().enumerate() {
            inputs[i] = bit(v, "inputs")?;
        }
        Ok(MicroState {
            mem: vec![fill; 0x10000],
            half_cycle,
            p,
            dp,
            stream,
            pos,
            phi1_next,
            op,
            cur_key,
            kil,
            cin_from_c,
            seam,
            caps: Caps { last_read, last_write, sum, sum_pre, srs, srs_pre, logic },
            reads,
            writes,
            next_op,
            fetch_pc,
            pin_w,
            pin_db,
            pin_hold,
            inputs,
            irq_seen: bit(tail[0], "irq_seen")?,
            nmi_pending: bit(tail[1], "nmi_pending")?,
            hijack_next: tail[2],
            hijacked: tail[3],
            stalled: bit(tail[4], "stalled")?,
            res_seen: bit(tail[5], "res_seen")?,
            res_pend: bit(tail[6], "res_pend")?,
            res_sel: bit(tail[7], "res_sel")?,
            res_phase: tail[8],
            mask_sync: bit(tail[9], "mask_sync")?,
        })
    }
}

fn intr_code(i: Option<Intr>) -> u8 {
    match i {
        None => 0,
        Some(Intr::Irq) => 1,
        Some(Intr::Nmi) => 2,
        Some(Intr::Res) => 3,
    }
}

fn intr_from(c: u8) -> Result<Option<Intr>, String> {
    Ok(match c {
        0 => None,
        1 => Some(Intr::Irq),
        2 => Some(Intr::Nmi),
        3 => Some(Intr::Res),
        _ => return Err(format!("interrupt flavour {c} is not one of 0..=3")),
    })
}

impl MicroCpu {
    pub fn snapshot(&self) -> MicroState {
        MicroState {
            mem: self.mem.clone(),
            half_cycle: self.half_cycle,
            p: self.p,
            dp: self.dp,
            stream: match self.stream {
                Stream::Tail => 0,
                // A 2-word span is the overlap pair: real spans are at
                // least two cycles of their own plus the overlap.
                Stream::Span if self.span.len() == 2 => 2,
                Stream::Span => 1,
            },
            pos: self.pos,
            phi1_next: self.next_phase == Phase::Phi1,
            op: self.op,
            cur_key: self.cur_key,
            kil: self.kil,
            cin_from_c: self.cin_from_c,
            seam: self.seam,
            caps: self.caps,
            reads: self.reads,
            writes: self.writes,
            next_op: self.next_op,
            fetch_pc: self.fetch_pc,
            pin_w: self.pin_w,
            pin_db: self.pin_db,
            pin_hold: self.pin_hold,
            inputs: [self.in_res, self.in_irq, self.in_nmi, self.in_rdy, self.in_so],
            irq_seen: self.irq_seen,
            nmi_pending: self.nmi_pending,
            hijack_next: intr_code(self.hijack_next),
            hijacked: intr_code(self.hijacked),
            stalled: self.stalled,
            res_seen: self.res_seen,
            res_pend: self.res_pend,
            res_sel: self.res_sel,
            res_phase: match self.res_phase {
                ResPhase::Run => 0,
                ResPhase::Freewheel => 1,
                ResPhase::Fetch => 2,
            },
            mask_sync: self.mask_sync,
        }
    }

    /// The inverse of `snapshot`. Refuses, by name, a state whose span the
    /// table does not hold or whose position falls outside it.
    pub fn restore(&mut self, st: &MicroState) -> Result<(), String> {
        if st.mem.len() != 0x10000 {
            return Err(format!("memory is {} bytes, not 65536", st.mem.len()));
        }
        let span: &'static [u64] = match st.stream {
            0 => &table::RESET_TAIL,
            1 | 2 => {
                let s = table::span(st.op, st.cur_key).ok_or_else(|| {
                    format!("op {:02x} has no recorded variant for key {:#04x}", st.op, st.cur_key)
                })?;
                if st.stream == 2 { &s[s.len() - 2..] } else { s }
            }
            n => return Err(format!("stream {n} is not one of 0..=2")),
        };
        if st.pos >= span.len() {
            return Err(format!("position {} is outside the {}-word span", st.pos, span.len()));
        }
        // Everything fallible resolves before anything mutates, so a
        // refused state leaves the machine as it was.
        let hijack_next = intr_from(st.hijack_next)?;
        let hijacked = intr_from(st.hijacked)?;
        let res_phase = match st.res_phase {
            0 => ResPhase::Run,
            1 => ResPhase::Freewheel,
            2 => ResPhase::Fetch,
            n => return Err(format!("res phase {n} is not one of 0..=2")),
        };
        self.mem.copy_from_slice(&st.mem);
        self.half_cycle = st.half_cycle;
        self.p = st.p;
        self.dp = st.dp;
        self.stream = if st.stream == 0 { Stream::Tail } else { Stream::Span };
        self.span = span;
        self.pos = st.pos;
        self.next_phase = if st.phi1_next { Phase::Phi1 } else { Phase::Phi2 };
        self.op = st.op;
        self.cur_key = st.cur_key;
        self.kil = st.kil;
        self.cin_from_c = st.cin_from_c;
        self.seam = st.seam;
        self.caps = st.caps;
        self.reads = st.reads;
        self.writes = st.writes;
        self.next_op = st.next_op;
        self.fetch_pc = st.fetch_pc;
        self.pin_w = st.pin_w;
        self.pin_db = st.pin_db;
        self.pin_hold = st.pin_hold;
        let [r, i, n, y, s] = st.inputs;
        self.in_res = r;
        self.in_irq = i;
        self.in_nmi = n;
        self.in_rdy = y;
        self.in_so = s;
        self.irq_seen = st.irq_seen;
        self.nmi_pending = st.nmi_pending;
        self.hijack_next = hijack_next;
        self.hijacked = hijacked;
        self.stalled = st.stalled;
        self.res_seen = st.res_seen;
        self.res_pend = st.res_pend;
        self.res_sel = st.res_sel;
        self.res_phase = res_phase;
        self.mask_sync = st.mask_sync;
        Ok(())
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
