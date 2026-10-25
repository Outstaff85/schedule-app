// The scanner's engine for tests/scan/phone_parity.test.mjs: the modules gen/phone.py mirrors, bundled with Vite
// into one IIFE (evaluated anew where a test needs fresh module state, as smallRGBA's shared canvas).
export * as geometry from '../../src/scan/engine/geometry';
export * as readers from '../../src/scan/engine/readers';
export * as shot from '../../src/scan/engine/shot';
export * as upright from '../../src/scan/engine/upright';
export * as live from '../../src/scan/engine/live';
