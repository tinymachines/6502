//! Converts the visual6502 JavaScript die data into a compact binary netlist.
//!
//! Runs at build time against `extern/visual6502/{segdefs,transdefs,nodenames}.js`
//! and writes `netlist.bin` into OUT_DIR, which `lib.rs` embeds with
//! `include_bytes!`. Nothing generated is checked in, and the ~1.4 MB of
//! JavaScript never ships.
//!
//! See NOTICE.md: the die data is CC BY-NC-SA 3.0, unlike this code.

use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// A tolerant parser for the JS-literal subset these three data files use:
// arrays, objects with bare-identifier or quoted keys, single/double quoted
// strings, integers (including negatives), comments and trailing commas.
// ---------------------------------------------------------------------------

/// A little-endian byte sink for this crate's own blobs.
///
/// The netlist blob is `halfphi`'s format and is written there. These two are
/// ours: `layout.bin` is geometry for the renderer and `centroids.bin` is where
/// each node sits on the die, and neither is anything a simulator needs.
struct Blob(Vec<u8>);

impl Blob {
    fn u16(&mut self, v: u16) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
}

struct Polygon {
    layer: u8,
    node: u16,
    pts: Vec<(u16, u16)>,
}

/// Number of mask layers in the die data (see `layernames` in expertWires.js):
/// metal, switched diffusion, inputdiode, grounded diffusion, powered diffusion,
/// polysilicon.
const LAYER_COUNT: usize = 6;

const LAYOUT_MAGIC: &[u8; 8] = b"V6502LAY";
const CENTROID_MAGIC: &[u8; 8] = b"V6502CEN";
/// Byte offset at which the vertex array starts. Fixed so the JS side can build
/// typed-array views without arithmetic, and 4-byte aligned for `Uint16Array`.
const LAYOUT_HEADER_LEN: usize = 96;

/// Triangulate every polygon and emit a GPU-ready vertex buffer.
///
/// Two decisions worth knowing:
///
/// * Triangulation happens here, at build time, not at load time. The layout is
///   static for the life of the program -- only *colours* change per frame -- so
///   the renderer uploads this once and thereafter touches nothing but a
///   1725-byte node-state texture.
/// * Vertices are sorted by layer into contiguous runs, so each layer is one
///   draw call and toggling a layer costs nothing.
///
/// Coordinates stay in raw die space (x 214..8983, y 179..9807). The Y flip the
/// original applied at draw time belongs in the projection matrix, not baked
/// into the data.
fn build_layout(polygons: &[Polygon], bboxes: &[[u16; 4]]) -> Result<(Vec<u8>, String), String> {
    let mut by_layer: Vec<&Polygon> = polygons.iter().collect();
    by_layer.sort_by_key(|p| p.layer);

    // x:u16, y:u16, node:u16 per vertex.
    let mut vertices: Vec<u16> = Vec::with_capacity(256 * 1024);
    let mut ranges = [(0u32, 0u32); LAYER_COUNT];
    let mut degenerate = 0usize;

    for layer in 0..LAYER_COUNT as u8 {
        let start = (vertices.len() / 3) as u32;
        for poly in by_layer.iter().filter(|p| p.layer == layer) {
            let flat: Vec<f64> =
                poly.pts.iter().flat_map(|&(x, y)| [x as f64, y as f64]).collect();
            let Ok(indices) = earcutr::earcut(&flat, &[], 2) else {
                degenerate += 1;
                continue;
            };
            if indices.is_empty() {
                // Collinear or zero-area: nothing to fill, and not an error --
                // the die data contains a few such slivers.
                degenerate += 1;
                continue;
            }
            for i in indices {
                let (x, y) = poly.pts[i];
                vertices.extend_from_slice(&[x, y, poly.node]);
            }
        }
        let count = (vertices.len() / 3) as u32 - start;
        ranges[layer as usize] = (start, count);
    }

    let vertex_count = (vertices.len() / 3) as u32;
    let (mut xmin, mut ymin, mut xmax, mut ymax) = (u16::MAX, u16::MAX, 0u16, 0u16);
    for p in polygons {
        for &(x, y) in &p.pts {
            xmin = xmin.min(x);
            ymin = ymin.min(y);
            xmax = xmax.max(x);
            ymax = ymax.max(y);
        }
    }

    let vertex_offset = LAYOUT_HEADER_LEN as u32;
    let transistor_offset = vertex_offset + vertex_count * 6;

    let mut b = Blob(Vec::with_capacity(transistor_offset as usize + bboxes.len() * 8));
    b.0.extend_from_slice(LAYOUT_MAGIC);
    b.u32(1); // version
    b.u32(vertex_count);
    b.u32(LAYER_COUNT as u32);
    b.u32(bboxes.len() as u32);
    b.u16(xmin);
    b.u16(ymin);
    b.u16(xmax);
    b.u16(ymax);
    b.u32(vertex_offset);
    b.u32(transistor_offset);
    for (start, count) in ranges {
        b.u32(start);
        b.u32(count);
    }
    assert!(b.0.len() <= LAYOUT_HEADER_LEN, "layout header overflowed its reserved space");
    b.0.resize(LAYOUT_HEADER_LEN, 0);

    for v in &vertices {
        b.u16(*v);
    }
    for bb in bboxes {
        for v in bb {
            b.u16(*v);
        }
    }

    let summary = format!(
        "{} polygons -> {} triangles ({} vertices), {} degenerate, {:.1} MiB",
        polygons.len(),
        vertex_count / 3,
        vertex_count,
        degenerate,
        b.0.len() as f64 / (1024.0 * 1024.0)
    );
    Ok((b.0, summary))
}

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let refdir = manifest.join("../../extern/visual6502");

    for f in ["segdefs.js", "transdefs.js", "nodenames.js"] {
        println!("cargo:rerun-if-changed={}", refdir.join(f).display());
    }
    println!("cargo:rerun-if-changed=build.rs");

    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    match build(&refdir, &out) {
        Ok(summary) => println!("cargo:warning=v6502-netlist: {summary}"),
        Err(e) => panic!("failed to build netlist from {}: {e}", refdir.display()),
    }
}

