// The weak-phone simulator's device stand-in (docs/tests.md → The weak-phone simulator): what the browser says of the
// device and what its WebGPU does, the same in the page (an init script) and in the scanner's background threads
// (mirror.mjs puts it in front of the worker's bundle, as an init script does not reach a worker). The profile
// replaces /*PROFILE*/; memory or cores null: the browser has no such figure (undefined, as Safari and Firefox give).
//   gpu: 'real' the browser's own; 'none' no navigator.gpu; 'no-adapter' requestAdapter answers null; 'adapter-hang' it
//   never answers; 'session-fail' the adapter works, the device is refused; 'session-hang' the device never comes;
//   'run-hang' everything starts, then the read of a result never comes back after hangAfter reads.
(function (p) {
  var proto = Object.getPrototypeOf(navigator);
  var fix = function (name, v) { Object.defineProperty(proto, name, { configurable: true, get: function () { return v; } }); };
  if ('memory' in p) fix('deviceMemory', p.memory === null ? undefined : p.memory);
  if ('cores' in p) fix('hardwareConcurrency', p.cores === null ? undefined : p.cores);
  var never = function () { return new Promise(function () {}); };
  if (p.gpu === 'none') { fix('gpu', undefined); return; }
  if (!self.GPU || p.gpu === 'real') return;
  if (p.gpu === 'no-adapter') GPU.prototype.requestAdapter = function () { return Promise.resolve(null); };
  if (p.gpu === 'adapter-hang') GPU.prototype.requestAdapter = never;
  if (p.gpu === 'session-fail') GPUAdapter.prototype.requestDevice = function () { return Promise.reject(new Error('the simulator refused the GPU device')); };
  if (p.gpu === 'session-hang') GPUAdapter.prototype.requestDevice = never;
  if (p.gpu === 'run-hang') {
    var map = GPUBuffer.prototype.mapAsync, reads = 0;
    GPUBuffer.prototype.mapAsync = function () { return ++reads > p.hangAfter ? never() : map.apply(this, arguments); };
  }
})(/*PROFILE*/{});
