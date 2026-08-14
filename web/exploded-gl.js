// WebGL2 renderer for the exploded die.
//
// Same geometry as the flat die view -- the identical `layout.bin`, the same
// 83,227 triangles -- moved rather than redrawn. Two independent explosions:
//
//   Z: the three physical layers lift apart. Diffusion is the doped silicon,
//      polysilicon is the gate layer above it, metal is the wiring on top.
//      A transistor is nothing more than a place where poly crosses diffusion,
//      so pulling those apart in Z makes all 3510 of them visible as the
//      stalks joining the two layers.
//
//   XY: the functional blocks slide apart, each in the direction it already
//      lies from the centre of the die. Which node belongs to which block is
//      derived in `crates/v6502-netlist/src/blocks.rs`.
//
// Both are one uniform each, applied in the vertex shader. Nothing is
// duplicated per explode state, and at 0/0 the result is the die exactly as it
// sits on the wafer.

const STATE_W = 512;

// The die has three physical layers, not six. `segdefs` distinguishes switched,
// grounded and powered diffusion, but those are one layer coloured by what it
// is tied to -- so all three share a height, which is the point.
export const LAYER_HEIGHT = [2, 0, 0, 0, 0, 1]; // metal, sw-diff, diode, gnd-diff, pwr-diff, poly
export const HEIGHT_NAMES = ['Diffusion', 'Polysilicon', 'Metal'];

// Kept slightly apart even when the layer slider is at zero, so coplanar
// polygons have a defined depth order. Without it the layers z-fight and the
// die crawls with speckle at rest, which reads as a corrupted upload.
const Z_BASELINE = 1.0;
// In die units, against a die about 9000 across. The first value tried was
// 2600, which is geometrically honest about nothing -- the real oxide is submicron
// -- and turned 3510 filaments into an opaque wall two-thirds the width of the
// chip. The gap is a legibility choice, so it is set to the smallest value at
// which the three layers read as separate.
const Z_GAP = 850.0;

// Maximum blocks the shader's uniform arrays hold. `blocks.rs` emits 13
// including the unclassified one; the ceiling is here so a mismatch fails loudly
// at load rather than silently indexing past the end.
const MAX_BLOCKS = 16;

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
layout(location=1) in uint aNode;

uniform mat4      uVP;
uniform sampler2D uState;      // per-node logic level
uniform sampler2D uBlock;      // per-node block id, high bit = "the die named it"
uniform vec2      uOffset[${MAX_BLOCKS}];
uniform float     uRadial[${MAX_BLOCKS}];
uniform float     uExplodeXY;
uniform float     uExplodeZ;
uniform float     uHeight;     // 0, 1 or 2 for this draw call
uniform vec2      uCentre;     // die centre, for the radial blocks
uniform float     uRadialAmount;

out float vState;
out float vNamed;
flat out int vBlock;

void main() {
  int n = int(aNode);
  ivec2 texel = ivec2(n % ${STATE_W}, n / ${STATE_W});
  vState = texelFetch(uState, texel, 0).r;

  float packed = floor(texelFetch(uBlock, texel, 0).r * 255.0 + 0.5);
  vNamed = packed >= 128.0 ? 1.0 : 0.0;
  int b = int(packed - vNamed * 128.0);
  vBlock = b;

  // The pads are a ring, not a blob: their centroid is the middle of the die,
  // so translating them by it would move them nowhere. They expand outward
  // from the centre instead, which is the motion the structure actually has.
  vec2 off = uOffset[b];
  if (uRadial[b] > 0.5) {
    vec2 d = aPos - uCentre;
    off = normalize(d + vec2(1e-4)) * uRadialAmount;
  }
  vec2 p = aPos + off * uExplodeXY;
  float z = uHeight * (Z_BASELINE_ + Z_GAP_ * uExplodeZ);

  // Die Y runs the opposite way to screen Y, and the flip lives here -- one
  // sign, in the projection, exactly as it does in the flat renderer.
  gl_Position = uVP * vec4(p.x, -p.y, z, 1.0);
}`
  .replace('Z_BASELINE_', Z_BASELINE.toFixed(1))
  .replace('Z_GAP_', Z_GAP.toFixed(1));

const FRAG = `#version 300 es
precision highp float;
in float vState;
in float vNamed;
flat in int vBlock;

