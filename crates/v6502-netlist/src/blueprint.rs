//! An idealised block diagram of the 6502 datapath, *derived* from switch
//! topology rather than drawn by hand.
//!
//! # Why this can be derived at all
//!
//! Three facts about the die data, each measured rather than assumed:
//!
//! 1. **Names decompose.** 300-odd node names are `stem` + `bit` (`sb0`, `alua7`),
//!    so the datapath's units and their bit widths fall straight out of the name
//!    table. No list of blocks is written down anywhere here.
//! 2. **The datapath is a real bit-slice.** For 29 of the 34 wide units, bit
//!    index maps monotonically to die Y while die X stays fixed: registers are
//!    columns, bits are rows, and the rows line up across units. The five
//!    exceptions (`ir`, `notir`, `p`, `Pout`, `pipeUNK`) are precisely the
//!    control section, which is not bit-sliced and is not drawn here.
//! 3. **Every datapath connection is a switch under one named control line.**
//!    A pass transistor joining two named units *on the same bit row* is one
//!    bit of a bus path, and the signal on its gate is the decode-PLA output
//!    that opens it. Group those by gate and you have the block diagram, edges
//!    and control annotations included.
//!
//! # The control line is the edge
//!
//! Links are keyed by the **control signal**, not by the unit pair. That choice
//! does real work:
//!
//! - It dissolves name aliasing. `sb0` and `dasb0` are the same node, so keying
//!   by unit pair invents two edges where the silicon has one; keying by control
//!   puts all eight switches in one group and the alias resolves as a naming
//!   detail of one endpoint.
//! - It keeps genuine splits visible. `dpc20_ADDSB06` opens the adder onto the
//!   special bus for bits 0..6 and `dpc19_ADDSB7` does bit 7 alone -- two edges
//!   between the same pair, which is the shifter's doing and worth seeing, not
//!   an artefact to merge away.
//!
//! # What is *not* claimed
//!
//! This accounts for the bus fabric only. The 6502 is 76% pass transistors, and
//! the static gates, the decode PLA, the timing chain and the pads are outside
//! what a bus diagram can honestly show. [`Blueprint::coverage`] reports the
//! fraction of transistors the drawing actually explains, so the page can say so
//! rather than implying it has drawn the chip.

use crate::{NodeId, Netlist, TransId};
use std::collections::{BTreeMap, HashMap};

/// Node centroids on the die, emitted alongside `netlist.bin` by `build.rs`.
static CENTROIDS: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/centroids.bin"));

/// Sentinel for a node with no geometry, and so no position.
pub const NO_CENTROID: u16 = u16::MAX;

/// Width of the datapath this derivation looks for. Units of any other width
/// (the 16-bit address pads, the 15-bit `pipeUNK`) are not bit-slices of it.
const DATAPATH_BITS: usize = 8;

/// A unit must show at least this many of its bits to be believed. Below it,
/// a coincidence of names is likelier than a register.
const MIN_BITS: usize = 6;

/// Links this narrow are not a bus path -- they are two wires that happen to
/// touch. A real one carries most of the byte.
const MIN_SWITCHES: usize = 6;

/// A unit that bridges at least this many *distinct* others is carrying traffic
/// between them, which is what makes something a bus rather than a register.
///
/// This is connectivity, and it is the honest criterion available. The tempting
/// physical one -- "a bus is a net nothing drives statically" -- was measured
/// and is wrong here: it separates *dynamic from static* storage, not bus from
/// register. It reports `a`, `x`, `y`, `s` as buses, because the 6502's
/// registers are dynamic and have no static pulldown at all, and reports `adh`
/// as driven, because it has constant generators hanging off it for the stack
/// page and vector fetches.
///
/// The consequence to know about: `pclp`/`pchp`, the program counter's holding
/// latches, each bridge three units and so come out as buses. That is not a
/// misfire so much as a fair description -- they do distribute -- and they draw
/// as short rails local to the PC rather than as spans across the datapath,
/// because a rail's extent is derived from the columns it actually reaches.
const BUS_DEGREE: usize = 3;

/// Die position of a node, as the mean of its polygons' centroids.
pub fn centroid(node: NodeId) -> Option<(u16, u16)> {
    let count = u32::from_le_bytes(CENTROIDS[8..12].try_into().ok()?) as usize;
    let i = node as usize;
    if i >= count {
        return None;
    }
    let at = 12 + i * 4;
    let x = u16::from_le_bytes(CENTROIDS[at..at + 2].try_into().ok()?);
    let y = u16::from_le_bytes(CENTROIDS[at + 2..at + 4].try_into().ok()?);
    (x != NO_CENTROID).then_some((x, y))
}

