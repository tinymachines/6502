//! WebAssembly bindings.
//!
//! The design constraint that shapes this whole module: a visualiser needs the
//! level of all 1725 nodes every frame. Calling across the JS/WASM boundary per
//! node would cost more than the simulation does, so node state is exposed as a
//! raw view into linear memory that JavaScript reads directly.
//!
//! Everything else is a thin wrapper over [`v6502_sim`].

#![forbid(unsafe_code)]

use std::sync::Arc;

use v6502_sim::state::{self, MachineState};
use v6502_sim::rows;
use v6502_sim::{bus::FlatMemory, cpu::Cpu, cpu::Fetch, history::History, ReadWrite};
use wasm_bindgen::prelude::*;

/// A 6502 with 64 KiB of RAM and a rewind buffer.
#[wasm_bindgen]
pub struct Machine {
    cpu: Cpu<FlatMemory>,
    history: History,
    /// One byte per node, refreshed on demand. Held here so the buffer is
    /// stable and reused rather than reallocated every frame.
    node_scratch: Vec<u8>,
}

#[wasm_bindgen]
impl Machine {
    /// Build a machine with the embedded 6502 netlist. Not yet reset -- load a
    /// program and set the reset vector first.
    ///
    /// Only in the default build. A build without the `mos6502` feature
    /// embeds no die data and has no chip to construct from: use
    /// [`Machine::from_netlist`].
    #[cfg(feature = "mos6502")]
    #[wasm_bindgen(constructor)]
    pub fn new() -> Machine {
        Machine::with(std::sync::Arc::new(v6502_sim::mos6502()))
    }

    /// Build a machine from a netlist supplied at runtime.
    ///
    /// This is the constructor a package that ships **no die data** has, and
    /// the reason it can be MIT: the 32 KB blob is CC BY-NC-SA and travels
    /// into anything that embeds it, so a caller fetches it and passes it in
    /// rather than receiving it inside the bundle. The format is halfphi's
    /// own, magic `HALFPHI1`, and `Netlist::decode` refuses anything else
    /// rather than building a chip out of the wrong bytes.
    ///
    /// It is not 6502-specific. Any netlist halfphi can decode works, though
    /// the clock and bus layer around it expects a 6502's signal names and
    /// will refuse a chip that lacks them.
    #[wasm_bindgen(js_name = fromNetlist)]
    pub fn from_netlist(blob: &[u8]) -> Result<Machine, JsError> {
        let netlist = halfphi::netlist::Netlist::decode(blob)
            .map_err(|e| JsError::new(&format!("netlist: {e:?}")))?;
        Ok(Machine::with(std::sync::Arc::new(netlist)))
    }

    fn with(netlist: Arc<v6502_sim::Netlist>) -> Machine {
        let node_count = netlist.node_count();
        let cpu = Cpu::new(netlist, FlatMemory::new())
            .expect("netlist has every required signal");
        Machine {
            cpu,
            // 256 keyframes at stride 16 => 4096 half-cycles of scrubbable
            // history for about 280 KiB, and at most 16 half-cycles of replay to
            // reach any point in it.
            history: History::new(16, 256),
            node_scratch: vec![0u8; node_count],
        }
    }

    // -- setup ------------------------------------------------------------

    pub fn load(&mut self, addr: u16, bytes: &[u8]) {
        self.cpu.bus.load(addr, bytes);
    }

    #[wasm_bindgen(js_name = setResetVector)]
    pub fn set_reset_vector(&mut self, addr: u16) {
        self.cpu.bus.set_reset_vector(addr);
    }

    /// Cold boot: restore layout pull state, then reset. Use this rather than
    /// `reset` when re-running, so a run cannot inherit bus pulls from the last.
    #[wasm_bindgen(js_name = powerCycle)]
    pub fn power_cycle(&mut self) {
        self.cpu.power_cycle();
        self.cpu.bus.clear_journal();
        self.history.clear();
        self.history.capture(&mut self.cpu);
    }

    pub fn reset(&mut self) {
        self.cpu.reset();
        self.cpu.bus.clear_journal();
        self.history.clear();
        self.history.capture(&mut self.cpu);
    }

    // -- running ----------------------------------------------------------

    #[wasm_bindgen(js_name = halfStep)]
    pub fn half_step(&mut self) {
        self.history.maybe_capture(&mut self.cpu);
        self.cpu.half_step();
    }

    #[wasm_bindgen(js_name = stepCycle)]
    pub fn step_cycle(&mut self) {
        self.half_step();
        self.half_step();
    }

    /// Run to the next opcode fetch. Returns false if the chip did not reach
    /// one within `max_half_cycles` (a jammed opcode, or a stalled bus).
    /// Over HTTP this is `{"until": "instruction", "max_half_cycles": n}`.
    /// Same reasoning as `runHalfCycles` above for why the names differ.
    #[wasm_bindgen(js_name = stepInstruction)]
    pub fn step_instruction(&mut self, max_half_cycles: u32) -> bool {
        let start = self.cpu.half_cycle();
        loop {
            self.half_step();
            if self.cpu.sync() && !self.cpu.clk0() {
                return true;
            }
            if self.cpu.half_cycle() - start >= max_half_cycles as u64 {
                return false;
            }
        }
    }

    /// Advance `n` half-cycles. Batching here rather than in JS keeps the
    /// boundary crossing count at one per frame instead of one per phase.
    /// Over HTTP this is `{"half_cycles": n}` on `POST /v1/step`. The names
    /// differ and are being left that way on purpose: renaming either side is
    /// a breaking change to a published surface (`runHalfCycles` has six
    /// callers in `web/` alone, and `half_cycles` appears in `app.py`,
    /// `mcp_server.py` and the reference page), and what it would buy is the
    /// deletion of a two-line mapping in a JavaScript wrapper. The
    /// correspondence is written down here instead, which is the part a reader
    /// actually needed.
    #[wasm_bindgen(js_name = runHalfCycles)]
    pub fn run_half_cycles(&mut self, n: u32) {
        for _ in 0..n {
            self.half_step();
        }
    }

