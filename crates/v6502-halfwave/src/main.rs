//! 6502 as a service: the engine end of it.
//!
//!     cargo run --release -p v6502-halfwave --bin halfwave
//!
//! (A crate of its own since M5: every other rung depends on `v6502-sim`,
//! so a binary that can answer as more than rung 0 sits above them. The
//! built artifact keeps its path, `target/release/halfwave`.)
//!
//! A warm, resident, STATELESS chip. The netlist is parsed once at startup and
//! one machine is kept constructed; every request carries the entire state in
//! (four hex bitsets, a half-cycle count, the memory image) and the response
//! carries the entire state back out. Nothing survives between requests, which
//! is what lets any number of these sit behind a load balancer and lets a
//! session live in the client's hands. `tests/state.rs` proves the round trip
//! bit-exact over every node at every half-cycle.
//!
//! The wire protocol is deliberately not JSON on the way IN: this workspace
//! has no dependencies, and a hand-written JSON parser would be a second thing
//! that can be wrong about strings. Requests are lines -- a verb, hex blobs,
//! whitespace -- parsed with `split_whitespace` and `from_str_radix`, which
//! have nothing in them to get wrong. Responses are one hand-written JSON line
//! each, the same emission style as every export binary.
//!
//! Request: one block of lines, terminated by `GO`.
//!
//!     META                        ask who I am (counts, limits, encoding, version, commit)
//!     NODES                       every named node, name to id
//!     BOOT                        power-cycle into the supplied memory
//!     VEC <hex4>                  (with BOOT) write the reset vector first
//!     STEP <n>                    advance n half-cycles from STATE
//!     RUN <max>                   advance to the next opcode fetch, capped
//!     RUNTO <max> <hex4>          advance to the opcode fetch AT an address
//!     ENGINE <rung>               which rung answers: 0 (default) or 3
//!     STATE <value> <pullup> <pulldown> <trans_on> <half_cycle> <fetch|->
//!     MICRO <hex>                 rung 3's own machine value (with ENGINE 3)
//!     FILL <hex2>                 memory background byte (default 00)
//!     PAGE <hex2> <512 hex>       one 256-byte page over the fill
//!     WATCH <name> [name...]     node names to read out (repeatable)
//!     PIN <name> <0|1>            drive an input pin (res irq nmi rdy so)
//!     WINDOW <name>               stand in a window of a record instead of memory:
//!                                 windows/<name>.window (HALFWAVE_WINDOWS names the
//!                                 directory), v6502_pins' text; STATE optional
//!     TRACE                       record an observation per half-cycle
//!     ROWS                        ...as columnar rows (v6502_sim::rows), implies TRACE
//!     GO
//!
//! Exactly one verb (META | NODES | BOOT | STEP | RUN | RUNTO) per block. The response is one
//! JSON object: `{"ok":true, "state":..., "memory":..., "observe":...}` or
//! `{"ok":false, "error":"..."}`. A malformed block gets an error, never a
//! guess, and never kills the process.
//!
//! `ENGINE` (M5 of the engine ladder) picks which rung answers the block:
//! 0 is rung 0, the switch-level solver, exactly as before the word
//! existed; 3 is rung 3 (`v6502-micro`), the measured control table, held
//! to the whole pin golden and about 1,400x quicker. Rung 3's machine
//! value is ITS OWN (`MICRO`, the versioned byte codec, about 90 bytes as
//! hex; the response's `state` carries it as `micro`) and does not
//! pretend to be the four node planes: `STATE` under `ENGINE 3` and
//! `MICRO` under `ENGINE 0` are both refused by name, which is the same
//! line the console's worker draws. Rungs 1 and 2 are refused by name
//! too: rung 1 is bit-exact with rung 0 and no faster, so rung 0 answers
//! for it, and rung 2 is a 64-lane throughput engine where one machine
//! would pay for the whole word. `WATCH` under rung 3 resolves the 51
//! control-vector columns (`v6502-micro`'s `lines.rs`) instead of die
//! nodes, and `TRACE`/`ROWS` are refused there: the columnar rows are
//! rung 0's node encoding, and this rung has no nodes to fill them with.
//! Its observation carries what the rung genuinely has (pins, registers,
//! the datapath latches) and omits the timing-chain fields rather than
//! faking them.
//!
//! `WINDOW` (the NES bench's trace plan, T2) runs rung 0 inside a window of
//! another machine's recorded run (`v6502_sim::recorded`): the chip is
//! restored to the window's own machine value (or to a STATE line saved
//! from an earlier step in the same window), every read is answered by
//! the record and every write held to it, the window's stimulus is applied
//! by half-cycle before each step, and PIN lines override it for the first
//! step. The record is the memory, so FILL and PAGE are refused with it;
//! the reply's `memory` is the window's shadow (what the run wrote, never
//! what answered a read), and a `window` object carries where the chip
//! stands, the first field where its pins differ from the record there,
//! and the bus's refusal if it asked for what the record does not show.
//! Never BOOTed: a window is stood in, not reset into.

use std::fmt::Write as _;
use std::io::{BufRead, Write};
use std::sync::Arc;

