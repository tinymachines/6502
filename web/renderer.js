// WebGL2 renderer for the 6502 die.
//
// The whole design turns on one observation: the layout never changes. 83,227
// triangles go to the GPU once, at startup. What changes per frame is a
// 1725-byte array of node levels, uploaded as a small texture that the vertex
// shader samples by node ID. So a frame costs six draw calls and a 2 KB upload,
// regardless of zoom.
//
// Picking follows the same logic. The original rendered node numbers into a
// hidden canvas and read a pixel back; we do the same thing on the GPU, but the
// buffer only needs redrawing when the *camera* moves, since node IDs are fixed.

const LAYER = {
  METAL: 0,
  SWITCHED_DIFFUSION: 1,
  INPUT_DIODE: 2,
  GROUNDED_DIFFUSION: 3,
  POWERED_DIFFUSION: 4,
  POLYSILICON: 5,
};

export const LAYER_INFO = [
  { id: LAYER.METAL, name: 'Metal', color: [0.58, 0.62, 0.82], alpha: 0.34 },
  { id: LAYER.SWITCHED_DIFFUSION, name: 'Switched diffusion', color: [0.96, 0.78, 0.30], alpha: 1.0 },
  { id: LAYER.INPUT_DIODE, name: 'Input diode', color: [1.0, 0.37, 0.86], alpha: 1.0 },
  { id: LAYER.GROUNDED_DIFFUSION, name: 'Grounded diffusion', color: [0.29, 0.87, 0.50], alpha: 1.0 },
  { id: LAYER.POWERED_DIFFUSION, name: 'Powered diffusion', color: [0.97, 0.44, 0.44], alpha: 1.0 },
  { id: LAYER.POLYSILICON, name: 'Polysilicon', color: [0.66, 0.33, 0.97], alpha: 1.0 },
];

// Back to front. Metal is translucent and sits on top, as it does on the die.
const DRAW_ORDER = [
  LAYER.GROUNDED_DIFFUSION,
  LAYER.POWERED_DIFFUSION,
  LAYER.SWITCHED_DIFFUSION,
  LAYER.POLYSILICON,
  LAYER.INPUT_DIODE,
  LAYER.METAL,
];

// Node-state textures are laid out as STATE_W columns by however many rows the
// node count needs.
const STATE_W = 512;

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2  aPos;
layout(location=1) in uint  aNode;

uniform vec2      uCenter;    // camera centre, die coordinates
uniform vec2      uScale;     // die units -> clip space (y negative: flips the die)
uniform sampler2D uState;     // per-node logic level
uniform sampler2D uMark;      // per-node highlight

out float vState;
out float vMark;

void main() {
  int n = int(aNode);
  ivec2 texel = ivec2(n % ${STATE_W}, n / ${STATE_W});
  vState = texelFetch(uState, texel, 0).r;
  vMark  = texelFetch(uMark,  texel, 0).r;
  gl_Position = vec4((aPos - uCenter) * uScale, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in float vState;
in float vMark;

uniform vec3  uColor;
uniform float uAlpha;
uniform float uDim;       // brightness of an inactive node
uniform vec3  uHotTint;   // added to an active node before bloom
uniform vec3  uMarkColor;

out vec4 fragColor;

void main() {
  vec3 cold = uColor * uDim;
  vec3 hot  = uColor * 1.30 + uHotTint * 0.55;
  vec3 col  = mix(cold, hot, vState);
  col = mix(col, uMarkColor, vMark * 0.85);
  // An active or highlighted polygon also becomes more opaque, so live signals
  // read clearly through the translucent metal layer above them.
  float a = uAlpha * (1.0 + 0.55 * max(vState, vMark));
  fragColor = vec4(col, min(a, 1.0));
}`;

const PICK_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
layout(location=1) in uint aNode;
uniform vec2 uCenter;
uniform vec2 uScale;
flat out uint vNode;
void main() {
  vNode = aNode;
  gl_Position = vec4((aPos - uCenter) * uScale, 0.0, 1.0);
}`;

const PICK_FRAG = `#version 300 es
precision highp float;
flat in uint vNode;
uniform float uLayer;
out vec4 fragColor;
void main() {
  // Node number packed little-endian across R and G; layer in B. Alpha marks
  // "something was here", distinguishing node 0 from empty space.
  float lo = float(vNode & 255u) / 255.0;
  float hi = float((vNode >> 8) & 255u) / 255.0;
  fragColor = vec4(lo, hi, uLayer / 255.0, 1.0);
}`;

const QUAD_VERT = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  // Fullscreen triangle; no vertex buffer needed.
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const BRIGHT_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uThreshold;
out vec4 fragColor;
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  fragColor = vec4(c * max(lum - uThreshold, 0.0) / max(lum, 1e-4), 1.0);
}`;

const BLUR_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;         // texel-sized step, horizontal or vertical
out vec4 fragColor;
void main() {
  // Nine-tap gaussian, weights from a normalised binomial kernel.
  float w[5] = float[](0.2270270270, 0.1945945946, 0.1216216216, 0.0540540541, 0.0162162162);
  vec3 sum = texture(uTex, vUv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    sum += texture(uTex, vUv + uDir * float(i)).rgb * w[i];
    sum += texture(uTex, vUv - uDir * float(i)).rgb * w[i];
  }
  fragColor = vec4(sum, 1.0);
}`;

const COMPOSITE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomAmount;
out vec4 fragColor;
void main() {
  vec3 scene = texture(uScene, vUv).rgb;
  vec3 bloom = texture(uBloom, vUv).rgb;
  vec3 col = scene + bloom * uBloomAmount;
  // Gentle filmic shoulder so bloom saturates gracefully instead of clipping.
  col = col / (col + vec3(0.85)) * 1.85;
  // Vignette, to settle the die into the frame.
  vec2 d = vUv - 0.5;
  col *= 1.0 - 0.55 * dot(d, d);
  fragColor = vec4(col, 1.0);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(sh) + '\n' + src);
  }
  return sh;
}

