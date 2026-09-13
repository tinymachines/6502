//! The pin contract: one definition of "the same chip at the package pins".
//!
//! Four engines are being built that present the same 6502 externally and
//! differ in how much of the silicon they still simulate (`docs/engine-ladder.md`).
//! Each is verified against the one above it and all of them against this
//! contract. It lives in a crate of its own, with no dependencies and no die
//! data, so the definition cannot drift between engines, and none of them may
//! change it without a note.
//!
//! Everything here is in HALF-CYCLES. `h` is the native unit in every struct,
//! file and table; a "cycle" is derived at the edge for display and nowhere
//! else.
//!
//! What is here besides the frame and the trait: the text format of a `.pins`
//! trace and a `.stim` input script, the driver that runs any engine through
//! a script and collects frames, and the comparison that reports the first
//! differing half-cycle by field. Every rung's replay test is those three
//! calls in a row.

#![forbid(unsafe_code)]

use std::fmt;

/// One half-cycle at the package pins. Everything an external observer can
/// see, and nothing an external observer cannot.
///
/// `h` counts half-cycles since the reset sequence completed, which is how
/// rung 0's `Cpu::half_cycle` counts and how the golden trace against the
/// reference counts: `power_cycle()` runs the eight reset pulses and eighteen
/// half-cycles the reference runs before anyone looks, and the frame it
/// leaves behind is `h = 0`. A frame is the state observed AFTER `h` calls to
/// `half_step`, so a run of `n` steps is `n + 1` frames.
///
/// `db` is the value on D0..D7 at the point the bus is serviced this
/// half-cycle: a read is serviced as `clk0` falls, a write as it rises. That
/// is what rung 0 already does, and an engine with no clock generator has to
/// produce the same byte at the same `h`.
///
/// Not here, deliberately: the internal clock phase (it lags `clk0` through
/// the on-die clock generator and is not visible at the pins) and the
/// registers (the ALU hold-register lag is real silicon; an engine reproduces
/// its externally visible consequences, the write data and the address
/// sequence, not the register).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct PinFrame {
    /// Half-cycles since the reset sequence completed. Never converted.
    pub h: u64,
    /// The input clock, as driven.
    pub clk0: bool,
    /// A0..A15.
    pub ab: u16,
    /// D0..D7, as the chip drives or samples them this half-cycle.
    pub db: u8,
    /// `true` = read.
    pub rw: bool,
    pub sync: bool,
    /// The five input pins, as driven. Active low where the chip says so:
    /// `res`, `irq`, `nmi` are asserted by `false`.
    pub res: bool,
    pub irq: bool,
    pub nmi: bool,
    pub rdy: bool,
    pub so: bool,
}

/// An engine that presents a 6502 at its pins.
pub trait PinEngine {
    /// Cold start: every pull to its layout default, then the reset
    /// sequence, leaving the engine at `h = 0`.
    fn power_cycle(&mut self);
    /// Drive the five input pins. Takes effect on the next `half_step`.
    fn set_inputs(&mut self, res: bool, irq: bool, nmi: bool, rdy: bool, so: bool);
    /// Advance exactly one half-cycle.
    fn half_step(&mut self);
    /// The pins as they stand now.
    fn pins(&self) -> PinFrame;
    /// Half-cycles since `h = 0`. Always equal to `pins().h`.
    fn h(&self) -> u64;
}

/// One line of a `.stim` script: at half-cycle `h`, before the step that
/// leads to `h + 1`, drive the inputs to these levels. Applied in order; a
/// script's `h` values must not decrease.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Stim {
    pub h: u64,
    pub res: bool,
    pub irq: bool,
    pub nmi: bool,
    pub rdy: bool,
    pub so: bool,
}

/// The inputs the reset sequence leaves behind, and what a run holds until a
/// script says otherwise: nothing asserted, `rdy` high, `so` low.
pub const IDLE_INPUTS: (bool, bool, bool, bool, bool) = (true, true, true, true, false);

/// One `# load` line: bytes placed in memory before power-up.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Load {
    pub org: u16,
    pub bytes: Vec<u8>,
}