uniform vec3  uColor;
uniform float uAlpha;
uniform float uDim;
uniform vec3  uHot;
uniform int   uFocus;        // -1 = none, else the only block drawn bright
uniform float uGhost;        // how far the unclassified block has faded out
uniform vec3  uBlockColor[${MAX_BLOCKS}];
uniform float uTint;         // how far to recolour by block rather than by layer

out vec4 fragColor;

void main() {
  vec3 cold = uColor * uDim;
  vec3 hot  = uColor * 1.30 + uHot * 0.55;
  vec3 col  = mix(cold, hot, vState);
  float a   = uAlpha * (1.0 + 0.55 * vState);

  // Separated blocks are recoloured by which block they are. Without this the
  // pieces fly apart still wearing their layer colours and become impossible to
  // tell from one another, which is the one thing the block axis exists to do.
  // Luminance is carried across from the layer colour, so the material still
  // reads through the block hue instead of being flattened by it.
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  vec3 tinted = uBlockColor[vBlock] * (0.35 + 1.5 * lum);
  col = mix(col, tinted, uTint);

  // A node the die did not name got here by inference from its neighbours.
  // Drawing it slightly duller is the honest rendering of a weaker claim.
  col *= mix(0.72, 1.0, vNamed);

  // Block 0 is everything no rule reached. It stays where it is while the rest
  // pulls away, and fades -- so what is left in the middle at full explode is
  // exactly the part of the chip this page cannot account for.
  if (vBlock == 0) { a *= uGhost; col *= 0.8; }

  if (uFocus >= 0 && vBlock != uFocus) { a *= 0.14; col *= 0.5; }

  fragColor = vec4(col, min(a, 1.0));
}`;

// One filament per transistor, joining the diffusion it switches to the poly
// that gates it. This is the only geometry on the page that is not in
// `layout.bin`, and it is built from the transistor bounding boxes that are.
const STALK_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2  aPos;
layout(location=1) in float aHeight;   // 0 at the diffusion end, 1 at the poly
layout(location=2) in uint  aBlock;
layout(location=3) in uint  aGate;

uniform mat4      uVP;
uniform sampler2D uState;
uniform vec2      uOffset[${MAX_BLOCKS}];
uniform float     uRadial[${MAX_BLOCKS}];
uniform float     uExplodeXY;
uniform float     uExplodeZ;
uniform vec2      uCentre;
uniform float     uRadialAmount;

out float vOn;
out float vT;
flat out int vBlock;

void main() {
  int g = int(aGate);
  vOn = texelFetch(uState, ivec2(g % ${STATE_W}, g / ${STATE_W}), 0).r;
  vT = aHeight;
  int b = int(aBlock);
  vBlock = b;

  vec2 off = uOffset[b];
  if (uRadial[b] > 0.5) off = normalize(aPos - uCentre + vec2(1e-4)) * uRadialAmount;
  vec2 p = aPos + off * uExplodeXY;
  float z = aHeight * (Z_BASELINE_ + Z_GAP_ * uExplodeZ);
  gl_Position = uVP * vec4(p.x, -p.y, z, 1.0);
}`
  .replace('Z_BASELINE_', Z_BASELINE.toFixed(1))
  .replace('Z_GAP_', Z_GAP.toFixed(1));

