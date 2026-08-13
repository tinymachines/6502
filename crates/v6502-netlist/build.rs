//! Converts the visual6502 JavaScript die data into a compact binary netlist.
//!
//! Runs at build time against `extern/visual6502/{segdefs,transdefs,nodenames}.js`
//! and writes `netlist.bin` into OUT_DIR, which `lib.rs` embeds with
//! `include_bytes!`. Nothing generated is checked in, and the ~1.4 MB of
//! JavaScript never ships.
//!
//! See NOTICE.md: the die data is CC BY-NC-SA 3.0, unlike this code.

use std::collections::HashMap;
use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// A tolerant parser for the JS-literal subset these three data files use:
// arrays, objects with bare-identifier or quoted keys, single/double quoted
// strings, integers (including negatives), comments and trailing commas.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum Val {
    Num(i64),
    Str(String),
    Arr(Vec<Val>),
    Obj(Vec<(String, Val)>),
}

impl Val {
    fn as_num(&self) -> Option<i64> {
        match self {
            Val::Num(n) => Some(*n),
            _ => None,
        }
    }
    fn as_str(&self) -> Option<&str> {
        match self {
            Val::Str(s) => Some(s),
            _ => None,
        }
    }
    fn as_arr(&self) -> Option<&[Val]> {
        match self {
            Val::Arr(a) => Some(a),
            _ => None,
        }
    }
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl<'a> Parser<'a> {
    fn new(s: &'a str) -> Self {
        Parser { s: s.as_bytes(), i: 0 }
    }

    fn skip_trivia(&mut self) {
        loop {
            while self.i < self.s.len() && (self.s[self.i] as char).is_ascii_whitespace() {
                self.i += 1;
            }
            if self.s[self.i..].starts_with(b"//") {
                while self.i < self.s.len() && self.s[self.i] != b'\n' {
                    self.i += 1;
                }
            } else if self.s[self.i..].starts_with(b"/*") {
                self.i += 2;
                while self.i < self.s.len() && !self.s[self.i..].starts_with(b"*/") {
                    self.i += 1;
                }
                self.i = (self.i + 2).min(self.s.len());
            } else {
                return;
            }
        }
    }

    fn peek(&mut self) -> u8 {
        self.skip_trivia();
        if self.i < self.s.len() {
            self.s[self.i]
        } else {
            0
        }
    }

    fn parse_value(&mut self) -> Result<Val, String> {
        match self.peek() {
            b'[' => self.parse_array(),
            b'{' => self.parse_object(),
            b'\'' | b'"' => Ok(Val::Str(self.parse_string()?)),
            c if c == b'-' || c == b'+' || c.is_ascii_digit() => self.parse_number(),
            c => Err(format!("unexpected byte {:?} at offset {}", c as char, self.i)),
        }
    }

    fn parse_array(&mut self) -> Result<Val, String> {
        self.i += 1; // '['
        let mut out = Vec::new();
        loop {
            if self.peek() == b']' {
                self.i += 1;
                return Ok(Val::Arr(out));
            }
            out.push(self.parse_value()?);
            match self.peek() {
                b',' => self.i += 1,
                b']' => {}
                c => return Err(format!("expected , or ] got {:?} at {}", c as char, self.i)),
            }
        }
    }

    fn parse_object(&mut self) -> Result<Val, String> {
        self.i += 1; // '{'
        let mut out = Vec::new();
        loop {
            if self.peek() == b'}' {
                self.i += 1;
                return Ok(Val::Obj(out));
            }
            let key = match self.peek() {
                b'\'' | b'"' => self.parse_string()?,
                _ => {
                    let start = self.i;
                    while self.i < self.s.len()
                        && (self.s[self.i].is_ascii_alphanumeric()
                            || self.s[self.i] == b'_'
                            || self.s[self.i] == b'$')
                    {
                        self.i += 1;
                    }
                    if start == self.i {
                        return Err(format!("empty object key at {}", self.i));
                    }
                    String::from_utf8_lossy(&self.s[start..self.i]).into_owned()
                }
            };
            if self.peek() != b':' {
                return Err(format!("expected : after key {key:?} at {}", self.i));
            }
            self.i += 1;
            let value = self.parse_value()?;
            out.push((key, value));
            match self.peek() {
                b',' => self.i += 1,
                b'}' => {}
                c => return Err(format!("expected , or }} got {:?} at {}", c as char, self.i)),
            }
        }
    }

    fn parse_string(&mut self) -> Result<String, String> {
        let quote = self.s[self.i];
        self.i += 1;
        let start = self.i;
        while self.i < self.s.len() && self.s[self.i] != quote {
            self.i += 1;
        }
        let out = String::from_utf8_lossy(&self.s[start..self.i]).into_owned();
        self.i += 1; // closing quote
        Ok(out)
    }

    fn parse_number(&mut self) -> Result<Val, String> {
        let start = self.i;
        if self.s[self.i] == b'-' || self.s[self.i] == b'+' {
            self.i += 1;
        }
        while self.i < self.s.len() && (self.s[self.i].is_ascii_digit() || self.s[self.i] == b'.') {
            self.i += 1;
        }
        let text = String::from_utf8_lossy(&self.s[start..self.i]);
        // The data files are all-integer; tolerate a trailing ".0" defensively.
        let text = text.split('.').next().unwrap_or("");
        text.parse::<i64>()
            .map(Val::Num)
            .map_err(|e| format!("bad number {text:?} at {start}: {e}"))
    }
}

/// Find `var <name> = <value>` (or `<name> = <value>`) and parse the literal.
fn parse_decl(src: &str, name: &str) -> Result<Val, String> {
    let pat = format!("{name} =");
    let alt = format!("{name}=");
    let at = src
        .find(&pat)
        .map(|p| p + pat.len())
        .or_else(|| src.find(&alt).map(|p| p + alt.len()))
        .ok_or_else(|| format!("declaration of `{name}` not found"))?;
    let mut p = Parser::new(&src[at..]);
    p.parse_value()
}

// ---------------------------------------------------------------------------
// Binary encoding
// ---------------------------------------------------------------------------

const MAGIC: &[u8; 8] = b"V6502NL1";

struct Blob(Vec<u8>);

impl Blob {
    fn u16(&mut self, v: u16) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn i32(&mut self, v: i32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn bits(&mut self, flags: &[bool]) {
        for chunk in flags.chunks(8) {
            let mut byte = 0u8;
            for (i, &b) in chunk.iter().enumerate() {
                if b {
                    byte |= 1 << i;
                }
            }
            self.0.push(byte);
        }
    }
}

/// One filled shape on one mask layer, belonging to one node.
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
    let read = |f: &str| -> Result<String, String> {
        fs::read_to_string(refdir.join(f)).map_err(|e| format!("{f}: {e}"))
    };