use v6502_netlist::{mos6502, NodeId};
use v6502_sim::bus::{Bus, FlatMemory};
use v6502_sim::cpu::{Cpu, Fetch, ReadWrite};
use v6502_sim::rows;
use v6502_sim::state::{restore, snapshot, MachineState};
use v6502_sim::timing::{Hidden, Phase, StoreData};

/// Hard ceiling on half-cycles per request, so a request cannot wedge the
/// worker. Stated in META so clients can shard long runs.
const MAX_STEP: u64 = 200_000;
/// Ceiling when TRACE is on: each traced half-cycle is a response line entry.
/// Shared with the wasm Machine's `traceRows`, so the two ends agree.
const MAX_TRACED: u64 = rows::MAX_TRACED;

struct Request {
    verb: Option<String>,
    arg: Option<u64>,
    target: Option<u16>,
    vec: Option<u16>,
    pins: Vec<(String, bool)>,
    state: Option<[String; 6]>,
    /// Rung 3's own machine value, hex (with `ENGINE 3`).
    micro: Option<String>,
    /// Which rung answers this block: 0 (default) or 3.
    engine: u8,
    /// A window of a record to stand in (`WINDOW <name>`): the file
    /// `<name>.window` under `HALFWAVE_WINDOWS` (default `windows`). The
    /// record is the memory; FILL and PAGE are refused with it.
    window: Option<String>,
    fill: u8,
    pages: Vec<(u8, Vec<u8>)>,
    watch: Vec<String>,
    trace: bool,
    rows: bool,
}

impl Request {
    fn empty() -> Self {
        Request {
            verb: None,
            arg: None,
            target: None,
            vec: None,
            pins: Vec::new(),
            state: None,
            micro: None,
            engine: 0,
            window: None,
            fill: 0,
            pages: Vec::new(),
            watch: Vec::new(),
            trace: false,
            rows: false,
        }
    }
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out
}

fn hex_bytes(s: &str) -> Result<Vec<u8>, String> {
    if !s.len().is_multiple_of(2) {
        return Err(format!("odd hex length {}", s.len()));
    }
    (0..s.len() / 2)
        .map(|i| {
            u8::from_str_radix(&s[i * 2..i * 2 + 2], 16)
                .map_err(|_| format!("bad hex byte at {}", i * 2))
        })
        .collect()
}

/// One observation as flat JSON: the architectural and microarchitectural
/// state a learner reads off the running chip, plus any watched nodes.
fn obs_json<B: Bus>(cpu: &Cpu<B>, watch: &[(String, NodeId)]) -> String {
    let o = cpu.observe();
    let mut s = String::with_capacity(320);
    let _ = write!(
        s,
        "{{\"half_cycle\":{},\"cycle\":{},\"clk0\":{},\"phase\":\"{}\",\
         \"addr\":{},\"data\":{},\"rw\":\"{}\",\"sync\":{},\
         \"pc\":{},\"a\":{},\"x\":{},\"y\":{},\"s\":{},\"p\":{},\"ir\":{},\"flags\":\"{}\",\
         \"tstates\":\"{}\",\"hidden\":\"{}\",\"store_data\":\"{}\"",
        o.half_cycle,
        o.cycle,
        o.clk0,
        match o.phase {
            Phase::Phi1 => "phi1",
            Phase::Phi2 => "phi2",
        },
        o.bus.addr,
        o.bus.data,
        match o.bus.rw {
            ReadWrite::Read => "read",
            ReadWrite::Write => "write",
        },
        o.bus.sync,
        o.regs.pc,
        o.regs.a,
        o.regs.x,
        o.regs.y,
        o.regs.s,
        o.regs.p,
        o.regs.ir,
        o.regs.flags_string(),
        o.timing.active(),
        match o.timing.hidden {
            Hidden::T1 => "T1",
            Hidden::Vec0 => "VEC0",
            Hidden::T6 => "T6",
            Hidden::None => "",
        },
        match o.timing.store_data {
            StoreData::Sd1 => "SD1",
            StoreData::Sd2 => "SD2",
            StoreData::None => "",
        },
    );
    let i = cpu.internals().expect("the 6502 netlist names its internal buses");
    let _ = write!(
        s,
        ",\"alu\":{},\"alua\":{},\"alub\":{},\"sb\":{},\"idb\":{},\"idl\":{},\"dor\":{},         \"adl\":{},\"adh\":{},\"abl\":{},\"abh\":{},\"pclp\":{},\"pchp\":{}",
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
    );
    match cpu.last_fetch() {
        Some(f) => {
            let _ = write!(s, ",\"fetch\":{{\"addr\":{},\"opcode\":{}}}", f.addr, f.opcode);
        }
        None => s.push_str(",\"fetch\":null"),
    }
    if !watch.is_empty() {
        s.push_str(",\"watch\":{");
        for (i, (name, id)) in watch.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            let _ = write!(s, "\"{}\":{}", json_escape(name), cpu.engine().is_high(*id));
        }
        s.push('}');
    }
    s.push('}');
    s
}

