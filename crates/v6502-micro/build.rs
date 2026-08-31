//! The recorder: rung 3's table, measured out of rung 0 at build time.
//!
//! For every opcode, in six contexts chosen so each of the four measured
//! mechanisms fires both ways (registers, flags, operands and base page all
//! varied; see `CONTEXTS`), rung 0 runs the opcode from its own fetch to
//! the fetch after it plus the two overlap half-cycles, and the 51-bit
//! control vector of `src/lines.rs` is recorded per half-cycle. Contexts
//! whose authored selector key (computed here from full knowledge of the
//! machine; the meaning of each bit is in `lines.rs`) is the same MUST
//! record identical spans: the build refuses otherwise, which is
//! experiment 3 (`tools/experiments/m4-rom-key.py`) as a gate.
//!
//! Also recorded: the reset tail (the vectors from h=0 to the first fetch,
//! plus the architectural state at h=0), which is what `power_cycle` has
//! to reproduce, and the build stamp.
//!
//! The emitted table is derived from the die data and is never committed
//! (the same licence position as `v6502-compiled`'s kernel); the names it
//! is recorded through stay in `src/lines.rs`.

use std::fmt::Write as _;
use std::path::Path;
use std::sync::Arc;

use v6502_sim::bus::FlatMemory;
use v6502_sim::cpu::Cpu;

#[allow(dead_code)] // the bit constants are the library's and the datapath's
mod lines {
    include!("src/lines.rs");
}
use lines::*;
include!("src/select.rs");
include!("src/harness.rs");

/// (name, base, preamble, operands): the opcode goes right after the
/// preamble, `operands` after it. Same shapes as the experiments, plus
/// `ycross` (the four contexts never fired a Y-indexed page cross: Y was
/// 0x01 in the crossing context) and `vset` (nothing had set V).
const CONTEXTS: &[(&str, u16, &[u8], &[u8])] = &[
    ("plain", 0x0200, &[0xa9, 0x41, 0xa2, 0x02, 0xa0, 0x03, 0x18], &[0x34, 0x12, 0x00]),
    ("setflags", 0x0200, &[0xa9, 0x80, 0xa2, 0xff, 0xa0, 0xff, 0x38], &[0xff, 0x02, 0x00]),
    ("zero", 0x0200, &[0xa9, 0x00, 0xa2, 0x00, 0xa0, 0x00, 0x18], &[0x00, 0x03, 0x00]),
    ("pagecross", 0x02f0, &[0x38, 0xa9, 0x80, 0xa2, 0xff, 0xa0, 0x01], &[0x7f, 0x02, 0x00]),
    ("ycross", 0x02f0, &[0x18, 0xa9, 0x80, 0xa2, 0x01, 0xa0, 0xff], &[0x7f, 0x02, 0x00]),
    ("vset", 0x0200, &[0xa9, 0x40, 0x85, 0x10, 0x24, 0x10, 0xa2, 0x02, 0xa0, 0x03], &[0x34, 0x12, 0x00]),
    // Near the page end with V set, and with Z set: without these, a BVS or
    // BEQ taken across a page has no recording to select.
    ("vcross", 0x02f0, &[0xa9, 0x40, 0x85, 0x10, 0x24, 0x10, 0xa2, 0x01], &[0x7f, 0x02, 0x00]),
    ("zcross", 0x02f0, &[0xa2, 0x01, 0xa0, 0x01, 0xa9, 0x00, 0x18], &[0x7f, 0x02, 0x00]),
    // Decorrelators: in the eight above, the carry always agrees with the
    // branch offset's sign, and the mask search learned C as a stand-in
    // for it. C=1 with a positive offset, and C=0 with a negative one.
    ("cpos", 0x0200, &[0xa9, 0x01, 0xa2, 0x02, 0xa0, 0x03, 0x38], &[0x34, 0x02, 0x00]),
    ("cneg", 0x0240, &[0xa9, 0x01, 0xa2, 0x02, 0xa0, 0x03, 0x18], &[0xf8, 0x02, 0x00]),
    // Decimal mode, both carry values: the ADC/SBC families drop #DAA or
    // #DSA under D, which is a control difference SEL_D has to carry.
    ("dec", 0x0200, &[0xa9, 0x19, 0xa2, 0x02, 0xa0, 0x03, 0xf8, 0x18], &[0x28, 0x02, 0x00]),
    ("decc", 0x0200, &[0xa9, 0x99, 0xa2, 0x02, 0xa0, 0x03, 0xf8, 0x38], &[0x99, 0x02, 0x00]),
];

