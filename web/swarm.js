// Swarm: the rung 2 kernel (v6502-compiled, emitted as WGSL by its own
// build.rs) on THIS machine's GPU through WebGPU, many chips wide. Every
// cell of the wall is one transistor-level 6502's screen page, gathered
// through the sparse per-lane memory (one shared base image, copy-on-write
// pages) that the native host (v6502-gpu) runs and tests.
//
// The machines are booted honestly: the painter program below is assembled
// in this page (asm.js, the same assembler the programs page uses), booted
// once on the switch-level chip (the wasm Machine, rung 0), and that
// machine value crosses onto the GPU rung the way tests/crossing.rs proves
// a rung 0 value crosses: at the four planes. Rung 2 is a THROUGHPUT
// engine: each chip here runs at a few hundred half-cycles a second, and
// the point of the page is the count, not the clock. The page says so.
//
// Refusals are by name: a browser without WebGPU, an adapter whose limits
// cannot hold the kernel's workgroup planes, a spent page pool.

import init, { Machine } from './pkg/v6502_wasm.js';
import { assemble } from './asm.js';

/* The program every chip runs. One source, every lane; the byte at $FF
 * (poked per lane before the first half-cycle) makes every chip a
 * different run, because it is the LFSR's tap set; the byte at $FE is the
 * host's brush, heard by every lane at once through the broadcast poke. */
export const PAINTER = `        .org $0200
start:  LDA $FF        ; the lane's own tap byte, poked by the host
        BNE seeded
        LDA #$A5       ; before the poke lands, self-seed
seeded: STA $F0
loop:   LDA $F0        ; one Galois LFSR step, taps = the lane byte
        LSR A
        BCC tap
        EOR $FF
tap:    STA $F0
        BNE go
        LDA $FF        ; a dead orbit reloads from the tap byte
        ORA #$01
        STA $F0
go:     TAY
        CLC
        ADC $FE        ; the brush shifts every lane's palette together
        STA $0400,Y    ; paint one byte of the screen page
        JMP loop`;

export const SCREEN_PAGE = 0x04;
const SEED_ADDR = 0x00ff;
const BRUSH_ADDR = 0x00fe;
const NO_WRITE = 0xffffffff;

/* One hex bitset (the machine JSON's wire encoding: bit i of the set is
 * byte i/8, LSB first) expanded to one u32 lane-mask per bit: every lane
 * of a word starts as the same machine. */
export function expandPlane(hex, bits) {
  const out = new Uint32Array(bits);
  for (let i = 0; i < bits; i++) {
    const byte = parseInt(hex.slice((i >> 3) * 2, (i >> 3) * 2 + 2), 16);
    out[i] = (byte >> (i & 7)) & 1 ? 0xffffffff : 0;
  }
  return out;
}

/* The machine JSON's sparse memory as the shared 64 KiB base image. */
export function baseImage(memory) {
  const img = new Uint8Array(0x10000).fill(parseInt(memory.fill ?? '00', 16));
  for (const [page, hexBytes] of Object.entries(memory.pages ?? {})) {
    const org = parseInt(page, 16) << 8;
    for (let i = 0; i < 256; i++) img[org + i] = parseInt(hexBytes.slice(i * 2, i * 2 + 2), 16);
  }
  return img;
}

/* Why this browser cannot run the wall, or null. Split out so the harness
 * can hold the refusal without a GPU in the room. */
export function refusal(nav) {
  if (!nav.gpu) return 'this browser has no WebGPU; the wall needs it (Chrome and Edge carry it, most others not yet)';
  return null;
}

/* The whole GPU side, mirroring crates/v6502-gpu/src/lib.rs exactly: the
 * same eight-buffer layout the kernel documents (the WebGPU spec's floor
 * for storage buffers per stage, so ANY adapter can bind it), the same
 * params words, the same copy-on-write memory. */