fn state_json<B: Bus>(cpu: &Cpu<B>) -> String {
    let st = snapshot(cpu);
    let [v, pu, pd, t] = st.chip_hex();
    let fetch = match st.last_fetch {
        Some(f) => format!("{{\"addr\":{},\"opcode\":{}}}", f.addr, f.opcode),
        None => "null".into(),
    };
    format!(
        "{{\"version\":1,\"half_cycle\":{},\"last_fetch\":{},\
         \"value\":\"{}\",\"pullup\":\"{}\",\"pulldown\":\"{}\",\"trans_on\":\"{}\"}}",
        st.half_cycle, fetch, v, pu, pd, t
    )
}

/// Memory back out as fill plus the pages that differ from it. Canonical:
/// a supplied page that turned out to be all-fill is dropped, because
/// "fill everywhere except the listed pages" is the whole meaning. One
/// emitter for both engines, so the two cannot drift in shape.
fn memory_json(mem: &[u8], fill: u8) -> String {
    let mut s = format!("{{\"fill\":\"{fill:02x}\",\"pages\":{{");
    let mut first = true;
    for page in 0..=255u16 {
        let chunk = &mem[(page as usize) * 256..(page as usize + 1) * 256];
        if chunk.iter().all(|&b| b == fill) {
            continue;
        }
        if !first {
            s.push(',');
        }
        first = false;
        let _ = write!(s, "\"{page:02x}\":\"");
        for &b in chunk {
            let _ = write!(s, "{b:02x}");
        }
        s.push('"');
    }
    s.push_str("}}");
    s
}

fn err(msg: &str) -> String {
    format!("{{\"ok\":false,\"error\":\"{}\"}}", json_escape(msg))
}

// -- rung 3 ---------------------------------------------------------------

use v6502_micro::machine::{MicroCpu, MicroState};
use v6502_pins::PinEngine;

/// Rung 3's observation: the same keys as rung 0's where the rung
/// genuinely has the value (pins, registers, the datapath latches), and
/// none of the timing-chain fields, which are node readings this rung
/// does not have. `ir` is the opcode whose span is playing.
fn micro_obs_json(m: &MicroCpu, watch: &[(String, usize)]) -> String {
    let pf = PinEngine::pins(m);
    let (a, x, y, sp, p, pc) = m.registers();
    let (faddr, fop) = m.last_fetch();
    let regs = v6502_sim::cpu::Registers { pc, a, x, y, s: sp, p, ir: m.opcode() };
    let d = m.datapath();
    let mut s = String::with_capacity(320);
    let _ = write!(
        s,
        "{{\"half_cycle\":{},\"cycle\":{},\"clk0\":{},\"phase\":\"{}\",\
         \"addr\":{},\"data\":{},\"rw\":\"{}\",\"sync\":{},\
         \"pc\":{},\"a\":{},\"x\":{},\"y\":{},\"s\":{},\"p\":{},\"ir\":{},\"flags\":\"{}\"",
        pf.h,
        pf.h / 2,
        pf.clk0,
        if pf.clk0 { "phi2" } else { "phi1" },
        pf.ab,
        pf.db,
        if pf.rw { "read" } else { "write" },
        pf.sync,
        pc,
        a,
        x,
        y,
        sp,
        p,
        m.opcode(),
        regs.flags_string(),
    );
    let _ = write!(
        s,
        ",\"alu\":{},\"alua\":{},\"alub\":{},\"sb\":{},\"idb\":{},\"idl\":{},\"dor\":{},\
         \"adl\":{},\"adh\":{},\"abl\":{},\"abh\":{},\"pclp\":{},\"pchp\":{}",
        d.add, d.ai, d.bi, d.sb, d.db, d.dl, d.dor, d.adl, d.adh, d.abl, d.abh, d.pclp, d.pchp,
    );
    let _ = write!(s, ",\"fetch\":{{\"addr\":{faddr},\"opcode\":{fop}}}");
    if !watch.is_empty() {
        s.push_str(",\"watch\":{");
        let w = m.control_word();
        for (i, (name, line)) in watch.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            let _ = write!(s, "\"{}\":{}", json_escape(name), w >> line & 1 != 0);
        }
        s.push('}');
    }
    s.push('}');
    s
}

fn micro_state_json(m: &MicroCpu) -> String {
    let st = m.snapshot();
    let (faddr, fop) = m.last_fetch();
    let mut hex = String::with_capacity(200);
    for b in st.encode() {
        let _ = write!(hex, "{b:02x}");
    }
    format!(
        "{{\"version\":1,\"half_cycle\":{},\"last_fetch\":{{\"addr\":{faddr},\"opcode\":{fop}}},\
         \"micro\":\"{hex}\"}}",
        st.half_cycle,
    )
}