/// What a unit does in the diagram, decided by how many others it bridges.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Kind {
    /// Carries traffic between several units: drawn as a horizontal rail.
    Bus,
    /// A register, latch or ALU port: drawn as a box in a column.
    Block,
}

/// One bit-sliced unit of the datapath.
#[derive(Clone, Debug)]
pub struct Unit {
    /// Name stem, e.g. `sb`, `alua`, `pcl`.
    pub name: String,
    /// Node per bit, index 0..8. `None` where the die names no such bit.
    pub bits: [Option<NodeId>; DATAPATH_BITS],
    pub kind: Kind,
    /// A `not<name>` unit folded in as this one's complement, if the die has one.
    pub complement: Option<String>,
    /// Other stems naming the same wire (`dasb` for `sb`), merged in.
    pub aliases: Vec<String>,
    /// Distinct units this one is linked to. The basis for [`Kind`], exported so
    /// the page can show the criterion instead of only its verdict.
    pub degree: usize,
    /// Mean die position of its bits: the seed for column order.
    pub die: (f64, f64),
    /// Where this unit sits *within* a bit slice, in die units, relative to the
    /// mean position of that bit row across the whole datapath.
    ///
    /// Column order comes from [`Unit::die`], but rail order cannot: every bus
    /// spans all eight rows, so their mean Y values are all roughly the middle
    /// of the datapath and say nothing about which wire is above which. Measured
    /// against its own row, though, a bus has a consistent offset -- which is
    /// exactly the vertical order to draw the rails in.
    pub row_offset: f64,
}

impl Unit {
    pub fn present_bits(&self) -> usize {
        self.bits.iter().filter(|b| b.is_some()).count()
    }
}

/// One switch: a single bit of a bus path.
#[derive(Copy, Clone, Debug)]
pub struct Switch {
    pub bit: u8,
    pub transistor: TransId,
}

/// A control line and the path it opens.
#[derive(Clone, Debug)]
pub struct Link {
    /// The decode-PLA output (or clock) on the switches' gates.
    pub control: String,
    pub control_node: NodeId,
    /// Indices into [`Blueprint::units`].
    pub a: usize,
    pub b: usize,
    pub switches: Vec<Switch>,
    /// Bits carried, as a mask -- `0xff` for a full-width path.
    pub bits: u8,
}

impl Link {
    pub fn full_width(&self) -> bool {
        self.bits == 0xff
    }
}

/// How much of the chip this diagram actually explains.
#[derive(Copy, Clone, Debug)]
pub struct Coverage {
    pub transistors_total: usize,
    /// Switches drawn as bus paths.
    pub transistors_drawn: usize,
    /// Nodes belonging to a drawn unit.
    pub nodes_drawn: usize,
    pub nodes_total: usize,
}

impl Coverage {
    pub fn transistor_fraction(&self) -> f64 {
        self.transistors_drawn as f64 / self.transistors_total as f64
    }
}

#[derive(Clone, Debug)]
pub struct Blueprint {
    pub units: Vec<Unit>,
    pub links: Vec<Link>,
    pub coverage: Coverage,
}

/// Split `sb0` into `("sb", 0)`. Rejects anything whose stem is not plain
/// letters/underscore, which keeps `dpc3_SBX` and friends out.
fn split_bit(name: &str) -> Option<(&str, usize)> {
    let digits = name.len() - name.trim_end_matches(|c: char| c.is_ascii_digit()).len();
    if digits == 0 || digits == name.len() {
        return None;
    }
    let (stem, num) = name.split_at(name.len() - digits);
    if !stem.chars().all(|c| c.is_ascii_alphabetic() || c == '_') {
        return None;
    }
    Some((stem, num.parse().ok()?))
}