const STALK_FRAG = `#version 300 es
precision highp float;
in float vOn;
in float vT;
flat in int vBlock;
uniform float uAmount;
uniform int   uFocus;
out vec4 fragColor;
void main() {
  // Amber at the diffusion end, purple at the poly end: the filament reads as
  // the junction between the two layers it joins.
  vec3 lo = vec3(0.96, 0.78, 0.30);
  vec3 hi = vec3(0.66, 0.33, 0.97);
  vec3 col = mix(lo, hi, vT);
  // A conducting transistor is one whose gate is high.
  col = mix(col * 0.55, col * 1.6 + vec3(0.25), vOn);
  // There are 3510 of these and they overlap heavily from most angles, so an
  // alpha that looks reasonable for one filament stacks into an opaque wall.
  // Idle ones stay very faint; the ones that are conducting are what to see.
  float a = uAmount * mix(0.09, 0.55, vOn);
  if (uFocus >= 0 && vBlock != uFocus) a *= 0.1;
  fragColor = vec4(col, a);
}`;

// ---------------------------------------------------------------------------
// Small matrix helpers. Only the two we need.
// ---------------------------------------------------------------------------

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function lookAt(eye, target, up) {
  const z = norm(sub(eye, target));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('link: ' + gl.getProgramInfoLog(p));
  }
  p.u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
    p.u[name] = gl.getUniformLocation(p, name);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Block placement
// ---------------------------------------------------------------------------

/**
 * Where each block travels to when the XY slider is pushed.
 *
 * Blocks keep the arrangement they have on the die -- scaled outward from the
 * centre, so what is above stays above -- and are then nudged apart until their
 * boxes stop overlapping. Preserving the arrangement matters more than packing
 * tightly: the point is to recognise the chip, not to tile a poster.
 */
