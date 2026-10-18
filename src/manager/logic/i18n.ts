// Translations of the manager app (docs/translations.md; from schedule-manager.html).
// Every UI text in the code is English. tr('Total Pay') returns it in the
// language picked with the Language button, from i18n/<lang>.json (English
// text → translation); a text the dictionary lacks shows in English. {name}
// placeholders take params: tr(text, {n: 3}). The page's own markup
// (data-i18n…) and the Language button stay the page's (applyI18n,
// setLanguage). The new pages' copy is src/lib/i18n.tsx.

export const I18N_LANGS: Record<string, string> = {en: 'English', he: 'עברית', ru: 'Русский'};
let dict: Record<string, string> = {}, lang = 'en';
/** the language and its loaded dictionary (the React pieces adopt them, ManagerBridge.lang / dict) */
export const currentLang = (): string => lang;
export const currentDict = (): Record<string, string> => dict;

export function tr(s: string, params?: Record<string, unknown>): string {
  let out = (lang !== 'en' && dict[s]) || s;
  if (params) out = out.replace(/\{(\w+)\}/g, (m, k) => params[k] != null ? String(params[k]) : m);
  return out;
}
// The date locale for month and weekday names on screen (numeric dates stay dd/mm/yyyy).
export function uiLocale(): string { return ({he: 'he-IL', ru: 'ru-RU'} as Record<string, string>)[lang] || 'en-GB'; }
// This device's language (localStorage.uiLang, shared by the pages): English by default.
export function storedLanguage(): string { try { const l = localStorage.getItem('uiLang'); return l && I18N_LANGS[l] ? l : 'en'; } catch { return 'en'; } }

// A newer dictionary arrived after the cached one was shown: the page redraws.
let onNewer: (() => void) | null = null;
export function onNewerDictionary(fn: () => void): void { onNewer = fn; }

// Loads a language's dictionary: from this device's copy at once when there
// is one (no wait at startup), refreshed from i18n/<lang>.json; a newer file
// calls the onNewerDictionary handler. English needs no file. The document's
// lang attribute follows.
export async function loadI18n(want: string): Promise<void> {
  const set = (l: string, d: Record<string, string> | null) => { lang = l; dict = d || {}; document.documentElement.lang = l; };
  if (!I18N_LANGS[want] || want === 'en') { set('en', {}); return; }
  let cached: Record<string, string> | null = null;
  try { cached = JSON.parse(localStorage.getItem('i18n_' + want) || 'null'); } catch { /* none */ }
  if (cached) set(want, cached);
  const fresh = fetch('i18n/' + want + '.json', {cache: 'no-cache'}).then(r => r.ok ? r.json() : null).then(d => {
    if (!d || typeof d !== 'object') return false;
    const changed = JSON.stringify(d) !== JSON.stringify(cached);
    try { localStorage.setItem('i18n_' + want, JSON.stringify(d)); } catch { /* full */ }
    if (lang === want || !cached) set(want, d);
    return changed;
  }).catch(() => false);
  if (cached) { fresh.then(ch => { if (ch && lang === want && onNewer) onNewer(); }); return; }
  await fresh;
}