impl Blueprint {
    pub fn derive(nl: &Netlist) -> Blueprint {
        // --- 1. every name that decomposes into (stem, bit) -------------------
        let mut wide: BTreeMap<String, BTreeMap<usize, NodeId>> = BTreeMap::new();
        let mut max_bit: HashMap<String, usize> = HashMap::new();
        for (name, node) in nl.names() {
            if let Some((stem, bit)) = split_bit(name) {
                let e = max_bit.entry(stem.to_string()).or_default();
                *e = (*e).max(bit);
                if bit < DATAPATH_BITS {
                    wide.entry(stem.to_string()).or_default().insert(bit, node);
                }
            }
        }
        // Keep only units that look like a byte of the datapath. A unit wider
        // than the datapath (`ab` at 16, `pipeUNK` at 15) is something else.
        wide.retain(|stem, bits| {
            bits.len() >= MIN_BITS && max_bit.get(stem).is_some_and(|m| *m < DATAPATH_BITS)
        });

        // --- 2. fold `notX` into `X` -----------------------------------------
        // Derived, not curated: the complement only folds when the die also
        // names the thing it is the complement of.
        let mut complement: HashMap<String, String> = HashMap::new();
        for stem in wide.keys().cloned().collect::<Vec<_>>() {
            if let Some(base) = stem.strip_prefix("not") {
                if wide.contains_key(base) {
                    complement.insert(base.to_string(), stem.clone());
                }
            }
        }
        wide.retain(|stem, _| !complement.values().any(|c| c == stem));

        // --- 3. stems that share a node are one wire -------------------------
        // `sb0` and `dasb0` are the same node, so `sb` and `dasb` are the same
        // bus -- the same rail before and after decimal correction, which the
        // die names differently on the bits where the correction can bite. Any
        // sharing at all merges the stems entirely, so the accumulator's path
        // lands on SB rather than on a stub with nothing at the far end.
        //
        // Without this, keying by node alone leaves `dasb`'s *unshared* bits as
        // a phantom second unit, and the diagram shows AC connected to a wire
        // that connects to nothing.
        let stems: Vec<String> = wide.keys().cloned().collect();
        let mut owner: HashMap<NodeId, usize> = HashMap::new();
        let mut parent: Vec<usize> = (0..stems.len()).collect();
        fn find(parent: &mut [usize], mut i: usize) -> usize {
            while parent[i] != i {
                parent[i] = parent[parent[i]];
                i = parent[i];
            }
            i
        }
        for (si, stem) in stems.iter().enumerate() {
            for node in wide[stem].values() {
                match owner.get(node) {
                    None => {
                        owner.insert(*node, si);
                    }
                    Some(&other) => {
                        let (a, b) = (find(&mut parent, si), find(&mut parent, other));
                        if a != b {
                            parent[a] = b;
                        }
                    }
                }
            }
        }
        // Canonical stem of each merged set: most bits, then shortest name.
        let mut canon: HashMap<usize, usize> = HashMap::new();
        for si in 0..stems.len() {
            let root = find(&mut parent, si);
            let best = *canon.entry(root).or_insert(si);
            let (a, b) = (&stems[si], &stems[best]);
            let better = wide[a].len() > wide[b].len()
                || (wide[a].len() == wide[b].len() && a.len() < b.len());
            if better {
                canon.insert(root, si);
            }
        }
        let canon_of = |parent: &mut [usize], si: usize| -> String {
            let root = find(parent, si);
            stems[canon[&root]].clone()
        };

        let mut aliases: HashMap<String, Vec<String>> = HashMap::new();
        let mut primary: HashMap<NodeId, String> = HashMap::new();
        let mut bit_of: HashMap<NodeId, u8> = HashMap::new();
        for si in 0..stems.len() {
            let c = canon_of(&mut parent, si);
            if c != stems[si] {
                aliases.entry(c.clone()).or_default().push(stems[si].clone());
            }
            for (bit, node) in &wide[&stems[si]] {
                primary.insert(*node, c.clone());
                bit_of.insert(*node, *bit as u8);
            }
        }
        for v in aliases.values_mut() {
            v.sort();
            v.dedup();
        }
        wide.retain(|stem, _| !aliases.values().any(|v| v.contains(stem)));

        // --- 4. switches: same bit row, two different units, one control ------
        let mut by_control: BTreeMap<NodeId, Vec<(TransId, String, String, u8)>> = BTreeMap::new();
        for t in 0..nl.transistor_count() as TransId {
            let gate = nl.transistor_gate(t);
            // A rail on the gate means permanently off (17 of these); it opens
            // nothing and is not an edge.
            if nl.is_rail(gate) {
                continue;
            }
            let (c1, c2) = (nl.transistor_c1(t), nl.transistor_c2(t));
            let (Some(u1), Some(u2)) = (primary.get(&c1), primary.get(&c2)) else {
                continue;
            };
            if u1 == u2 {
                continue;
            }
            let (Some(b1), Some(b2)) = (bit_of.get(&c1), bit_of.get(&c2)) else {
                continue;
            };
            // Different bit rows would be a shifter or a carry chain, not a bus
            // path. Those exist, and are not what this diagram draws.
            if b1 != b2 {
                continue;
            }
            by_control.entry(gate).or_default().push((t, u1.clone(), u2.clone(), *b1));
        }

        // --- 5. one link per control line ------------------------------------
        let mut links: Vec<Link> = Vec::new();
        // Endpoint stems, parallel to `links`. Unit indices cannot be assigned
        // until the unit list is final, and the unit list depends on which links
        // survive, so the names are carried alongside until both are known.
        let mut ends: Vec<(String, String)> = Vec::new();
        for (gate, group) in &by_control {
            // The pair carrying the most switches is the edge; anything else in
            // the group is an alias of one of its ends.
            let mut tally: HashMap<(String, String), usize> = HashMap::new();
            for (_, a, b, _) in group {
                let key = if a < b { (a.clone(), b.clone()) } else { (b.clone(), a.clone()) };
                *tally.entry(key).or_default() += 1;
            }
            let Some(((pa, pb), _)) = tally.iter().max_by_key(|(k, v)| (**v, (*k).clone())) else {
                continue;
            };
            let (pa, pb) = (pa.clone(), pb.clone());
            let switches: Vec<Switch> = group
                .iter()
                .filter(|(_, a, b, _)| {
                    // Accept the canonical pair and any alias-substituted form.
                    let ends = [a.as_str(), b.as_str()];
                    ends.contains(&pa.as_str()) || ends.contains(&pb.as_str())
                })
                .map(|(t, _, _, bit)| Switch { bit: *bit, transistor: *t })
                .collect();
            let Some(control) = nl.name_of(*gate) else { continue };
            let bits = switches.iter().fold(0u8, |m, s| m | 1 << s.bit);
            links.push(Link {
                control: control.to_string(),
                control_node: *gate,
                a: usize::MAX, // resolved below, once the unit list exists
                b: usize::MAX,
                switches,
                bits,
            });
            ends.push((pa, pb));
        }

        // Width filter, applied to the finished candidate set rather than as
        // each one is built. A narrow group is usually two wires that happen to
        // touch -- but not always: `dpc19_ADDSB7` is a *single* switch putting
        // the adder's bit 7 onto SB, the other seven bits being `dpc20_ADDSB06`.
        // That is the shifter, and dropping it would leave the diagram claiming
        // the ALU reaches SB on bits 0..6 and that bit 7 goes nowhere. So a
        // narrow link survives when a wider link already joins the same pair and
        // it contributes bits that link does not carry.
        let mut pair_bits: HashMap<(String, String), u8> = HashMap::new();
        for (l, pair) in links.iter().zip(&ends) {
            if l.switches.len() >= MIN_SWITCHES {
                *pair_bits.entry(pair.clone()).or_default() |= l.bits;
            }
        }
        let keep: Vec<bool> = links
            .iter()
            .zip(&ends)
            .map(|(l, pair)| {
                l.switches.len() >= MIN_SWITCHES
                    || pair_bits.get(pair).is_some_and(|carried| l.bits & !carried != 0)
            })
            .collect();
        let mut it = keep.iter();
        links.retain(|_| *it.next().unwrap());
        let mut it = keep.iter();
        ends.retain(|_| *it.next().unwrap());

        // --- 6. only units that a link actually touches ----------------------
        // A named byte with no bus path is not part of this picture: `ir` and
        // `pd` belong to the control section, and drawing them unattached would
        // imply the diagram had looked for their connections and found none.
        let mut kept: Vec<String> = ends.iter().flat_map(|(a, b)| [a.clone(), b.clone()]).collect();
        kept.sort();
        kept.dedup();

        // Degree over *distinct* partners, which is what "bridges several units"
        // means. Two links to the same neighbour -- `dpc20_ADDSB06` and
        // `dpc19_ADDSB7` both joining the adder to SB -- is one relationship
        // split by the shifter, and must not count twice toward being a bus.
        let mut partners: HashMap<&str, Vec<&str>> = HashMap::new();
        for (a, b) in &ends {
            partners.entry(a.as_str()).or_default().push(b.as_str());
            partners.entry(b.as_str()).or_default().push(a.as_str());
        }
        for v in partners.values_mut() {
            v.sort();
            v.dedup();
        }

        // Mean die Y of each bit row, taken across every unit that will be
        // drawn: the datum each unit's row offset is measured against.
        let mut row_mean = [0.0f64; DATAPATH_BITS];
        for (bit, mean) in row_mean.iter_mut().enumerate() {
            let ys: Vec<f64> = kept
                .iter()
                .filter_map(|stem| wide[stem].get(&bit))
                .filter_map(|n| centroid(*n))
                .map(|(_, y)| y as f64)
                .collect();
            *mean = if ys.is_empty() { 0.0 } else { ys.iter().sum::<f64>() / ys.len() as f64 };
        }

        let mut units: Vec<Unit> = Vec::new();
        let mut index: HashMap<String, usize> = HashMap::new();
        for stem in &kept {
            let bitmap = &wide[stem];
            let mut bits = [None; DATAPATH_BITS];
            let mut sx = 0.0;
            let mut sy = 0.0;
            let mut n = 0.0;
            let mut offset = 0.0;
            let mut offset_n = 0.0;
            for (bit, node) in bitmap {
                bits[*bit] = Some(*node);
                if let Some((x, y)) = centroid(*node) {
                    sx += x as f64;
                    sy += y as f64;
                    n += 1.0;
                    if row_mean[*bit] != 0.0 {
                        offset += y as f64 - row_mean[*bit];
                        offset_n += 1.0;
                    }
                }
            }
            let deg = partners.get(stem.as_str()).map_or(0, Vec::len);
            index.insert(stem.clone(), units.len());
            units.push(Unit {
                name: stem.clone(),
                bits,
                kind: if deg >= BUS_DEGREE { Kind::Bus } else { Kind::Block },
                complement: complement.get(stem).cloned(),
                aliases: aliases.get(stem).cloned().unwrap_or_default(),
                degree: deg,
                die: if n > 0.0 { (sx / n, sy / n) } else { (0.0, 0.0) },
                row_offset: if offset_n > 0.0 { offset / offset_n } else { 0.0 },
            });
        }

        for (l, (a, b)) in links.iter_mut().zip(&ends) {
            l.a = index[a];
            l.b = index[b];
        }
        links.sort_by(|x, y| x.control.cmp(&y.control));

        // --- 7. coverage, stated rather than implied -------------------------
        let drawn: usize = links.iter().map(|l| l.switches.len()).sum();
        let nodes_drawn = units.iter().map(Unit::present_bits).sum();
        Blueprint {
            coverage: Coverage {
                transistors_total: nl.transistor_count(),
                transistors_drawn: drawn,
                nodes_drawn,
                nodes_total: nl.node_count(),
            },
            units,
            links,
        }
    }