function program(gl, vsSrc, fsSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('link: ' + gl.getProgramInfoLog(p));
  }
  // Cache uniform locations; looking them up per frame shows up in profiles.
  p.u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
    p.u[name] = gl.getUniformLocation(p, name);
  }
  return p;
}

/** Parse the layout blob produced by `cargo run -p v6502-netlist --bin export-layout`. */
export function parseLayout(buffer) {
  const dv = new DataView(buffer);
  const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 8));
  if (magic !== 'V6502LAY') throw new Error(`layout.bin: bad magic ${JSON.stringify(magic)}`);
  const version = dv.getUint32(8, true);
  if (version !== 1) throw new Error(`layout.bin: unsupported version ${version}`);

  const vertexCount = dv.getUint32(12, true);
  const layerCount = dv.getUint32(16, true);
  const transistorCount = dv.getUint32(20, true);
  const bounds = {
    xmin: dv.getUint16(24, true),
    ymin: dv.getUint16(26, true),
    xmax: dv.getUint16(28, true),
    ymax: dv.getUint16(30, true),
  };
  const vertexOffset = dv.getUint32(32, true);
  const transistorOffset = dv.getUint32(36, true);

  const ranges = [];
  for (let i = 0; i < layerCount; i++) {
    ranges.push({
      start: dv.getUint32(40 + i * 8, true),
      count: dv.getUint32(44 + i * 8, true),
    });
  }

  return {
    vertexCount,
    bounds,
    ranges,
    // Interleaved x, y, node -- three uint16 per vertex.
    vertices: new Uint16Array(buffer, vertexOffset, vertexCount * 3),
    transistorBoxes: new Uint16Array(buffer, transistorOffset, transistorCount * 4),
  };
}

export class DieRenderer {
  constructor(canvas, layout, nodeCount) {
    const gl = canvas.getContext('webgl2', {
      antialias: false, // we resolve our own MSAA into the scene FBO
      alpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 is required and unavailable in this browser.');

    this.gl = gl;
    this.canvas = canvas;
    this.layout = layout;
    this.nodeCount = nodeCount;
    this.stateH = Math.ceil(nodeCount / STATE_W);

    this.dim = 0.5;
    this.hotTint = [1.0, 0.78, 0.42];
    this.markColor = [1.0, 1.0, 1.0];
    this.bloomAmount = 1.15;
    this.bloomThreshold = 0.55;
    this.layerVisible = LAYER_INFO.map(() => true);

    this.railNodes = [];
    this.camera = { cx: 0, cy: 0, scale: 1 };
    this.pickDirty = true;
    // Until the user pans or zooms, keep the die framed across layout changes.
    // The canvas is created inside a hidden panel, so its first measured size is
    // meaningless; this makes that self-correcting rather than a boot-order bug.
    this.userFramed = false;

    this.progScene = program(gl, VERT, FRAG);
    this.progPick = program(gl, PICK_VERT, PICK_FRAG);
    this.progBright = program(gl, QUAD_VERT, BRIGHT_FRAG);
    this.progBlur = program(gl, QUAD_VERT, BLUR_FRAG);
    this.progComposite = program(gl, QUAD_VERT, COMPOSITE_FRAG);

    this._initGeometry();
    this._initStateTextures();
    this._computeNodeBounds();
    this.emptyVao = gl.createVertexArray();

    this.fb = {};
    this.resize();
    this.fitToDie();
  }

  _initGeometry() {
    const gl = this.gl;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.layout.vertices, gl.STATIC_DRAW);
    const stride = 6; // 3 * uint16
    // Position stays integral in die space; the shader works in floats from here.
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.UNSIGNED_SHORT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_SHORT, stride, 4);
    gl.bindVertexArray(null);
  }

