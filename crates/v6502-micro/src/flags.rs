//! The status register, authored.
//!
//! Nothing here is measured from the die: the 44 lines do not carry the
//! flag loads, and `P/DB` has no named node (the ladder's open item), so
//! this is the one wholly authored layer of rung 3, written from the
//! manual and held by the pin golden: every BRK pushes P onto the data
//! bus, and every branch turns a flag into a pin sequence, so a wrong rule
//! here fails a trace by name rather than hiding.
//!
//! The sequencer captures the ALU's inputs and outputs at the half-cycles
//! the table says an ALU op ran, and this module turns the captures into
//! flag updates at the instruction boundary.

/// What the playback captured while an instruction ran.
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
pub struct Caps {
    /// The last byte read before the overlap: the operand for loads and BIT.
    pub last_read: u8,
    /// The last byte written: the result of an RMW.
    pub last_write: u8,
    /// The last SUMS capture at the overlap: the accumulator path's own
    /// compute (ADC, compares, ASL A) runs under the next fetch.
    pub sum: Option<(u8, u8, bool, u8)>,
    /// The last SUMS capture before the overlap: an RMW's modify.
    pub sum_pre: Option<(u8, u8, bool, u8)>,
    /// The same split for SRS, the right shift.
    pub srs: Option<(u8, u8)>,
    pub srs_pre: Option<(u8, u8)>,
    /// The last ANDS / ORS / EORS result.
    pub logic: Option<u8>,
}

const N: u8 = 0x80;
const V: u8 = 0x40;
const Z: u8 = 0x02;
const C: u8 = 0x01;

fn nz(p: &mut u8, v: u8) {
    *p = (*p & !(N | Z)) | (v & N) | if v == 0 { Z } else { 0 };
}
fn put(p: &mut u8, flag: u8, on: bool) {
    *p = (*p & !flag) | if on { flag } else { 0 };
}

/// Carry and overflow out of an addition capture.
fn adc_flags(p: &mut u8, (a, b, cin, r): (u8, u8, bool, u8)) {
    put(p, C, (a as u16 + b as u16 + cin as u16) > 0xff);
    put(p, V, (a ^ r) & (b ^ r) & 0x80 != 0);
    nz(p, r);
}

