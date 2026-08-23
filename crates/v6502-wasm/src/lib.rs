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
use v6502_sim::{bus::FlatMemory, cpu::Cpu, cpu::Fetch, history::History, mos6502, ReadWrite};
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
    #[wasm_bindgen(constructor)]
    pub fn new() -> Machine {
        let netlist = Arc::new(mos6502());
        let node_count = netlist.node_count();
        let cpu = Cpu::new(netlist, FlatMemory::new())
            .expect("embedded netlist has every required signal");
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
    #[wasm_bindgen(js_name = runHalfCycles)]
    pub fn run_half_cycles(&mut self, n: u32) {
        for _ in 0..n {
            self.half_step();
        }
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
        let st = state::snapshot(&self.cpu);
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
        out.push_str("},\"memory\":{\"fill\":\"00\",\"pages\":{");
        let image = self.cpu.bus.as_slice();
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
        out.push_str("}}}");
        out
    }

    /// Restore the chip half of a machine. Memory travels separately: fill it
    /// and write the pages with `fillMemory` and `load`, which already exist.
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

impl Default for Machine {
    fn default() -> Self {
        Self::new()
    }
}

/// Netlist facts, available without constructing a machine.
#[wasm_bindgen(js_name = netlistInfo)]
pub fn netlist_info() -> String {
    let nl = mos6502();
    format!("{} nodes, {} transistors", nl.node_count(), nl.transistor_count())
}