  /**
   * Die-space bounding box per node, from one pass over the vertex array.
   * Lets "find sync" frame the signal instead of just colouring it.
   */
  _computeNodeBounds() {
    const v = this.layout.vertices;
    const n = this.nodeCount;
    const b = new Int32Array(n * 4);
    for (let i = 0; i < n; i++) {
      b[i * 4] = 0x7fffffff;
      b[i * 4 + 1] = 0x7fffffff;
      b[i * 4 + 2] = -1;
      b[i * 4 + 3] = -1;
    }
    for (let i = 0; i < v.length; i += 3) {
      const node = v[i + 2];
      if (node >= n) continue;
      const o = node * 4;
      const x = v[i];
      const y = v[i + 1];
      if (x < b[o]) b[o] = x;
      if (y < b[o + 1]) b[o + 1] = y;
      if (x > b[o + 2]) b[o + 2] = x;
      if (y > b[o + 3]) b[o + 3] = y;
    }
    this.nodeBounds = b;
  }

  /** Bounding box of a node, or null if it has no geometry. */
  nodeBox(node) {
    const b = this.nodeBounds;
    const o = node * 4;
    if (o + 3 >= b.length || b[o + 2] < 0) return null;
    return { xmin: b[o], ymin: b[o + 1], xmax: b[o + 2], ymax: b[o + 3] };
  }

  /** Frame a set of nodes. */
  zoomToNodes(nodes) {
    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    for (const n of nodes) {
      const box = this.nodeBox(n);
      if (!box) continue;
      xmin = Math.min(xmin, box.xmin);
      ymin = Math.min(ymin, box.ymin);
      xmax = Math.max(xmax, box.xmax);
      ymax = Math.max(ymax, box.ymax);
    }
    if (!Number.isFinite(xmin)) return false;
    this.zoomToBox(xmin, ymin, xmax, ymax);
    return true;
  }