fn build(refdir: &Path, out: &Path) -> Result<String, String> {
    // The die data, parsed by the library rather than by this script. Rails are
    // named rather than assumed: the 6502 and the Z80 call ground `vss` and the
    // 6800 calls it `gnd`, and a parser that hardcodes one spelling is how a
    // library ends up quietly about one chip.
    let read = |f: &str| -> Result<String, String> {
        fs::read_to_string(refdir.join(f)).map_err(|e| format!("{f}: {e}"))
    };
    let parsed = halfphi::source::parse(&halfphi::ChipSource {
        segdefs: &read("segdefs.js")?,
        transdefs: &read("transdefs.js")?,
        nodenames: &read("nodenames.js")?,
        rails: halfphi::Rails { ground: "vss", supply: "vcc" },
    })?;
    let node_count = parsed.node_count;
    let polygons: Vec<Polygon> = parsed
        .polygons
        .iter()
        .map(|p| Polygon { layer: p.layer, node: p.node, pts: p.pts.clone() })
        .collect();
    let bboxes = parsed.gate_boxes.clone();
    let gated_by_rail = parsed.gated_by_supply;

    let path = out.join("netlist.bin");
    fs::write(&path, &parsed.blob).map_err(|e| format!("writing {}: {e}", path.display()))?;

    // --- layout: geometry for the renderer, kept in a separate blob ---
    //
    // This is ~1.5 MiB and only the renderer wants it, so it is never embedded
    // in the simulation crates. `cargo run -p v6502-netlist --bin export-layout`
    // writes it out for the web front end to fetch.
    let (layout, layout_summary) = build_layout(&polygons, &bboxes)?;
    let layout_path = out.join("layout.bin");
    fs::write(&layout_path, &layout)
        .map_err(|e| format!("writing {}: {e}", layout_path.display()))?;

    // --- centroids: where each node sits on the die ---
    //
    // The blueprint derivation orders its columns and rails by real die
    // position, so the idealised drawing is a *monotone remap* of the silicon
    // rather than an independent invention -- a reader can carry left-of/
    // above-of relationships between the two views. That needs one point per
    // node, which the simulation itself has no use for, so it goes in its own
    // small blob rather than into `netlist.bin`.
    //
    // The mean of per-polygon centroids, not of raw vertices: a node with one
    // sprawling polygon and twenty small ones should not be dragged toward
    // whichever happens to have the most points.
    let mut sums = vec![(0f64, 0f64, 0u32); node_count];
    for p in &polygons {
        let n = p.node as usize;
        let cx = p.pts.iter().map(|q| q.0 as f64).sum::<f64>() / p.pts.len() as f64;
        let cy = p.pts.iter().map(|q| q.1 as f64).sum::<f64>() / p.pts.len() as f64;
        sums[n].0 += cx;
        sums[n].1 += cy;
        sums[n].2 += 1;
    }
    let mut c = Blob(Vec::with_capacity(8 + 4 + node_count * 4));
    c.0.extend_from_slice(CENTROID_MAGIC);
    c.u32(node_count as u32);
    for (sx, sy, n) in &sums {
        if *n == 0 {
            // No geometry: not placeable. NO_CENTROID rather than (0,0), which
            // is a real corner of the die and would silently anchor a column.
            c.u16(u16::MAX);
            c.u16(u16::MAX);
        } else {
            c.u16((sx / *n as f64).round() as u16);
            c.u16((sy / *n as f64).round() as u16);
        }
    }
    let cen_path = out.join("centroids.bin");
    fs::write(&cen_path, &c.0).map_err(|e| format!("writing {}: {e}", cen_path.display()))?;

    let mut summary = String::new();
    let _ = write!(
        summary,
        "{} nodes, {} transistors, {} names, {} KiB; layout: {}",
        node_count,
        parsed.transistor_count,
        parsed.name_count,
        parsed.blob.len() / 1024,
        layout_summary
    );
    if gated_by_rail > 0 {
        let _ = write!(
            summary,
            "; WARNING {gated_by_rail} transistors gated by vcc will be stuck off"
        );
    }
    Ok(summary)
}