    /// Advance `half_cycles` half-cycles, recording one row per half-cycle:
    /// the same 34 columns, in the same encodings, that `POST /v1/step`
    /// returns as `trace_rows` when asked for `format: "rows"`, packed by the
    /// same Rust function (`v6502_sim::rows`). A page that recorded a
    /// machine over the API reads a recording made here without a second
    /// decoder, and `tools/check-wasm-parity.py` holds the two bit-identical.
    ///
    /// `watch` is node names separated by whitespace, exactly the API's
    /// `watch` list joined with spaces (and halfwave's `WATCH` line); bit i of
    /// each row's watch column is name i. An unknown name is an error, before
    /// the chip is touched. More than `MAX_TRACED` half-cycles (10,000, the
    /// service's `max_traced`) is an error too, so the JSON string cannot
    /// grow without bound in a tab.
    ///
    /// Returns a JSON string `{cols, watch_names, watch_encoding, rows}`. A
    /// string rather than an object because this crate emits JSON and never
    /// parses it, and because one `JSON.parse` on the far side is cheaper
    /// than 34 boundary crossings per row.
    #[wasm_bindgen(js_name = traceRows)]
    pub fn trace_rows(&mut self, half_cycles: u32, watch: &str) -> Result<String, JsError> {
        if half_cycles as u64 > rows::MAX_TRACED {
            return Err(JsError::new(&format!(
                "{half_cycles} traced half-cycles exceeds max_traced {}",
                rows::MAX_TRACED
            )));
        }
        let names: Vec<String> = watch.split_whitespace().map(str::to_owned).collect();
        let mut ids = Vec::with_capacity(names.len());
        for name in &names {
            match self.cpu.engine().netlist().node(name) {
                Some(id) => ids.push(id),
                None => return Err(JsError::new(&format!("unknown node {name:?}"))),
            }
        }
        let mut out = String::with_capacity(96 * half_cycles as usize + 512);
        out.push_str("{\"cols\":");
        out.push_str(&rows::cols_json());
        out.push_str(",\"watch_names\":");
        out.push_str(&rows::names_json(&names));
        out.push_str(",\"watch_encoding\":\"hex\",\"rows\":[");
        for i in 0..half_cycles {
            self.half_step();
            if i > 0 {
                out.push(',');
            }
            rows::push_row(&mut out, &self.cpu, &ids);
        }
        out.push_str("]}");
        Ok(out)
    }

    // -- time travel ------------------------------------------------------

    /// Rewind to an absolute half-cycle. Returns false if it is outside the
    /// retained window.
    #[wasm_bindgen(js_name = rewindTo)]
    pub fn rewind_to(&mut self, half_cycle: f64) -> bool {
        if half_cycle < 0.0 {
            return false;
        }
        self.history.rewind_to(&mut self.cpu, half_cycle as u64).is_ok()
    }

    #[wasm_bindgen(js_name = stepBack)]
    pub fn step_back(&mut self) -> bool {
        self.history.step_back(&mut self.cpu).is_ok()
    }

    /// Oldest half-cycle still reachable by `rewindTo`, or -1 if none.
    #[wasm_bindgen(js_name = earliestHalfCycle)]
    pub fn earliest_half_cycle(&self) -> f64 {
        self.history.earliest().map_or(-1.0, |v| v as f64)
    }

    // -- observation ------------------------------------------------------

    #[wasm_bindgen(js_name = halfCycle)]
    pub fn half_cycle(&self) -> f64 {
        self.cpu.half_cycle() as f64
    }
    pub fn cycle(&self) -> f64 {
        self.cpu.cycle() as f64
    }
    #[wasm_bindgen(js_name = addressBus)]
    pub fn address_bus(&self) -> u16 {
        self.cpu.address_bus()
    }
    #[wasm_bindgen(js_name = dataBus)]
    pub fn data_bus(&self) -> u8 {
        self.cpu.data_bus()
    }
    #[wasm_bindgen(js_name = isRead)]
    pub fn is_read(&self) -> bool {
        self.cpu.rw() == ReadWrite::Read
    }
    pub fn sync(&self) -> bool {
        self.cpu.sync()
    }
    pub fn clk0(&self) -> bool {
        self.cpu.clk0()
    }

    pub fn pc(&self) -> u16 {
        self.cpu.registers().pc
    }
    pub fn a(&self) -> u8 {
        self.cpu.registers().a
    }
    pub fn x(&self) -> u8 {
        self.cpu.registers().x
    }
    pub fn y(&self) -> u8 {
        self.cpu.registers().y
    }
    pub fn s(&self) -> u8 {
        self.cpu.registers().s
    }
    pub fn p(&self) -> u8 {
        self.cpu.registers().p
    }
    pub fn ir(&self) -> u8 {
        self.cpu.registers().ir
    }

    /// Status flags as `NV-BDIZC`, uppercase where set.
    #[wasm_bindgen(js_name = flagsString)]
    pub fn flags_string(&self) -> String {
        self.cpu.registers().flags_string()
    }

    /// Address of the most recent opcode fetch, or -1 if none yet.
    #[wasm_bindgen(js_name = lastFetchAddr)]
    pub fn last_fetch_addr(&self) -> i32 {
        self.cpu.last_fetch().map_or(-1, |f| f.addr as i32)
    }

    /// Opcode of the most recent fetch. Meaningless unless `lastFetchAddr >= 0`.
    #[wasm_bindgen(js_name = lastFetchOpcode)]
    pub fn last_fetch_opcode(&self) -> u8 {
        self.cpu.last_fetch().map_or(0, |f| f.opcode)
    }

    /// Active internal T-states, e.g. `"T0+T2"`.
    #[wasm_bindgen(js_name = timingStates)]
    pub fn timing_states(&self) -> String {
        self.cpu.timing().active()
    }

    /// Fixed-width timing chain, matching the reference's trace format.
    #[wasm_bindgen(js_name = timingFixedWidth)]
    pub fn timing_fixed_width(&self) -> String {
        self.cpu.timing().fixed_width()
    }

    /// Internal clock phase: 1 or 2. Not the same as the `clk0` pin.
    pub fn phase(&self) -> u8 {
        match self.cpu.phase() {
            v6502_sim::Phase::Phi1 => 1,
            v6502_sim::Phase::Phi2 => 2,
        }
    }

    // -- bulk node access -------------------------------------------------

    #[wasm_bindgen(js_name = nodeCount)]
    pub fn node_count(&self) -> u32 {
        self.cpu.engine().netlist().node_count() as u32
    }

