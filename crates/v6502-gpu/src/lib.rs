//! Rung 2 on a GPU.
//!
//! `v6502_compiled::KERNEL_WGSL` is the same kernel the CPU rung runs,
//! emitted by the same `build.rs` from the same folds, with `u32` lanes. One
//! invocation owns one word of 32 machines and does a whole half-step (the
//! clock edge, the settle to closure, the bus service against that lane's
//! memory), so the CPU only dispatches half-steps in batches and reads back
//! what it wants to look at.
//!
//! **Memory is sparse per lane.** A dense 64 KiB per lane was 99% of the
//! footprint (400 MB of the 408 at 6,400 machines) and was the stated
//! ceiling on machine count; the lanes mostly run one ROM and differ only
//! in the pages they write. So the kernel carries ONE shared base image, a
//! 256-entry page table per lane, and a pool of 256-byte pages allocated
//! copy-on-write at a lane's first write into a page. The pool's size is
//! the host's promise; a spent pool raises a flag and every readback
//! REFUSES the run by name rather than serving memory that silently
//! diverged. Lanes loaded with different images (the parity test's lane 1)
//! get their differing pages pre-seeded into the pool.
//!
//! **The kernel binds eight buffers**, which is the WebGPU spec's floor for
//! storage buffers per stage, so the same WGSL runs in any browser: the
//! four node planes share one buffer, the six read-only tables share one,
//! and the atomics (pool meta, the page pool, the lite variant's fifth
//! plane) share one. This host mirrors that layout exactly, and the
//! browser host (`web/swarm.js`) mirrors this one.
//!
//! Per-lane semantics are lane-independent, so GPU lane `k` of any word must
//! equal CPU lane `k` of a `Machines` given the same memory, bit for bit,
//! after the same number of half-steps; `tests/parity.rs` holds that for
//! BOTH settle variants (`half_step`, five planes in workgroup memory, and
//! `half_step_lite`, four there and the fifth in storage for adapters at
//! the 32 KB workgroup-storage floor), and holds the reconstructed
//! per-lane memory against the CPU lane's too.

#![forbid(unsafe_code)]

use v6502_compiled::kernel::{NODES, TRANS};
use v6502_compiled::{Machines, KERNEL_WGSL};

pub const LANES_PER_WORD: usize = 32;
/// The default pool budget: pages per lane, averaged across the pool (a
/// hot lane can take more as long as the whole pool holds). Sixteen is
/// 4 KiB a lane against the dense 64 KiB.
pub const DEFAULT_POOL_PAGES_PER_LANE: usize = 16;

const NO_PAGE: u32 = 0xffff_ffff;
/// Pool meta is the atomic buffer's first four words; page `e` is the 64
/// words at `POOL_O + e * 64`. Matches the kernel's `POOL_O`.
const POOL_O: usize = 4;

