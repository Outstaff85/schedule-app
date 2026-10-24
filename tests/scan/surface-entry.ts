// Both surfaces for the scanner's tests: the engine's (src/scan/engine/surface.ts, the site's) and the lab's own
// (src/scan/lab/surface.ts, apart so the site's chunks never name /scan-lab/).
export * from '../../src/scan/engine/surface';
export { labSurface } from '../../src/scan/lab/surface';
