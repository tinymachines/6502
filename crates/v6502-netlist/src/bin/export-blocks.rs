//! Writes the derived functional blocks to a path, for the web front end.
//!
//!     cargo run -p v6502-netlist --bin export-blocks -- web/blocks.json
//!
//! Nothing here is authored either. The blocks are seeded from the names the die
//! carries and grown along the wiring; see `blocks.rs` for why that works and
//! for what it deliberately leaves unclassified.

use v6502_netlist::{blocks::Blocks, Netlist};

fn main() -> std::io::Result<()> {
    let path = std::env::args().nth(1).unwrap_or_else(|| "web/blocks.json".into());
    let nl = Netlist::mos6502();
    let b = Blocks::derive(&nl);
    let json = b.to_json(&nl);

    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, &json)?;

    let placed = nl.transistor_count() - b.unclassified_transistors();
    println!(
        "wrote {path} ({:.1} KiB): {} blocks, {placed} of {} transistors placed ({:.0}%), \
         {} nodes named",
        json.len() as f64 / 1024.0,
        b.blocks.len() - 1,
        nl.transistor_count(),
        100.0 * placed as f64 / nl.transistor_count() as f64,
        b.blocks.iter().skip(1).map(|x| x.seeded).sum::<usize>()
    );
    for x in b.blocks.iter().skip(1) {
        println!(
            "  {:<22} {:>4} nodes ({:>3.0}% named) {:>5} transistors",
            x.name,
            x.nodes.len(),
            100.0 * x.seeded_fraction(),
            x.transistors.len()
        );
    }
    println!(
        "  {:<22} {:>4} nodes {:>16} transistors",
        "(unclassified)",
        b.unclassified_nodes(),
        b.unclassified_transistors()
    );
    Ok(())
}