    // --- nodenames: name -> node number (values may be -1 for "no such bit") ---
    let nodenames = parse_decl(&read("nodenames.js")?, "nodenames")?;
    let Val::Obj(entries) = &nodenames else {
        return Err("nodenames is not an object".into());
    };
    let mut names: Vec<(String, i32)> = Vec::with_capacity(entries.len());
    let mut name_to_node: HashMap<&str, i64> = HashMap::new();
    for (k, v) in entries {
        let n = v.as_num().ok_or_else(|| format!("nodename {k} is not a number"))?;
        names.push((k.clone(), n as i32));
        name_to_node.insert(k.as_str(), n);
    }
    let vss = *name_to_node.get("vss").ok_or("no vss in nodenames")? as u32;
    let vcc = *name_to_node.get("vcc").ok_or("no vcc in nodenames")? as u32;

    // --- segdefs: [node, '+'|'-' pullup, layer, x0,y0, x1,y1, ...] ---
    // One polygon per entry; a node owns many. Only the node number and the
    // pullup flag matter to the simulation.
    //
    // Faithful detail: the reference sets pullup when it FIRST sees a node and
    // never revisits it, so a later polygon for the same node cannot change it.
    // Replicated here -- OR-ing the flags instead would alter the netlist.
    let segdefs = parse_decl(&read("segdefs.js")?, "segdefs")?;
    let segs = segdefs.as_arr().ok_or("segdefs is not an array")?;
    let mut node_count = 0usize;
    for s in segs {
        let a = s.as_arr().ok_or("segdef entry is not an array")?;
        let n = a
            .first()
            .and_then(Val::as_num)
            .ok_or("segdef entry has no node number")? as usize;
        node_count = node_count.max(n + 1);
    }
    let mut exists = vec![false; node_count];
    let mut pullup = vec![false; node_count];
    let mut polygons: Vec<Polygon> = Vec::with_capacity(segs.len());
    for s in segs {
        let a = s.as_arr().unwrap();
        let n = a[0].as_num().unwrap() as usize;
        if !exists[n] {
            // First sighting wins for the pullup flag -- see above.
            exists[n] = true;
            pullup[n] = a.get(1).and_then(Val::as_str) == Some("+");
        }
        // Geometry, in contrast, accumulates: a node owns every polygon that
        // names it.
        let layer = a.get(2).and_then(Val::as_num).ok_or("segdef entry has no layer")? as u8;
        let coords = &a[3..];
        if coords.len() < 6 || coords.len() % 2 != 0 {
            continue; // fewer than 3 points cannot be filled
        }
        let mut pts = Vec::with_capacity(coords.len() / 2);
        for xy in coords.chunks_exact(2) {
            let x = xy[0].as_num().ok_or("non-numeric polygon x")?;
            let y = xy[1].as_num().ok_or("non-numeric polygon y")?;
            pts.push((x as u16, y as u16));
        }
        polygons.push(Polygon { layer, node: n as u16, pts });
    }

