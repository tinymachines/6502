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
//! No interrupts, no RDY stalls yet: the scripted stimulus traces are the
//! recorded gap, listed in the replay test.

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
        let mut w = self.span[self.pos];
        if self.pos == 0 && self.stream == Stream::Span {
            w |= self.seam;
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
                // third. The B bit rides only on the pushed copy.
                let data = if (self.op == 0x08 && self.writes == 1) || (self.op == 0x00 && self.writes == 3) {
                    (self.p & 0xcf) | 0x30
                } else {
                    self.dp.dor
                };
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
        let op = self.next_op;
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
    fn set_inputs(&mut self, _res: bool, _irq: bool, _nmi: bool, _rdy: bool, _so: bool) {
        // Not yet authored; the stimulus traces are the recorded gap.
    }
    fn half_step(&mut self) {
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
            res: true,
            irq: true,
            nmi: true,
            rdy: true,
            so: false,
        }
    }
    fn h(&self) -> u64 {
        self.half_cycle
    }
}