export function computeOffsets(blocks, bounds, opts = {}) {
  const spread = opts.spread ?? 1.85;
  const rounds = opts.rounds ?? 60;
  const pad = opts.pad ?? 260;
  const cx = (bounds.xmin + bounds.xmax) / 2;
  const cy = (bounds.ymin + bounds.ymax) / 2;

  const items = blocks.map((b) => {
    const [x0, x1, y0, y1] = b.bounds;
    const w = Math.max(x1 - x0, 1);
    const h = Math.max(y1 - y0, 1);
    // Block 0 (unclassified) and the pad ring do not translate.
    const fixed = b.id === 0 || b.half === 'io';
    return {
      id: b.id,
      fixed,
      w,
      h,
      home: [b.die[0], b.die[1]],
      pos: fixed
        ? [b.die[0], b.die[1]]
        : [cx + (b.die[0] - cx) * spread, cy + (b.die[1] - cy) * spread],
    };
  });

  const movable = items.filter((i) => !i.fixed);
  for (let r = 0; r < rounds; r++) {
    let moved = false;
    for (let i = 0; i < movable.length; i++) {
      for (let j = i + 1; j < movable.length; j++) {
        const a = movable[i];
        const b = movable[j];
        const dx = b.pos[0] - a.pos[0];
        const dy = b.pos[1] - a.pos[1];
        const needX = (a.w + b.w) / 2 + pad;
        const needY = (a.h + b.h) / 2 + pad;
        const overX = needX - Math.abs(dx);
        const overY = needY - Math.abs(dy);
        if (overX <= 0 || overY <= 0) continue;
        // Separate along whichever axis needs the least movement.
        moved = true;
        if (overX < overY) {
          const s = (dx >= 0 ? 1 : -1) * overX * 0.5;
          a.pos[0] -= s;
          b.pos[0] += s;
        } else {
          const s = (dy >= 0 ? 1 : -1) * overY * 0.5;
          a.pos[1] -= s;
          b.pos[1] += s;
        }
      }
    }
    if (!moved) break;
  }

  const offset = new Float32Array(MAX_BLOCKS * 2);
  const radial = new Float32Array(MAX_BLOCKS);
  for (const it of items) {
    if (it.id >= MAX_BLOCKS) continue;
    offset[it.id * 2] = it.pos[0] - it.home[0];
    offset[it.id * 2 + 1] = it.pos[1] - it.home[1];
    radial[it.id] = it.fixed && it.id !== 0 ? 1 : 0;
  }
  return { offset, radial };
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export class ExplodedRenderer {
  constructor(canvas, layout, blocks, nodeCount) {
    if (blocks.blocks.length > MAX_BLOCKS) {
      throw new Error(`blocks.json has ${blocks.blocks.length} blocks, shader holds ${MAX_BLOCKS}`);
    }
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL2 is unavailable');
    this.gl = gl;
    this.canvas = canvas;
    this.layout = layout;
    this.blocks = blocks;
    this.nodeCount = nodeCount;

    this.explodeXY = 0;
    this.explodeZ = 0;
    this.stalkAmount = 1;
    this.focus = -1;
    this.yaw = -0.42;
    this.pitch = 0.62;
    this.zoom = 1;
    this.layerVisible = LAYER_HEIGHT.map(() => true);

    const b = layout.bounds;
    this.centre = [(b.xmin + b.xmax) / 2, (b.ymin + b.ymax) / 2];
    this.dieSize = Math.max(b.xmax - b.xmin, b.ymax - b.ymin);

    const placed = computeOffsets(blocks.blocks, b);
    this.offset = placed.offset;
    this.radial = placed.radial;
    this.radialAmount = this.dieSize * 0.42;

    this.blockColor = new Float32Array(MAX_BLOCKS * 3);
    for (let i = 0; i < MAX_BLOCKS; i++) {
      const c = BLOCK_COLOR[i] || [0.5, 0.5, 0.5];
      this.blockColor.set(c, i * 3);
    }

    this.prog = program(gl, VERT, FRAG);
    this.stalkProg = program(gl, STALK_VERT, STALK_FRAG);

    // --- polygon geometry, uploaded once -----------------------------------
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, layout.vertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.UNSIGNED_SHORT, false, 6, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_SHORT, 6, 4);

    // --- stalks -------------------------------------------------------------
    this.buildStalks();

    // --- textures -----------------------------------------------------------
    this.stateH = Math.ceil(nodeCount / STATE_W);
    this.stateBuf = new Uint8Array(STATE_W * this.stateH);
    this.stateTex = this.makeTex(gl, this.stateBuf);

    const blockBuf = new Uint8Array(STATE_W * this.stateH);
    blockBuf.set(blocks.nodeBlock.subarray(0, Math.min(blocks.nodeBlock.length, blockBuf.length)));
    this.blockTex = this.makeTex(gl, blockBuf);

    this.railNodes = [];
    gl.bindVertexArray(null);
  }

  makeTex(gl, buf) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, STATE_W, this.stateH, 0, gl.RED, gl.UNSIGNED_BYTE, buf);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Two vertices per transistor: one on the diffusion, one on the poly. */
  buildStalks() {
    const gl = this.gl;
    const boxes = this.layout.transistorBoxes;
    const n = boxes.length / 4;
    const tb = this.blocks.transistorBlock;
    const gates = this.blocks.transistorGate;
    const pos = new Float32Array(n * 4);
    const height = new Float32Array(n * 2);
    const blk = new Uint16Array(n * 2);
    const gate = new Uint16Array(n * 2);
    for (let i = 0; i < n; i++) {
      // [xmin, xmax, ymin, ymax] -- the ordering the flat renderer flags too.
      const cx = (boxes[i * 4] + boxes[i * 4 + 1]) / 2;
      const cy = (boxes[i * 4 + 2] + boxes[i * 4 + 3]) / 2;
      pos[i * 4] = cx;
      pos[i * 4 + 1] = cy;
      pos[i * 4 + 2] = cx;
      pos[i * 4 + 3] = cy;
      height[i * 2] = 0;
      height[i * 2 + 1] = 1;
      const b = tb ? tb[i] : 0;
      blk[i * 2] = b;
      blk[i * 2 + 1] = b;
      const g = gates ? gates[i] : 0;
      gate[i * 2] = g;
      gate[i * 2 + 1] = g;
    }
    this.stalkCount = n * 2;
    this.stalkVao = gl.createVertexArray();
    gl.bindVertexArray(this.stalkVao);
    const bind = (loc, data, size, type, integer) => {
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      if (integer) gl.vertexAttribIPointer(loc, size, type, 0, 0);
      else gl.vertexAttribPointer(loc, size, type, false, 0, 0);
    };
    bind(0, pos, 2, gl.FLOAT, false);
    bind(1, height, 1, gl.FLOAT, false);
    bind(2, blk, 1, gl.UNSIGNED_SHORT, true);
    bind(3, gate, 1, gl.UNSIGNED_SHORT, true);
    gl.bindVertexArray(null);
  }

  setNodeLevels(levels) {
    const gl = this.gl;
    this.stateBuf.set(levels.subarray(0, Math.min(levels.length, this.stateBuf.length)));
    for (const n of this.railNodes) this.stateBuf[n] = 0;
    gl.bindTexture(gl.TEXTURE_2D, this.stateTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, STATE_W, this.stateH,
      gl.RED, gl.UNSIGNED_BYTE, this.stateBuf);
  }

  setRailNodes(nodes) {
    this.railNodes = nodes.slice();
  }

  resize() {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    // A canvas of 1px is an element that has not been laid out yet, not a
    // viewport. Same trap as the flat renderer's.
    if (w <= 1 || h <= 1) return false;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    return true;
  }

  viewProjection() {
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    // The explosion grows the scene, so the camera has to back off with it or
    // the blocks leave the frame. It must back off by *less* than the scene
    // grows, though: matching the growth exactly keeps the die the same size on
    // screen and makes the slider look like it is doing nothing, and overshooting
    // shrinks the chip as it comes apart.
    const reach = this.dieSize * (1 + 0.72 * this.explodeXY);
    const dist = (reach / this.zoom) * 1.5;
    const cp = Math.cos(this.pitch);
    const eye = [
      this.centre[0] + dist * cp * Math.sin(this.yaw),
      -this.centre[1] - dist * cp * Math.cos(this.yaw),
      dist * Math.sin(this.pitch) + Z_GAP * this.explodeZ,
    ];
    const target = [this.centre[0], -this.centre[1], Z_GAP * this.explodeZ * 1.0];
    const proj = perspective(0.72, aspect, dist * 0.02, dist * 6 + this.dieSize * 4);
    return mul(proj, lookAt(eye, target, [0, 0, 1]));
  }

  render() {
    const gl = this.gl;
    if (!this.resize()) return;
    gl.clearColor(0.043, 0.055, 0.09, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const vp = this.viewProjection();
    const ghost = 1 - 0.68 * Math.max(this.explodeXY, this.explodeZ);

    const p = this.prog;
    gl.useProgram(p);
    gl.bindVertexArray(this.vao);
    gl.uniformMatrix4fv(p.u.uVP, false, vp);
    gl.uniform2fv(p.u.uOffset, this.offset);
    gl.uniform1fv(p.u.uRadial, this.radial);
    gl.uniform1f(p.u.uExplodeXY, this.explodeXY);
    gl.uniform1f(p.u.uExplodeZ, this.explodeZ);
    gl.uniform2fv(p.u.uCentre, this.centre);
    gl.uniform1f(p.u.uRadialAmount, this.radialAmount);
    gl.uniform1i(p.u.uFocus, this.focus);
    gl.uniform1f(p.u.uGhost, ghost);
    gl.uniform3fv(p.u.uBlockColor, this.blockColor);
    // Recolouring is tied to the block slider, so the layer colours own the
    // picture until the moment the blocks start to separate and need naming.
    gl.uniform1f(p.u.uTint, Math.min(1, this.explodeXY * 1.6) * 0.8);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.stateTex);
    gl.uniform1i(p.u.uState, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.blockTex);
    gl.uniform1i(p.u.uBlock, 1);

    // Opaque layers first with depth writes, then metal on top with the depth
    // test still on but writes off: it is translucent, and the pitch is clamped
    // above the plane so it is always the near face.
    const order = [3, 4, 1, 5, 2, 0];
    for (const layer of order) {
      if (!this.layerVisible[layer]) continue;
      const range = this.layout.ranges[layer];
      if (!range || !range.count) continue;
      const info = LAYER_STYLE[layer];
      const isMetal = layer === 0;
      gl.depthMask(!isMetal);
      gl.uniform3fv(p.u.uColor, info.color);
      gl.uniform1f(p.u.uAlpha, info.alpha);
      gl.uniform1f(p.u.uDim, 0.55);
      gl.uniform3fv(p.u.uHot, [0.35, 0.85, 1.0]);
      gl.uniform1f(p.u.uHeight, LAYER_HEIGHT[layer]);
      gl.drawArrays(gl.TRIANGLES, range.start, range.count);
    }
    gl.depthMask(true);

    // Stalks last: they are thin, additive-looking filaments and should not
    // occlude the layers they join.
    if (this.stalkAmount > 0.01) {
      const s = this.stalkProg;
      gl.useProgram(s);
      gl.bindVertexArray(this.stalkVao);
      gl.depthMask(false);
      gl.uniformMatrix4fv(s.u.uVP, false, vp);
      gl.uniform2fv(s.u.uOffset, this.offset);
      gl.uniform1fv(s.u.uRadial, this.radial);
      gl.uniform1f(s.u.uExplodeXY, this.explodeXY);
      gl.uniform1f(s.u.uExplodeZ, this.explodeZ);
      gl.uniform2fv(s.u.uCentre, this.centre);
      gl.uniform1f(s.u.uRadialAmount, this.radialAmount);
      gl.uniform1f(s.u.uAmount, this.stalkAmount * Math.min(1, this.explodeZ * 2.2));
      gl.uniform1i(s.u.uFocus, this.focus);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.stateTex);
      gl.uniform1i(s.u.uState, 0);
      gl.drawArrays(gl.LINES, 0, this.stalkCount);
      gl.depthMask(true);
    }
    gl.bindVertexArray(null);
  }
}