    // --- transdefs: ['name', gate, c1, c2, [bb], [geometry]] ---
    let transdefs = parse_decl(&read("transdefs.js")?, "transdefs")?;
    let trans = transdefs.as_arr().ok_or("transdefs is not an array")?;
    let mut tg = Vec::with_capacity(trans.len());
    let mut bboxes: Vec<[u16; 4]> = Vec::with_capacity(trans.len());
    let mut gated_by_rail = 0usize;
    for t in trans {
        let a = t.as_arr().ok_or("transdef entry is not an array")?;
        if a.len() < 4 {
            return Err(format!("short transdef entry: {a:?}"));
        }
        // Gate bounding box [xmin, xmax, ymin, ymax], used for hit-testing and
        // for outlining a transistor in the renderer.
        let bb = a.get(4).and_then(Val::as_arr).unwrap_or(&[]);
        bboxes.push(if bb.len() >= 4 {
            [
                bb[0].as_num().unwrap_or(0) as u16,
                bb[1].as_num().unwrap_or(0) as u16,
                bb[2].as_num().unwrap_or(0) as u16,
                bb[3].as_num().unwrap_or(0) as u16,
            ]
        } else {
            [0; 4]
        });
        let gate = a[1].as_num().ok_or("transdef gate")? as u32;
        let mut c1 = a[2].as_num().ok_or("transdef c1")? as u32;
        let mut c2 = a[3].as_num().ok_or("transdef c2")? as u32;

        // Terminal normalisation, ported exactly from wires.js:setupTransistors().
        // The two ifs are sequential, not exclusive -- the second sees the result
        // of the first. Preserved so the netlist matches the reference bit for bit.
        if c1 == vss {
            c1 = c2;
            c2 = vss;
        }
        if c1 == vcc {
            c1 = c2;
            c2 = vcc;
        }

        // A transistor gated by vss is permanently off, which is both what the
        // model does and what the silicon does -- 17 of these exist and are fine.
        // A transistor gated by vcc would be permanently *on* in silicon but
        // permanently off here, because group evaluation never crosses a rail.
        // None exist in the 6502 data; warn loudly if that ever changes.
        if gate == vcc {
            gated_by_rail += 1;
        }
        for n in [gate, c1, c2] {
            if (n as usize) >= node_count || !exists[n as usize] {
                return Err(format!("transistor references unknown node {n}"));
            }
        }
        tg.push((gate as u16, c1 as u16, c2 as u16));
    }

    // --- encode ---
    let mut b = Blob(Vec::with_capacity(1 << 16));
    b.0.extend_from_slice(MAGIC);
    b.u32(node_count as u32);
    b.u32(tg.len() as u32);
    b.u32(names.len() as u32);
    b.u32(vss);
    b.u32(vcc);
    b.bits(&exists);
    b.bits(&pullup);
    for (g, c1, c2) in &tg {
        b.u16(*g);
        b.u16(*c1);
        b.u16(*c2);
    }
    for (name, node) in &names {
        let bytes = name.as_bytes();
        b.u16(bytes.len() as u16);
        b.0.extend_from_slice(bytes);
        b.i32(*node);
    }

    let path = out.join("netlist.bin");
    fs::write(&path, &b.0).map_err(|e| format!("writing {}: {e}", path.display()))?;

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
        tg.len(),
        names.len(),
        b.0.len() / 1024,
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
