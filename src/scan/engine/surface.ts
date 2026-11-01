// The scanner's engine (docs/scan-plan.md → S9): the surface it runs on — the site's scanner (/scan/) or the
// scanner lab (/scan-lab/). Each has its own models, models.json, he-layouts.json and ONNX Runtime, put there
// at deploy by its own fetch script (scripts/scan/fetch-models.sh, scripts/scan-lab/fetch-models.sh) at its
// own model version, and its own browser cache of the models. Every URL the engine loads is built here from
// the surface's base, so the site never names /scan-lab/ (CLAUDE.md → Scanner: the lab and the site are apart).
// The lab's surface itself is src/scan/lab/surface.ts, which only the lab's page imports: a module the site's
// scanner shares with the lab never holds the lab's folder, so no chunk the manager page loads names it
// (tests/build/check.js → the surface guard).

/** The ONNX Runtime Web builds put next to each surface: 1.22 for the CPU, 1.30 for the GPU (its GPU runs the
 *  light model right on a phone where 1.22 returned zeros). The lab may pick 1.30 for the CPU too. */
export type OrtDir = 'ort' | 'ort130';
export const CPU_ORT: OrtDir = 'ort', GPU_ORT: OrtDir = 'ort130';

/** What a background thread needs of the surface (sent in its 'load' message; no functions). */
export interface SurfaceRef {
  base: '/scan/' | '/scan-lab/';
  cache: 'scan-models' | 'scan-lab-models';
}

export interface ScanSurface extends SurfaceRef {
  /** Where the training attempts say they came from (scan_feedback). */
  source: 'site' | 'lab';
  /** The signed-in user's ID token for scan_feedback, null when there is none. */
  idToken(): Promise<string | null>;
}

export const noToken = async (): Promise<string | null> => null;

/** The site's scanner: /scan/ and its models (scripts/scan/models-version). */
export const siteSurface = (idToken: () => Promise<string | null> = noToken): ScanSurface =>
  ({ base: '/scan/', cache: 'scan-models', source: 'site', idToken });

/** Only the serializable part, for a background thread. */
export const surfaceRef = (s: SurfaceRef): SurfaceRef => ({ base: s.base, cache: s.cache });

/** A model or data file of the surface (lite.onnx, sa24_w16.onnx, yunet.onnx, doctype.onnx, mrz.onnx, he.onnx…). */
export const modelUrl = (s: SurfaceRef, name: string): string => s.base + name;
/** models.json: the surface's model version and which readers it has. */
export const modelsJsonUrl = (s: SurfaceRef): string => s.base + 'models.json';
/** he-layouts.json: the card layouts the Hebrew field reader reads. */
export const layoutsUrl = (s: SurfaceRef): string => s.base + 'he-layouts.json';
/** The folder of one ONNX Runtime build (its .wasm and the .mjs its loader imports). */
export const ortDirUrl = (s: SurfaceRef, dir: OrtDir): string => s.base + dir + '/';
/** The ONNX Runtime build's ES module: `ort.all.min.mjs`, with the GPU, or — gpu false, a model asked for on the CPU
 *  alone — the plain `ort.wasm.min.mjs` (measured on a PC: a session and its first run take half the time, the same
 *  answers; docs/scan-plan.md → The CPU first). */
export const ortModuleUrl = (s: SurfaceRef, dir: OrtDir, gpu = true): string => ortDirUrl(s, dir) + (gpu ? 'ort.all.min.mjs' : 'ort.wasm.min.mjs');