/**
 * A hue per functional block, in `blocks.json` id order.
 *
 * Presentation, not derivation -- but the *order* is not arbitrary: control
 * blocks are warm, datapath blocks are cool, so the two halves of the chip stay
 * distinguishable at a glance even before the labels are read.
 */
export const BLOCK_COLOR = [
  [0.42, 0.45, 0.52], // 0  unclassified -- grey, and it stays grey
  [0.60, 0.70, 0.85], // 1  pads & I/O
  [1.00, 0.62, 0.25], // 2  instruction register
  [1.00, 0.36, 0.62], // 3  decode PLA
  [0.82, 0.42, 1.00], // 4  control pipeline
  [1.00, 0.85, 0.35], // 5  timing chain
  [1.00, 0.40, 0.35], // 6  interrupts & vectors
  [0.35, 0.95, 0.70], // 7  program counter
  [0.30, 0.85, 1.00], // 8  ALU
  [0.45, 0.70, 1.00], // 9  registers
  [0.75, 0.95, 0.45], // 10 status register
  [0.35, 0.62, 0.92], // 11 address latches
  [0.40, 0.92, 0.85], // 12 data bus
];

const LAYER_STYLE = [
  { color: [0.58, 0.62, 0.82], alpha: 0.30 },  // metal
  { color: [0.96, 0.78, 0.30], alpha: 1.0 },   // switched diffusion
  { color: [1.0, 0.37, 0.86], alpha: 1.0 },    // input diode
  { color: [0.29, 0.87, 0.50], alpha: 1.0 },   // grounded diffusion
  { color: [0.97, 0.44, 0.44], alpha: 1.0 },   // powered diffusion
  { color: [0.66, 0.33, 0.97], alpha: 1.0 },   // polysilicon
];