fn bytes(v: &[u32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

pub struct Gpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::ComputePipeline,
    bind: [wgpu::BindGroup; 2],
    planes: wgpu::Buffer,
    trans_on: wgpu::Buffer,
    base: wgpu::Buffer,
    ptab: wgpu::Buffer,
    am: wgpu::Buffer,
    staging: wgpu::Buffer,
    pub words: usize,
    /// The pool's capacity in 256-byte pages.
    pub pool_pages: usize,
    pub half_cycle: u64,
    /// The clock as loaded, toggled per half-step: it picks the edge to dispatch.
    clk_high: bool,
    pub adapter_name: String,
}

impl Gpu {
    /// `None` when no adapter or device is available. The pool takes the
    /// default budget; `new_with_pool` names one. Both run `half_step`;
    /// `new_with_entry` picks the lite variant instead.
    pub fn new(words: usize) -> Option<Gpu> {
        Gpu::new_with_pool(words, words * LANES_PER_WORD * DEFAULT_POOL_PAGES_PER_LANE)
    }

    pub fn new_with_pool(words: usize, pool_pages: usize) -> Option<Gpu> {
        Gpu::new_with_entry(words, pool_pages, false)
    }

    pub fn new_with_entry(words: usize, pool_pages: usize, lite: bool) -> Option<Gpu> {
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
        // The explicit eight-binding layout the kernel documents, shared by
        // every entry point (an auto layout would drop what one entry does
        // not touch, and the variants touch different sets).
        let buf_entry = |binding, read_only| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let uni = wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
            count: None,
        };
        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("kernel"),
            entries: &[uni, buf_entry(1, false), buf_entry(2, false), buf_entry(3, true), buf_entry(4, true),
                       buf_entry(5, false), buf_entry(6, false), buf_entry(7, false)],
        });
        let playout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("kernel"),
            bind_group_layouts: &[&bgl],
            push_constant_ranges: &[],
        });
        let entry = if lite { "half_step_lite" } else { "half_step" };
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some(entry),
            layout: Some(&playout),
            module: &module,
            entry_point: entry,
            compilation_options: Default::default(),
            cache: None,
        });
        let mk = |label: &str, size: usize, usage: wgpu::BufferUsages| {
            device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size: size as u64, usage, mapped_at_creation: false })
        };
        let st = wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC;
        let pool_pages = pool_pages.max(1);
        let lanes = words * LANES_PER_WORD;
        // planes: value | pullup | pulldown | next, words*NODES each.
        let planes = mk("planes", 4 * words * NODES * 4, st);
        let trans_on = mk("trans_on", words * TRANS * 4, st);
        let base = mk("base image", 0x10000, st);
        let ptab = mk("page table", lanes * 256 * 4, st);
        // am: pool meta (4 words) | the pool | the lite fifth plane.
        let p4s_off = POOL_O + pool_pages * 64;
        let am = mk("atomics", (p4s_off + words * NODES) * 4, st);
        let shuttle = mk("shuttle", (4 + lanes).max(1 + lanes * 64) * 4, st);
        // Read-only tables, concatenated in the kernel's TAB_* order.
        let mut tabs: Vec<u32> = v6502_compiled::kernel::GATE_OF.iter().map(|&g| g as u32).collect();
        tabs.extend_from_slice(&v6502_compiled::kernel::SWITCH_TABLE);
        tabs.extend_from_slice(&v6502_compiled::kernel::GATE_TABLE);
        tabs.extend_from_slice(&v6502_compiled::kernel::JUNCTION_TABLE);
        tabs.extend_from_slice(&v6502_compiled::kernel::GATE_OFFSETS);
        tabs.extend_from_slice(&v6502_compiled::kernel::JUNCTION_OFFSETS);
        let tab = mk("tables", tabs.len() * 4, wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST);
        queue.write_buffer(&tab, 0, &bytes(&tabs));
        let staging = mk("staging", (words * TRANS * 4).max(0x10000 + 256 * 4 + 16), wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST);
        let params: Vec<wgpu::Buffer> = (0..2u32)
            .map(|op| {
                let b = mk("params", 48, wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST);
                queue.write_buffer(&b, 0, &bytes(&[words as u32, op, v6502_compiled::MAX_ROUNDS as u32, NODES as u32, TRANS as u32,
                                                   (v6502_compiled::kernel::SWITCH_TABLE.len() / 4) as u32,
                                                   v6502_compiled::kernel::FOLDED_GATES as u32, v6502_compiled::kernel::JUNCTIONS as u32,
                                                   p4s_off as u32, 0, 0, 0]));
                b
            })
            .collect();
        let bind = std::array::from_fn(|i| {
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("bind"),
                layout: &bgl,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: params[i].as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: planes.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 2, resource: trans_on.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 3, resource: tab.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 4, resource: base.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 5, resource: am.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 6, resource: ptab.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 7, resource: shuttle.as_entire_binding() },
                ],
            })
        });
        Some(Gpu { device, queue, pipeline, bind, planes, trans_on, base, ptab, am, staging,
                   words, pool_pages, half_cycle: 0, clk_high: false, adapter_name })
    }

    /// Fill every word from the lower 32 lanes of a CPU `Machines`: node
    /// state and each lane's memory. Lane `k` of every word is CPU lane `k`.
    ///
    /// Lane 0's image becomes the shared base; a lane whose image differs
    /// gets its differing pages pre-seeded into the pool, per word (every
    /// word's copy of that lane evolves separately). A load whose seeding
    /// alone would spend the pool refuses here, by the numbers.
    pub fn load(&mut self, m: &Machines) {
        let lanes = |src: &[u64]| -> Vec<u32> {
            let one: Vec<u32> = src.iter().map(|&w| w as u32).collect();
            one.iter().cycle().take(one.len() * self.words).copied().collect()
        };
        let region = (self.words * NODES * 4) as u64;
        self.queue.write_buffer(&self.planes, 0, &bytes(&lanes(&m.state.value)));
        self.queue.write_buffer(&self.planes, region, &bytes(&lanes(&m.state.pullup)));
        self.queue.write_buffer(&self.planes, 2 * region, &bytes(&lanes(&m.state.pulldown)));
        self.queue.write_buffer(&self.trans_on, 0, &bytes(&lanes(&m.state.trans_on)));

        let base = &m.mem[0];
        self.queue.write_buffer(&self.base, 0, base);
        // Which pages of which lanes differ from the base: computed once,
        // seeded into the pool for every word.
        let dirty: Vec<(usize, Vec<usize>)> = (0..LANES_PER_WORD)
            .map(|lane| {
                let pages = (0..256)
                    .filter(|&p| m.mem[lane][p * 256..(p + 1) * 256] != base[p * 256..(p + 1) * 256])
                    .collect::<Vec<_>>();
                (lane, pages)
            })
            .filter(|(_, p)| !p.is_empty())
            .collect();
        let per_word: usize = dirty.iter().map(|(_, p)| p.len()).sum();
        let used = per_word * self.words;
        assert!(
            used <= self.pool_pages,
            "loading these machines needs {used} pool pages ({per_word} differing pages per word x {} words) but the pool holds {}",
            self.words,
            self.pool_pages
        );
        let mut ptab = vec![NO_PAGE; self.words * LANES_PER_WORD * 256];
        let mut seed: Vec<u8> = Vec::with_capacity(used * 256);
        let mut next = 0u32;
        for w in 0..self.words {
            for (lane, pages) in &dirty {
                for &p in pages {
                    ptab[(w * LANES_PER_WORD + lane) * 256 + p] = next;
                    seed.extend_from_slice(&m.mem[*lane][p * 256..(p + 1) * 256]);
                    next += 1;
                }
            }
        }
        self.queue.write_buffer(&self.ptab, 0, &bytes(&ptab));
        self.queue.write_buffer(&self.am, 0, &bytes(&[next, self.pool_pages as u32, 0, 0]));
        if !seed.is_empty() {
            self.queue.write_buffer(&self.am, (POOL_O * 4) as u64, &seed);
        }
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

    fn read_raw(&self, src: &wgpu::Buffer, src_off: u64, words: usize) -> Vec<u32> {
        let mut enc = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("read") });
        enc.copy_buffer_to_buffer(src, src_off, &self.staging, 0, (words * 4) as u64);
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

    /// The pool as it stands: pages taken (allocation count, which can
    /// exceed the capacity once spent), capacity, and whether a write was
    /// dropped. Reading anything else first goes through [`Gpu::refuse_if_spent`].
    pub fn pool_state(&self) -> (u32, u32, bool) {
        let m = self.read_raw(&self.am, 0, 3);
        (m[0], m[1], m[2] != 0)
    }

    /// A spent pool means a write was dropped and the lanes have silently
    /// diverged from what a dense memory would hold: every readback calls
    /// this and panics by the numbers rather than serving that state.
    fn refuse_if_spent(&self) {
        let (taken, cap, spent) = self.pool_state();
        assert!(
            !spent,
            "the page pool is spent: {taken} pages asked of {cap}; writes were dropped and this run's memory is not to be believed. Size the pool for the workload (Gpu::new_with_pool)."
        );
    }

    fn read(&self, src: &wgpu::Buffer, src_off: u64, words: usize) -> Vec<u32> {
        self.refuse_if_spent();
        self.read_raw(src, src_off, words)
    }

    /// Every word's node values, word-major.
    pub fn values(&self) -> Vec<u32> {
        self.read(&self.planes, 0, self.words * NODES)
    }
    pub fn trans_on(&self) -> Vec<u32> {
        self.read(&self.trans_on, 0, self.words * TRANS)
    }

    /// One lane's 64 KiB, reconstructed from the base, its page table and
    /// the pool: what a dense buffer would hold, or a refusal.
    pub fn memory(&self, lane_global: usize) -> Vec<u8> {
        self.refuse_if_spent();
        assert!(lane_global < self.words * LANES_PER_WORD, "lane {lane_global} of {}", self.words * LANES_PER_WORD);
        let table = self.read_raw(&self.ptab, (lane_global * 256 * 4) as u64, 256);
        let base = self.read_raw(&self.base, 0, 0x4000);
        let mut out: Vec<u8> = base.iter().flat_map(|w| w.to_le_bytes()).collect();
        for (p, &e) in table.iter().enumerate() {
            if e != NO_PAGE {
                let page = self.read_raw(&self.am, ((POOL_O + e as usize * 64) * 4) as u64, 64);
                let bytes: Vec<u8> = page.iter().flat_map(|w| w.to_le_bytes()).collect();
                out[p * 256..(p + 1) * 256].copy_from_slice(&bytes);
            }
        }
        out
    }

    /// Wait for everything submitted so far.
    pub fn sync(&self) {
        self.device.poll(wgpu::Maintain::Wait);
    }
}
