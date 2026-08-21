//! 6502 as a service: the engine end of it.
//!
//!     cargo run --release -p v6502-sim --bin halfwave
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
//!     META                        ask who I am (counts, limits, encoding)
//!     NODES                       every named node, name to id
//!     BOOT                        power-cycle into the supplied memory
//!     VEC <hex4>                  (with BOOT) write the reset vector first
//!     STEP <n>                    advance n half-cycles from STATE
//!     RUN <max>                   advance to the next opcode fetch, capped
//!     RUNTO <max> <hex4>          advance to the opcode fetch AT an address
//!     STATE <value> <pullup> <pulldown> <trans_on> <half_cycle> <fetch|->
//!     FILL <hex2>                 memory background byte (default 00)
//!     PAGE <hex2> <512 hex>       one 256-byte page over the fill
//!     WATCH <name> [name...]     node names to read out (repeatable)
//!     PIN <name> <0|1>            drive an input pin (res irq nmi rdy so)
//!     TRACE                       record an observation per half-cycle
//!     GO
//!
//! Exactly one verb (META | NODES | BOOT | STEP | RUN | RUNTO) per block. The response is one
//! JSON object: `{"ok":true, "state":..., "memory":..., "observe":...}` or
//! `{"ok":false, "error":"..."}`. A malformed block gets an error, never a
//! guess, and never kills the process.

use std::fmt::Write as _;
use std::io::{BufRead, Write};
use std::sync::Arc;

use v6502_netlist::{mos6502, NodeId};
use v6502_sim::bus::FlatMemory;
use v6502_sim::cpu::{Cpu, Fetch, ReadWrite};
use v6502_sim::state::{restore, snapshot, MachineState};
use v6502_sim::timing::{Hidden, Phase, StoreData};

/// Hard ceiling on half-cycles per request, so a request cannot wedge the
/// worker. Stated in META so clients can shard long runs.
const MAX_STEP: u64 = 200_000;
/// Ceiling when TRACE is on: each traced half-cycle is a response line entry.
const MAX_TRACED: u64 = 10_000;

struct Request {
    verb: Option<String>,
    arg: Option<u64>,
    target: Option<u16>,
    vec: Option<u16>,
    pins: Vec<(String, bool)>,
    state: Option<[String; 6]>,
    fill: u8,
    pages: Vec<(u8, Vec<u8>)>,
    watch: Vec<String>,
    trace: bool,
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
            fill: 0,
            pages: Vec::new(),
            watch: Vec::new(),
            trace: false,
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

/// The buses and hold registers an observation reads beside the registers.
/// Resolved once at startup. `alu` is the adder's hold register: the wire
/// where a sum is real before any register holds it, which is the reading
/// the whole overlap demo turns on.
struct ExtraBuses {
    alu: [NodeId; 8],
    alua: [NodeId; 8],
    alub: [NodeId; 8],
    sb: [NodeId; 8],
    idb: [NodeId; 8],
    idl: [NodeId; 8],
    dor: [NodeId; 8],
    adl: [NodeId; 8],
    adh: [NodeId; 8],
    abl: [NodeId; 8],
    abh: [NodeId; 8],
    pclp: [NodeId; 8],
    pchp: [NodeId; 8],
}

impl ExtraBuses {
    fn resolve(nl: &v6502_netlist::Netlist) -> ExtraBuses {
        let bus = |p: &str| nl.bus::<8>(p).unwrap_or_else(|| panic!("no bus {p}0..7"));
        ExtraBuses {
            alu: bus("alu"),
            alua: bus("alua"),
            alub: bus("alub"),
            sb: bus("sb"),
            idb: bus("idb"),
            idl: bus("idl"),
            dor: bus("dor"),
            adl: bus("adl"),
            adh: bus("adh"),
            abl: bus("abl"),
            abh: bus("abh"),
            pclp: bus("pclp"),
            pchp: bus("pchp"),
        }
    }
}

/// One observation as flat JSON: the architectural and microarchitectural
/// state a learner reads off the running chip, plus any watched nodes.
fn obs_json(cpu: &Cpu<FlatMemory>, extra: &ExtraBuses, watch: &[(String, NodeId)]) -> String {
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
    let rb = |b: &[NodeId; 8]| cpu.engine().read_bus(b);
    let _ = write!(
        s,
        ",\"alu\":{},\"alua\":{},\"alub\":{},\"sb\":{},\"idb\":{},\"idl\":{},\"dor\":{},         \"adl\":{},\"adh\":{},\"abl\":{},\"abh\":{},\"pclp\":{},\"pchp\":{}",
        rb(&extra.alu),
        rb(&extra.alua),
        rb(&extra.alub),
        rb(&extra.sb),
        rb(&extra.idb),
        rb(&extra.idl),
        rb(&extra.dor),
        rb(&extra.adl),
        rb(&extra.adh),
        rb(&extra.abl),
        rb(&extra.abh),
        rb(&extra.pclp),
        rb(&extra.pchp),
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

fn state_json(cpu: &Cpu<FlatMemory>) -> String {
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
/// "fill everywhere except the listed pages" is the whole meaning.
fn memory_json(cpu: &Cpu<FlatMemory>, fill: u8) -> String {
    let mem = cpu.bus.as_slice();
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

fn handle(cpu: &mut Cpu<FlatMemory>, extra: &ExtraBuses, req: &Request) -> String {
    let verb = match &req.verb {
        Some(v) => v.as_str(),
        None => return err("no verb (META, NODES, BOOT, STEP, RUN or RUNTO) before GO"),
    };

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

            let mut trace = String::new();
            if req.trace {
                trace.push_str(",\"trace\":[");
            }
            let mut stepped = 0u64;
            let mut completed = true;
            for i in 0..n {
                cpu.half_step();
                stepped += 1;
                if req.trace {
                    if i > 0 {
                        trace.push(',');
                    }
                    trace.push_str(&obs_json(cpu, extra, &watch));
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
            if !arrived {
                completed = false; // the cap came first: a JAM, a loop that
                                   // never fetches there, or the cap is low
            }
            if req.trace {
                trace.push(']');
            }
            return format!(
                "{{\"ok\":true,\"stepped\":{},\"completed\":{},\"state\":{},\"memory\":{},\"observe\":{}{}}}",
                stepped,
                completed,
                state_json(cpu),
                memory_json(cpu, req.fill),
                obs_json(cpu, extra, &watch),
                trace
            );
        }
        v => return err(&format!("unknown verb {v:?}")),
    }

    // BOOT falls through to here.
    format!(
        "{{\"ok\":true,\"stepped\":0,\"completed\":true,\"state\":{},\"memory\":{},\"observe\":{}}}",
        state_json(cpu),
        memory_json(cpu, req.fill),
        obs_json(cpu, extra, &watch)
    )
}

fn main() {
    let netlist = Arc::new(mos6502());
    let extra = ExtraBuses::resolve(&netlist);
    let mut cpu = Cpu::new(netlist, FlatMemory::new()).expect("6502 signals resolve");
    cpu.bus.set_journalling(false);

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
            w => Err(format!("unknown line {w:?}")),
        })();

        match result {
            Ok(false) => {}
            Ok(true) => {
                let response = match bad.take() {
                    Some(e) => err(&e),
                    None => handle(&mut cpu, &extra, &req),
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
