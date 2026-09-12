//! A bus that is a recording: rung 0 runs another machine's program.
//!
//! The NES console records its CPU at the pins every half-cycle (the bench's
//! trace plan, T0) in this crate's own `.pins` format. That record carries
//! every byte the program fetched, so it is a memory image of a kind: not
//! by address but by half-cycle. `RecordedBus` answers each read with the
//! byte the record shows at the half-cycle being stepped into, and holds
//! each write to the write the record shows there. Rung 0, the switch-level
//! chip, then runs the console's program from reset with no ROM in the room,
//! and its pins are compared with the console's frame for frame: the die
//! against the 2A03's fast rung, on a commercial cartridge no test was
//! written for.
//!
//! Two rules, decided in the plan and kept here:
//!
//! - **The bus refuses, never fills in.** A read at an address the record
//!   does not show, or a write the record does not carry, is a refusal with
//!   the half-cycle, the address and the frame, and the run stops there.
//!   Answering from a shadow would make a plausible run out of a wrong one.
//! - **Half-cycles are never converted.** `at` is the record's own `h`, the
//!   frame the coming half-step produces: a read is serviced as `clk0` falls
//!   and lands in that frame's `db`; a write as it rises, likewise.
//!
//! One exception to the address rule, measured on the record: while RDY is
//! driven low the bus belongs to the 2A03's sprite DMA, the record shows the
//! DMA's addresses, and a 6502 held mid-read samples whatever is on the data
//! lines at every held phi2 (rung 3's rule, measured from rung 0). The held
//! chip's address is not the DMA's, so under RDY low the bus answers the
//! record's byte without asking the address. The comparison skips the
//! address, direction and sync there for the same reason: a bare 6502 has
//! no DMA unit, and what it can be held to is the byte it sampled.
//!
//! Before `h = 0` (the reset sequence) the record has one thing to say: its
//! frame 0 is the fetch the reset leaves behind, so a read at that address
//! gets that byte; every other reset read comes from a shadow holding the
//! header's loads and the reset vector, exactly as `rung0`'s flat memory
//! would. Every write the chip makes also
//! lands in the shadow, so a page of RAM can be read out afterwards (T2's
//! overlays), but nothing is ever answered from it after `h = 0`.
use crate::bus::Bus;
use v6502_pins::{Load, PinFrame};

/// Why the bus stopped answering, with everything needed to name the
/// instruction that was executing (the record's last `sync` before `h`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    /// The half-cycle whose service was refused.
    pub h: u64,
    pub what: &'static str,
    /// What the chip asked for.
    pub addr: u16,
    /// The byte the chip wrote (a write), or the byte handed back (a read).
    pub value: u8,
    /// The record's frame at `h`, or the default frame past the end.
    pub frame: PinFrame,
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "h={}: {} (chip at {:04x} value {:02x}; the record shows {})",
            self.h,
            self.what,
            self.addr,
            self.value,
            v6502_pins::line(&self.frame)
        )
    }
}

pub struct RecordedBus {
    frames: Vec<PinFrame>,
    shadow: Vec<u8>,
    /// The frame the coming half-step produces (the record's `h`), or
    /// `None` before the run starts, when the reset sequence reads the
    /// shadow. The driver sets it before every `half_step`.
    pub at: Option<u64>,
    /// The first refusal, if any. Once set, nothing later is checked; the
    /// driver is expected to stop.
    pub refusal: Option<Refusal>,
    pub reads: u64,
    pub writes: u64,
    /// Reads answered under RDY low without an address check.
    pub held_reads: u64,
}

impl RecordedBus {
    pub fn new(frames: Vec<PinFrame>, loads: &[Load], reset_vector: u16) -> RecordedBus {
        let mut shadow = vec![0u8; 0x1_0000];
        for l in loads {
            let end = (l.org as usize + l.bytes.len()).min(shadow.len());
            shadow[l.org as usize..end].copy_from_slice(&l.bytes[..end - l.org as usize]);
        }
        shadow[0xfffc] = reset_vector as u8;
        shadow[0xfffd] = (reset_vector >> 8) as u8;
        RecordedBus { frames, shadow, at: None, refusal: None, reads: 0, writes: 0, held_reads: 0 }
    }