    /// Refresh the node-level buffer and return a pointer into WASM linear
    /// memory holding one byte per node: **255 for high, 0 for low**.
    ///
    /// Read it from JS as:
    ///
    /// ```js
    /// const view = new Uint8Array(memory.buffer, m.nodeLevelsPtr(), m.nodeCount());
    /// ```
    ///
    /// The 255 matters: this buffer is uploaded straight into an R8 texture,
    /// whose values the shader reads normalised to 0..1. A byte of `1` would
    /// arrive as 1/255 -- visually identical to "low", and silently so.
    ///
    /// The pointer is only valid until the next call that grows WASM memory, so
    /// re-acquire the view after any allocation. Stepping does not allocate.
    #[wasm_bindgen(js_name = nodeLevelsPtr)]
    pub fn node_levels_ptr(&mut self) -> *const u8 {
        let engine = self.cpu.engine();
        for (n, slot) in self.node_scratch.iter_mut().enumerate() {
            *slot = if engine.is_high(n as u16) { 255 } else { 0 };
        }
        self.node_scratch.as_ptr()
    }

    /// Copying alternative to [`Machine::node_levels_ptr`] for callers that
    /// would rather not touch raw memory.
    #[wasm_bindgen(js_name = nodeLevels)]
    pub fn node_levels(&mut self) -> Vec<u8> {
        self.node_levels_ptr();
        self.node_scratch.clone()
    }

    #[wasm_bindgen(js_name = isNodeHigh)]
    pub fn is_node_high(&self, node: u16) -> bool {
        self.cpu.engine().is_high(node)
    }

    /// Resolve a signal name to a node number, or -1 if unknown.
    #[wasm_bindgen(js_name = nodeId)]
    pub fn node_id(&self, name: &str) -> i32 {
        self.cpu.engine().netlist().node(name).map_or(-1, i32::from)
    }

    #[wasm_bindgen(js_name = nodeName)]
    pub fn node_name(&self, node: u16) -> Option<String> {
        self.cpu.engine().netlist().name_of(node).map(str::to_owned)
    }

    /// Nodes currently shorted to `node` through conducting transistors.
    ///
    /// The answer depends on the instant it is asked: this is the live
    /// electrical extent of a wire, not a static netlist property.
    #[wasm_bindgen(js_name = nodeGroup)]
    pub fn node_group(&self, node: u16) -> Vec<u16> {
        self.cpu.engine().group_of(node)
    }

    // -- memory -----------------------------------------------------------

    pub fn peek(&self, addr: u16) -> u8 {
        self.cpu.bus.peek(addr)
    }

    /// Copy `len` bytes of memory starting at `addr`, wrapping at the top of
    /// the address space.
    #[wasm_bindgen(js_name = memorySlice)]
    pub fn memory_slice(&self, addr: u16, len: u32) -> Vec<u8> {
        (0..len).map(|i| self.cpu.bus.peek(addr.wrapping_add(i as u16))).collect()
    }

    // -- the machine as a value -------------------------------------------
    //
    // The same object the HTTP API passes, so a machine can start here and
    // finish there, or the reverse. That interchangeability is not a feature
    // anyone had to build: the service is stateless because a machine IS a
    // value, and `v6502-sim`'s codec is already proven bit-exact restoring
    // into a machine that never ran the first half. What was missing was any
    // way to get one in or out of the browser.
    //
    // JSON is emitted here and parsed in JavaScript, never the other way
    // round. Emitting it is a format string; parsing it would be a parser,
    // and this crate has one dependency and does not need a second. The same
    // asymmetry the engine's line protocol runs on: parse simple, emit rich.

    /// The whole machine as the API's own JSON: `{state, memory}`.
    ///
    /// Memory is sparse by the service's rule, a fill byte plus only the
    /// pages that differ from it, so an idle 64 KiB costs a few hundred bytes
    /// rather than 128 KB of hex.
    #[wasm_bindgen(js_name = exportMachine)]
    pub fn export_machine(&self) -> String {
        machine_json(&state::snapshot(&self.cpu), self.cpu.bus.as_slice())
    }