/// The block, answered by rung 3. The refusals mirror the console
/// worker's: a node-shaped `STATE` has no way in here, and the way onto
/// this rung is `BOOT`.
fn handle_micro(m: &mut MicroCpu, req: &Request) -> String {
    let verb = req.verb.as_deref().unwrap_or("");
    if req.state.is_some() {
        return err("STATE is a node engine's machine; rung 3 carries its own. Send MICRO, or BOOT to start here.");
    }
    if req.trace || req.rows {
        return err("TRACE and ROWS are rung 0's node encodings; rung 3 has no nodes to fill them with");
    }
    let mut watch: Vec<(String, usize)> = Vec::new();
    for name in &req.watch {
        match v6502_micro::lines::LINE_NAMES.iter().position(|n| n == name) {
            Some(i) => watch.push((name.clone(), i)),
            None => {
                return err(&format!(
                    "{name:?} is not a control column on rung 3 (the 44 dpc lines, 0/ADL0..2, rw, sync)"
                ))
            }
        }
    }
    for (name, _) in &req.pins {
        if !matches!(name.as_str(), "res" | "irq" | "nmi" | "rdy" | "so") {
            return err(&format!("unknown pin {name:?} (res, irq, nmi, rdy, so)"));
        }
    }

    match verb {
        "BOOT" => {
            let mut image = vec![req.fill; 65536];
            for (page, bytes) in &req.pages {
                image[(*page as usize) * 256..(*page as usize + 1) * 256].copy_from_slice(bytes);
            }
            m.mem.copy_from_slice(&image);
            if let Some(v) = req.vec {
                m.mem[0xfffc] = v as u8;
                m.mem[0xfffd] = (v >> 8) as u8;
            }
            m.power_cycle();
        }
        "STEP" | "RUN" | "RUNTO" => {
            let hex = match &req.micro {
                Some(h) => h,
                None => return err("STEP/RUN on rung 3 needs a MICRO line"),
            };
            let n = match req.arg {
                Some(n) if n <= MAX_STEP => n,
                Some(n) => return err(&format!("{n} half-cycles exceeds max_step {MAX_STEP}")),
                None => return err("STEP/RUN needs a count"),
            };
            if verb == "RUNTO" && req.target.is_none() {
                return err("RUNTO needs a target address");
            }
            let blob = match hex_bytes(hex) {
                Ok(b) => b,
                Err(e) => return err(&format!("MICRO: {e}")),
            };
            let mut st = match MicroState::decode(&blob, req.fill) {
                Ok(st) => st,
                Err(e) => return err(&e),
            };
            for (page, bytes) in &req.pages {
                st.mem[(*page as usize) * 256..(*page as usize + 1) * 256].copy_from_slice(bytes);
            }
            // Pins are levels, carried in the state; a PIN line sets one on
            // top before the run, exactly as rung 0's pad pulls persist.
            let mut inputs = st.inputs;
            for (name, level) in &req.pins {
                let i = match name.as_str() {
                    "res" => 0,
                    "irq" => 1,
                    "nmi" => 2,
                    "rdy" => 3,
                    "so" => 4,
                    _ => unreachable!("validated above"),
                };
                inputs[i] = *level;
            }
            if let Err(e) = m.restore(&st) {
                return err(&e);
            }
            PinEngine::set_inputs(m, inputs[0], inputs[1], inputs[2], inputs[3], inputs[4]);

            let mut stepped = 0u64;
            for _ in 0..n {
                PinEngine::half_step(m);
                stepped += 1;
                let pf = PinEngine::pins(m);
                let at_fetch = pf.sync && !pf.clk0;
                let stop = match verb {
                    "RUN" => at_fetch,
                    "RUNTO" => at_fetch && m.last_fetch().0 == req.target.unwrap_or(0),
                    _ => false,
                };
                if stop {
                    break;
                }
            }
            let pf = PinEngine::pins(m);
            let at_fetch = pf.sync && !pf.clk0;
            let completed = match verb {
                "RUN" => at_fetch,
                "RUNTO" => at_fetch && m.last_fetch().0 == req.target.unwrap_or(0),
                _ => true,
            };
            return format!(
                "{{\"ok\":true,\"stepped\":{},\"completed\":{},\"state\":{},\"memory\":{},\"observe\":{}}}",
                stepped,
                completed,
                micro_state_json(m),
                memory_json(&m.mem, req.fill),
                micro_obs_json(m, &watch),
            );
        }
        "" => return err("no verb (META, NODES, BOOT, STEP, RUN or RUNTO) before GO"),
        v => return err(&format!("unknown verb {v:?}")),
    }

    // BOOT falls through to here.
    format!(
        "{{\"ok\":true,\"stepped\":0,\"completed\":true,\"state\":{},\"memory\":{},\"observe\":{}}}",
        micro_state_json(m),
        memory_json(&m.mem, req.fill),
        micro_obs_json(m, &watch)
    )
}