/// What a `.pins` file says about how it was made: enough to rebuild the
/// machine that produced it without consulting anything else.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Header {
    pub name: String,
    pub loads: Vec<Load>,
    pub reset_vector: u16,
    /// Name of the `.stim` file beside this one, or empty for a free run.
    pub stim: String,
    /// Which engine build recorded it. Free text, one line.
    pub stamp: String,
    /// Steps recorded; the file carries this many + 1 frames.
    pub half_cycles: u64,
}

/// A recorded trace: the header and the frames.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Trace {
    pub header: Header,
    pub frames: Vec<PinFrame>,
}

/// Run `engine` for `steps` half-cycles from a cold start under `stim`,
/// collecting a frame before the first step and after every step.
///
/// This is the whole replay: the same function records the golden from rung
/// 0 and replays it through any other rung, so the two cannot apply a script
/// differently.
pub fn run<E: PinEngine>(engine: &mut E, steps: u64, stim: &[Stim]) -> Vec<PinFrame> {
    engine.power_cycle();
    let (r, i, n, y, s) = IDLE_INPUTS;
    engine.set_inputs(r, i, n, y, s);
    let mut frames = Vec::with_capacity(steps as usize + 1);
    frames.push(engine.pins());
    let mut next = 0usize;
    for h in 0..steps {
        while next < stim.len() && stim[next].h <= h {
            let s = stim[next];
            engine.set_inputs(s.res, s.irq, s.nmi, s.rdy, s.so);
            next += 1;
        }
        engine.half_step();
        frames.push(engine.pins());
    }
    frames
}

/// Where two traces first disagree.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Mismatch {
    pub h: u64,
    pub field: &'static str,
    pub expected: PinFrame,
    pub got: PinFrame,
}

impl fmt::Display for Mismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "h={}: {} differs\n  expected {}\n  got      {}",
            self.h,
            self.field,
            line(&self.expected),
            line(&self.got)
        )
    }
}

/// The first field that differs between two frames, in the order they are
/// written, or `None` if they are equal.
pub fn first_difference(a: &PinFrame, b: &PinFrame) -> Option<&'static str> {
    if a.h != b.h {
        return Some("h");
    }
    if a.clk0 != b.clk0 {
        return Some("clk0");
    }
    if a.ab != b.ab {
        return Some("ab");
    }
    if a.db != b.db {
        return Some("db");
    }
    if a.rw != b.rw {
        return Some("rw");
    }
    if a.sync != b.sync {
        return Some("sync");
    }
    if a.res != b.res {
        return Some("res");
    }
    if a.irq != b.irq {
        return Some("irq");
    }
    if a.nmi != b.nmi {
        return Some("nmi");
    }
    if a.rdy != b.rdy {
        return Some("rdy");
    }
    if a.so != b.so {
        return Some("so");
    }
    None
}

