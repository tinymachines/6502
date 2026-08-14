//! Writes the recognised gate-level schematic for the web front end.
//!
//!     cargo run -p v6502-netlist --bin export-schematic -- web/schematic.json
//!
//! The whole netlist goes out as gates and switches rather than as cones: cone
//! extraction is cheap, and doing it in the page means the reader can re-root
//! anywhere and change depth without another fetch.

use v6502_netlist::schematic::{Kind, Schematic};
use v6502_netlist::{Netlist, NodeId};

fn main() -> std::io::Result<()> {
    let path = std::env::args().nth(1).unwrap_or_else(|| "web/schematic.json".into());
    let nl = Netlist::mos6502();
    let sc = Schematic::derive(&nl);

    let kind_index = |k: Kind| match k {
        Kind::Inverter => 0,
        Kind::Nor => 1,
        Kind::Nand => 2,
        Kind::Aoi => 3,
        Kind::Dynamic => 4,
    };

    let mut s = String::with_capacity(1 << 19);
    s.push_str("{\n  \"kinds\": [\"inverter\",\"nor\",\"nand\",\"aoi\",\"dynamic\"],\n");

    let (inv, nor, nand, aoi, dyn_) = sc.counts();
    s.push_str(&format!(
        "  \"counts\": {{\"inverter\":{inv},\"nor\":{nor},\"nand\":{nand},\"aoi\":{aoi},\
         \"dynamic\":{dyn_},\"gates\":{},\"switches\":{},\"absorbed\":{},\"transistors\":{},\
         \"sharedPulldowns\":{},\"unresolved\":{}}},\n",
        sc.gates.len(),
        sc.switches.len(),
        sc.absorbed(),
        nl.transistor_count(),
        sc.shared_pulldowns(),
        sc.unresolved.len()
    ));

    // Names, indexed by node. The page needs them for labels and for the signal
    // picker, and fetching them separately would be a second chance for the two
    // to disagree about node numbering.
    s.push_str("  \"names\": [");
    for n in 0..nl.node_count() {
        if n > 0 {
            s.push(',');
        }
        match nl.name_of(n as NodeId) {
            Some(name) => s.push_str(&format!("{name:?}")),
            None => s.push_str("null"),
        }
    }
    s.push_str("],\n");

    // [out, kind, precharge, [[literal,...], ...]]
    s.push_str("  \"gates\": [\n");
    for (i, g) in sc.gates.iter().enumerate() {
        let terms: Vec<String> = g
            .terms
            .iter()
            .map(|t| {
                let lits: Vec<String> = t.iter().map(|n| n.to_string()).collect();
                format!("[{}]", lits.join(","))
            })
            .collect();
        s.push_str(&format!(
            "    [{},{},{},[{}]]{}\n",
            g.out,
            kind_index(g.kind),
            g.precharge.map_or(-1i32, |p| p as i32),
            terms.join(","),
            if i + 1 < sc.gates.len() { "," } else { "" }
        ));
    }
    s.push_str("  ],\n  \"switches\": [\n");
    for (i, w) in sc.switches.iter().enumerate() {
        s.push_str(&format!(
            "    [{},{},{}]{}\n",
            w.control,
            w.a,
            w.b,
            if i + 1 < sc.switches.len() { "," } else { "" }
        ));
    }
    s.push_str("  ],\n  \"unresolved\": [\n");
    for (i, u) in sc.unresolved.iter().enumerate() {
        s.push_str(&format!(
            "    {{\"node\":{},\"reason\":{:?}}}{}\n",
            u.node,
            u.reason,
            if i + 1 < sc.unresolved.len() { "," } else { "" }
        ));
    }
    s.push_str("  ],\n");
    s.push_str(&format!("  \"vss\": {}, \"vcc\": {}\n}}\n", nl.vss(), nl.vcc()));

    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, &s)?;

    println!(
        "wrote {path} ({:.0} KiB): {} gates (inv {inv}, nor {nor}, nand {nand}, aoi {aoi}, \
         dynamic {dyn_}) + {} switches; {} of {} transistors inside gates; {} unresolved",
        s.len() as f64 / 1024.0,
        sc.gates.len(),
        sc.switches.len(),
        sc.absorbed(),
        nl.transistor_count(),
        sc.unresolved.len()
    );
    Ok(())
}