export async function gpuHost(kern, planes, base, words) {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('WebGPU is present but no adapter answered');
  // Two emissions of one settle: five planes on chip where the adapter
  // allows it, four on chip and the fifth in storage at the common 32 KB
  // workgroup-storage floor. Both are held to the CPU rung by the native
  // parity test; the choice here is only where the planes live.
  const full = adapter.limits.maxComputeWorkgroupStorageSize >= 5 * kern.nodes * 4;
  const entryPoint = full ? 'half_step' : 'half_step_lite';
  const LANES = 32, PAGES_PER_LANE = 16;
  const N = kern.nodes, T = kern.trans;
  const lanes = words * LANES;
  const poolPages = lanes * PAGES_PER_LANE;
  const p4sOff = 4 + poolPages * 64;
  const need = {
    maxComputeWorkgroupStorageSize: (full ? 5 : 4) * N * 4,
    maxStorageBufferBindingSize: Math.max(4 * words * N * 4, (p4sOff + words * N) * 4, lanes * 256 * 4),
    maxBufferSize: Math.max(4 * words * N * 4, (p4sOff + words * N) * 4, 1 + lanes * 64 * 4),
  };
  const limits = {};
  for (const [k, v] of Object.entries(need)) {
    const have = adapter.limits[k];
    if (have < v) throw new Error(`this adapter's ${k} is ${have} and the kernel needs ${v}; fewer words may fit (?words=)`);
    limits[k] = v;
  }
  const device = await adapter.requestDevice({ requiredLimits: limits });
  // Everything from the module to the bind groups under one validation
  // scope: a binding mistake would otherwise break the wall silently.
  device.pushErrorScope('validation');
  const module = device.createShaderModule({ code: kern.wgsl });

  const mk = (size, usage) => device.createBuffer({ size: Math.max(size, 16), usage });
  const ST = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  const shuttleWords = Math.max(4 + lanes, 1 + lanes * 64);
  const buf = {
    planes: mk(4 * words * N * 4, ST),
    trans_on: mk(words * T * 4, ST),
    base: mk(0x10000, ST),
    am: mk((p4sOff + words * N) * 4, ST),
    ptab: mk(lanes * 256 * 4, ST),
    shuttle: mk(shuttleWords * 4, ST),
    staging: mk(16 + lanes * 64 * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
  };
  const tabs = new Uint32Array([...kern.gate_of, ...kern.switch_table, ...kern.gate_table,
                                ...kern.junction_table, ...kern.gate_offsets, ...kern.junction_offsets]);
  buf.tabs = mk(tabs.length * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  const q = device.queue;
  q.writeBuffer(buf.tabs, 0, tabs);
  const bcast = (plane) => {
    const wide = new Uint32Array(plane.length * words);
    for (let w = 0; w < words; w++) wide.set(plane, w * plane.length);
    return wide;
  };
  const region = words * N * 4;
  q.writeBuffer(buf.planes, 0, bcast(planes.value));
  q.writeBuffer(buf.planes, region, bcast(planes.pullup));
  q.writeBuffer(buf.planes, 2 * region, bcast(planes.pulldown));
  q.writeBuffer(buf.trans_on, 0, bcast(planes.trans_on));
  q.writeBuffer(buf.base, 0, base);
  q.writeBuffer(buf.ptab, 0, new Uint32Array(lanes * 256).fill(NO_WRITE));
  q.writeBuffer(buf.am, 0, new Uint32Array([0, poolPages, 0, 0]));
  const params = [0, 1].map((op) => {
    const b = mk(48, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    q.writeBuffer(b, 0, new Uint32Array([words, op, kern.max_rounds, N, T, kern.switch_table.length / 4,
                                         kern.folded_gates, kern.junctions, p4sOff, 0, 0, 0]));
    return b;
  });

  const be = (binding, type) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } });
  const layout = device.createBindGroupLayout({
    entries: [
      be(0, 'uniform'), be(1, 'storage'), be(2, 'storage'), be(3, 'read-only-storage'),
      be(4, 'read-only-storage'), be(5, 'storage'), be(6, 'storage'), be(7, 'storage'),
    ],
  });
  const playout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const pipe = {};
  for (const name of [entryPoint, 'gather_page', 'poke_frame']) {
    pipe[name] = device.createComputePipeline({ layout: playout, compute: { module, entryPoint: name } });
  }
  pipe.step = pipe[entryPoint];
  const binds = params.map((pb) => device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer: pb } },
      { binding: 1, resource: { buffer: buf.planes } },
      { binding: 2, resource: { buffer: buf.trans_on } },
      { binding: 3, resource: { buffer: buf.tabs } },
      { binding: 4, resource: { buffer: buf.base } },
      { binding: 5, resource: { buffer: buf.am } },
      { binding: 6, resource: { buffer: buf.ptab } },
      { binding: 7, resource: { buffer: buf.shuttle } },
    ],
  }));

  // On a hardware adapter the scope resolves as fast as the compile; a
  // software one spends minutes there, so its verdict lands in the
  // console instead of blocking a host the harness only sets up.
  const software = /swiftshader|llvmpipe|software/i.test(`${adapter.info?.vendor ?? ''} ${adapter.info?.description ?? ''}`);
  const scope = device.popErrorScope();
  if (software) {
    scope.then((e) => { if (e) console.warn('GPU validation:', e.message); });
  } else {
    const verr = await scope;
    if (verr) throw new Error(`the GPU refused the kernel's setup: ${verr.message}`);
  }

  let clkHigh = (planes.value[kern.sig.clk0] & 1) !== 0;
  const pokeGroups = Math.ceil(lanes / 64);
  return {
    adapter: `${adapter.info ? `${adapter.info.vendor ?? ''} ${adapter.info.architecture ?? ''}`.trim() : 'GPU'} (${entryPoint})`,
    lanes,
    poolPages,
    /* Seeds before the first half-cycle, the brush any time after. */
    poke(broadcastAddr, broadcastVal, perLaneAddr, perLaneBytes) {
      const head = new Uint32Array(4 + lanes);
      head[0] = broadcastAddr; head[1] = broadcastVal; head[2] = perLaneAddr;
      if (perLaneBytes) for (let i = 0; i < lanes; i++) head[4 + i] = perLaneBytes[i];
      q.writeBuffer(buf.shuttle, 0, head);
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipe.poke_frame);
      pass.setBindGroup(0, binds[0]);
      pass.dispatchWorkgroups(pokeGroups);
      pass.end();
      q.submit([enc.finish()]);
    },
    /* n half-steps, then the screen page of every lane and the pool meter,
     * one submission and one map. */
    async frame(n, page) {
      const enc = device.createCommandEncoder();
      for (let i = 0; i < n; i++) {
        const pass = enc.beginComputePass();
        pass.setPipeline(pipe.step);
        pass.setBindGroup(0, binds[clkHigh ? 0 : 1]);
        pass.dispatchWorkgroups(words);
        pass.end();
        clkHigh = !clkHigh;
      }
      q.writeBuffer(buf.shuttle, 0, new Uint32Array([page]));
      const pass = enc.beginComputePass();
      pass.setPipeline(pipe.gather_page);
      pass.setBindGroup(0, binds[0]);
      pass.dispatchWorkgroups(pokeGroups);
      pass.end();
      enc.copyBufferToBuffer(buf.am, 0, buf.staging, 0, 16);
      enc.copyBufferToBuffer(buf.shuttle, 4, buf.staging, 16, lanes * 64 * 4);
      q.submit([enc.finish()]);
      await buf.staging.mapAsync(GPUMapMode.READ);
      const mapped = buf.staging.getMappedRange();
      const meta = new Uint32Array(mapped.slice(0, 16));
      const screens = new Uint8Array(mapped.slice(16, 16 + lanes * 256));
      buf.staging.unmap();
      return { screens, poolUsed: meta[0], poolCap: meta[1], spent: meta[2] !== 0 };
    },
  };
}

