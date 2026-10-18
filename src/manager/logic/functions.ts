// The Cloud Functions the page calls directly, and their warm-up (from
// schedule-manager.html). A cold preprocess_scan / fill_form_101 / ai_read
// instance costs seconds on first use (the Timings pane showed ~4-5 s in
// "Enhance (server)"), so a {"ping":true} call wakes them while the user is
// still photographing or filling the form; the functions answer a ping at
// once without doing any work. At most once per URL per 4 minutes. The
// results are kept in fnWarm for the scan timing (scan-pipeline.js reads __fnWarm).

// The server-side Form 101 PDF builder (Python + PyMuPDF; functions/main.py).
export const FORM101_FN_URL = 'https://us-central1-schedule-odinson.cloudfunctions.net/fill_form_101';
// Scan preprocessing (OpenCV geometry + Pillow contrast / sharpness; scan-pipeline.js preAlignScan()).
export const PREPROCESS_SCAN_FN_URL = 'https://us-central1-schedule-odinson.cloudfunctions.net/preprocess_scan';
// The AI reads (firestore-backend.js sends them).
export const AI_FN_URL = 'https://europe-west3-schedule-odinson.cloudfunctions.net/ai_read';
export const USERS_ADMIN_FN_URL = 'https://europe-west3-schedule-odinson.cloudfunctions.net/users_admin';
/** the functions a scan uses */
export function SCAN_WARM_URLS(): string[] { return [PREPROCESS_SCAN_FN_URL, FORM101_FN_URL, AI_FN_URL]; }

export const fnWarm: Record<string, {at: number; ms: number | null}> = {};
export function warmCloudFunctions(urls: string[]): void {
  const now = Date.now();
  for (const url of urls) {
    const w = fnWarm[url];
    if (w && now - w.at < 240000) continue;
    const rec: {at: number; ms: number | null} = {at: now, ms: null}; fnWarm[url] = rec;
    fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{"ping":true}'})
      .then(() => { rec.ms = Date.now() - rec.at; }).catch(() => {});
  }
}
