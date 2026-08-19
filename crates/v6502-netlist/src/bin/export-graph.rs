//! Writes the chip as one node-and-edge graph, for anything that wants the
//! network without learning the gate and switch encoding.
//!
//!     cargo run -p v6502-netlist --bin export-graph -- web/graph.json
//!
//! Three layers in one file, all from the same netlist, schematic, blocks and
//! layout the other exports use, so none of it can disagree with them:
//!
//!  - `nodes`: every node by index (the die's own numbering), with its name,
//!    functional block, role, pullup flag, centroid and the block its gate
//!    drives, when it is a static gate.
//!  - `transistors`: every one of the 3510 as `{gate, c1, c2}`, by the die's
//!    own transistor number. That is the whole chip as a hypergraph, every
//!    edge a transistor joining two nodes and labelled by a third, and it is
//!    the truth the rest is read from. `kind` is the simplest per-transistor
//!    reading (a terminal on vss is a pulldown, on vcc a pullup, neither a
//!    pass transistor); the gate recognition below absorbs series chains and
//!    is the interpreted one.
//!  - `edges`: the interpreted circuit the pages draw. A `gate` edge runs from
//!    a gate input to the output it helps produce (one per distinct pair); a
//!    `switch` edge joins the two terminals of a pass transistor with its
//!    control riding on it (one per switch transistor: 70 of the 873 are
//!    parallel pairs on the same ends under the same control, and `t` tells
//!    them apart). A rail is never a gate edge's OUTPUT, because a pulldown to
//!    vss is the gate, not a wire; vss does appear as an INPUT on the few
//!    gates with a leg gated by it, the permanently-off transistors the
//!    pinout page's direction rule turns on.
//!
//! Centroids are the mean of a node's own polygon vertices out of layout.bin,
//! Y flipped for display, computed here exactly as `web/die-centroids.js`
//! computes them, and `_graph-test.html` compares the two.

use v6502_netlist::blocks::Blocks;
use v6502_netlist::pla::Pla;
use v6502_netlist::schematic::Schematic;
use v6502_netlist::{mos6502, NodeId};

static LAYOUT: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/layout.bin"));

/// Node centroids and the die bounds, read the way die-centroids.js reads them.
fn centroids(node_count: usize) -> (Vec<Option<(f64, f64)>>, (u16, u16, u16, u16)) {
    let u16at = |o: usize| u16::from_le_bytes([LAYOUT[o], LAYOUT[o + 1]]);
    let u32at = |o: usize| u32::from_le_bytes([LAYOUT[o], LAYOUT[o + 1], LAYOUT[o + 2], LAYOUT[o + 3]]);
    assert_eq!(&LAYOUT[0..8], b"V6502LAY", "layout.bin: bad magic");
    let vertex_count = u32at(12) as usize;
    let bounds = (u16at(24), u16at(26), u16at(28), u16at(30));
    let vertex_offset = u32at(32) as usize;
    let mut sx = vec![0f64; node_count];
    let mut sy = vec![0f64; node_count];
    let mut n = vec![0u32; node_count];
    for i in 0..vertex_count {
        let o = vertex_offset + i * 6;
        let node = u16at(o + 4) as usize;
        if node >= node_count {
            continue;
        }
        sx[node] += u16at(o) as f64;
        sy[node] += u16at(o + 2) as f64;
        n[node] += 1;
    }
    let (_, ymin, _, ymax) = bounds;
    let pos = (0..node_count)
        .map(|i| {
            if n[i] == 0 {
                None
            } else {
                let k = n[i] as f64;
                Some((sx[i] / k, ymax as f64 - (sy[i] / k) + ymin as f64))
            }
        })
        .collect();
    (pos, bounds)
}

fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn main() -> std::io::Result<()> {
    let path = std::env::args().nth(1).unwrap_or_else(|| "web/graph.json".into());
    let nl = mos6502();
    let sc = Schematic::derive(&nl);
    let blocks = Blocks::derive(&nl);
    let pla = Pla::derive(&nl);
    let n_nodes = nl.node_count();
    let (pos, bounds) = centroids(n_nodes);

    let mut role = vec![0u8; n_nodes];
    for r in &pla.rows {
        role[r.node as usize] = 1;
    }
    for o in &pla.outputs {
        role[o.node as usize] = 2;
    }
    let vss = nl.vss();
    let vcc = nl.vcc();

    // Gate edges: one per distinct (input, output) pair.
    let mut gate_edges: Vec<(NodeId, NodeId)> = Vec::new();
    for g in &sc.gates {
        for i in g.inputs() {
            gate_edges.push((i, g.out));
        }
    }
    gate_edges.sort_unstable();
    gate_edges.dedup();

    let mut s = String::with_capacity(1 << 19);
    s.push_str("{\n  \"format\": \"v6502 graph 1\",\n");
    s.push_str(&format!(
        "  \"counts\": {{\"nodes\":{},\"named\":{},\"transistors\":{},\"gates\":{},\"gateEdges\":{},\"switchEdges\":{},\"edges\":{}}},\n",
        n_nodes,
        (0..n_nodes).filter(|&n| nl.name_of(n as NodeId).is_some()).count(),
        nl.transistor_count(),
        sc.gates.len(),
        gate_edges.len(),
        sc.switches.len(),
        gate_edges.len() + sc.switches.len()
    ));
    s.push_str(&format!("  \"rails\": {{\"vss\":{vss},\"vcc\":{vcc}}},\n"));
    s.push_str(&format!(
        "  \"bounds\": {{\"xmin\":{},\"ymin\":{},\"xmax\":{},\"ymax\":{}}},\n",
        bounds.0, bounds.1, bounds.2, bounds.3
    ));
    s.push_str("  \"blockNames\": [");
    for (i, b) in blocks.blocks.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&json_str(&b.name));
    }
    s.push_str("],\n");
    s.push_str("  \"roles\": [\"signal\",\"decode term\",\"control line\"],\n");
    s.push_str("  \"transistorKinds\": [\"pass\",\"pulldown\",\"pullup\",\"rails\"],\n");
    s.push_str("  \"edgeKinds\": [\"gate\",\"switch\"],\n");

    // Nodes, one object per line, by index. A node the die data does not
    // define (a gap in the numbering) is null, so the array stays indexable.
    s.push_str("  \"nodes\": [\n");
    for n in 0..n_nodes {
        let id = n as NodeId;
        if n > 0 {
            s.push_str(",\n");
        }
        if !nl.exists(id) {
            s.push_str("    null");
            continue;
        }
        let name = match nl.name_of(id) {
            Some(nm) => json_str(nm),
            None => "null".into(),
        };
        let (x, y) = match pos[n] {
            Some((x, y)) => (format!("{x:.2}"), format!("{y:.2}")),
            None => ("null".into(), "null".into()),
        };
        let drives = blocks.drives(id);
        s.push_str(&format!(
            "    {{\"id\":{n},\"name\":{name},\"block\":{},\"seeded\":{},\"role\":{},\"pullup\":{},\"x\":{x},\"y\":{y},\"drives\":{}}}",
            blocks.of_node(id),
            if blocks.was_seeded(id) { "true" } else { "false" },
            role[n],
            if nl.pullups().get(n) { "true" } else { "false" },
            if drives == 0 { "null".to_string() } else { drives.to_string() },
        ));
    }
    s.push_str("\n  ],\n");

    // Transistors, by the die's own number.
    s.push_str("  \"transistors\": [\n");
    for t in 0..nl.transistor_count() {
        let t = t as u16;
        let (g, c1, c2) = (nl.transistor_gate(t), nl.transistor_c1(t), nl.transistor_c2(t));
        let kind = if nl.is_rail(c1) {
            3
        } else if c2 == vss {
            1
        } else if c2 == vcc {
            2
        } else {
            0
        };
        if t > 0 {
            s.push_str(",\n");
        }
        s.push_str(&format!(
            "    {{\"id\":{t},\"gate\":{g},\"c1\":{c1},\"c2\":{c2},\"kind\":{kind},\"block\":{}}}",
            blocks.of_transistor(t)
        ));
    }
    s.push_str("\n  ],\n");

    // Edges: gate edges first, then switches.
    s.push_str("  \"edges\": [\n");
    let mut first = true;
    for (a, b) in &gate_edges {
        if !first {
            s.push_str(",\n");
        }
        first = false;
        s.push_str(&format!("    {{\"kind\":0,\"a\":{a},\"b\":{b}}}"));
    }
    for sw in &sc.switches {
        if !first {
            s.push_str(",\n");
        }
        first = false;
        s.push_str(&format!(
            "    {{\"kind\":1,\"a\":{},\"b\":{},\"control\":{},\"t\":{}}}",
            sw.a, sw.b, sw.control, sw.transistor
        ));
    }
    s.push_str("\n  ]\n}\n");

    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, &s)?;
    println!(
        "wrote {path}: {} nodes, {} transistors, {} gate edges + {} switches ({:.0} KiB)",
        n_nodes,
        nl.transistor_count(),
        gate_edges.len(),
        sc.switches.len(),
        s.len() as f64 / 1024.0
    );
    Ok(())
}
