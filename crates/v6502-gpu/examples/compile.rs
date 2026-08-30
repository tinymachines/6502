//! Where the shader compile time goes: naga (module creation) against the
//! driver (pipeline creation). Run under a memory cap:
//!     (ulimit -v 16000000; /usr/bin/time -v cargo run --release -p v6502-gpu --example compile)
use std::time::Instant;
fn main() {
    let instance = wgpu::Instance::default();
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default() })).expect("adapter");
    println!("adapter: {} (workgroup storage limit {} bytes)", adapter.get_info().name, adapter.limits().max_compute_workgroup_storage_size);
    let (device, _queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { label: None, required_features: wgpu::Features::empty(), required_limits: adapter.limits(), memory_hints: wgpu::MemoryHints::Performance }, None)).expect("device");
    let owned = std::env::var("WGSL").ok().map(|p| std::fs::read_to_string(p).unwrap());
    let src: &str = owned.as_deref().unwrap_or(v6502_compiled::KERNEL_WGSL);
    println!("wgsl: {} bytes, {} lines", src.len(), src.lines().count());
    let t = Instant::now();
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("kernel"), source: wgpu::ShaderSource::Wgsl(src.into()) });
    device.poll(wgpu::Maintain::Wait);
    println!("naga module: {:.2}s", t.elapsed().as_secs_f64());
    let t = Instant::now();
    let _p = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor { label: Some("half_step"), layout: None, module: &module, entry_point: "half_step", compilation_options: Default::default(), cache: None });
    device.poll(wgpu::Maintain::Wait);
    println!("pipeline (driver): {:.2}s", t.elapsed().as_secs_f64());
}