/// Applied at the instruction boundary, after the overlap half-cycles and
/// before the next span is selected, which is exactly when the chip's own
/// update becomes visible to a following branch.
/// The one subtlety running through every arm: a result reaches its
/// register at the NEXT span's h=2, after this update runs, so the flag
/// source is the captured value in flight (the operand read, the ALU
/// capture), never the stale register. The registers named here are
/// SOURCES of transfers, which do not change.
pub fn update(op: u8, p: &mut u8, a: u8, x: u8, y: u8, s: u8, c: &Caps) {
    let sum_r = c.sum.map(|t| t.3);
    let srs_r = c.srs.map(|t| t.1);
    let logic = c.logic;
    let _ = (sum_r, srs_r, logic);
    match op {
        // Flag instructions.
        0x18 => put(p, C, false),
        0x38 => put(p, C, true),
        0x58 | 0x78 => put(p, 0x04, op == 0x78),
        0xb8 => put(p, V, false),
        0xd8 | 0xf8 => put(p, 0x08, op == 0xf8),
        // Loads: the operand in flight is the flag source.
        0xa9 | 0xa5 | 0xb5 | 0xad | 0xbd | 0xb9 | 0xa1 | 0xb1 | 0x68 => nz(p, c.last_read),
        0xa2 | 0xa6 | 0xb6 | 0xae | 0xbe => nz(p, c.last_read),
        0xa0 | 0xa4 | 0xb4 | 0xac | 0xbc => nz(p, c.last_read),
        // Transfers: the SOURCE register, which does not change.
        0x8a => nz(p, x),
        0x98 => nz(p, y),
        0xaa | 0xa8 => nz(p, a),
        0xba => nz(p, s),
        // LAX and LAS: the value in flight.
        0xa7 | 0xb7 | 0xaf | 0xbf | 0xa3 | 0xb3 => nz(p, c.last_read),
        // Logic on the accumulator: the captured ALU result.
        0x29 | 0x25 | 0x35 | 0x2d | 0x3d | 0x39 | 0x21 | 0x31
        | 0x09 | 0x05 | 0x15 | 0x0d | 0x1d | 0x19 | 0x01 | 0x11
        | 0x49 | 0x45 | 0x55 | 0x4d | 0x5d | 0x59 | 0x41 | 0x51 => {
            if let Some(r) = logic {
                nz(p, r);
            }
        }
        // ANC: AND, with N copied into C.
        0x0b | 0x2b => {
            if let Some(r) = logic {
                nz(p, r);
                put(p, C, r & 0x80 != 0);
            }
        }
        // ADC / SBC (and the RRA/ISC composites, whose adds were captured).
        0x69 | 0x65 | 0x75 | 0x6d | 0x7d | 0x79 | 0x61 | 0x71 | 0xe9 | 0xe5 | 0xf5 | 0xed | 0xfd
        | 0xf9 | 0xe1 | 0xf1 | 0xeb | 0x67 | 0x77 | 0x6f | 0x7f | 0x7b | 0x63 | 0x73 | 0xe7
        | 0xf7 | 0xef | 0xff | 0xfb | 0xe3 | 0xf3 => {
            if let Some(s) = c.sum {
                adc_flags(p, s);
            }
        }
        // Compares: carry and NZ from the captured subtract.
        0xc9 | 0xc5 | 0xd5 | 0xcd | 0xdd | 0xd9 | 0xc1 | 0xd1 | 0xe0 | 0xe4 | 0xec | 0xc0 | 0xc4
        | 0xcc | 0xc7 | 0xd7 | 0xcf | 0xdf | 0xdb | 0xc3 | 0xd3 => {
            if let Some((ai, bi, cin, r)) = c.sum {
                put(p, C, (ai as u16 + bi as u16 + cin as u16) > 0xff);
                nz(p, r);
            }
        }
        // SBX: (A & X) - imm into X, carry like a compare.
        0xcb => {
            if let Some((ai, bi, cin, r)) = c.sum {
                put(p, C, (ai as u16 + bi as u16 + cin as u16) > 0xff);
                nz(p, r);
            }
        }
        // Accumulator shifts: SUMS a+a is ASL, SRS is the right shift; the
        // captured result is the flag source.
        0x0a | 0x2a => {
            if let Some((ai, _, _, r)) = c.sum {
                put(p, C, ai & 0x80 != 0);
                nz(p, r);
            }
        }
        0x4a | 0x6a | 0x4b => {
            if let Some((before, r)) = c.srs {
                put(p, C, before & 1 != 0);
                nz(p, r);
            }
        }
        // Memory shifts and their composites: carry from the captured ALU,
        // NZ from what was written back (or the accumulator for composites).
        0x06 | 0x16 | 0x0e | 0x1e | 0x26 | 0x36 | 0x2e | 0x3e => {
            if let Some((ai, _, _, _)) = c.sum_pre {
                put(p, C, ai & 0x80 != 0);
            }
            nz(p, c.last_write);
        }
        0x46 | 0x56 | 0x4e | 0x5e | 0x66 | 0x76 | 0x6e | 0x7e => {
            if let Some((before, _)) = c.srs_pre {
                put(p, C, before & 1 != 0);
            }
            nz(p, c.last_write);
        }
        0x07 | 0x17 | 0x0f | 0x1f | 0x1b | 0x03 | 0x13 => {
            // SLO: ASL memory, then ORA; NZ from the ORA in flight.
            if let Some((ai, _, _, _)) = c.sum_pre {
                put(p, C, ai & 0x80 != 0);
            }
            if let Some(r) = logic {
                nz(p, r);
            }
        }
        0x27 | 0x37 | 0x2f | 0x3f | 0x3b | 0x23 | 0x33 => {
            // RLA: ROL memory, then AND.
            if let Some((ai, _, _, _)) = c.sum_pre {
                put(p, C, ai & 0x80 != 0);
            }
            if let Some(r) = logic {
                nz(p, r);
            }
        }
        0x47 | 0x57 | 0x4f | 0x5f | 0x5b | 0x43 | 0x53 => {
            // SRE: LSR memory, then EOR.
            if let Some((before, _)) = c.srs_pre {
                put(p, C, before & 1 != 0);
            }
            if let Some(r) = logic {
                nz(p, r);
            }
        }
        // Increments and decrements.
        0xe6 | 0xf6 | 0xee | 0xfe | 0xc6 | 0xd6 | 0xce | 0xde => nz(p, c.last_write),
        // Register increments: the sum in flight, not the stale register.
        0xe8 | 0xc8 | 0xca | 0x88 => {
            if let Some(r) = sum_r {
                nz(p, r);
            }
        }
        // BIT: N and V from the operand, Z from the AND.
        0x24 | 0x2c => {
            put(p, N, c.last_read & 0x80 != 0);
            put(p, V, c.last_read & 0x40 != 0);
            put(p, Z, a & c.last_read == 0);
        }
        // LAS: memory & S into A, X and S; NZ from the value in flight.
        0xbb => nz(p, c.last_read & s),
        // Everything else leaves the flags alone: stores, branches, jumps,
        // pushes of A or P, the NOP family. PLP and RTI load P wholesale in
        // the sequencer's read path, not here.
        _ => {}
    }
}
