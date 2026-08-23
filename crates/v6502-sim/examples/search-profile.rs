//! What the solver actually looks at, per half-cycle.
//!
//!     cargo run --release -p v6502-sim --features probe \
//!         --example search-profile -- 120 > /tmp/searches.json
//!
//! A recalc is a SEARCH: `build_group` walks out from one seed across
//! conducting transistors and returns everything electrically joined to it.
//! The engine's own `Stats` count those in aggregate; this records each one,
//! so the searches can be joined against the chip atlas and asked which parts
//! of the die the solver spends its time in.
//!
//! Emitted as one JSON object. Parse simple, emit rich: this crate has no JSON
//! library and does not want one, so writing is a format string and reading
//! happens in the analysis script.

use std::fmt::Write as _;
use std::sync::Arc;

use v6502_netlist::mos6502;
use v6502_sim::{bus::FlatMemory, cpu::Cpu};

const BASE: u16 = 0x0200;

fn main() {
    let halves: u64 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(120);

    // The seven shipped programs all measure the same to within noise (the
    // chip does the same fetch, decode and settle work whatever the opcode
    // is), so one representative program is enough and a spread would only
    // suggest a difference that is not there.
    let prog: [u8; 16] = [
        0xa9, 0x2e, 0x69, 0x14, 0x85, 0x82, 0xa2, 0x03, 0xa0, 0x05, 0x8a, 0xa8, 0x98, 0x4c, 0x00,
        0x02,
    ];
    let mut page = vec![0xeau8; 256];
    page[..prog.len()].copy_from_slice(&prog);

    let nl = Arc::new(mos6502());
    let mut mem = FlatMemory::new();
    mem.load(BASE, &page);
    mem.set_reset_vector(BASE);
    let mut cpu = Cpu::new(nl, mem).expect("signals resolve");
    cpu.power_cycle();

    // Recording starts AFTER the reset sequence. Reset is a different workload
    // from running -- it drives nodes the program never touches -- and mixing
    // the two would describe neither.
    cpu.engine_mut().probe_mut().on = true;
    for h in 0..halves {
        cpu.engine_mut().probe_mut().mark(h);
        cpu.half_step();
    }
    cpu.engine_mut().probe_mut().on = false;

    let p = cpu.engine().probe();
    let mut s = String::with_capacity(1 << 22);
    s.push_str("{\"format\":\"search-profile/1\"");
    let _ = write!(s, ",\"halfCycles\":{},\"recalcs\":{}", halves, p.len());
    s.push_str(",\"marks\":[");
    for (i, (label, at)) in p.marks.iter().enumerate() {
        let _ = write!(s, "{}[{},{}]", if i > 0 { "," } else { "" }, label, at);
    }
    s.push_str("],\"seed\":[");
    for (i, n) in p.seed.iter().enumerate() {
        let _ = write!(s, "{}{}", if i > 0 { "," } else { "" }, n);
    }
    s.push_str("],\"changed\":[");
    for (i, c) in p.changed.iter().enumerate() {
        let _ = write!(s, "{}{}", if i > 0 { "," } else { "" }, u8::from(*c));
    }
    // The group of every recalc, as a flat array plus offsets. A list of lists
    // would be three times the bytes for the same information.
    s.push_str("],\"start\":[");
    for (i, a) in p.start.iter().enumerate() {
        let _ = write!(s, "{}{}", if i > 0 { "," } else { "" }, a);
    }
    s.push_str("],\"members\":[");
    for (i, m) in p.members.iter().enumerate() {
        let _ = write!(s, "{}{}", if i > 0 { "," } else { "" }, m);
    }
    s.push_str("]}\n");
    print!("{s}");

    let st = cpu.engine().stats();
    eprintln!(
        "{halves} half-cycles: {} recalcs, {} group members, {} rounds, {} settles",
        st.node_recalcs, st.group_members, st.rounds, st.settles
    );
}
