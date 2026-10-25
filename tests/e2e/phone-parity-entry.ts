// The scanner's resampling paths for tests/e2e/phone-parity.test.js, bundled with esbuild into one IIFE (the global
// Probe) and run in Chromium: the lab's resampling probe itself (src/scan/lab/probe.ts) and the engine's smallRGBA /
// warpRGBA it measures.
export { probeFrame, runProbe } from '../../src/scan/lab/probe';
export { smallRGBA } from '../../src/scan/engine/live';
export { S, warpRGBA } from '../../src/scan/engine/geometry';