/* Byte to color: a 256-entry palette, zero near-black so an unwritten
 * screen reads as dark rather than as data. */
function palette() {
  const lut = new Uint8Array(256 * 3);
  for (let v = 1; v < 256; v++) {
    const h = (v * 1.40625) % 360, s = 0.65, l = 0.28 + (v / 255) * 0.38;
    const a = s * Math.min(l, 1 - l);
    for (let i = 0; i < 3; i++) {
      const k = ((i === 0 ? 0 : i === 1 ? 8 : 4) + h / 30) % 12;
      lut[v * 3 + i] = Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    }
  }
  return lut;
}

async function boot(root) {
  const say = (msg, bad) => {
    const el = root.querySelector('#swarm-status');
    el.textContent = msg;
    el.classList.toggle('bad', !!bad);
  };
  const stat = (id, v) => { root.querySelector(id).textContent = v; };
  const no = refusal(navigator);
  if (no) { say(no, true); return; }
  try {
    say('fetching the kernel');
    const kern = await (await fetch('gpu.json')).json();
    say('booting one chip at the switches');
    await init();
    const asm = assemble(PAINTER);
    const chip = new Machine();
    chip.fillMemory(0);
    chip.load(asm.org, new Uint8Array(asm.bytes));
    chip.setResetVector(asm.org);
    chip.powerCycle();
    const m = JSON.parse(chip.exportMachine());
    const planes = {
      value: expandPlane(m.state.value, kern.nodes),
      pullup: expandPlane(m.state.pullup, kern.nodes),
      pulldown: expandPlane(m.state.pulldown, kern.nodes),
      trans_on: expandPlane(m.state.trans_on, kern.trans),
    };
    const base = baseImage(m.memory);

    const words = Math.max(1, Math.min(512, parseInt(new URLSearchParams(location.search).get('words') ?? '64', 10) || 64));
    say('asking the GPU');
    const host = await gpuHost(kern, planes, base, words);
    stat('#swarm-adapter', host.adapter);
    stat('#swarm-count', host.lanes.toLocaleString());

    // Every lane its own tap byte, before the first half-cycle runs.
    const seeds = new Uint8Array(host.lanes);
    for (let i = 0; i < host.lanes; i++) seeds[i] = (i * 151 + 43) & 0xff || 0xa5;
    host.poke(NO_WRITE, 0, SEED_ADDR, seeds);

    // The wall: one 16x16 cell per machine.
    const canvas = root.querySelector('#swarm-wall');
    const cell = 16, gap = 2, span = cell + gap;
    const cols = Math.min(Math.max(8, Math.floor((canvas.parentElement.clientWidth - 2) / span)), Math.ceil(Math.sqrt(host.lanes * 1.6)));
    const rows = Math.ceil(host.lanes / cols);
    canvas.width = cols * span + gap;
    canvas.height = rows * span + gap;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(canvas.width, canvas.height);
    img.data.fill(18); for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    const lut = palette();

    const zoom = root.querySelector('#swarm-zoom');
    const zctx = zoom.getContext('2d');
    let focused = 0;
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      host.poke(BRUSH_ADDR, Math.floor(((e.clientX - r.left) / r.width) * 255) & 0xff, NO_WRITE, null);
    });
    canvas.addEventListener('click', (e) => {
      const r = canvas.getBoundingClientRect();
      const cx = Math.floor(((e.clientX - r.left) / r.width) * canvas.width / span);
      const cy = Math.floor(((e.clientY - r.top) / r.height) * canvas.height / span);
      const lane = cy * cols + cx;
      if (lane < host.lanes) { focused = lane; stat('#swarm-focus', `machine ${lane}`); }
    });

    let paused = false;
    root.querySelector('#swarm-pause').addEventListener('click', (ev) => {
      paused = !paused;
      ev.target.textContent = paused ? 'run' : 'pause';
    });

    let batch = 8;
    let total = 0;
    const t0 = performance.now();
    let lastPaint = 0;
    say('');
    const loop = async () => {
      if (paused) { requestAnimationFrame(loop); return; }
      const ft = performance.now();
      const { screens, poolUsed, poolCap, spent } = await host.frame(batch, SCREEN_PAGE);
      total += batch;
      if (spent) {
        say(`the page pool is spent (${poolUsed} pages asked of ${poolCap}); writes were dropped, so the wall stops rather than showing memory that diverged`, true);
        return;
      }
      const dt = performance.now() - ft;
      batch = Math.max(1, Math.min(64, Math.round(batch * (dt > 0 ? 90 / dt : 2))));
      // paint
      for (let lane = 0; lane < host.lanes; lane++) {
        const ox = (lane % cols) * span + gap, oy = Math.floor(lane / cols) * span + gap;
        for (let p = 0; p < 256; p++) {
          const v = screens[lane * 256 + p];
          const x = ox + (p & 15), y = oy + (p >> 4);
          const at = (y * canvas.width + x) * 4;
          img.data[at] = lut[v * 3]; img.data[at + 1] = lut[v * 3 + 1]; img.data[at + 2] = lut[v * 3 + 2];
        }
      }
      ctx.putImageData(img, 0, 0);
      const now = performance.now();
      if (now - lastPaint > 500) {
        lastPaint = now;
        const secs = (now - t0) / 1000;
        stat('#swarm-sweeps', `${(total / secs).toFixed(0)} half-cycles/s each`);
        stat('#swarm-rate', `${((total / secs) * host.lanes / 1e6).toFixed(2)} M machine-half-cycles/s`);
        stat('#swarm-pool', `${poolUsed} of ${poolCap} pages`);
      }
      // the focused machine, 8x
      const z = screens.subarray(focused * 256, focused * 256 + 256);
      const zi = zctx.createImageData(128, 128);
      for (let p = 0; p < 256; p++) {
        const v = z[p];
        for (let dy = 0; dy < 8; dy++) for (let dx = 0; dx < 8; dx++) {
          const at = (((p >> 4) * 8 + dy) * 128 + (p & 15) * 8 + dx) * 4;
          zi.data[at] = lut[v * 3]; zi.data[at + 1] = lut[v * 3 + 1]; zi.data[at + 2] = lut[v * 3 + 2]; zi.data[at + 3] = 255;
        }
      }
      zctx.putImageData(zi, 0, 0);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  } catch (e) {
    say(e instanceof Error ? e.message : String(e), true);
  }
}

const src = document.getElementById('swarm-src');
if (src) src.textContent = PAINTER;
const root = document.getElementById('swarm');
if (root) boot(root);