/// How far past the fetch the recorder looks before calling an opcode KIL.
const WINDOW: usize = 40;
/// A KIL's recorded span: enough to show the loop it is stuck in.
const KIL_SPAN: usize = 16;

type Variant = (u8, Vec<u64>, u8, u64);

struct Recorded {
    key: u8,
    context: &'static str,
    span: Vec<u64>,
    kil: bool,
    /// The overlap's alucin was data: the sequencer supplies its C flag.
    cin_from_c: bool,
    /// The seam word: this op's write-back at the next span's h=2.
    wb: u64,
}

fn report_conflict(op: u8, prev: &Recorded, r: &Recorded) -> ! {
    let n = prev.span.len().min(r.span.len());
    for h in 0..n {
        let d = prev.span[h] ^ r.span[h];
        if d != 0 {
            let names: Vec<&str> = (0..52).filter(|i| d >> i & 1 != 0).map(|i| if i == 51 { "alucin" } else { LINE_NAMES[i] }).collect();
            eprintln!("op {op:02x} h={} ({} vs {}): {}", h + 2, prev.context, r.context, names.join(", "));
        }
    }
    panic!(
        "op {op:02x}: contexts {} and {} share key {:#04x} but recorded different spans (lengths {} and {})",
        prev.context, r.context, r.key, prev.span.len(), r.span.len()
    );
}

