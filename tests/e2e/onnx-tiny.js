// Tiny ONNX models made in the test, for the scanner's real ONNX Runtime check (scanner.test.js → the real
// runtime): written straight as ONNX protobuf (ModelProto, IR 7, opset 13), so the check needs no Python. Both
// read their input for real — every output is scaled by twice the input's mean (a scalar: ReduceMean,
// keepdims 0), so a mid-grey picture (128/255) gives the planted answer and a black one gives zeros:
//  - corners(spots): input [1,3,256,256] → heatmaps [1,4,128,128], one Gaussian spot per corner
//    (tests/scan/corners.test.mjs maps), as the corners models give them (src/scan/engine/models.ts detectRGBA);
//  - doctype(kind, turn): input [1,3,256,256] → "doctype" [1,6] and "turn" [1,4], as the document type model
//    gives them (src/scan/engine/readers.ts doctypeAnswer).
'use strict';

const varint = n => { const b = []; n = BigInt(n); do { let x = Number(n & 0x7fn); n >>= 7n; if (n) x |= 0x80; b.push(x); } while (n); return Buffer.from(b); };
const key = (f, wt) => varint((f << 3) | wt);
const bytes = (f, buf) => Buffer.concat([key(f, 2), varint(buf.length), buf]);
const str = (f, s) => bytes(f, Buffer.from(s, 'utf8'));
const int = (f, n) => Buffer.concat([key(f, 0), varint(n)]);
const cat = parts => Buffer.concat(parts);

const FLOAT = 1;
/** TensorProto: float, its dims, raw little-endian data. */
function tensor(name, dims, data) {
  const raw = Buffer.alloc(data.length * 4);
  data.forEach((v, i) => raw.writeFloatLE(v, i * 4));
  return cat([...dims.map(d => int(1, d)), int(2, FLOAT), str(8, name), bytes(9, raw)]);
}
/** ValueInfoProto of a float tensor of fixed dims. */
const valueInfo = (name, dims) => cat([str(1, name), bytes(2, bytes(1, cat([int(1, FLOAT), bytes(2, cat(dims.map(d => bytes(1, int(1, d)))))])))]);
/** NodeProto, with int attributes (AttributeProto: name, i, type INT). */
const node = (op, inputs, outputs, ints = {}) => cat([...inputs.map(i => str(1, i)), ...outputs.map(o => str(2, o)), str(4, op),
  ...Object.entries(ints).map(([n, v]) => bytes(5, cat([str(1, n), int(3, v), int(20, 2)])))]);

/** A model whose outputs are consts[k] × 2 × mean(input): {name, dims, data} per output. */
function scaledConsts(outputs) {
  const IN = [1, 3, 256, 256];
  const nodes = [node('ReduceMean', ['x'], ['m'], { keepdims: 0 }), node('Mul', ['m', 'two'], ['s'])];
  const inits = [tensor('two', [], [2])];
  for (const o of outputs) { inits.push(tensor(o.name + '_c', o.dims, o.data)); nodes.push(node('Mul', [o.name + '_c', 's'], [o.name])); }
  const graph = cat([...nodes.map(n => bytes(1, n)), str(2, 'tiny'), ...inits.map(t => bytes(5, t)), bytes(11, valueInfo('x', IN)), ...outputs.map(o => bytes(12, valueInfo(o.name, o.dims)))]);
  return cat([int(1, 7), str(2, 'scanner.test.js'), bytes(7, graph), bytes(8, cat([str(1, ''), int(2, 13)]))]);
}

const H = 128, SIGMA = 2.4;
/** Heatmaps with one spot [x, y, height] per corner (shares of the picture). */
function corners(spots) {
  const hm = new Float32Array(4 * H * H);
  spots.forEach(([x, y, a], k) => {
    for (let j = 0; j < H; j++) for (let i = 0; i < H; i++) hm[k * H * H + j * H + i] = a * Math.exp(-((i - (x * H - 0.5)) ** 2 + (j - (y * H - 0.5)) ** 2) / (2 * SIGMA ** 2));
  });
  return scaledConsts([{ name: 'heatmaps', dims: [1, 4, H, H], data: Array.from(hm) }]);
}
/** The document type model's answer: kind k of 6 at p, turn t of 4 at q. */
function doctype(k, p, t, q) {
  const kinds = Array.from({ length: 6 }, (_, i) => i === k ? p : (1 - p) / 5), turns = Array.from({ length: 4 }, (_, i) => i === t ? q : (1 - q) / 3);
  return scaledConsts([{ name: 'doctype', dims: [1, 6], data: kinds }, { name: 'turn', dims: [1, 4], data: turns }]);
}

module.exports = { corners, doctype };
