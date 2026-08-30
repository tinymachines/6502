//! Rung 2 on a GPU.
//!
//! `v6502_compiled::KERNEL_WGSL` is the same kernel the CPU rung runs,
//! emitted by the same `build.rs` from the same folds, with `u32` lanes. One
//! invocation owns one word of 32 machines and does a whole half-step (the
//! clock edge, the settle to closure, the bus service against that lane's
//! 64 KiB in a storage buffer), so the CPU only dispatches half-steps in
//! batches and reads back what it wants to look at.
//!
//! Per-lane semantics are lane-independent, so GPU lane `k` of any word must
//! equal CPU lane `k` of a `Machines` given the same memory, bit for bit,
//! after the same number of half-steps; `tests/parity.rs` holds that.

#![forbid(unsafe_code)]

use v6502_compiled::kernel::{NODES, TRANS};
use v6502_compiled::{Machines, KERNEL_WGSL};

pub const LANES_PER_WORD: usize = 32;

fn bytes(v: &[u32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

pub struct Gpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::ComputePipeline,
    bind: [wgpu::BindGroup; 2],
    value: wgpu::Buffer,
    pullup: wgpu::Buffer,
    pulldown: wgpu::Buffer,
    trans_on: wgpu::Buffer,
    mem: wgpu::Buffer,
    staging: wgpu::Buffer,
    pub words: usize,
    pub half_cycle: u64,
    /// The clock as loaded, toggled per half-step: it picks the edge to dispatch.
    clk_high: bool,
    pub adapter_name: String,
}

impl Gpu {
    /// `None` when no adapter or device is available.
    pub fn new(words: usize) -> Option<Gpu> {
        let instance = wgpu::Instance::default();
        // GPU_INDEX picks among the adapters (a box with two cards and one
        // busy); otherwise the high-performance one.
        let adapter = match std::env::var("GPU_INDEX").ok().and_then(|s| s.parse::<usize>().ok()) {
            Some(i) => instance.enumerate_adapters(wgpu::Backends::all()).into_iter().nth(i)?,
            None => pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                ..Default::default()
            }))?,
        };
        let adapter_name = adapter.get_info().name;
        let (device, queue) = pollster::block_on(adapter.request_device(
            &wgpu::DeviceDescriptor {
                label: Some("v6502-gpu"),
                required_features: wgpu::Features::empty(),
                required_limits: adapter.limits(),
                memory_hints: wgpu::MemoryHints::Performance,
            },
            None,
        ))
        .ok()?;
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("kernel"),
            source: wgpu::ShaderSource::Wgsl(KERNEL_WGSL.into()),
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("half_step"),
            layout: None,
            module: &module,
            entry_point: "half_step",
            compilation_options: Default::default(),
            cache: None,
        });
        let mk = |label: &str, size: usize, usage: wgpu::BufferUsages| {
            device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size: size as u64, usage, mapped_at_creation: false })
        };
        let st = wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC;
        let value = mk("value", words * NODES * 4, st);
        let pullup = mk("pullup", words * NODES * 4, st);
        let pulldown = mk("pulldown", words * NODES * 4, st);
        let trans_on = mk("trans_on", words * TRANS * 4, st);
        let nxt = mk("next", words * NODES * 4, st);
        let mem = mk("mem", words * LANES_PER_WORD * 0x10000, st);
        let gate_of = mk("gate_of", TRANS * 4, wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST);
        let staging = mk("staging", words * TRANS * 4, wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST);
        let gates: Vec<u32> = v6502_compiled::kernel::GATE_OF.iter().map(|&g| g as u32).collect();
        queue.write_buffer(&gate_of, 0, &bytes(&gates));
        let sw = mk("switches", v6502_compiled::kernel::SWITCH_TABLE.len() * 4, wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST);
        queue.write_buffer(&sw, 0, &bytes(&v6502_compiled::kernel::SWITCH_TABLE));
        let gt = mk("gates", v6502_compiled::kernel::GATE_TABLE.len() * 4, wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST);
        queue.write_buffer(&gt, 0, &bytes(&v6502_compiled::kernel::GATE_TABLE));
        let jt = mk("junctions", v6502_compiled::kernel::JUNCTION_TABLE.len() * 4, wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST);
        queue.write_buffer(&jt, 0, &bytes(&v6502_compiled::kernel::JUNCTION_TABLE));
        let go = mk("gate offsets", v6502_compiled::kernel::GATE_OFFSETS.len() * 4, wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST);
        queue.write_buffer(&go, 0, &bytes(&v6502_compiled::kernel::GATE_OFFSETS));
        let jo = mk("junction offsets", v6502_compiled::kernel::JUNCTION_OFFSETS.len() * 4, wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST);
        queue.write_buffer(&jo, 0, &bytes(&v6502_compiled::kernel::JUNCTION_OFFSETS));
        let params: Vec<wgpu::Buffer> = (0..2u32)
            .map(|op| {
                let b = mk("params", 32, wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST);
                queue.write_buffer(&b, 0, &bytes(&[words as u32, op, v6502_compiled::MAX_ROUNDS as u32, NODES as u32, TRANS as u32,
                                                   (v6502_compiled::kernel::SWITCH_TABLE.len() / 4) as u32,
                                                   v6502_compiled::kernel::FOLDED_GATES as u32, v6502_compiled::kernel::JUNCTIONS as u32]));
                b
            })
            .collect();
        let layout = pipeline.get_bind_group_layout(0);
        let bind = std::array::from_fn(|i| {
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("bind"),
                layout: &layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: params[i].as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: value.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 2, resource: pullup.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 3, resource: pulldown.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 4, resource: trans_on.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 6, resource: nxt.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 7, resource: mem.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 8, resource: gate_of.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 9, resource: sw.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 10, resource: gt.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 11, resource: jt.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 12, resource: go.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 13, resource: jo.as_entire_binding() },
                ],
            })
        });
        Some(Gpu { device, queue, pipeline, bind, value, pullup, pulldown, trans_on, mem, staging, words, half_cycle: 0, clk_high: false, adapter_name })
    }

    /// Fill every word from the lower 32 lanes of a CPU `Machines`: node
    /// state and each lane's memory. Lane `k` of every word is CPU lane `k`.
    pub fn load(&mut self, m: &Machines) {
        let lanes = |src: &[u64]| -> Vec<u32> {
            let one: Vec<u32> = src.iter().map(|&w| w as u32).collect();
            one.iter().cycle().take(one.len() * self.words).copied().collect()
        };
        self.queue.write_buffer(&self.value, 0, &bytes(&lanes(&m.state.value)));
        self.queue.write_buffer(&self.pullup, 0, &bytes(&lanes(&m.state.pullup)));
        self.queue.write_buffer(&self.pulldown, 0, &bytes(&lanes(&m.state.pulldown)));
        self.queue.write_buffer(&self.trans_on, 0, &bytes(&lanes(&m.state.trans_on)));
        let mut mem = Vec::with_capacity(self.words * LANES_PER_WORD * 0x10000);
        for _ in 0..self.words {
            for lane in 0..LANES_PER_WORD {
                mem.extend_from_slice(&m.mem[lane]);
            }
        }
        self.queue.write_buffer(&self.mem, 0, &mem);
        self.half_cycle = m.half_cycle();
        self.clk_high = m.state.value[v6502_compiled::kernel::sig::CLK0] != 0;
    }

    /// `n` half-steps for every machine, as one submission.
    pub fn half_steps(&mut self, n: u64) {
        let mut enc = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("half_steps") });
        let groups = self.words as u32;
        for _ in 0..n {
            // op 0 when the clock is high (it falls), op 1 when low (it
            // rises), tracked from the loaded state the way the CPU rung
            // reads it off the node.
            let op = if self.clk_high { 0 } else { 1 };
            self.clk_high = !self.clk_high;
            let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: None, timestamp_writes: None });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.bind[op], &[]);
            pass.dispatch_workgroups(groups, 1, 1);
            drop(pass);
            self.half_cycle += 1;
        }
        self.queue.submit(Some(enc.finish()));
    }

    fn read(&self, src: &wgpu::Buffer, words: usize) -> Vec<u32> {
        let mut enc = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("read") });
        enc.copy_buffer_to_buffer(src, 0, &self.staging, 0, (words * 4) as u64);
        self.queue.submit(Some(enc.finish()));
        let slice = self.staging.slice(0..(words * 4) as u64);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| tx.send(r).unwrap());
        self.device.poll(wgpu::Maintain::Wait);
        rx.recv().unwrap().expect("map");
        let out: Vec<u32> = slice.get_mapped_range().chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        self.staging.unmap();
        out
    }

    /// Every word's node values, word-major.
    pub fn values(&self) -> Vec<u32> {
        self.read(&self.value, self.words * NODES)
    }
    pub fn trans_on(&self) -> Vec<u32> {
        self.read(&self.trans_on, self.words * TRANS)
    }
    /// Wait for everything submitted so far.
    pub fn sync(&self) {
        self.device.poll(wgpu::Maintain::Wait);
    }
}