fn record(op: u8, ids: &[u16], name: &'static str, base: u16, preamble: &[u8], operands: &[u8]) -> Recorded {
    let image = memory_image(base, preamble, op, operands);
    let at = base + preamble.len() as u16;
    let mut cpu = boot(&image);
    // To the opcode's own fetch: sync high with its address on the bus.
    let mut guard = 0;
    while !(cpu.sync() && cpu.address_bus() == at) {
        cpu.half_step();
        guard += 1;
        assert!(guard < 400, "op {op:02x} in {name}: never fetched at {at:04x}");
    }
    let regs = cpu.registers();
    let key = selector(op, regs.p, regs.x, regs.y, at, &image);
    // The fetch's own two half-cycles belong to the PREVIOUS instruction
    // (its T0 overlapping the new T1), so the opcode's span starts at h=2
    // from its fetch and runs through the two overlap half-cycles of the
    // fetch after it. Recording them here would record the preamble.
    let mut span = vec![vector(&cpu, ids)];
    let mut kil = false;
    loop {
        cpu.half_step();
        span.push(vector(&cpu, ids));
        let h = span.len() - 1;
        if h >= 2 && span[h] >> BIT_SYNC & 1 != 0 {
            // The next instruction's fetch: keep its two overlap half-cycles.
            cpu.half_step();
            span.push(vector(&cpu, ids));
            break;
        }
        if h >= WINDOW {
            kil = true;
            span.truncate(KIL_SPAN);
            break;
        }
    }
    // One more half-cycle: the seam word, the write-back this op performs
    // inside the NEXT instruction's first execution half-cycle.
    let wb = if kil {
        0
    } else {
        cpu.half_step();
        vector(&cpu, ids) & WB_MASK
    };
    span.drain(..2);
    // The overlap alucin, where nothing consumes it, is data the key
    // cannot determine (lines.rs, `overlap_alucin_consumed`): masked here
    // and in the coverage test's reading, held harmless by the pin replay.
    // The RRA family's is data too, but consumed (the fresh carry): masked
    // here, computed by the sequencer from its own shift capture.
    if ((!overlap_alucin_consumed(op) && wb == 0) || overlap_cin_from_shift(op)) && !kil {
        let n = span.len();
        for w in &mut span[n.saturating_sub(2)..] {
            *w &= !(1 << BIT_ALUCIN);
        }
    }
    Recorded { key, context: name, span, kil, cin_from_c: false, wb }
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=src/lines.rs");
    println!("cargo:rerun-if-changed=src/select.rs");
    println!("cargo:rerun-if-changed=src/harness.rs");
    let nl = v6502_netlist::mos6502();
    let mut ids: Vec<u16> = LINE_NAMES[..49]
        .iter()
        .map(|n| nl.node(n).unwrap_or_else(|| panic!("line {n} is not a node on this die")))
        .collect();
    ids.push(nl.node("alucin").expect("alucin is a node"));

    // Per opcode: variants after the gate, as (masked key, span).
    // (masked key, span, flags, seam word)
    let mut variants_of: Vec<Vec<Variant>> = Vec::with_capacity(256);
    let mut kils = Vec::new();
    let mut masks: Vec<u8> = Vec::with_capacity(256);
    for op in 0..=255u8 {
        let mut seen: Vec<Recorded> = Vec::new();
        for &(name, base, pre, ops) in CONTEXTS {
            let r = record(op, &ids, name, base, pre, ops);
            if let Some(prev) = seen.iter().position(|s| s.key == r.key) {
                let prev = &mut seen[prev];
                // The overlap's alucin is the finishing instruction's own
                // tail. Where it is control (an increment's +1) it records
                // and replays; where two same-key recordings disagree it is
                // riding data (an RMW's fresh carry, op 2e), so THOSE spans
                // mask it and the sequencer supplies its not-yet-updated C,
                // which is what the ADC class computes with there anyway.
                if !prev.kil && prev.span.len() == r.span.len() {
                    let n = prev.span.len();
                    for i in [n - 2, n - 1] {
                        if (prev.span[i] ^ r.span[i]) & (1 << BIT_ALUCIN) != 0 {
                            prev.span[i] &= !(1 << BIT_ALUCIN);
                            prev.cin_from_c = true;
                        }
                    }
                    let mut masked = r.span.clone();
                    if prev.cin_from_c {
                        masked[n - 2] &= !(1 << BIT_ALUCIN);
                        masked[n - 1] &= !(1 << BIT_ALUCIN);
                    }
                    if prev.span != masked || prev.wb != r.wb {
                        let r = Recorded { span: masked, ..r };
                        report_conflict(op, prev, &r);
                    }
                    continue;
                }
                // The gate: one key, one span. Refuse to build otherwise,
                // naming the half-cycle and the lines.
                if prev.span != r.span || prev.wb != r.wb {
                    report_conflict(op, prev, &r);
                }
            } else {
                seen.push(r);
            }
        }
        if seen.iter().any(|s| s.kil) {
            assert!(seen.iter().all(|s| s.kil), "op {op:02x}: KIL in one context only");
            kils.push(op);
        }
        // The relevance mask: the smallest set of selector bits under which
        // the recorded spans are single-valued. A bit an opcode does not
        // care about (the carry, for most) must not partition its lookup,
        // or every fresh context would find a key nobody recorded.
        let single_valued = |mask: u8| -> bool {
            for a in 0..seen.len() {
                for b in a + 1..seen.len() {
                    if seen[a].key & mask == seen[b].key & mask
                        && (seen[a].span != seen[b].span || seen[a].wb != seen[b].wb)
                    {
                        return false;
                    }
                }
            }
            true
        };
        // The SMALLEST single-valued mask, by exhaustive search over the
        // seven bits: a greedy pick chose whichever correlate came first.
        let mut candidates: Vec<u8> = (0u8..128).collect();
        candidates.sort_by_key(|m| (m.count_ones(), *m));
        let mask = *candidates
            .iter()
            .find(|&&m| single_valued(m))
            .unwrap_or_else(|| panic!("op {op:02x}: no selector mask makes the recordings single-valued"));
        // Dedupe to the masked key; the gate already proved same-key spans equal.
        let mut folded: Vec<Variant> = Vec::new();
        for s2 in seen {
            if !folded.iter().any(|(k, ..)| *k == s2.key & mask) {
                folded.push((s2.key & mask, s2.span, s2.kil as u8 | (s2.cin_from_c as u8) << 1, s2.wb));
            }
        }
        masks.push(mask);
        variants_of.push(folded);
    }

    // The reset tail and the h=0 seed. The seed's registers depend on the
    // reset vector and the memory (the golden trace found this: its base
    // is not the recorder's), so reset is recorded under TWO vectors and
    // every field classified: constant, the vector's low or high byte, or
    // the byte the vector points at. A field that classifies as none of
    // those refuses the build.
    let reset_probe = |vec: u16, fill: u8| -> ([u8; 16], Vec<u64>) {
        let mut image = vec![fill; 0x10000];
        image[0xfffc] = vec as u8;
        image[0xfffd] = (vec >> 8) as u8;
        let mut cpu = boot(&image);
        let r0 = cpu.registers();
        let i0 = cpu.internals().expect("the netlist names the internal buses");
        let regs = [
            r0.a, r0.x, r0.y, r0.s, r0.p, r0.pc as u8, (r0.pc >> 8) as u8,
            i0.pclp, i0.pchp, i0.abl, i0.abh, i0.idl, i0.dor, i0.alu, i0.alua, i0.alub,
        ];
        let mut tail = vec![vector(&cpu, &ids)];
        while tail.last().unwrap() >> BIT_SYNC & 1 == 0 {
            cpu.half_step();
            tail.push(vector(&cpu, &ids));
            assert!(tail.len() < 64, "no fetch after reset");
        }
        cpu.half_step();
        tail.push(vector(&cpu, &ids));
        (regs, tail)
    };
    let (va, fa) = (0x0200u16, 0xeau8);
    let (vb, fb) = (0x03ffu16, 0x37u8);
    let (ra, tail) = reset_probe(va, fa);
    let (rb, tail_b) = reset_probe(vb, fb);
    assert_eq!(tail, tail_b, "the reset tail's control vectors depend on the image");
    // 0 constant, 1 vector low, 2 vector high, 3 the byte at the vector.
    let kinds: Vec<u8> = (0..16)
        .map(|i| {
            if ra[i] == rb[i] {
                0
            } else if ra[i] == va as u8 && rb[i] == vb as u8 {
                1
            } else if ra[i] == (va >> 8) as u8 && rb[i] == (vb >> 8) as u8 {
                2
            } else if ra[i] == fa && rb[i] == fb {
                3
            } else {
                panic!("reset field {i}: {:02x} vs {:02x} classifies as nothing", ra[i], rb[i])
            }
        })
        .collect();
    let r0 = ra;

    // Emit: numbers only. The names live in src/lines.rs.
    let mut w = String::with_capacity(1 << 20);
    let mut spans = String::new();
    let mut vtab = String::new();
    let mut ops = String::new();
    let (mut off, mut vi) = (0usize, 0usize);
    for (op, vs) in variants_of.iter().enumerate() {
        let first = vi;
        for (key, span, flags, wb) in vs {
            let _ = writeln!(vtab, "    ({key}, {off}, {}, {}, {wb:#x}),", span.len(), flags);
            for v in span {
                let _ = writeln!(spans, "    {v:#018x},");
            }
            off += span.len();
            vi += 1;
        }
        let _ = writeln!(ops, "    ({first}, {}), // {op:#04x}", vi - first);
    }
    let _ = writeln!(w, "pub const SPAN_WORDS: usize = {off};");
    let _ = writeln!(w, "pub static SPANS: [u64; {off}] = [\n{spans}];");
    let _ = writeln!(w, "/// (selector key, offset into SPANS, half-cycles, flags: bit 0 kil, bit 1 overlap cin from C, seam write-back word)");
    let _ = writeln!(w, "pub static VARIANTS: [(u8, usize, usize, u8, u64); {vi}] = [\n{vtab}];");
    let _ = writeln!(w, "/// Per opcode: (first variant, variant count)");
    let _ = writeln!(w, "pub static OPS: [(usize, usize); 256] = [\n{ops}];");
    let _ = writeln!(w, "pub static KILS: [u8; {}] = {kils:?};", kils.len());
    let _ = writeln!(w, "/// Per opcode: which selector bits partition its lookup.");
    let _ = writeln!(w, "pub static MASKS: [u8; 256] = {masks:?};");
    let _ = writeln!(w, "pub static RESET_TAIL: [u64; {}] = {:?};", tail.len(), tail);
    let _ = writeln!(
        w,
        "/// a x y s p pcl pch pclp pchp abl abh dl dor add ai bi at h=0,\n/// measured under the recorder's vector; RESET_KINDS says how each\n/// follows the machine's own (0 constant, 1 vector low, 2 vector high,\n/// 3 the byte at the vector).\npub static RESET_REGS: [u8; 16] = {r0:?};\npub static RESET_KINDS: [u8; 16] = {kinds:?};"
    );
    let _ = writeln!(
        w,
        "pub fn build_stamp() -> &'static str {{ \"v6502-sim {} over {} nodes {} transistors\" }}",
        env!("CARGO_PKG_VERSION"),
        nl.node_count(),
        nl.transistor_count()
    );
    let out = std::env::var("OUT_DIR").unwrap();
    std::fs::write(Path::new(&out).join("table.rs"), w).unwrap();
    let total: usize = variants_of.iter().map(|v| v.len()).sum();
    println!("cargo:warning=v6502-micro: {total} variants over 256 opcodes, {off} span words, {} KILs, reset tail {} hc", kils.len(), tail.len());
}