  _initStateTextures() {
    const gl = this.gl;
    const make = () => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, STATE_W, this.stateH);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.stateTex = make();
    this.markTex = make();
    this.stateBuf = new Uint8Array(STATE_W * this.stateH);
    this.markBuf = new Uint8Array(STATE_W * this.stateH);
  }

  /**
   * Nodes to draw as inert background regardless of their logic level.
   *
   * This is for vss and vcc. They are legitimately "always low" and "always
   * high", but their polygons blanket the die, so colouring them by state
   * floods the image and highlighting one makes the whole chip light up. The
   * original sidestepped this by never storing geometry for the rails at all;
   * we keep the geometry (it is most of the visible structure) and mute it
   * here instead.
   */
  setRailNodes(ids) {
    this.railNodes = ids.filter((n) => n >= 0);
  }

  /** Upload per-node logic levels (one byte per node, 0 or 1). */
  setNodeLevels(levels) {
    const gl = this.gl;
    this.stateBuf.set(levels.subarray(0, Math.min(levels.length, this.stateBuf.length)));
    for (const n of this.railNodes) this.stateBuf[n] = 0;
    gl.bindTexture(gl.TEXTURE_2D, this.stateTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, STATE_W, this.stateH, gl.RED, gl.UNSIGNED_BYTE, this.stateBuf);
  }

  /** Highlight a set of node IDs (pass an empty array to clear). */
  setHighlight(nodes) {
    const gl = this.gl;
    this.markBuf.fill(0);
    for (const n of nodes) {
      if (n >= 0 && n < this.markBuf.length && !this.railNodes.includes(n)) this.markBuf[n] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.markTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, STATE_W, this.stateH, gl.RED, gl.UNSIGNED_BYTE, this.markBuf);
  }

  setLayerVisible(layerId, visible) {
    this.layerVisible[layerId] = visible;
    this.pickDirty = true;
  }

  // -- framebuffers ---------------------------------------------------------

  _makeTarget(w, h, samples) {
    const gl = this.gl;
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    let tex = null;
    let rbo = null;
    if (samples > 1) {
      rbo = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rbo);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rbo);
    } else {
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex, rbo, w, h };
  }

  _dispose(t) {
    if (!t) return;
    const gl = this.gl;
    gl.deleteFramebuffer(t.fbo);
    if (t.tex) gl.deleteTexture(t.tex);
    if (t.rbo) gl.deleteRenderbuffer(t.rbo);
  }

  resize() {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width === w && this.canvas.height === h && this.fb.scene) return;
    this.canvas.width = w;
    this.canvas.height = h;

    for (const k of ['msaa', 'scene', 'bloomA', 'bloomB', 'pick']) this._dispose(this.fb[k]);

    // 4x MSAA matters here: the die is full of one-pixel-wide traces that alias
    // badly when zoomed out.
    const maxSamples = gl.getParameter(gl.MAX_SAMPLES);
    this.fb.msaa = this._makeTarget(w, h, Math.min(4, maxSamples));
    this.fb.scene = this._makeTarget(w, h, 1);
    const bw = Math.max(1, w >> 1);
    const bh = Math.max(1, h >> 1);
    this.fb.bloomA = this._makeTarget(bw, bh, 1);
    this.fb.bloomB = this._makeTarget(bw, bh, 1);
    this.fb.pick = this._makeTarget(w, h, 1);
    this.pickDirty = true;
    if (!this.userFramed) this.fitToDie();
  }

  // -- camera ---------------------------------------------------------------

  fitToDie() {
    const b = this.layout.bounds;
    const w = b.xmax - b.xmin;
    const h = b.ymax - b.ymin;
    this.camera.cx = (b.xmin + b.xmax) / 2;
    this.camera.cy = (b.ymin + b.ymax) / 2;
    const fit = 0.94;
    this.camera.scale = Math.min(this.canvas.width / w, this.canvas.height / h) * fit;
    this.minScale = this.camera.scale * 0.6;
    this.maxScale = this.camera.scale * 220;
    this.pickDirty = true;
  }

  /** Canvas-relative CSS pixels -> die coordinates. */
  screenToDie(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / r.width;
    const px = (clientX - r.left) * dpr;
    const py = (clientY - r.top) * dpr;
    return {
      x: this.camera.cx + (px - this.canvas.width / 2) / this.camera.scale,
      // Screen y grows downward, die y grows upward.
      y: this.camera.cy - (py - this.canvas.height / 2) / this.camera.scale,
      px,
      py,
    };
  }

  panByPixels(dx, dy) {
    const dpr = this.canvas.width / this.canvas.getBoundingClientRect().width;
    this.camera.cx -= (dx * dpr) / this.camera.scale;
    this.camera.cy += (dy * dpr) / this.camera.scale;
    this.pickDirty = true;
    this.userFramed = true;
  }

  /** Zoom about a screen point, so the die feature under the cursor stays put. */
  zoomAt(clientX, clientY, factor) {
    const before = this.screenToDie(clientX, clientY);
    this.camera.scale = Math.min(this.maxScale, Math.max(this.minScale, this.camera.scale * factor));
    const after = this.screenToDie(clientX, clientY);
    this.camera.cx += before.x - after.x;
    this.camera.cy += before.y - after.y;
    this.pickDirty = true;
    this.userFramed = true;
  }

  /** Frame a die-space bounding box. */
  zoomToBox(xmin, ymin, xmax, ymax) {
    const w = Math.max(xmax - xmin, 24);
    const h = Math.max(ymax - ymin, 24);
    this.camera.cx = (xmin + xmax) / 2;
    this.camera.cy = (ymin + ymax) / 2;
    this.camera.scale = Math.min(
      this.maxScale,
      Math.max(this.minScale, Math.min(this.canvas.width / w, this.canvas.height / h) * 0.6)
    );
    this.pickDirty = true;
    this.userFramed = true;
  }

  _setCamera(prog) {
    const gl = this.gl;
    gl.uniform2f(prog.u.uCenter, this.camera.cx, this.camera.cy);
    gl.uniform2f(
      prog.u.uScale,
      (2 * this.camera.scale) / this.canvas.width,
      // Negative: die Y is up, clip Y is up but screen Y is down; this single
      // sign is the flip the original baked into every drawSeg call.
      (-2 * this.camera.scale) / this.canvas.height
    );
  }

  // -- drawing --------------------------------------------------------------

  _drawLayers(prog, isPick) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    for (const layerId of DRAW_ORDER) {
      if (!this.layerVisible[layerId]) continue;
      const r = this.layout.ranges[layerId];
      if (!r || r.count === 0) continue;
      const info = LAYER_INFO[layerId];
      if (isPick) {
        gl.uniform1f(prog.u.uLayer, layerId);
      } else {
        gl.uniform3fv(prog.u.uColor, info.color);
        gl.uniform1f(prog.u.uAlpha, info.alpha);
      }
      gl.drawArrays(gl.TRIANGLES, r.start, r.count);
    }
    gl.bindVertexArray(null);
  }

  render() {
    const gl = this.gl;
    this.resize();

    // --- scene into the multisampled target ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb.msaa.fbo);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.026, 0.028, 0.039, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.progScene);
    this._setCamera(this.progScene);
    gl.uniform1f(this.progScene.u.uDim, this.dim);
    gl.uniform3fv(this.progScene.u.uHotTint, this.hotTint);
    gl.uniform3fv(this.progScene.u.uMarkColor, this.markColor);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.stateTex);
    gl.uniform1i(this.progScene.u.uState, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.markTex);
    gl.uniform1i(this.progScene.u.uMark, 1);
    this._drawLayers(this.progScene, false);

    // Resolve MSAA into a sampleable texture.
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fb.msaa.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fb.scene.fbo);
    gl.blitFramebuffer(
      0, 0, this.canvas.width, this.canvas.height,
      0, 0, this.canvas.width, this.canvas.height,
      gl.COLOR_BUFFER_BIT, gl.NEAREST
    );

    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.emptyVao);

    // --- bloom: bright pass at half resolution, then separable blur ---
    const bw = this.fb.bloomA.w;
    const bh = this.fb.bloomA.h;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb.bloomA.fbo);
    gl.viewport(0, 0, bw, bh);
    gl.useProgram(this.progBright);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fb.scene.tex);
    gl.uniform1i(this.progBright.u.uTex, 0);
    gl.uniform1f(this.progBright.u.uThreshold, this.bloomThreshold);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.useProgram(this.progBlur);
    gl.uniform1i(this.progBlur.u.uTex, 0);
    for (const [src, dst, dir] of [
      [this.fb.bloomA, this.fb.bloomB, [1 / bw, 0]],
      [this.fb.bloomB, this.fb.bloomA, [0, 1 / bh]],
    ]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform2f(this.progBlur.u.uDir, dir[0], dir[1]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // --- composite to the screen ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.progComposite);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fb.scene.tex);
    gl.uniform1i(this.progComposite.u.uScene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.fb.bloomA.tex);
    gl.uniform1i(this.progComposite.u.uBloom, 1);
    gl.uniform1f(this.progComposite.u.uBloomAmount, this.bloomAmount);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  _renderPickBuffer() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb.pick.fbo);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0); // alpha 0 == nothing here
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);
    gl.useProgram(this.progPick);
    this._setCamera(this.progPick);
    this._drawLayers(this.progPick, true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.pickDirty = false;
  }

  /**
   * Node under a screen point, or null.
   *
   * Only re-renders the ID buffer when the camera has moved -- node IDs are a
   * property of the geometry, not of the simulation, so a running chip does not
   * invalidate it.
   */
  pick(clientX, clientY) {
    const gl = this.gl;
    if (this.pickDirty) this._renderPickBuffer();
    const { px, py } = this.screenToDie(clientX, clientY);
    const x = Math.floor(px);
    const y = Math.floor(this.canvas.height - py); // GL reads bottom-up
    if (x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) return null;

    const px4 = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb.pick.fbo);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (px4[3] === 0) return null;
    return { node: px4[0] | (px4[1] << 8), layer: px4[2] };
  }

  /** Die-space bounding box of a transistor, for zoom-to-fit. */
  transistorBox(index) {
    const b = this.layout.transistorBoxes;
    const o = index * 4;
    if (o + 3 >= b.length) return null;
    // Stored as [xmin, xmax, ymin, ymax] -- note the ordering.
    return { xmin: b[o], xmax: b[o + 1], ymin: b[o + 2], ymax: b[o + 3] };
  }
}