    pub fn frames(&self) -> &[PinFrame] {
        &self.frames
    }

    /// The shadow: the loads, the reset vector, and every write the chip
    /// made. Never answered from after `h = 0`.
    pub fn shadow(&self) -> &[u8] {
        &self.shadow
    }

    fn refuse(&mut self, h: u64, what: &'static str, addr: u16, value: u8) {
        if self.refusal.is_none() {
            let frame = self.frames.get(h as usize).copied().unwrap_or(PinFrame { h, ..PinFrame::default() });
            self.refusal = Some(Refusal { h, what, addr, value, frame });
        }
    }
}

impl Bus for RecordedBus {
    fn read(&mut self, addr: u16) -> u8 {
        let Some(h) = self.at else {
            // The reset sequence: the shadow answers, except that the
            // record's frame 0 IS the reset sequence's last read (the
            // opcode fetch it leaves behind), so that address gets the
            // record's byte and the run starts on the program's first
            // opcode rather than the shadow's.
            return match self.frames.first() {
                Some(f) if f.rw && f.ab == addr => f.db,
                _ => self.shadow[addr as usize],
            };
        };
        self.reads += 1;
        let Some(f) = self.frames.get(h as usize).copied() else {
            self.refuse(h, "a read past the end of the record", addr, 0xff);
            return 0xff;
        };
        if !f.rdy {
            // The DMA's bus: the held chip samples what is there.
            self.held_reads += 1;
            return f.db;
        }
        if !f.rw {
            self.refuse(h, "a read where the record shows a write", addr, f.db);
        } else if f.ab != addr {
            self.refuse(h, "a read at an address the record does not show", addr, f.db);
        }
        f.db
    }

    fn write(&mut self, addr: u16, value: u8) {
        self.shadow[addr as usize] = value;
        let Some(h) = self.at else {
            return;
        };
        self.writes += 1;
        let Some(f) = self.frames.get(h as usize).copied() else {
            self.refuse(h, "a write past the end of the record", addr, value);
            return;
        };
        if f.rw {
            self.refuse(h, "a write where the record shows a read", addr, value);
        } else if f.ab != addr {
            self.refuse(h, "a write at an address the record does not show", addr, value);
        } else if f.db != value {
            self.refuse(h, "a write of a byte the record does not carry", addr, value);
        }
    }
}

/// Where a replay under a record first differs from it, by the rule above:
/// every field where RDY is high; under RDY low only the byte and the
/// inputs. `None` if the frames agree.
pub fn first_difference_under_record(e: &PinFrame, g: &PinFrame) -> Option<&'static str> {
    if e.rdy {
        return v6502_pins::first_difference(e, g);
    }
    if e.h != g.h {
        return Some("h");
    }
    if e.clk0 != g.clk0 {
        return Some("clk0");
    }
    if e.db != g.db {
        return Some("db");
    }
    if e.res != g.res {
        return Some("res");
    }
    if e.irq != g.irq {
        return Some("irq");
    }
    if e.nmi != g.nmi {
        return Some("nmi");
    }
    if e.rdy != g.rdy {
        return Some("rdy");
    }
    if e.so != g.so {
        return Some("so");
    }
    None
}

/// The instruction executing at `h` in a record: the address and opcode of
/// the last opcode fetch (`sync` on the `clk0`-low frame) at or before `h`.
pub fn instruction_at(frames: &[PinFrame], h: u64) -> Option<(u16, u8)> {
    frames[..=(h as usize).min(frames.len().saturating_sub(1))]
        .iter()
        .rev()
        .find(|f| f.sync && !f.clk0)
        .map(|f| (f.ab, f.db))
}
