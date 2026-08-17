//! Writes the recognised gate-level schematic for the web front end.
//!
//!     cargo run -p v6502-netlist --bin export-schematic -- web/schematic.json
//!
//! The whole netlist goes out as gates and switches rather than as cones: cone
//! extraction is cheap, and doing it in the page means the reader can re-root
//! anywhere and change depth without another fetch.

use v6502_netlist::blocks::Blocks;
use v6502_netlist::blueprint::Blueprint;
use v6502_netlist::pla::Pla;
use v6502_netlist::schematic::{Kind, Schematic};
use v6502_netlist::{mos6502, NodeId};

fn main() -> std::io::Result<()> {
    let path = std::env::args().nth(1).unwrap_or_else(|| "web/schematic.json".into());
    let nl = mos6502();
    let sc = Schematic::derive(&nl);

    let kind_index = |k: Kind| match k {
        Kind::Inverter => 0,
        Kind::Nor => 1,
        Kind::Nand => 2,
        Kind::Aoi => 3,
        Kind::Dynamic => 4,
    };

    // What a signal *is*, derived from the passes that already know. The page
    // needs this to answer "what is dpc3_SBX" with facts rather than with a
    // naming convention, and deriving it here rather than fetching three more
    // files at runtime keeps one source of truth for node numbering.
    let blocks = Blocks::derive(&nl);
    let pla = Pla::derive(&nl);
    let bp = Blueprint::derive(&nl);

    let mut role = vec![0u8; nl.node_count()];
    for r in &pla.rows {
        role[r.node as usize] = 1; // a product term of the decode PLA
    }
    for o in &pla.outputs {
        role[o.node as usize] = 2; // a decode control line
    }

    // A control line's job, as the blueprint measured it: the two datapath
    // units it joins and the bits it carries. This is what makes "SBX" mean
    // something without anyone asserting that S-B-X stands for anything.
    let mut paths: Vec<(NodeId, &str, &str, u8)> = Vec::new();
    for link in &bp.links {
        paths.push((
            link.control_node,
            bp.units[link.a].name.as_str(),
            bp.units[link.b].name.as_str(),
            link.bits,
        ));
    }
    paths.sort_by_key(|p| p.0);

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

    s.push_str("  \"blockNames\": [");
    for (i, b) in blocks.blocks.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!("{:?}", b.name));
    }
    s.push_str("],\n  \"nodeBlock\": [");
    for n in 0..nl.node_count() {
        if n > 0 {
            s.push(',');
        }
        s.push_str(&blocks.of_node(n as NodeId).to_string());
    }
    s.push_str("],\n  \"nodeFanout\": [");
    for n in 0..nl.node_count() {
        if n > 0 {
            s.push(',');
        }
        s.push_str(&nl.gates_of(n as NodeId).len().to_string());
    }
    s.push_str("],\n  \"nodeRole\": [");
    for n in 0..nl.node_count() {
        if n > 0 {
            s.push(',');
        }
        s.push_str(&role[n].to_string());
    }
    s.push_str("],\n  \"controlPaths\": [\n");
    for (i, (node, a, b, bits)) in paths.iter().enumerate() {
        s.push_str(&format!(
            "    [{},{:?},{:?},{}]{}\n",
            node,
            a,
            b,
            bits,
            if i + 1 < paths.len() { "," } else { "" }
        ));
    }
    s.push_str("  ],\n");

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