fn handle(cpu: &mut Cpu<FlatMemory>, micro: &mut MicroCpu, req: &Request) -> String {
    let verb = match &req.verb {
        Some(v) => v.as_str(),
        None => return err("no verb (META, NODES, BOOT, STEP, RUN or RUNTO) before GO"),
    };

    // META and NODES describe the die and the process, whatever answers
    // the frames; everything below them is the chosen rung's.
    if req.engine == 3 && verb != "META" && verb != "NODES" {
        return handle_micro(micro, req);
    }
    if req.micro.is_some() {
        return err("MICRO is rung 3's machine; add ENGINE 3, or send STATE for the node engine");
    }
    if req.window.is_some() && verb != "META" && verb != "NODES" {
        return handle_window(cpu.engine().netlist_arc().clone(), req);
    }

    if verb == "NODES" {
        // Every named node, sorted by name so the output is deterministic.
        let mut names: Vec<(&str, NodeId)> = cpu.engine().netlist().names().collect();
        names.sort();
        let mut s = format!("{{\"ok\":true,\"count\":{},\"nodes\":{{", names.len());
        for (i, (name, id)) in names.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            let _ = write!(s, "\"{}\":{}", json_escape(name), id);
        }
        s.push_str("}}");
        return s;
    }

    if verb == "META" {
        return format!(
            "{{\"ok\":true,\"meta\":{{\"chip\":\"mos6502\",\"nodes\":1725,\"transistors\":3510,\
             \"version\":\"{VERSION}\",\"commit\":\"{COMMIT}\",\"engines\":[0,3],\
             \"max_step\":{MAX_STEP},\"max_traced\":{MAX_TRACED},\
             \"encoding\":\"lowercase hex; bit i of a set is byte i/8, LSB first; \
node numbering is visual6502's own; node bitsets 216 bytes, transistor set 439 bytes\"}}}}"
        );
    }

    // Resolve watches before touching the chip: an unknown name is the
    // caller's typo and must be an error, not a silently absent key.
    let mut watch: Vec<(String, NodeId)> = Vec::new();
    for name in &req.watch {
        match cpu.engine().netlist().node(name) {
            Some(id) => watch.push((name.clone(), id)),
            None => return err(&format!("unknown node name {name:?}")),
        }
    }

    // Memory: fill everywhere, then the pages.
    let mut image = vec![req.fill; 65536];
    for (page, bytes) in &req.pages {
        image[(*page as usize) * 256..(*page as usize + 1) * 256].copy_from_slice(bytes);
    }

    match verb {
        "BOOT" => {
            cpu.bus.set_journalling(false);
            cpu.bus.load(0, &image);
            if let Some(v) = req.vec {
                cpu.bus.set_reset_vector(v);
            }
            cpu.power_cycle();
        }
        "STEP" | "RUN" | "RUNTO" => {
            let st = match &req.state {
                Some(s) => s,
                None => return err("STEP/RUN needs a STATE line"),
            };
            let n = match req.arg {
                Some(n) if n <= MAX_STEP => n,
                Some(n) => return err(&format!("{n} half-cycles exceeds max_step {MAX_STEP}")),
                None => return err("STEP/RUN needs a count"),
            };
            if req.trace && n > MAX_TRACED {
                return err(&format!("{n} traced half-cycles exceeds max_traced {MAX_TRACED}"));
            }
            if verb == "RUNTO" && req.target.is_none() {
                return err("RUNTO needs a target address");
            }
            let half_cycle: u64 = match st[4].parse() {
                Ok(h) => h,
                Err(_) => return err(&format!("bad half_cycle {:?}", st[4])),
            };
            let fetch = if st[5] == "-" {
                None
            } else if st[5].len() == 6 {
                let addr = u16::from_str_radix(&st[5][..4], 16);
                let op = u8::from_str_radix(&st[5][4..], 16);
                match (addr, op) {
                    (Ok(addr), Ok(opcode)) => Some(Fetch { addr, opcode }),
                    _ => return err(&format!("bad fetch {:?}", st[5])),
                }
            } else {
                return err(&format!("bad fetch {:?} (want - or 6 hex chars)", st[5]));
            };
            let ms = match MachineState::from_hex(
                1725, 3510, &st[0], &st[1], &st[2], &st[3], half_cycle, fetch,
            ) {
                Ok(ms) => ms,
                Err(e) => return err(&e),
            };
            for (name, _) in &req.pins {
                if !matches!(name.as_str(), "res" | "irq" | "nmi" | "rdy" | "so") {
                    return err(&format!("unknown pin {name:?} (res, irq, nmi, rdy, so)"));
                }
            }
            cpu.bus.set_journalling(false);
            cpu.bus.load(0, &image);
            restore(cpu, &ms);
            // Pins are LEVELS, not interpretations: four of the five are
            // active low, so 0 asserts them. The drive is a pull on the pad
            // node, which lives in the state bitsets, so a pin stays where
            // it was put across requests until set again.
            for (name, level) in &req.pins {
                match name.as_str() {
                    "res" => cpu.set_res(*level),
                    "irq" => cpu.set_irq(*level),
                    "nmi" => cpu.set_nmi(*level),
                    "rdy" => cpu.set_rdy(*level),
                    "so" => cpu.set_so(*level),
                    _ => unreachable!("validated above"),
                }
            }

            let (stepped, completed, trace) = drive(cpu, req, verb, n, &watch, &mut |_| true);
            return format!(
                "{{\"ok\":true,\"stepped\":{},\"completed\":{},\"state\":{},\"memory\":{},\"observe\":{}{}}}",
                stepped,
                completed,
                state_json(cpu),
                memory_json(cpu.bus.as_slice(), req.fill),
                obs_json(cpu, &watch),
                trace
            );
        }
        v => return err(&format!("unknown verb {v:?}")),
    }

    // BOOT falls through to here.
    format!(
        "{{\"ok\":true,\"stepped\":0,\"completed\":true,\"state\":{},\"memory\":{},\"observe\":{}}}",
        state_json(cpu),
        memory_json(cpu.bus.as_slice(), req.fill),
        obs_json(cpu, &watch)
    )
}