    /// Restore the chip half of a machine, and ONLY the chip half.
    ///
    /// Memory does not come with it. Fill it and write the pages with
    /// `fillMemory` and `load`, or use `importMachine`, which does both in one
    /// call and is the reason not to reach for this one.
    ///
    /// The failure this warns about is quiet. A caller who restores the chip
    /// and forgets the memory does not get an error or an empty machine: they
    /// get the PREVIOUS program still sitting in RAM under a program counter
    /// that belongs to a different one. It runs, and what it does looks like a
    /// simulation bug rather than a missing call.
    ///
    /// The fields are passed one by one rather than as a parsed object, for
    /// the reason above. `halfCycle` is an `f64` so it stays an ordinary
    /// JavaScript number: a `u64` would arrive as a BigInt, and no run will
    /// reach 2^53 half-cycles at fourteen kilohertz.
    ///
    /// `fetchAddr` of -1 means no fetch has happened, matching `lastFetchAddr`.
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = importState)]
    pub fn import_state(
        &mut self,
        value: &str,
        pullup: &str,
        pulldown: &str,
        trans_on: &str,
        half_cycle: f64,
        fetch_addr: i32,
        fetch_opcode: u8,
    ) -> Result<(), JsError> {
        let (nodes, transistors) = {
            let nl = self.cpu.engine().netlist();
            (nl.node_count(), nl.transistor_count())
        };
        let last_fetch = if fetch_addr < 0 {
            None
        } else {
            Some(Fetch { addr: fetch_addr as u16, opcode: fetch_opcode })
        };
        let st = MachineState::from_hex(
            nodes,
            transistors,
            value,
            pullup,
            pulldown,
            trans_on,
            half_cycle as u64,
            last_fetch,
        )
        .map_err(|e| JsError::new(&e))?;
        state::restore(&mut self.cpu, &st);
        // The rewind buffer belongs to the run that just ended. Keeping it
        // would let `stepBack` walk into a machine this one never was.
        self.history = History::new(16, 256);
        Ok(())
    }

    /// A whole machine: the chip and its memory, in one call.
    ///
    /// This is the counterpart to `exportMachine`, and the pair is what lets a
    /// run started here be finished on the API or the other way round. Over
    /// HTTP a machine is one value and arrives whole; this makes it one call
    /// here too, so the two surfaces differ in shape rather than in what a
    /// caller has to remember.
    ///
    /// It takes decoded bytes rather than the JSON `exportMachine` emits, and
    /// that is deliberate rather than lazy. This crate emits JSON and never
    /// parses it: emitting is a format string, parsing is a parser, and the
    /// dependency list is `wasm-bindgen`, `halfphi` and `v6502-sim`. Adding
    /// serde here to save a caller five lines of `JSON.parse` would be paying
    /// for it in every build of the data-free package, whose whole point is to
    /// be small enough that nobody minds shipping it.
    ///
    /// Memory arrives the way the sparse format already describes it:
    ///
    /// - `fill` is the byte every page not listed is made of.
    /// - `page_ids` is one entry per page present, each the high byte of that
    ///   page's address.
    /// - `page_bytes` is those pages back to back, 256 bytes each, in the same
    ///   order.
    ///
    /// Refused rather than guessed at: if `page_bytes` is not exactly 256
    /// times `page_ids`, the pages cannot be cut apart unambiguously, and
    /// writing whatever happens to line up would produce a machine that is
    /// wrong somewhere the caller will not look.
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = importMachine)]
    pub fn import_machine(
        &mut self,
        value: &str,
        pullup: &str,
        pulldown: &str,
        trans_on: &str,
        half_cycle: f64,
        fetch_addr: i32,
        fetch_opcode: u8,
        fill: u8,
        page_ids: &[u8],
        page_bytes: &[u8],
    ) -> Result<(), JsError> {
        check_page_cut(page_ids, page_bytes)?;

        // The chip first. If the state is malformed this returns before memory
        // is touched, so a refused import leaves the machine as it was rather
        // than half replaced.
        self.import_state(
            value, pullup, pulldown, trans_on, half_cycle, fetch_addr, fetch_opcode,
        )?;

        self.fill_memory(fill);
        for (i, &page) in page_ids.iter().enumerate() {
            let from = i * 256;
            self.load(u16::from(page) << 8, &page_bytes[from..from + 256]);
        }
        Ok(())
    }

    /// Set all 64 KiB to one byte, so a sparse image can be written over it.
    #[wasm_bindgen(js_name = fillMemory)]
    pub fn fill_memory(&mut self, byte: u8) {
        self.cpu.bus.load(0, &vec![byte; 0x10000]);
    }

    // -- input pins -------------------------------------------------------

    /// All active low: pass false to assert.
    #[wasm_bindgen(js_name = setIrq)]
    pub fn set_irq(&mut self, level: bool) {
        self.cpu.set_irq(level);
    }
    #[wasm_bindgen(js_name = setNmi)]
    pub fn set_nmi(&mut self, level: bool) {
        self.cpu.set_nmi(level);
    }
    #[wasm_bindgen(js_name = setRes)]
    pub fn set_res(&mut self, level: bool) {
        self.cpu.set_res(level);
    }
    /// Low stalls the CPU on read cycles.
    #[wasm_bindgen(js_name = setRdy)]
    pub fn set_rdy(&mut self, level: bool) {
        self.cpu.set_rdy(level);
    }
    #[wasm_bindgen(js_name = setSo)]
    pub fn set_so(&mut self, level: bool) {
        self.cpu.set_so(level);
    }

    // -- diagnostics ------------------------------------------------------

    /// Settles that failed to converge. Nonzero means the model oscillated and
    /// the state shown is not trustworthy.
    #[wasm_bindgen(js_name = nonconvergentSettles)]
    pub fn nonconvergent_settles(&self) -> f64 {
        self.cpu.engine().stats().nonconvergent_settles as f64
    }

    /// Node groups driven both up and down at once -- genuine electrical
    /// contention. Expected to stay zero.
    #[wasm_bindgen(js_name = contestedGroups)]
    pub fn contested_groups(&self) -> f64 {
        self.cpu.engine().stats().contested_groups as f64
    }
}

/// A default only exists where there is a chip to default to.
#[cfg(feature = "mos6502")]
impl Default for Machine {
    fn default() -> Self {
        Self::new()
    }
}

/// Netlist facts, available without constructing a machine.
///
/// Needs the embedded chip, for the obvious reason: without the `mos6502`
/// feature there is no netlist here to report on until a caller supplies one.
#[cfg(feature = "mos6502")]
#[wasm_bindgen(js_name = netlistInfo)]
pub fn netlist_info() -> String {
    let nl = v6502_sim::mos6502();
    format!("{} nodes, {} transistors", nl.node_count(), nl.transistor_count())
}

/// The same facts for a netlist the caller already has, so the no-data build
/// is not silent about what it was handed.
#[wasm_bindgen(js_name = netlistInfoOf)]
pub fn netlist_info_of(blob: &[u8]) -> Result<String, JsError> {
    let nl = halfphi::netlist::Netlist::decode(blob)
        .map_err(|e| JsError::new(&format!("netlist: {e:?}")))?;
    Ok(format!("{} nodes, {} transistors", nl.node_count(), nl.transistor_count()))
}

// -- shared emitters ------------------------------------------------------

/// The whole machine as the API's own JSON: `{state, memory}`.
///
/// One emitter for every engine in this crate, so two rungs cannot drift in
/// shape. Memory is sparse by the service's rule, a fill byte plus only the
/// pages that differ from it, so an idle 64 KiB costs a few hundred bytes
/// rather than 128 KB of hex.
fn machine_json(st: &MachineState, image: &[u8]) -> String {
    let [value, pullup, pulldown, trans_on] = st.chip_hex();
    let mut out = String::with_capacity(4096);
    out.push_str("{\"state\":{\"half_cycle\":");
    out.push_str(&st.half_cycle.to_string());
    out.push_str(",\"last_fetch\":");
    match st.last_fetch {
        Some(f) => {
            out.push_str("{\"addr\":");
            out.push_str(&f.addr.to_string());
            out.push_str(",\"opcode\":");
            out.push_str(&f.opcode.to_string());
            out.push('}');
        }
        None => out.push_str("null"),
    }
    for (k, v) in [
        ("value", &value),
        ("pullup", &pullup),
        ("pulldown", &pulldown),
        ("trans_on", &trans_on),
    ] {
        out.push_str(",\"");
        out.push_str(k);
        out.push_str("\":\"");
        out.push_str(v);
        out.push('"');
    }
    out.push_str("},\"memory\":");
    push_memory(&mut out, image);
    out.push('}');
    out
}

/// The sparse memory object every engine's export shares: a fill byte plus
/// only the pages that differ from it.
fn push_memory(out: &mut String, image: &[u8]) {
    out.push_str("{\"fill\":\"00\",\"pages\":{");
    let mut first = true;
    for page in 0..256usize {
        let bytes = &image[page * 256..(page + 1) * 256];
        if bytes.iter().all(|&b| b == 0) {
            continue;
        }
        if !first {
            out.push(',');
        }
        first = false;
        out.push_str(&format!("\"{page:02x}\":\""));
        for &b in bytes {
            out.push_str(&format!("{b:02x}"));
        }
        out.push('"');
    }
    out.push_str("}}");
}

