//! Hanson's block diagram as corrected by measurement, in registers.
//!
//! A port, line for line, of the model `tools/experiments/m4-datapath.py`
//! proved against the chip's own control-line levels (100% of 2,396
//! half-cycles on `abl abh pc pclp pchp a x y s` over four programs), with
//! the two corrections that run produced: register-to-bus drives from X, Y,
//! A and DL are effective in phi1 only while S, ADD, the PC and the
//! constants hold through phi2 and the next phi1; and the PC increments
//! through the address bus (the incrementer latch takes PC + IPC during
//! phi2, `PCL/ADL` drives the latch, `ADL/PCL` loads at phi1, and
//! `PCL/PCL` is the hold path).
//!
//! NMOS discipline throughout: buses precharge to $FF and drivers AND in,
//! so low wins. `tests/datapath.rs` re-proves the port the way the Python
//! was proved, against rung 0, and holds the nine fields at 100%.
//!
//! The ALU carry-in arrives as an argument: it is a data signal (the flags,
//! or the increment short-circuits), the sequencer's to compute, and the
//! test reads it off the chip so only the SEMANTICS are under test here.

use crate::lines::bit::*;

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Phase {
    Phi1,
    Phi2,
}

/// Every register and latch of the diagram, one byte each.
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
pub struct Datapath {
    pub a: u8,
    pub x: u8,
    pub y: u8,
    /// The stack register's two halves: `s_in` loads, `s_out` drives, and
    /// the handover happens in phi2.
    pub s_in: u8,
    pub s_out: u8,
    pub pcl: u8,
    pub pch: u8,
    /// The incrementer latch: PC + IPC, taken during phi2, held through
    /// the next phi1. Every PC-to-bus drive is from this latch.
    pub pclp: u8,
    pub pchp: u8,
    pub abl: u8,
    pub abh: u8,
    /// Input data latch, data output register, ALU hold register.
    pub dl: u8,
    pub dor: u8,
    pub add: u8,
    /// The ALU's two input latches.
    pub ai: u8,
    pub bi: u8,
    /// The four internal buses as of the last step, for observation.
    pub sb: u8,
    pub db: u8,
    pub adl: u8,
    pub adh: u8,
}

#[inline]
fn on(w: u64, b: usize) -> bool {
    w >> b & 1 != 0
}

impl Datapath {
    /// One half-cycle: the control vector `w` (lines.rs order), the phase,
    /// the byte on the external data bus if this half-cycle reads, and the
    /// ALU carry-in.
    pub fn step(&mut self, w: u64, phase: Phase, data_in: u8, alucin: bool) {
        let p1 = phase == Phase::Phi1;

        if phase == Phase::Phi2 {
            let ipc = !on(w, IPC_N);
            self.pclp = self.pcl.wrapping_add(ipc as u8);
            self.pchp = self.pch.wrapping_add((ipc && self.pcl == 0xff) as u8);
        }
        let (pcl_inc, pch_inc) = (self.pclp, self.pchp);

        // Buses: precharge, drivers AND in, then the pass-connects.
        let mut sb = 0xffu8;
        let mut db = 0xffu8;
        let mut adl = 0xffu8;
        let mut adh = 0xffu8;
        if on(w, YSB) && p1 {
            sb &= self.y;
        }
        if on(w, XSB) && p1 {
            sb &= self.x;
        }
        if on(w, SSB) {
            sb &= self.s_out;
        }
        if on(w, ACSB) && p1 {
            sb &= self.a;
        }
        if on(w, ADDSB06) {
            sb &= self.add | 0x80;
        }
        if on(w, ADDSB7) {
            sb &= self.add | 0x7f;
        }
        if on(w, ACDB) && p1 {
            db &= self.a;
        }
        if on(w, PCHDB) {
            db &= pch_inc;
        }
        if on(w, PCLDB) {
            db &= pcl_inc;
        }
        if on(w, DL_DB) && p1 {
            db &= self.dl;
        }
        if on(w, SADL) {
            adl &= self.s_out;
        }
        if on(w, ADDADL) {
            adl &= self.add;
        }
        if on(w, PCLADL) {
            adl &= pcl_inc;
        }
        if on(w, DL_ADL) && p1 {
            adl &= self.dl;
        }
        if on(w, VADL0) {
            adl &= !1;
        }
        if on(w, VADL1) {
            adl &= !2;
        }
        if on(w, VADL2) {
            adl &= !4;
        }
        if on(w, PCHADH) {
            adh &= pch_inc;
        }
        if on(w, DL_ADH) && p1 {
            adh &= self.dl;
        }
        if on(w, ZADH0) {
            adh &= 0xfe;
        }
        if on(w, ZADH17) {
            adh &= 0x01;
        }
        if on(w, SBDB) {
            let v = sb & db;
            sb = v;
            db = v;
        }
        if on(w, SBADH) {
            let v = sb & adh;
            sb = v;
            adh = v;
        }
        if on(w, SBDB) && on(w, SBADH) {
            let v = sb & db & adh;
            sb = v;
            db = v;
            adh = v;
        }
        self.sb = sb;
        self.db = db;
        self.adl = adl;
        self.adh = adh;

        if p1 {
            if on(w, ADL_ABL) {
                self.abl = adl;
            }
            if on(w, ADH_ABH) {
                self.abh = adh;
            }
            if on(w, SBY) {
                self.y = sb;
            }
            if on(w, SBX) {
                self.x = sb;
            }
            if on(w, SBS) {
                self.s_in = sb;
            } else if on(w, SS) {
                self.s_in = self.s_out;
            }
            if on(w, SBAC) {
                self.a = sb;
            }
            if on(w, SBADD) {
                self.ai = sb;
            }
            if on(w, ZADD) {
                self.ai = 0;
            }
            if on(w, DBADD) {
                self.bi = db;
            }
            if on(w, NDBADD) {
                self.bi = !db;
            }
            if on(w, ADLADD) {
                self.bi = adl;
            }
            if on(w, ADLPCL) {
                self.pcl = adl;
            } else if on(w, PCLPCL) {
                self.pcl = self.pclp;
            }
            if on(w, ADHPCH) {
                self.pch = adh;
            } else if on(w, PCHPCH) {
                self.pch = self.pchp;
            }
            self.dor = db;
        } else {
            let cin = alucin as u16;
            let (a, b) = (self.ai as u16, self.bi as u16);
            if on(w, SUMS) {
                self.add = (a + b + cin) as u8;
            } else if on(w, ANDS) {
                self.add = (a & b) as u8;
            } else if on(w, ORS) {
                self.add = (a | b) as u8;
            } else if on(w, EORS) {
                self.add = (a ^ b) as u8;
            } else if on(w, SRS) {
                // The right shift is of the B input ALONE, with the
                // carry-in into bit 7 (how ROR and LSR share one line).
                // The Python model's (a | b) >> 1 could not be told apart
                // on the four programs, because an accumulator shift loads
                // both latches with A; rung 0's own latches through LSR zp
                // (ai=ff, bi=ea, add=75) settled it.
                self.add = ((b >> 1) as u8) | (cin as u8) << 7;
            }
            self.dl = data_in;
            self.s_out = self.s_in;
        }
    }

    pub fn pc(&self) -> u16 {
        (self.pch as u16) << 8 | self.pcl as u16
    }
    pub fn address(&self) -> u16 {
        (self.abh as u16) << 8 | self.abl as u16
    }
}