/// The STEP/RUN/RUNTO loop, shared by the memory machine and a window:
/// `n` half-steps at most, each traced if asked (rows or observations),
/// RUN stopping at the next opcode fetch and RUNTO at the fetch of the
/// target; `before` runs before every step and returns false to stop the
/// run short (a window's bus refusing). Returns (stepped, completed, the
/// trace fragment).
fn drive<B: Bus>(cpu: &mut Cpu<B>, req: &Request, verb: &str, n: u64, watch: &[(String, NodeId)], before: &mut dyn FnMut(&mut Cpu<B>) -> bool) -> (u64, bool, String) {
    // The rows form is the same trace packed by v6502_sim::rows, the
    // packer the wasm Machine uses too: the service passes it
    // through untouched, so nothing downstream re-encodes a column.
    let watch_ids: Vec<NodeId> = watch.iter().map(|w| w.1).collect();
    let mut trace = String::new();
    if req.rows {
        let _ = write!(
            trace,
            ",\"trace_rows\":{{\"cols\":{},\"watch_names\":{},\"watch_encoding\":\"hex\",\"rows\":[",
            rows::cols_json(),
            rows::names_json(&req.watch)
        );
    } else if req.trace {
        trace.push_str(",\"trace\":[");
    }
    let mut stepped = 0u64;
    let mut short = false;
    for i in 0..n {
        if !before(cpu) {
            short = true;
            break;
        }
        cpu.half_step();
        stepped += 1;
        if req.trace {
            if i > 0 {
                trace.push(',');
            }
            if req.rows {
                rows::push_row(&mut trace, cpu, &watch_ids);
            } else {
                trace.push_str(&obs_json(cpu, watch));
            }
        }
        // RUN stops at the next opcode fetch: sync high with clk0
        // low, the same boundary `step_instruction` uses. RUNTO stops
        // at the fetch OF a given address -- a breakpoint, with the
        // address read from the latched fetch, the same latch the
        // disassembler relies on.
        let at_fetch = cpu.sync() && !cpu.clk0();
        let stop = match verb {
            "RUN" => at_fetch,
            "RUNTO" => at_fetch && cpu.last_fetch().map(|f| f.addr) == req.target,
            _ => false,
        };
        if stop {
            break;
        }
    }
    let at_fetch = cpu.sync() && !cpu.clk0();
    let arrived = match verb {
        "RUN" => at_fetch,
        "RUNTO" => at_fetch && cpu.last_fetch().map(|f| f.addr) == req.target,
        _ => true,
    };
    // Not completed when the cap came first (a JAM, a loop that never
    // fetches there, or the cap is low) or the bus stopped the run.
    let completed = arrived && !short;
    if req.rows {
        trace.push_str("]}");
    } else if req.trace {
        trace.push(']');
    }
    (stepped, completed, trace)
}