/// Refuse a page list that cannot be cut apart unambiguously; shared by every
/// engine's `importMachine` so the refusal cannot drift.
fn check_page_cut(page_ids: &[u8], page_bytes: &[u8]) -> Result<(), JsError> {
    if page_bytes.len() != page_ids.len() * 256 {
        return Err(JsError::new(&format!(
            "importMachine: {} page ids but {} bytes of page data. \
             Expected {} (256 per page), so the pages cannot be cut apart.",
            page_ids.len(),
            page_bytes.len(),
            page_ids.len() * 256,
        )));
    }
    Ok(())
}

// -- rung 1 ---------------------------------------------------------------

/// Rung 1 of the engine ladder (`v6502-hybrid`): the same chip with the
/// recognised gates folded into per-output counters, behind the surface the
/// console's worker drives. Bit-exact with [`Machine`] every node every
/// half-cycle (`v6502-hybrid/tests/lockstep.rs`), and the machine value is
/// the SAME value, so a run can cross between the two engines mid-game
/// (`v6502-hybrid/tests/state.rs`).
///
/// Only in the default build: the hybrid netlist is derived from the
/// schematic, which is derived from the die data, so the data-free package
/// has no rung 1 to construct.
///
/// No rewind and no node-level buffer: this surface is the console contract
/// (boot, step, the machine as a value, named-node sampling), not the
/// explorer's.
#[cfg(feature = "mos6502")]
#[wasm_bindgen]
pub struct HybridMachine {
    cpu: v6502_hybrid::HybridCpu<FlatMemory>,
}

#[cfg(feature = "mos6502")]
#[wasm_bindgen]
impl HybridMachine {
    /// Build with the embedded 6502 netlist, the gates recognised at
    /// construction. Not yet reset -- load a program and set the reset
    /// vector first, exactly as [`Machine::new`].
    #[wasm_bindgen(constructor)]
    pub fn new() -> HybridMachine {
        let hn = v6502_hybrid::HybridNetlist::new(Arc::new(v6502_sim::mos6502()));
        HybridMachine { cpu: v6502_hybrid::HybridCpu::new(Arc::new(hn), FlatMemory::new()) }
    }

    pub fn load(&mut self, addr: u16, bytes: &[u8]) {
        self.cpu.bus.load(addr, bytes);
    }

    #[wasm_bindgen(js_name = setResetVector)]
    pub fn set_reset_vector(&mut self, addr: u16) {
        self.cpu.bus.set_reset_vector(addr);
    }

    /// Set all 64 KiB to one byte, so a sparse image can be written over it.
    #[wasm_bindgen(js_name = fillMemory)]
    pub fn fill_memory(&mut self, byte: u8) {
        self.cpu.bus.load(0, &vec![byte; 0x10000]);
    }

    /// Cold boot, as [`Machine::power_cycle`].
    #[wasm_bindgen(js_name = powerCycle)]
    pub fn power_cycle(&mut self) {
        self.cpu.power_cycle();
        self.cpu.bus.clear_journal();
    }

    /// Warm reset, as [`Machine::reset`].
    pub fn reset(&mut self) {
        self.cpu.reset();
        self.cpu.bus.clear_journal();
    }

    #[wasm_bindgen(js_name = halfStep)]
    pub fn half_step(&mut self) {
        self.cpu.half_step();
    }

    /// Advance `n` half-cycles, one boundary crossing for the batch.
    #[wasm_bindgen(js_name = runHalfCycles)]
    pub fn run_half_cycles(&mut self, n: u32) {
        for _ in 0..n {
            self.cpu.half_step();
        }
    }

    #[wasm_bindgen(js_name = halfCycle)]
    pub fn half_cycle(&self) -> f64 {
        self.cpu.half_cycle() as f64
    }
    #[wasm_bindgen(js_name = addressBus)]
    pub fn address_bus(&self) -> u16 {
        self.cpu.address_bus()
    }
    #[wasm_bindgen(js_name = dataBus)]
    pub fn data_bus(&self) -> u8 {
        self.cpu.data_bus()
    }
    #[wasm_bindgen(js_name = isRead)]
    pub fn is_read(&self) -> bool {
        self.cpu.rw_is_read()
    }
    pub fn sync(&self) -> bool {
        self.cpu.sync()
    }
    pub fn clk0(&self) -> bool {
        self.cpu.clk0()
    }

    #[wasm_bindgen(js_name = nodeCount)]
    pub fn node_count(&self) -> u32 {
        self.cpu.engine().netlist().node_count() as u32
    }
    #[wasm_bindgen(js_name = isNodeHigh)]
    pub fn is_node_high(&self, node: u16) -> bool {
        self.cpu.engine().is_high(node)
    }
    /// Resolve a signal name to a node number, or -1 if unknown: the refusal
    /// the console's gate sampling is built on.
    #[wasm_bindgen(js_name = nodeId)]
    pub fn node_id(&self, name: &str) -> i32 {
        self.cpu.engine().netlist().node(name).map_or(-1, i32::from)
    }

    pub fn peek(&self, addr: u16) -> u8 {
        self.cpu.bus.peek(addr)
    }
    #[wasm_bindgen(js_name = memorySlice)]
    pub fn memory_slice(&self, addr: u16, len: u32) -> Vec<u8> {
        (0..len).map(|i| self.cpu.bus.peek(addr.wrapping_add(i as u16))).collect()
    }

    /// The whole machine as the API's own JSON, through the same emitter as
    /// [`Machine::export_machine`], so the two cannot drift in shape.
    #[wasm_bindgen(js_name = exportMachine)]
    pub fn export_machine(&self) -> String {
        machine_json(&v6502_hybrid::state::snapshot(&self.cpu), self.cpu.bus.as_slice())
    }

