// Translations in the new stack (docs/translations.md → New stack): the same
// dictionaries (i18n/<lang>.json, English text → translation), the same device
// key (localStorage.uiLang, shared with the old pages) and the same rules as
// the old pages' core. `tr(text, params)` returns the English text in the
// chosen language; tests/i18n/check.js reads its literals from src/ too.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export const I18N_LANGS: Record<string, string> = { en: 'English', he: 'עברית', ru: 'Русский' };
export const I18N_LANG_EN: Record<string, string> = { en: 'English', he: 'Hebrew', ru: 'Russian' };
export type Lang = keyof typeof I18N_LANGS;

let dict: Record<string, string> = {};
let current = 'en';

/** The text in the chosen language; `{key}` placeholders filled from params. */
export function tr(s: string, params?: Record<string, string | number>): string {
  let out = (current !== 'en' && dict[s]) || s;
  if (params) out = out.replace(/\{(\w+)\}/g, (m, k: string) => (params[k] != null ? String(params[k]) : m));
  return out;
}

/**
 * Takes a language and its dictionary already loaded by the page — the manager
 * app's React pieces follow the old page's language (src/manager/), which has
 * no I18nProvider.
 */
export function adoptLanguage(lang: string, d: Record<string, string>): void {
  current = I18N_LANGS[lang] ? lang : 'en';
  dict = d || {};
}

/** The language's locale for dates and numbers. */
export function uiLocale(lang = current): string {
  return ({ he: 'he-IL', ru: 'ru-RU' } as Record<string, string>)[lang] || 'en-GB';
}

export function storedLanguage(): string {
  try {
    const l = localStorage.getItem('uiLang');
    return l && I18N_LANGS[l] ? l : 'en';
  } catch {
    return 'en';
  }
}

// This device's copy first (instant), the file refreshes it.
async function loadDictionary(lang: string, onFresh: (d: Record<string, string>) => void): Promise<Record<string, string>> {
  if (lang === 'en') return {};
  let cached: Record<string, string> | null = null;
  try { cached = JSON.parse(localStorage.getItem('i18n_' + lang) || 'null'); } catch { /* no copy */ }
  const fresh = fetch(`/i18n/${lang}.json`, { cache: 'no-cache' })
    .then(r => (r.ok ? r.json() : null))
    .then((d: Record<string, string> | null) => {
      if (!d || typeof d !== 'object') return null;
      try { localStorage.setItem('i18n_' + lang, JSON.stringify(d)); } catch { /* full */ }
      return d;
    })
    .catch(() => null);
  if (cached) {
    fresh.then(d => { if (d && JSON.stringify(d) !== JSON.stringify(cached)) onFresh(d); });
    return cached;
  }
  return (await fresh) || {};
}

type I18nState = { lang: string; setLanguage: (lang: string) => Promise<void>; ready: boolean };
const I18nContext = createContext<I18nState>({ lang: 'en', setLanguage: async () => {}, ready: true });

/**
 * Wraps a page: loads the chosen language before the first draw and redraws
 * everything under it when the language changes. `onSave` keeps a signed-in
 * user's choice on their account (the old pages' updateMyLanguage).
 */
export function I18nProvider({ children, onSave }: { children: ReactNode; onSave?: (lang: string) => void }) {
  const [lang, setLang] = useState('en');
  const [ready, setReady] = useState(false);
  const [, bump] = useState(0);

  const apply = useCallback(async (l: string) => {
    const d = await loadDictionary(l, fresh => { if (current === l) { dict = fresh; bump(n => n + 1); } });
    dict = d; current = l;
    document.documentElement.lang = l;
    setLang(l);
  }, []);

  useEffect(() => { apply(storedLanguage()).finally(() => setReady(true)); }, [apply]);

  const setLanguage = useCallback(async (l: string) => {
    const next = I18N_LANGS[l] ? l : 'en';
    try { localStorage.setItem('uiLang', next); } catch { /* private mode */ }
    onSave?.(next);
    await apply(next);
  }, [apply, onSave]);

  const value = useMemo(() => ({ lang, setLanguage, ready }), [lang, setLanguage, ready]);
  // key: a new language redraws the whole tree, so every tr() reads the new dictionary
  return <I18nContext.Provider value={value}>{ready ? <div key={lang} className="contents">{children}</div> : null}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);

/**
 * The manager app's frame (no I18nProvider): the components under it read the
 * page's language (`lang`, adopted with adoptLanguage) from useI18n — the
 * Shell mirrors itself in Hebrew by it.
 */
export function LanguageScope({ lang, children }: { lang: string; children: ReactNode }) {
  return <I18nContext.Provider value={{ lang, setLanguage: async () => {}, ready: true }}>{children}</I18nContext.Provider>;
}
