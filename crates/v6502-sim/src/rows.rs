//! The trace as columnar rows: one packer, used by `halfwave` and the wasm
//! `Machine` alike, so the two ends of the engine cannot disagree about a
//! column.
//!
//! A row is one half-cycle: the observation (`Cpu::observe`), the thirteen
//! internal buses (`Cpu::internals`), the latched fetch and the watched nodes,
//! in the order of [`COLS`]. It is emitted as JSON text, never parsed: this
//! workspace has no JSON dependency and the consumers on both sides already
//! read the object form. Encodings, stated once:
//!
//! - `clk0` and `sync` are 0/1; `phase` is 1 (phi1) or 2 (phi2); `rw` is 0
//!   for read, 1 for write.
//! - `tstates` is a bitmask, bit n for Tn (bit 1 is the T1x/T+ state).
//! - `hidden` is 0 none, 1 T1, 2 VEC0, 3 T6; `store_data` is 0 none, 1 SD1,
//!   2 SD2.
//! - `fetch_addr` and `fetch_opcode` are -1 until the first opcode fetch.
//! - `watch` is a lowercase hex bitset over the watch names, bit i in byte
//!   i/8, LSB first (the convention the state blobs use), fixed width of
//!   ceil(names/8) bytes, and an empty string with no watches. Hex rather
//!   than an integer because a JSON number is a float64 to every browser:
//!   past 53 names an integer mask corrupts silently, found by a consumer
//!   watching 64.
//!
//! The flags string is dropped: it derives from `p`.

use std::fmt::Write as _;

use halfphi::netlist::NodeId;

use crate::bus::Bus;
use crate::cpu::{Cpu, ReadWrite};
use crate::timing::{Hidden, Phase, StoreData};

/// Ceiling on traced half-cycles per call: each row is a response entry, and
/// a caller wanting more shards the run. `halfwave` states it in META; the
/// wasm `Machine` refuses past it. One number, so the two ends agree.
pub const MAX_TRACED: u64 = 10_000;

/// Column names, in row order.
pub const COLS: [&str; 34] = [
    "half_cycle", "cycle", "clk0", "phase", "addr", "data", "rw", "sync",
    "pc", "a", "x", "y", "s", "p", "ir",
    "alu", "alua", "alub", "sb", "idb", "idl", "dor",
    "adl", "adh", "abl", "abh", "pclp", "pchp",
    "tstates", "hidden", "store_data", "fetch_addr", "fetch_opcode", "watch",
];

/// `COLS` as a JSON array literal.
pub fn cols_json() -> String {
    let mut s = String::with_capacity(320);
    s.push('[');
    for (i, c) in COLS.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push('"');
        s.push_str(c);
        s.push('"');
    }
    s.push(']');
    s
}

/// A list of names as a JSON array literal. Names are node names, which the
/// netlist restricts to identifier characters, so no escaping is needed;
/// the one that could contain a quote would have failed to resolve.
pub fn names_json(names: &[String]) -> String {
    let mut s = String::with_capacity(16 * names.len() + 2);
    s.push('[');
    for (i, n) in names.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push('"');
        s.push_str(n);
        s.push('"');
    }
    s.push(']');
    s
}

/// Append one row for the chip's current state as a JSON array literal.
///
/// `watch` is the resolved node of each watch name, in the order the names
/// were given: bit i of the mask is `watch[i]`. Panics if the netlist does
/// not name the internal buses; every netlist that can be a `Cpu` so far
/// does, and a row without them would be a different format.
pub fn push_row<B: Bus>(out: &mut String, cpu: &Cpu<B>, watch: &[NodeId]) {
    let o = cpu.observe();
    let i = cpu
        .internals()
        .expect("rows need the internal buses the netlist names");
    let t = &o.timing;
    let tmask = (t.t0 as u32)
        | (t.t1x as u32) << 1
        | (t.t2 as u32) << 2
        | (t.t3 as u32) << 3
        | (t.t4 as u32) << 4
        | (t.t5 as u32) << 5;
    let hidden = match t.hidden {
        Hidden::None => 0,
        Hidden::T1 => 1,
        Hidden::Vec0 => 2,
        Hidden::T6 => 3,
    };
    let sd = match t.store_data {
        StoreData::None => 0,
        StoreData::Sd1 => 1,
        StoreData::Sd2 => 2,
    };
    let (fa, fo) = match cpu.last_fetch() {
        Some(f) => (f.addr as i32, f.opcode as i32),
        None => (-1, -1),
    };
    let _ = write!(
        out,
        "[{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},\"",
        o.half_cycle,
        o.cycle,
        o.clk0 as u8,
        match o.phase {
            Phase::Phi1 => 1,
            Phase::Phi2 => 2,
        },
        o.bus.addr,
        o.bus.data,
        match o.bus.rw {
            ReadWrite::Read => 0,
            ReadWrite::Write => 1,
        },
        o.bus.sync as u8,
        o.regs.pc,
        o.regs.a,
        o.regs.x,
        o.regs.y,
        o.regs.s,
        o.regs.p,
        o.regs.ir,
        i.alu,
        i.alua,
        i.alub,
        i.sb,
        i.idb,
        i.idl,
        i.dor,
        i.adl,
        i.adh,
        i.abl,
        i.abh,
        i.pclp,
        i.pchp,
        tmask,
        hidden,
        sd,
        fa,
        fo,
    );
    // The watch bitset, one byte per eight names, LSB first.
    for chunk in watch.chunks(8) {
        let mut byte = 0u8;
        for (bit, &n) in chunk.iter().enumerate() {
            if cpu.engine().is_high(n) {
                byte |= 1 << bit;
            }
        }
        let _ = write!(out, "{byte:02x}");
    }
    out.push_str("\"]");
}