    /// Restore the chip half of a machine, and ONLY the chip half. The same
    /// contract, and the same quiet failure to avoid, as
    /// [`Machine::import_state`]: memory does not come with it.
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = importState)]
    pub fn import_state(
        &mut self,
        value: &str,
        pullup: &str,
        pulldown: &str,
        trans_on: &str,
        half_cycle: f64,
        fetch_addr: i32,
        fetch_opcode: u8,
    ) -> Result<(), JsError> {
        let (nodes, transistors) = {
            let nl = self.cpu.engine().netlist();
            (nl.node_count(), nl.transistor_count())
        };
        let last_fetch = if fetch_addr < 0 {
            None
        } else {
            Some(Fetch { addr: fetch_addr as u16, opcode: fetch_opcode })
        };
        let st = MachineState::from_hex(
            nodes, transistors, value, pullup, pulldown, trans_on, half_cycle as u64, last_fetch,
        )
        .map_err(|e| JsError::new(&e))?;
        v6502_hybrid::state::restore(&mut self.cpu, &st);
        Ok(())
    }

    /// A whole machine, chip and memory in one call: the counterpart to
    /// `exportMachine`, with [`Machine::import_machine`]'s contract.
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = importMachine)]
    pub fn import_machine(
        &mut self,
        value: &str,
        pullup: &str,
        pulldown: &str,
        trans_on: &str,
        half_cycle: f64,
        fetch_addr: i32,
        fetch_opcode: u8,
        fill: u8,
        page_ids: &[u8],
        page_bytes: &[u8],
    ) -> Result<(), JsError> {
        check_page_cut(page_ids, page_bytes)?;
        self.import_state(value, pullup, pulldown, trans_on, half_cycle, fetch_addr, fetch_opcode)?;
        self.fill_memory(fill);
        for (i, &page) in page_ids.iter().enumerate() {
            let from = i * 256;
            self.load(u16::from(page) << 8, &page_bytes[from..from + 256]);
        }
        Ok(())
    }

    #[wasm_bindgen(js_name = nonconvergentSettles)]
    pub fn nonconvergent_settles(&self) -> f64 {
        self.cpu.engine().stats().nonconvergent_settles as f64
    }
    #[wasm_bindgen(js_name = contestedGroups)]
    pub fn contested_groups(&self) -> f64 {
        self.cpu.engine().stats().contested_groups as f64
    }
}

#[cfg(feature = "mos6502")]
impl Default for HybridMachine {
    fn default() -> Self {
        Self::new()
    }
}

// -- rung 2 ---------------------------------------------------------------

/// Rung 2 of the engine ladder (`v6502-compiled`): the recognised network as
/// generated code, behind the console's verbs. **Not node-exact with
/// [`Machine`] by nature** (Jacobi against the queue: charge remembers a
/// trajectory), and it does not pretend to be: what is held, and proven at
/// the crossing (`v6502-compiled/tests/crossing.rs`), is the console
/// contract itself: all eleven pins, the watched control lines, and the
/// memory image, every half-cycle from a mid-run resume in either direction.
/// A comparison of exported `value`/`trans_on` against another rung is
/// expected to differ; compare memory and gates instead.
///
/// The kernel runs 64 lanes a word; here one machine is broadcast into all
/// of them (the clock is one instruction for every lane regardless), and
/// lane 0 is what is read back. Names resolve through the embedded netlist
/// on this side of the boundary, so the generated kernel stays numbers.
///
/// Only in the default build, like [`HybridMachine`].
#[cfg(feature = "mos6502")]
#[wasm_bindgen]
pub struct CompiledMachine {
    m: v6502_compiled::Machines,
    nl: Arc<v6502_sim::Netlist>,
    last_fetch: Option<Fetch>,
}

#[cfg(feature = "mos6502")]
fn decode_hex(name: &str, hex: &str) -> Result<Vec<u8>, JsError> {
    if !hex.len().is_multiple_of(2) {
        return Err(JsError::new(&format!("{name}: odd hex length {}", hex.len())));
    }
    (0..hex.len() / 2)
        .map(|i| {
            u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
                .map_err(|_| JsError::new(&format!("{name}: bad hex at byte {i}")))
        })
        .collect()
}

#[cfg(feature = "mos6502")]
#[wasm_bindgen]
impl CompiledMachine {
    /// Build with the embedded netlist's layout pulls and name table. Not
    /// yet reset -- load a program and set the reset vector first, exactly
    /// as [`Machine::new`].
    #[wasm_bindgen(constructor)]
    pub fn new() -> CompiledMachine {
        let nl = Arc::new(v6502_sim::mos6502());
        let pu: Vec<bool> = (0..nl.node_count()).map(|i| nl.pullups().get(i)).collect();
        CompiledMachine { m: v6502_compiled::Machines::new(&pu), nl, last_fetch: None }
    }

    /// Into every lane: one machine, broadcast, per the type's account.
    pub fn load(&mut self, addr: u16, bytes: &[u8]) {
        for lane in 0..v6502_compiled::LANES {
            let o = addr as usize;
            self.m.mem[lane][o..o + bytes.len()].copy_from_slice(bytes);
        }
    }

    #[wasm_bindgen(js_name = setResetVector)]
    pub fn set_reset_vector(&mut self, addr: u16) {
        self.load(0xfffc, &[addr as u8, (addr >> 8) as u8]);
    }

    /// Set all 64 KiB to one byte, so a sparse image can be written over it.
    #[wasm_bindgen(js_name = fillMemory)]
    pub fn fill_memory(&mut self, byte: u8) {
        for lane in 0..v6502_compiled::LANES {
            self.m.mem[lane].iter_mut().for_each(|b| *b = byte);
        }
    }

    /// Cold boot. The fetch bookkeeping starts at the first fetch after the
    /// boot rather than inside the reset sequence; the state and memory are
    /// what the crossing holds, and `last_fetch` is bookkeeping, not
    /// silicon.
    #[wasm_bindgen(js_name = powerCycle)]
    pub fn power_cycle(&mut self) {
        self.m.power_cycle();
        self.last_fetch = None;
    }

    /// Warm reset, same bookkeeping note as `powerCycle`.
    pub fn reset(&mut self) {
        self.m.reset();
        self.last_fetch = None;
    }

    #[wasm_bindgen(js_name = halfStep)]
    pub fn half_step(&mut self) {
        self.m.half_step();
        // The latch rung 0 keeps in service_read, read back off the settled
        // state: a falling edge that serviced a fetch read leaves clk0 low,
        // sync high and rw reading, with the opcode on the data bus.
        let pins = v6502_compiled::Machines::pins(&self.m, 0);
        if !pins.clk0 && pins.sync && pins.rw {
            self.last_fetch = Some(Fetch { addr: pins.ab, opcode: pins.db });
        }
    }

    /// Advance `n` half-cycles, one boundary crossing for the batch.
    #[wasm_bindgen(js_name = runHalfCycles)]
    pub fn run_half_cycles(&mut self, n: u32) {
        for _ in 0..n {
            self.half_step();
        }
    }