/// Compare two traces frame by frame. A length difference is reported as a
/// mismatch at the first `h` one of them lacks, so a trace that is merely
/// short cannot pass against a prefix of itself.
pub fn compare(expected: &[PinFrame], got: &[PinFrame]) -> Result<(), Mismatch> {
    for (i, (e, g)) in expected.iter().zip(got).enumerate() {
        if let Some(field) = first_difference(e, g) {
            return Err(Mismatch { h: i as u64, field, expected: *e, got: *g });
        }
    }
    if expected.len() != got.len() {
        let h = expected.len().min(got.len()) as u64;
        return Err(Mismatch {
            h,
            field: "length",
            expected: expected.get(h as usize).copied().unwrap_or(PinFrame { h, ..PinFrame::default() }),
            got: got.get(h as usize).copied().unwrap_or(PinFrame { h, ..PinFrame::default() }),
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Text format. Hex text rather than binary so `diff` on two files is readable.
//
//   # pins 1
//   # name Fibonacci
//   # load 0200 a90085f0...
//   # reset_vector 0200
//   # stim irq-lost.stim          (absent for a free run)
//   # stamp v6502-sim 0.1.0 nodes 1725 transistors 3510
//   # half_cycles 3000
//   h clk0 ab db rw sync inputs
//   0 0 fffc 00 1 0 11110
//
// `inputs` is res irq nmi rdy so as five 0/1 characters, in that order.
// ---------------------------------------------------------------------------

const BIT: [char; 2] = ['0', '1'];

fn bits(f: &PinFrame) -> String {
    [f.res, f.irq, f.nmi, f.rdy, f.so].iter().map(|&b| BIT[b as usize]).collect()
}

/// One frame as one line, without the newline.
pub fn line(f: &PinFrame) -> String {
    format!(
        "{} {} {:04x} {:02x} {} {} {}",
        f.h,
        BIT[f.clk0 as usize],
        f.ab,
        f.db,
        BIT[f.rw as usize],
        BIT[f.sync as usize],
        bits(f)
    )
}

fn parse_bit(s: &str, what: &str) -> Result<bool, String> {
    match s {
        "0" => Ok(false),
        "1" => Ok(true),
        _ => Err(format!("{what}: expected 0 or 1, got {s:?}")),
    }
}

fn parse_inputs(s: &str) -> Result<[bool; 5], String> {
    let c: Vec<char> = s.chars().collect();
    if c.len() != 5 {
        return Err(format!("inputs: expected five 0/1 characters, got {s:?}"));
    }
    let mut out = [false; 5];
    for (i, ch) in c.iter().enumerate() {
        out[i] = match ch {
            '0' => false,
            '1' => true,
            _ => return Err(format!("inputs: expected 0 or 1, got {ch:?} in {s:?}")),
        };
    }
    Ok(out)
}

/// The inverse of [`line`].
pub fn parse_line(s: &str) -> Result<PinFrame, String> {
    let f: Vec<&str> = s.split_whitespace().collect();
    if f.len() != 7 {
        return Err(format!("expected 7 fields, got {}: {s:?}", f.len()));
    }
    let hex = |t: &str, w: &str| u32::from_str_radix(t, 16).map_err(|e| format!("{w}: {e}"));
    let [res, irq, nmi, rdy, so] = parse_inputs(f[6])?;
    Ok(PinFrame {
        h: f[0].parse().map_err(|e| format!("h: {e}"))?,
        clk0: parse_bit(f[1], "clk0")?,
        ab: hex(f[2], "ab")? as u16,
        db: hex(f[3], "db")? as u8,
        rw: parse_bit(f[4], "rw")?,
        sync: parse_bit(f[5], "sync")?,
        res,
        irq,
        nmi,
        rdy,
        so,
    })
}

fn hex_bytes(s: &str) -> Result<Vec<u8>, String> {
    if !s.len().is_multiple_of(2) {
        return Err(format!("odd-length hex: {s:?}"));
    }
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

/// A whole `.pins` file.
pub fn write_trace(t: &Trace) -> String {
    let mut out = String::new();
    out.push_str("# pins 1\n");
    out.push_str(&format!("# name {}\n", t.header.name));
    for l in &t.header.loads {
        out.push_str(&format!("# load {:04x} ", l.org));
        for b in &l.bytes {
            out.push_str(&format!("{b:02x}"));
        }
        out.push('\n');
    }
    out.push_str(&format!("# reset_vector {:04x}\n", t.header.reset_vector));
    if !t.header.stim.is_empty() {
        out.push_str(&format!("# stim {}\n", t.header.stim));
    }
    out.push_str(&format!("# stamp {}\n", t.header.stamp));
    out.push_str(&format!("# half_cycles {}\n", t.header.half_cycles));
    out.push_str("# h clk0 ab db rw sync inputs(res irq nmi rdy so)\n");
    for f in &t.frames {
        out.push_str(&line(f));
        out.push('\n');
    }
    out
}

/// The inverse of [`write_trace`]. Checks the frame count against the header
/// and that `h` runs 0, 1, 2, ... so a truncated or spliced file is refused.
pub fn parse_trace(text: &str) -> Result<Trace, String> {
    let mut t = Trace::default();
    let mut version = None;
    let mut have_count = false;
    for (n, raw) in text.lines().enumerate() {
        let lineno = n + 1;
        if let Some(rest) = raw.strip_prefix("# ") {
            let mut it = rest.splitn(2, ' ');
            let key = it.next().unwrap_or("");
            let val = it.next().unwrap_or("").trim();
            match key {
                "pins" => version = Some(val.to_string()),
                "name" => t.header.name = val.to_string(),
                "load" => {
                    let mut p = val.split_whitespace();
                    let org = p.next().ok_or(format!("line {lineno}: load without org"))?;
                    let bytes = p.next().unwrap_or("");
                    t.header.loads.push(Load {
                        org: u16::from_str_radix(org, 16).map_err(|e| format!("line {lineno}: {e}"))?,
                        bytes: hex_bytes(bytes).map_err(|e| format!("line {lineno}: {e}"))?,
                    });
                }
                "reset_vector" => {
                    t.header.reset_vector =
                        u16::from_str_radix(val, 16).map_err(|e| format!("line {lineno}: {e}"))?
                }
                "stim" => t.header.stim = val.to_string(),
                "stamp" => t.header.stamp = val.to_string(),
                "half_cycles" => {
                    t.header.half_cycles = val.parse().map_err(|e| format!("line {lineno}: {e}"))?;
                    have_count = true;
                }
                _ => {} // the column heading, or a comment
            }
            continue;
        }
        if raw.trim().is_empty() {
            continue;
        }
        let f = parse_line(raw).map_err(|e| format!("line {lineno}: {e}"))?;
        if f.h != t.frames.len() as u64 {
            return Err(format!("line {lineno}: h={} where {} was expected", f.h, t.frames.len()));
        }
        t.frames.push(f);
    }
    match version.as_deref() {
        Some("1") => {}
        Some(v) => return Err(format!("unknown pins format version {v:?}")),
        None => return Err("not a .pins file (no '# pins 1' line)".into()),
    }
    if !have_count {
        return Err("no '# half_cycles' line".into());
    }
    if t.frames.len() as u64 != t.header.half_cycles + 1 {
        return Err(format!(
            "header says {} half-cycles ({} frames), file has {}",
            t.header.half_cycles,
            t.header.half_cycles + 1,
            t.frames.len()
        ));
    }
    Ok(t)
}

/// A whole `.stim` file:
///
///   # stim 1
///   # h inputs(res irq nmi rdy so)
///   52 10110
pub fn write_stim(name: &str, stim: &[Stim]) -> String {
    let mut out = format!("# stim 1\n# name {name}\n# h inputs(res irq nmi rdy so)\n");
    for s in stim {
        let b: String =
            [s.res, s.irq, s.nmi, s.rdy, s.so].iter().map(|&x| BIT[x as usize]).collect();
        out.push_str(&format!("{} {}\n", s.h, b));
    }
    out
}

/// The inverse of [`write_stim`]. Refuses an `h` that goes backwards.
pub fn parse_stim(text: &str) -> Result<Vec<Stim>, String> {
    let mut out: Vec<Stim> = Vec::new();
    let mut versioned = false;
    for (n, raw) in text.lines().enumerate() {
        let lineno = n + 1;
        if let Some(rest) = raw.strip_prefix("# ") {
            if rest.trim() == "stim 1" {
                versioned = true;
            }
            continue;
        }
        if raw.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = raw.split_whitespace().collect();
        if f.len() != 2 {
            return Err(format!("line {lineno}: expected 'h inputs', got {raw:?}"));
        }
        let h: u64 = f[0].parse().map_err(|e| format!("line {lineno}: h: {e}"))?;
        if let Some(last) = out.last() {
            if h < last.h {
                return Err(format!("line {lineno}: h={h} after h={}", last.h));
            }
        }
        let [res, irq, nmi, rdy, so] = parse_inputs(f[1]).map_err(|e| format!("line {lineno}: {e}"))?;
        out.push(Stim { h, res, irq, nmi, rdy, so });
    }
    if !versioned {
        return Err("not a .stim file (no '# stim 1' line)".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(h: u64) -> PinFrame {
        PinFrame { h, clk0: h % 2 == 1, ab: 0x1234 ^ h as u16, db: h as u8, rw: true, sync: h.is_multiple_of(6),
                   res: true, irq: true, nmi: true, rdy: true, so: false }
    }

    #[test]
    fn a_frame_survives_the_text_form() {
        for h in 0..40 {
            let f = frame(h);
            assert_eq!(parse_line(&line(&f)).unwrap(), f, "h={h}");
        }
        let mut f = frame(3);
        f.rw = false;
        f.res = false;
        f.so = true;
        assert_eq!(parse_line(&line(&f)).unwrap(), f);
    }

    #[test]
    fn a_trace_survives_the_text_form_and_a_truncated_one_is_refused() {
        let t = Trace {
            header: Header {
                name: "t".into(),
                loads: vec![Load { org: 0x200, bytes: vec![0xa9, 0x41] }, Load { org: 0xfffe, bytes: vec![0, 3] }],
                reset_vector: 0x200,
                stim: "x.stim".into(),
                stamp: "test".into(),
                half_cycles: 5,
            },
            frames: (0..6).map(frame).collect(),
        };
        let text = write_trace(&t);
        assert_eq!(parse_trace(&text).unwrap(), t);
        let short: String = text.lines().take(text.lines().count() - 1).map(|l| format!("{l}\n")).collect();
        assert!(parse_trace(&short).unwrap_err().contains("header says 5"));
    }

    #[test]
    fn a_stim_survives_the_text_form_and_cannot_go_backwards() {
        let s = vec![
            Stim { h: 3, res: true, irq: false, nmi: true, rdy: true, so: false },
            Stim { h: 9, res: true, irq: true, nmi: true, rdy: true, so: false },
        ];
        assert_eq!(parse_stim(&write_stim("n", &s)).unwrap(), s);
        assert!(parse_stim("# stim 1\n9 11110\n3 10110\n").is_err());
        assert!(parse_stim("3 10110\n").is_err(), "no version line");
    }

    #[test]
    fn compare_names_the_field_and_refuses_a_short_trace() {
        let a: Vec<PinFrame> = (0..10).map(frame).collect();
        assert_eq!(compare(&a, &a), Ok(()));
        let mut b = a.clone();
        b[7].db ^= 1;
        let m = compare(&a, &b).unwrap_err();
        assert_eq!((m.h, m.field), (7, "db"));
        let m = compare(&a, &a[..6]).unwrap_err();
        assert_eq!((m.h, m.field), (6, "length"));
        let m = compare(&a[..6], &a).unwrap_err();
        assert_eq!((m.h, m.field), (6, "length"));
    }

    /// A fake engine, to pin down what `run` does with a script: the inputs
    /// set at `h` are visible in the frame at `h + 1`, and a script entry is
    /// applied exactly once.
    struct Echo {
        h: u64,
        inputs: (bool, bool, bool, bool, bool),
        applied: usize,
    }
    impl PinEngine for Echo {
        fn power_cycle(&mut self) {
            self.h = 0;
        }
        fn set_inputs(&mut self, res: bool, irq: bool, nmi: bool, rdy: bool, so: bool) {
            self.inputs = (res, irq, nmi, rdy, so);
            self.applied += 1;
        }
        fn half_step(&mut self) {
            self.h += 1;
        }
        fn pins(&self) -> PinFrame {
            let (res, irq, nmi, rdy, so) = self.inputs;
            PinFrame { h: self.h, res, irq, nmi, rdy, so, ..PinFrame::default() }
        }
        fn h(&self) -> u64 {
            self.h
        }
    }

    #[test]
    fn run_applies_a_script_at_the_half_cycle_it_names() {
        let mut e = Echo { h: 99, inputs: (false, false, false, false, true), applied: 0 };
        let stim = [
            Stim { h: 4, res: true, irq: false, nmi: true, rdy: true, so: false },
            Stim { h: 4, res: true, irq: false, nmi: false, rdy: true, so: false },
            Stim { h: 6, res: true, irq: true, nmi: true, rdy: true, so: false },
        ];
        let f = run(&mut e, 8, &stim);
        assert_eq!(f.len(), 9);
        assert_eq!(f[0].h, 0);
        assert_eq!(e.applied, 1 + 3, "idle inputs once, then each script line once");
        assert!(f[4].irq, "the entry at h=4 is not visible in the frame at h=4");
        assert!(!f[5].irq && !f[5].nmi, "both h=4 entries applied, last wins");
        assert!(f[7].irq && f[7].nmi);
    }
}

// ---------------------------------------------------------------------------
// A window: a piece of a record with the machine standing at its first
// half-cycle, so a run can be resumed at any point without the record's
// whole length or the reset sequence. Text, like everything here, and one
// format for the service, the wasm machine and the pages:
//
//   # window 1
//   # name <name>
//   # record <the record's stamp>
//   # origin <h of the first frame>
//   # state <value> <pullup> <pulldown> <trans_on> <half_cycle> <fetch|->
//   # fill <hex2>
//   # page <hex2> <512 hex>            (repeatable: the shadow's pages that
//                                        differ from the fill)
//   # stim <h> <inputs>                (repeatable: the inputs in force from
//                                        the step after h, first at origin)
//   # h clk0 ab db rw sync inputs(res irq nmi rdy so)
//   <origin> ...                       (one frame line per half-cycle)
//
// The state line is the engine's own machine value in its own words (the
// hex planes are opaque here: this crate has no chip), the way `halfwave`'s
// `STATE` line carries it, and `half_cycle` must equal `origin`. The shadow
// is what the run had written by then plus the header's loads: never what
// answers a read, which is the record's business, but what an overlay of
// memory shows.

/// The machine value at a window's first half-cycle, as text.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct WindowState {
    pub value: String,
    pub pullup: String,
    pub pulldown: String,
    pub trans_on: String,
    pub half_cycle: u64,
    /// The last opcode fetch, (address, opcode), if any.
    pub fetch: Option<(u16, u8)>,
}

#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Window {
    pub name: String,
    pub record: String,
    pub origin: u64,
    pub state: WindowState,
    pub fill: u8,
    pub pages: Vec<(u8, Vec<u8>)>,
    pub stim: Vec<Stim>,
    pub frames: Vec<PinFrame>,
}

pub fn write_window(w: &Window) -> String {
    let mut out = String::new();
    out.push_str("# window 1\n");
    out.push_str(&format!("# name {}\n", w.name));
    out.push_str(&format!("# record {}\n", w.record));
    out.push_str(&format!("# origin {}\n", w.origin));
    let fetch = match w.state.fetch {
        Some((a, o)) => format!("{a:04x}{o:02x}"),
        None => "-".into(),
    };
    out.push_str(&format!(
        "# state {} {} {} {} {} {fetch}\n",
        w.state.value, w.state.pullup, w.state.pulldown, w.state.trans_on, w.state.half_cycle
    ));
    out.push_str(&format!("# fill {:02x}\n", w.fill));
    for (id, bytes) in &w.pages {
        out.push_str(&format!("# page {id:02x} "));
        for b in bytes {
            out.push_str(&format!("{b:02x}"));
        }
        out.push('\n');
    }
    for s in &w.stim {
        let b: String = [s.res, s.irq, s.nmi, s.rdy, s.so].iter().map(|&x| BIT[x as usize]).collect();
        out.push_str(&format!("# stim {} {}\n", s.h, b));
    }
    out.push_str("# h clk0 ab db rw sync inputs(res irq nmi rdy so)\n");
    for f in &w.frames {
        out.push_str(&line(f));
        out.push('\n');
    }
    out
}

pub fn parse_window(text: &str) -> Result<Window, String> {
    let mut w = Window::default();
    let mut versioned = false;
    let mut have_state = false;
    for (n, raw) in text.lines().enumerate() {
        let lineno = n + 1;
        if let Some(rest) = raw.strip_prefix("# ") {
            let rest = rest.trim();
            if rest == "window 1" {
                versioned = true;
                continue;
            }
            let (key, val) = rest.split_once(' ').unwrap_or((rest, ""));
            match key {
                "name" => w.name = val.to_string(),
                "record" => w.record = val.to_string(),
                "origin" => w.origin = val.parse().map_err(|_| format!("line {lineno}: origin"))?,
                "state" => {
                    let f: Vec<&str> = val.split_whitespace().collect();
                    if f.len() != 6 {
                        return Err(format!("line {lineno}: a state line has six fields, this one {}", f.len()));
                    }
                    for (i, x) in f[..4].iter().enumerate() {
                        if x.is_empty() || !x.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) {
                            return Err(format!("line {lineno}: state field {i} is not lowercase hex"));
                        }
                    }
                    let fetch = if f[5] == "-" {
                        None
                    } else if f[5].len() == 6 {
                        Some((
                            u16::from_str_radix(&f[5][..4], 16).map_err(|_| format!("line {lineno}: fetch"))?,
                            u8::from_str_radix(&f[5][4..], 16).map_err(|_| format!("line {lineno}: fetch"))?,
                        ))
                    } else {
                        return Err(format!("line {lineno}: fetch is '-' or six hex digits"));
                    };
                    w.state = WindowState {
                        value: f[0].into(),
                        pullup: f[1].into(),
                        pulldown: f[2].into(),
                        trans_on: f[3].into(),
                        half_cycle: f[4].parse().map_err(|_| format!("line {lineno}: state half_cycle"))?,
                        fetch,
                    };
                    have_state = true;
                }
                "fill" => w.fill = u8::from_str_radix(val.trim(), 16).map_err(|_| format!("line {lineno}: fill"))?,
                "page" => {
                    let (id, hex) = val.split_once(' ').ok_or(format!("line {lineno}: page needs an id and bytes"))?;
                    let id = u8::from_str_radix(id, 16).map_err(|_| format!("line {lineno}: page id"))?;
                    let hex = hex.trim();
                    if hex.len() != 512 {
                        return Err(format!("line {lineno}: a page is 512 hex digits, this one {}", hex.len()));
                    }
                    let bytes: Result<Vec<u8>, _> = (0..256).map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16)).collect();
                    w.pages.push((id, bytes.map_err(|_| format!("line {lineno}: page bytes"))?));
                }
                "stim" => {
                    let (h, bits) = val.split_once(' ').ok_or(format!("line {lineno}: stim needs h and inputs"))?;
                    let bits = bits.trim();
                    if bits.len() != 5 || !bits.chars().all(|c| c == '0' || c == '1') {
                        return Err(format!("line {lineno}: inputs are five bits"));
                    }
                    let b: Vec<bool> = bits.chars().map(|c| c == '1').collect();
                    w.stim.push(Stim {
                        h: h.parse().map_err(|_| format!("line {lineno}: stim h"))?,
                        res: b[0],
                        irq: b[1],
                        nmi: b[2],
                        rdy: b[3],
                        so: b[4],
                    });
                }
                _ => {} // the column heading, and anything a later version adds
            }
            continue;
        }
        if raw.trim().is_empty() {
            continue;
        }
        let f = parse_line(raw).map_err(|e| format!("line {lineno}: {e}"))?;
        let expected = w.origin + w.frames.len() as u64;
        if f.h != expected {
            return Err(format!("line {lineno}: h={} where {expected} was expected", f.h));
        }
        w.frames.push(f);
    }
    if !versioned {
        return Err("not a .window file (no '# window 1' line)".into());
    }
    if !have_state {
        return Err("no '# state' line".into());
    }
    if w.state.half_cycle != w.origin {
        return Err(format!("the state stands at {} and the window starts at {}", w.state.half_cycle, w.origin));
    }
    if w.frames.is_empty() {
        return Err("a window with no frames".into());
    }
    Ok(w)
}
