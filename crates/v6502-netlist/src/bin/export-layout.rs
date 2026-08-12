//! Writes the generated layout blob to a path, for the web front end to fetch.
//!
//! The blob is ~1.5 MiB of triangulated die geometry. It lives in a separate
//! file rather than inside the `.wasm` so the simulation stays a small download
//! and the geometry can stream in parallel.
//!
//!     cargo run -p v6502-netlist --bin export-layout -- web/layout.bin

static LAYOUT: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/layout.bin"));

fn main() -> std::io::Result<()> {
    let path = std::env::args().nth(1).unwrap_or_else(|| "web/layout.bin".into());
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, LAYOUT)?;
    println!("wrote {path} ({:.2} MiB)", LAYOUT.len() as f64 / (1024.0 * 1024.0));
    Ok(())
}