    pub fn unit(&self, name: &str) -> Option<&Unit> {
        self.units.iter().find(|u| u.name == name)
    }

    /// Serialise for the web front end. Hand-rolled so the crate that compiles
    /// into the `.wasm` gains no dependency for the sake of one build-time tool.
    pub fn to_json(&self) -> String {
        let mut s = String::with_capacity(64 * 1024);
        s.push_str("{\n  \"units\": [\n");
        for (i, u) in self.units.iter().enumerate() {
            let bits: Vec<String> = u
                .bits
                .iter()
                .map(|b| b.map_or("null".into(), |n| n.to_string()))
                .collect();
            let aliases: Vec<String> = u.aliases.iter().map(|a| format!("\"{a}\"")).collect();
            s.push_str(&format!(
                "    {{\"name\":\"{}\",\"kind\":\"{}\",\"bits\":[{}],\"complement\":{},\
                 \"aliases\":[{}],\"degree\":{},\"dieX\":{:.1},\"dieY\":{:.1},\
                 \"rowOffset\":{:.1}}}{}\n",
                u.name,
                if u.kind == Kind::Bus { "bus" } else { "block" },
                bits.join(","),
                u.complement.as_ref().map_or("null".into(), |c| format!("\"{c}\"")),
                aliases.join(","),
                u.degree,
                u.die.0,
                u.die.1,
                u.row_offset,
                if i + 1 < self.units.len() { "," } else { "" }
            ));
        }
        s.push_str("  ],\n  \"links\": [\n");
        for (i, l) in self.links.iter().enumerate() {
            let sw: Vec<String> = l
                .switches
                .iter()
                .map(|w| format!("[{},{}]", w.bit, w.transistor))
                .collect();
            s.push_str(&format!(
                "    {{\"control\":\"{}\",\"controlNode\":{},\"a\":{},\"b\":{},\
                 \"bits\":{},\"switches\":[{}]}}{}\n",
                l.control,
                l.control_node,
                l.a,
                l.b,
                l.bits,
                sw.join(","),
                if i + 1 < self.links.len() { "," } else { "" }
            ));
        }
        let c = &self.coverage;
        s.push_str(&format!(
            "  ],\n  \"coverage\": {{\"transistorsTotal\":{},\"transistorsDrawn\":{},\
             \"nodesTotal\":{},\"nodesDrawn\":{}}}\n}}\n",
            c.transistors_total, c.transistors_drawn, c.nodes_total, c.nodes_drawn
        ));
        s
    }
}