/// `WINDOW <name>`: rung 0 standing inside a window of a record
/// (`v6502_sim::recorded`, the `.window` text of `v6502_pins`). The chip
/// is restored to the window's own machine value, or to a STATE line if
/// one is sent (a state saved from an earlier step in the same window);
/// the record is the memory, so FILL and PAGE are refused; the window's
/// stimulus is applied by half-cycle before every step, and PIN lines
/// override it for the first step only. The reply carries the usual
/// fields plus `window`: name, origin, end, where the chip stands, the
/// first field where its pins differ from the record there (or null), and
/// the bus's refusal if the chip asked for what the record does not show
/// (the run stops there, `completed` false).
fn handle_window(netlist: Arc<v6502_sim::Netlist>, req: &Request) -> String {
    let name = req.window.as_deref().unwrap_or("");
    let verb = req.verb.as_deref().unwrap_or("");
    if !matches!(verb, "STEP" | "RUN" | "RUNTO") {
        return err("a window answers STEP, RUN and RUNTO (it is never BOOTed: the chip is restored into it)");
    }
    if !req.pages.is_empty() || req.fill != 0 {
        return err("a window is the memory; FILL and PAGE do not apply");
    }
    let dir = std::env::var("HALFWAVE_WINDOWS").unwrap_or_else(|_| "windows".into());
    let path = std::path::Path::new(&dir).join(format!("{name}.window"));
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => return err(&format!("window {name:?}: {}: {e}", path.display())),
    };
    let w = match v6502_pins::parse_window(&text) {
        Ok(w) => w,
        Err(e) => return err(&format!("window {name:?}: {e}")),
    };
    let mut watch: Vec<(String, NodeId)> = Vec::new();
    for wname in &req.watch {
        match netlist.node(wname) {
            Some(id) => watch.push((wname.clone(), id)),
            None => return err(&format!("unknown node name {wname:?}")),
        }
    }
    let n = match req.arg {
        Some(n) if n <= MAX_STEP => n,
        Some(n) => return err(&format!("{n} half-cycles exceeds max_step {MAX_STEP}")),
        None => return err("STEP/RUN needs a count"),
    };
    if req.trace && n > MAX_TRACED {
        return err(&format!("{n} traced half-cycles exceeds max_traced {MAX_TRACED}"));
    }
    if verb == "RUNTO" && req.target.is_none() {
        return err("RUNTO needs a target address");
    }
    let bus = v6502_sim::recorded::RecordedBus::window(w.frames.clone(), w.origin, w.fill, &w.pages);
    let mut cpu = match Cpu::new(netlist, bus) {
        Ok(c) => c,
        Err(e) => return err(&format!("{e:?}")),
    };
    // The window's own state, or the caller's.
    let (planes, half_cycle, fetch): ([&str; 4], u64, Option<Fetch>) = match &req.state {
        Some(st) => {
            let half_cycle: u64 = match st[4].parse() {
                Ok(h) => h,
                Err(_) => return err(&format!("bad half_cycle {:?}", st[4])),
            };
            let fetch = if st[5] == "-" {
                None
            } else if st[5].len() == 6 {
                match (u16::from_str_radix(&st[5][..4], 16), u8::from_str_radix(&st[5][4..], 16)) {
                    (Ok(addr), Ok(opcode)) => Some(Fetch { addr, opcode }),
                    _ => return err(&format!("bad fetch {:?}", st[5])),
                }
            } else {
                return err(&format!("bad fetch {:?} (want - or 6 hex chars)", st[5]));
            };
            ([&st[0], &st[1], &st[2], &st[3]], half_cycle, fetch)
        }
        None => (
            [&w.state.value, &w.state.pullup, &w.state.pulldown, &w.state.trans_on],
            w.state.half_cycle,
            w.state.fetch.map(|(addr, opcode)| Fetch { addr, opcode }),
        ),
    };
    if half_cycle < w.origin || half_cycle > w.origin + w.frames.len() as u64 - 1 {
        return err(&format!("the state stands at {half_cycle}, outside the window {}..={}", w.origin, w.origin + w.frames.len() as u64 - 1));
    }
    let ms = match MachineState::from_hex(1725, 3510, planes[0], planes[1], planes[2], planes[3], half_cycle, fetch) {
        Ok(ms) => ms,
        Err(e) => return err(&e),
    };
    restore(&mut cpu, &ms);
    for (pname, _) in &req.pins {
        if !matches!(pname.as_str(), "res" | "irq" | "nmi" | "rdy" | "so") {
            return err(&format!("unknown pin {pname:?} (res, irq, nmi, rdy, so)"));
        }
    }
    let stim = w.stim.clone();
    let mut first = true;
    let pins = req.pins.clone();
    let mut before = |cpu: &mut Cpu<v6502_sim::recorded::RecordedBus>| -> bool {
        let h = cpu.half_cycle();
        let mut level = None;
        for st in &stim {
            if st.h <= h {
                level = Some(*st);
            }
        }
        if let Some(st) = level {
            cpu.set_res(st.res);
            cpu.set_irq(st.irq);
            cpu.set_nmi(st.nmi);
            cpu.set_rdy(st.rdy);
            cpu.set_so(st.so);
        }
        if first {
            for (pname, lvl) in &pins {
                match pname.as_str() {
                    "res" => cpu.set_res(*lvl),
                    "irq" => cpu.set_irq(*lvl),
                    "nmi" => cpu.set_nmi(*lvl),
                    "rdy" => cpu.set_rdy(*lvl),
                    "so" => cpu.set_so(*lvl),
                    _ => unreachable!("validated above"),
                }
            }
            first = false;
        }
        cpu.bus.refusal.is_none() && cpu.bus.frame_at(h + 1).is_some()
    };
    let (stepped, completed, trace) = drive(&mut cpu, req, verb, n, &watch, &mut before);
    let h = cpu.half_cycle();
    let differs = match cpu.bus.frame_at(h) {
        Some(expected) => v6502_sim::recorded::first_difference_under_record(&expected, &v6502_pins::PinEngine::pins(&cpu)).map(|f| format!("\"{f}\"")).unwrap_or_else(|| "null".into()),
        None => "\"outside\"".into(),
    };
    let refusal = match &cpu.bus.refusal {
        Some(r) => format!("\"{}\"", json_escape(&r.to_string())),
        None => "null".into(),
    };
    format!(
        "{{\"ok\":true,\"stepped\":{},\"completed\":{},\"state\":{},\"memory\":{},\"observe\":{},\"window\":{{\"name\":\"{}\",\"origin\":{},\"end\":{},\"h\":{},\"differs\":{},\"refusal\":{}}}{}}}",
        stepped,
        completed && cpu.bus.refusal.is_none(),
        state_json(&cpu),
        memory_json(cpu.bus.shadow(), 0),
        obs_json(&cpu, &watch),
        json_escape(&w.name),
        w.origin,
        w.origin + w.frames.len() as u64 - 1,
        h,
        differs,
        refusal,
        trace
    )
}

/// The workspace version and the commit this binary was built from, as
/// `build.rs` stamped them. `--version` prints it and the META reply carries
/// it, so the thing answering behind a service can say what it is rather than
/// being identified by a file digest.
const VERSION: &str = env!("CARGO_PKG_VERSION");
const COMMIT: &str = env!("V6502_COMMIT");

