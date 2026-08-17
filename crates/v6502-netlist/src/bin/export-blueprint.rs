//! Writes the derived block diagram to a path, for the web front end to fetch.
//!
//!     cargo run -p v6502-netlist --bin export-blueprint -- web/blueprint.json
//!
//! Nothing here is authored: the units, the edges and their control lines all
//! fall out of switch topology. See `blueprint.rs` for why that is possible.

use v6502_netlist::{mos6502, blueprint::Blueprint};

fn main() -> std::io::Result<()> {
    let path = std::env::args().nth(1).unwrap_or_else(|| "web/blueprint.json".into());
    let nl = mos6502();
    let bp = Blueprint::derive(&nl);
    let json = bp.to_json();

    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, &json)?;

    let c = &bp.coverage;
    println!(
        "wrote {path} ({:.1} KiB): {} units, {} links, {} switches -- \
         {:.0}% of {} transistors",
        json.len() as f64 / 1024.0,
        bp.units.len(),
        bp.links.len(),
        c.transistors_drawn,
        100.0 * c.transistor_fraction(),
        c.transistors_total
    );
    Ok(())
}