    #[wasm_bindgen(js_name = halfCycle)]
    pub fn half_cycle(&self) -> f64 {
        self.m.half_cycle() as f64
    }
    #[wasm_bindgen(js_name = addressBus)]
    pub fn address_bus(&self) -> u16 {
        v6502_compiled::Machines::pins(&self.m, 0).ab
    }
    #[wasm_bindgen(js_name = dataBus)]
    pub fn data_bus(&self) -> u8 {
        v6502_compiled::Machines::pins(&self.m, 0).db
    }
    #[wasm_bindgen(js_name = isRead)]
    pub fn is_read(&self) -> bool {
        v6502_compiled::Machines::pins(&self.m, 0).rw
    }
    pub fn sync(&self) -> bool {
        v6502_compiled::Machines::pins(&self.m, 0).sync
    }
    pub fn clk0(&self) -> bool {
        v6502_compiled::Machines::pins(&self.m, 0).clk0
    }

    #[wasm_bindgen(js_name = nodeCount)]
    pub fn node_count(&self) -> u32 {
        self.nl.node_count() as u32
    }
    #[wasm_bindgen(js_name = isNodeHigh)]
    pub fn is_node_high(&self, node: u16) -> bool {
        self.m.state.is_high(0, node as usize)
    }
    /// Resolve a signal name to a node number, or -1 if unknown: the refusal
    /// the console's gate sampling is built on. The name table lives on this
    /// side of the licence boundary; the kernel itself carries none.
    #[wasm_bindgen(js_name = nodeId)]
    pub fn node_id(&self, name: &str) -> i32 {
        self.nl.node(name).map_or(-1, i32::from)
    }

    pub fn peek(&self, addr: u16) -> u8 {
        self.m.mem[0][addr as usize]
    }
    #[wasm_bindgen(js_name = memorySlice)]
    pub fn memory_slice(&self, addr: u16, len: u32) -> Vec<u8> {
        (0..len).map(|i| self.m.mem[0][addr.wrapping_add(i as u16) as usize]).collect()
    }

    /// The whole machine as the API's own JSON, through the same emitter as
    /// [`Machine::export_machine`]. The lane's packed bytes ARE the codec's
    /// byte order, so the hex here is rung 0's wire encoding.
    #[wasm_bindgen(js_name = exportMachine)]
    pub fn export_machine(&self) -> String {
        let (value, pullup, pulldown, trans_on) = self.m.state.extract_lane(0);
        let hex = |v: &[u8]| {
            let mut out = String::with_capacity(v.len() * 2);
            for b in v {
                out.push_str(&format!("{b:02x}"));
            }
            out
        };
        let st = MachineState::from_hex(
            self.nl.node_count(),
            self.nl.transistor_count(),
            &hex(&value),
            &hex(&pullup),
            &hex(&pulldown),
            &hex(&trans_on),
            self.m.half_cycle(),
            self.last_fetch,
        )
        .expect("an extracted lane is a well-formed machine");
        machine_json(&st, &self.m.mem[0])
    }

    /// Restore the chip half of a machine, and ONLY the chip half. The same
    /// contract and the same quiet failure to avoid as
    /// [`Machine::import_state`]: memory does not come with it.
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = importState)]
    pub fn import_state(
        &mut self,
        value: &str,
        pullup: &str,
        pulldown: &str,
        trans_on: &str,
        half_cycle: f64,
        fetch_addr: i32,
        fetch_opcode: u8,
    ) -> Result<(), JsError> {
        let v = decode_hex("value", value)?;
        let pu = decode_hex("pullup", pullup)?;
        let pd = decode_hex("pulldown", pulldown)?;
        let t = decode_hex("trans_on", trans_on)?;
        self.m.state.inject_all(&v, &pu, &pd, &t).map_err(|e| JsError::new(&e))?;
        self.m.set_half_cycle(half_cycle as u64);
        self.last_fetch = if fetch_addr < 0 {
            None
        } else {
            Some(Fetch { addr: fetch_addr as u16, opcode: fetch_opcode })
        };
        Ok(())
    }

    /// A whole machine, chip and memory in one call: the counterpart to
    /// `exportMachine`, with [`Machine::import_machine`]'s contract.
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = importMachine)]
    pub fn import_machine(
        &mut self,
        value: &str,
        pullup: &str,
        pulldown: &str,
        trans_on: &str,
        half_cycle: f64,
        fetch_addr: i32,
        fetch_opcode: u8,
        fill: u8,
        page_ids: &[u8],
        page_bytes: &[u8],
    ) -> Result<(), JsError> {
        check_page_cut(page_ids, page_bytes)?;
        self.import_state(value, pullup, pulldown, trans_on, half_cycle, fetch_addr, fetch_opcode)?;
        self.fill_memory(fill);
        for (i, &page) in page_ids.iter().enumerate() {
            let from = i * 256;
            self.load(u16::from(page) << 8, &page_bytes[from..from + 256]);
        }
        Ok(())
    }

    #[wasm_bindgen(js_name = nonconvergentSettles)]
    pub fn nonconvergent_settles(&self) -> f64 {
        self.m.stats.nonconvergent_settles as f64
    }
}

#[cfg(feature = "mos6502")]
impl Default for CompiledMachine {
    fn default() -> Self {
        Self::new()
    }
}

// -- rung 3 ---------------------------------------------------------------

/// Rung 3 of the engine ladder (`v6502-micro`): no nodes at all, the
/// measured control table through the authored datapath, behind the same
/// console verbs. Held to the whole pin golden, stimulus traces included.
///
/// **Its machine value is its own** (`state.micro` on the wire, about 90
/// bytes plus the memory pages) and does not pretend to be the four node
/// planes: there is no `importMachine` here, and a node-shaped value has
/// no way in. The worker that owns the engine switch says so by name;
/// moving a running cartridge onto this rung means powering it here.
///
/// `nodeId` resolves the 51 control-vector columns (`lines.rs`: the 44
/// dpc lines, the vector constants, rw and sync), which are exactly what
/// Die Runner's eight watched gates are; every other name is refused with
/// -1, because this rung has nothing to sample it from.
///
/// Only in the default build: the table is derived from the die data.
#[cfg(feature = "mos6502")]
#[wasm_bindgen]
pub struct MicroMachine {
    cpu: v6502_micro::machine::MicroCpu,
}

#[cfg(feature = "mos6502")]
#[wasm_bindgen]
impl MicroMachine {
    /// Not yet reset -- load a program and set the reset vector first,
    /// exactly as [`Machine::new`].
    #[wasm_bindgen(constructor)]
    pub fn new() -> MicroMachine {
        MicroMachine { cpu: v6502_micro::machine::MicroCpu::new() }
    }