fn main() {
    if std::env::args().skip(1).any(|a| a == "--version" || a == "-V") {
        println!("halfwave {VERSION} {COMMIT}");
        return;
    }
    let netlist = Arc::new(mos6502());
    let mut cpu = Cpu::new(netlist, FlatMemory::new()).expect("6502 signals resolve");
    cpu.bus.set_journalling(false);
    let mut micro = MicroCpu::new();

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let mut req = Request::empty();
    let mut bad: Option<String> = None;

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let mut parts = line.split_whitespace();
        let Some(word) = parts.next() else { continue };
        let r = &mut req;
        let result: Result<bool, String> = (|| match word {
            "GO" => Ok(true),
            "META" | "NODES" | "BOOT" => {
                if r.verb.is_some() {
                    return Err("more than one verb in a block".into());
                }
                r.verb = Some(word.into());
                Ok(false)
            }
            "STEP" | "RUN" | "RUNTO" => {
                if r.verb.is_some() {
                    return Err("more than one verb in a block".into());
                }
                r.verb = Some(word.into());
                r.arg = Some(
                    parts
                        .next()
                        .ok_or("STEP/RUN/RUNTO needs a count")?
                        .parse()
                        .map_err(|_| "bad count")?,
                );
                if word == "RUNTO" {
                    let t = parts.next().ok_or("RUNTO needs a hex target address")?;
                    r.target =
                        Some(u16::from_str_radix(t, 16).map_err(|_| format!("bad target {t:?}"))?);
                }
                Ok(false)
            }
            "WINDOW" => {
                let name = parts.next().ok_or("WINDOW needs a name")?;
                if name.contains('/') || name.contains("..") {
                    return Err("a window name has no path in it".into());
                }
                r.window = Some(name.into());
                Ok(false)
            }
            "VEC" => {
                let v = parts.next().ok_or("VEC needs a hex address")?;
                r.vec = Some(u16::from_str_radix(v, 16).map_err(|_| format!("bad VEC {v:?}"))?);
                Ok(false)
            }
            "STATE" => {
                let f: Vec<&str> = parts.collect();
                if f.len() != 6 {
                    return Err(format!("STATE wants 6 fields, got {}", f.len()));
                }
                r.state = Some([
                    f[0].into(),
                    f[1].into(),
                    f[2].into(),
                    f[3].into(),
                    f[4].into(),
                    f[5].into(),
                ]);
                Ok(false)
            }
            "ENGINE" => {
                let n = parts.next().ok_or("ENGINE needs a rung number")?;
                r.engine = match n {
                    "0" => 0,
                    "3" => 3,
                    "1" => return Err("rung 1 is bit-exact with rung 0 and no faster; ENGINE 0 answers for it".into()),
                    "2" => return Err("rung 2 is a 64-lane throughput engine; one machine would pay for the whole word. ENGINE 0 or 3".into()),
                    _ => return Err(format!("unknown engine {n:?} (0 or 3)")),
                };
                Ok(false)
            }
            "MICRO" => {
                let h = parts.next().ok_or("MICRO needs the state as hex")?;
                r.micro = Some(h.into());
                Ok(false)
            }
            "FILL" => {
                let v = parts.next().ok_or("FILL needs a hex byte")?;
                r.fill = u8::from_str_radix(v, 16).map_err(|_| format!("bad FILL {v:?}"))?;
                Ok(false)
            }
            "PAGE" => {
                let p = parts.next().ok_or("PAGE needs a page number")?;
                let page = u8::from_str_radix(p, 16).map_err(|_| format!("bad page {p:?}"))?;
                let hexs = parts.next().ok_or("PAGE needs 512 hex chars")?;
                let bytes = hex_bytes(hexs)?;
                if bytes.len() != 256 {
                    return Err(format!("page {p} is {} bytes, want 256", bytes.len()));
                }
                r.pages.push((page, bytes));
                Ok(false)
            }
            "PIN" => {
                let name = parts.next().ok_or("PIN needs a name")?.to_string();
                let level = match parts.next() {
                    Some("0") => false,
                    Some("1") => true,
                    _ => return Err("PIN needs a level of 0 or 1".into()),
                };
                r.pins.push((name, level));
                Ok(false)
            }
            "WATCH" => {
                for name in parts {
                    r.watch.push(name.into());
                }
                Ok(false)
            }
            "TRACE" => {
                r.trace = true;
                Ok(false)
            }
            "ROWS" => {
                r.trace = true;
                r.rows = true;
                Ok(false)
            }
            w => Err(format!("unknown line {w:?}")),
        })();

        match result {
            Ok(false) => {}
            Ok(true) => {
                let response = match bad.take() {
                    Some(e) => err(&e),
                    None => handle(&mut cpu, &mut micro, &req),
                };
                let _ = writeln!(out, "{response}");
                let _ = out.flush();
                req = Request::empty();
            }
            Err(e) => {
                // Remember the first fault; still consume to GO so one bad
                // line cannot desynchronise the stream.
                if bad.is_none() {
                    bad = Some(e);
                }
            }
        }
    }
}
