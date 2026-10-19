// The manager app's toast (the punch page's copy is src/punch/core.ts —
// duplicated on purpose, CLAUDE.md): small, an icon and a coloured edge by
// its kind, guessed from the text — error, ongoing (ends with …), warning,
// else done. Any toast text goes through tr(): a server message in the
// dictionary shows translated. A toast that reads as an error is also sent
// to the error log (Admin → Errors), as the page's other errors are.
// The page's modules import it; window.showToast is the same function (the
// browser tests call it).
import { tr } from './logic/i18n';
import { reportError } from './data/telemetry';

export type ToastKind = 'ok' | 'warn' | 'err' | 'info';
const TOAST_ICONS: Record<ToastKind, string> = {ok: 'ti-circle-check', warn: 'ti-alert-triangle', err: 'ti-alert-circle', info: 'ti-info-circle'};
export function toastKind(t: string): ToastKind {
  if (/fail|error|could not|couldn't|not saved|denied|refused|invalid|נכשל|שגיאה|לא נשמר|לא ניתן/i.test(t)) return 'err';
  if (/(…|\.\.\.)\s*$/.test(t)) return 'info';
  if (/⚠|warn|check|empty|missing|not found|בדקו|ריק|חסר|לא נמצא/i.test(t)) return 'warn';
  return 'ok';
}
// The texts sent to the error log (checked on the text before translation).
const ERROR_TOAST_RE = /fail|could not|error|offline|denied|invalid|no network|not available|no rights|not enough rights|expired|⚠|⚠/i;

/** Shows `msg` for `dur` ms (2.5 s by default) in the page's #toast. */
export function showToast(msg: unknown, dur?: number): void {
  const t = document.getElementById('toast') as (HTMLElement & {__hide?: ReturnType<typeof setTimeout>}) | null;
  const text = typeof msg === 'string' ? tr(msg) : String(msg), k = toastKind(text);
  if (t) {
    t.className = 'toast show ' + k;
    t.innerHTML = '<i class="ti ' + TOAST_ICONS[k] + '"></i><span></span>';
    t.lastChild!.textContent = text;
    clearTimeout(t.__hide); t.__hide = setTimeout(() => t.classList.remove('show'), dur || 2500);
  }
  try { if (ERROR_TOAST_RE.test(String(msg || ''))) reportError(String(msg), 'toast', ''); } catch { /* the log is best effort */ }
}
