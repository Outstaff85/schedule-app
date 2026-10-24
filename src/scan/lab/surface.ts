// The scanner lab's surface (docs/scan-plan.md → S9): /scan-lab/ and its own models (scripts/scan-lab/models-version,
// fetched at deploy by scripts/scan-lab/fetch-models.sh), its own browser cache and training source. Kept apart from
// src/scan/engine/surface.ts so only the lab's page imports it: the chunks the site's scanner shares with the lab never
// name /scan-lab/ (tests/build/check.js → the surface guard; CLAUDE.md → Scanner: the lab and the site are apart).
import { noToken, type ScanSurface } from '../engine/surface';

/** The scanner lab: /scan-lab/ and its models (scripts/scan-lab/models-version). */
export const labSurface = (idToken: () => Promise<string | null> = noToken): ScanSurface =>
  ({ base: '/scan-lab/', cache: 'scan-lab-models', source: 'lab', idToken });