    pub fn load(&mut self, addr: u16, bytes: &[u8]) {
        let o = addr as usize;
        self.cpu.mem[o..o + bytes.len()].copy_from_slice(bytes);
    }

    #[wasm_bindgen(js_name = setResetVector)]
    pub fn set_reset_vector(&mut self, addr: u16) {
        self.load(0xfffc, &[addr as u8, (addr >> 8) as u8]);
    }

    /// Set all 64 KiB to one byte, so a sparse image can be written over it.
    #[wasm_bindgen(js_name = fillMemory)]
    pub fn fill_memory(&mut self, byte: u8) {
        self.cpu.mem.iter_mut().for_each(|b| *b = byte);
    }

    /// Cold boot: seed from the measured reset state and stand at h = 0.
    #[wasm_bindgen(js_name = powerCycle)]
    pub fn power_cycle(&mut self) {
        self.cpu.power_cycle();
    }

    /// This rung has no warm reset apart from the RES pin itself; the
    /// console only powers, and this alias keeps the verb set whole.
    pub fn reset(&mut self) {
        self.cpu.power_cycle();
    }

    #[wasm_bindgen(js_name = halfStep)]
    pub fn half_step(&mut self) {
        v6502_pins::PinEngine::half_step(&mut self.cpu);
    }

    #[wasm_bindgen(js_name = runHalfCycles)]
    pub fn run_half_cycles(&mut self, n: u32) {
        for _ in 0..n {
            v6502_pins::PinEngine::half_step(&mut self.cpu);
        }
    }

    #[wasm_bindgen(js_name = halfCycle)]
    pub fn half_cycle(&self) -> f64 {
        v6502_pins::PinEngine::h(&self.cpu) as f64
    }
    #[wasm_bindgen(js_name = addressBus)]
    pub fn address_bus(&self) -> u16 {
        v6502_pins::PinEngine::pins(&self.cpu).ab
    }
    #[wasm_bindgen(js_name = dataBus)]
    pub fn data_bus(&self) -> u8 {
        v6502_pins::PinEngine::pins(&self.cpu).db
    }
    #[wasm_bindgen(js_name = isRead)]
    pub fn is_read(&self) -> bool {
        v6502_pins::PinEngine::pins(&self.cpu).rw
    }
    pub fn sync(&self) -> bool {
        v6502_pins::PinEngine::pins(&self.cpu).sync
    }
    pub fn clk0(&self) -> bool {
        v6502_pins::PinEngine::pins(&self.cpu).clk0
    }

    /// Drive the five input pins, active low where the chip says so.
    #[wasm_bindgen(js_name = setInputs)]
    pub fn set_inputs(&mut self, res: bool, irq: bool, nmi: bool, rdy: bool, so: bool) {
        v6502_pins::PinEngine::set_inputs(&mut self.cpu, res, irq, nmi, rdy, so);
    }

    /// No nodes on this rung; what `nodeId` resolves is the control
    /// vector's columns.
    #[wasm_bindgen(js_name = nodeCount)]
    pub fn node_count(&self) -> u32 {
        0
    }
    /// A control-vector column by its die name (`dpc25_SBDB` and kin, plus
    /// rw and sync), or -1: the refusal the console's gate sampling is
    /// built on, and here it also covers every name that is a real node on
    /// the die but not a line this rung carries.
    #[wasm_bindgen(js_name = nodeId)]
    pub fn node_id(&self, name: &str) -> i32 {
        v6502_micro::lines::LINE_NAMES
            .iter()
            .position(|&n| n == name)
            .map_or(-1, |i| i as i32)
    }
    /// The named column's level as of the last played half-cycle: the
    /// table's own word, which the coverage test holds to the chip line
    /// for line.
    #[wasm_bindgen(js_name = isNodeHigh)]
    pub fn is_node_high(&self, line: u16) -> bool {
        (line as usize) < v6502_micro::lines::LINE_NAMES.len()
            && self.cpu.control_word() >> line & 1 != 0
    }

    pub fn peek(&self, addr: u16) -> u8 {
        self.cpu.mem[addr as usize]
    }
    #[wasm_bindgen(js_name = memorySlice)]
    pub fn memory_slice(&self, addr: u16, len: u32) -> Vec<u8> {
        (0..len).map(|i| self.cpu.mem[addr.wrapping_add(i as u16) as usize]).collect()
    }

    /// The whole machine as the API's JSON shape, with rung 3's own state
    /// where the node planes would be: `state.micro`, the versioned byte
    /// codec as hex. `half_cycle` and `last_fetch` ride beside it for the
    /// console's readouts, emitted from the same machine in the same call.
    #[wasm_bindgen(js_name = exportMachine)]
    pub fn export_machine(&self) -> String {
        let st = self.cpu.snapshot();
        let (addr, opcode) = self.cpu.last_fetch();
        let mut out = String::with_capacity(1024);
        out.push_str("{\"state\":{\"half_cycle\":");
        out.push_str(&st.half_cycle.to_string());
        out.push_str(",\"last_fetch\":{\"addr\":");
        out.push_str(&addr.to_string());
        out.push_str(",\"opcode\":");
        out.push_str(&opcode.to_string());
        out.push_str("},\"micro\":\"");
        for b in st.encode() {
            out.push_str(&format!("{b:02x}"));
        }
        out.push_str("\"},\"memory\":");
        push_memory(&mut out, &st.mem);
        out.push('}');
        out
    }

    /// The counterpart to `exportMachine`: rung 3's own value, decoded and
    /// refused by name where it cannot stand (a bad version, a span the
    /// table does not hold). The memory is the fill plus the pages, as
    /// every engine's import lays it.
    #[wasm_bindgen(js_name = importMicro)]
    pub fn import_micro(
        &mut self,
        micro_hex: &str,
        fill: u8,
        page_ids: &[u8],
        page_bytes: &[u8],
    ) -> Result<(), JsError> {
        check_page_cut(page_ids, page_bytes)?;
        let blob = decode_hex("micro", micro_hex)?;
        let mut st = v6502_micro::machine::MicroState::decode(&blob, fill)
            .map_err(|e| JsError::new(&e))?;
        for (i, &page) in page_ids.iter().enumerate() {
            let from = i * 256;
            let o = usize::from(page) << 8;
            st.mem[o..o + 256].copy_from_slice(&page_bytes[from..from + 256]);
        }
        self.cpu.restore(&st).map_err(|e| JsError::new(&e))
    }
}

#[cfg(feature = "mos6502")]
impl Default for MicroMachine {
    fn default() -> Self {
        Self::new()
    }
}
