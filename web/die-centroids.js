// Where each node is on the die, read out of the geometry rather than decided.
//
// Extracted from diegraph.js when the tracer wanted the same positions. Two
// pages computing a centroid from two copies would eventually put a node in
// two places, and a reader comparing them would have no way to tell which was
// lying. A leaf: it imports nothing.

/**
 * Node centroids, straight out of `layout.bin`, the same file the explorer
 * fetches, so this asks the polygons where each node is rather than inventing
 * a position for it. A node's centroid is the mean of its own vertices: crude
 * for an L-shaped wire that wanders across the die, exactly right for the
 * great majority that do not.
 *
 * Returns `{ pos, bounds }`: `pos` maps node -> {x, y} in die coordinates with
 * Y flipped for display (the same single sign the die view's projection
 * carries; without it the chip is drawn upside down against every other
 * picture on the site), and `bounds` is the die's extent as the file states it.
 */
export function centroids(buffer) {
  const dv = new DataView(buffer);
  const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 8));
  if (magic !== 'V6502LAY') throw new Error(`layout.bin: bad magic ${JSON.stringify(magic)}`);
  const vertexCount = dv.getUint32(12, true);
  const bounds = {
    xmin: dv.getUint16(24, true), ymin: dv.getUint16(26, true),
    xmax: dv.getUint16(28, true), ymax: dv.getUint16(30, true),
  };
  const vertexOffset = dv.getUint32(32, true);
  const sx = new Float64Array(2048);
  const sy = new Float64Array(2048);
  const n = new Uint32Array(2048);
  for (let i = 0; i < vertexCount; i++) {
    const o = vertexOffset + i * 6;
    const node = dv.getUint16(o + 4, true);
    sx[node] += dv.getUint16(o, true);
    sy[node] += dv.getUint16(o + 2, true);
    n[node] += 1;
  }
  const pos = new Map();
  for (let node = 0; node < 2048; node++) {
    if (!n[node]) continue;
    pos.set(node, { x: sx[node] / n[node], y: bounds.ymax - (sy[node] / n[node]) + bounds.ymin });
  }
  return { pos, bounds };
}
