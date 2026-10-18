// The theme (docs/redesign.md → Light theme): Dark (the default), Light — for
// outdoors — or System (the device's own light / dark setting, followed live).
// The choice is kept on this device (localStorage.uiTheme, shared by every
// page) and, for a signed-in user, on their account (updateMyTheme; login
// returns it, so it follows them to every device). The page's
// <html data-theme="dark|light"> carries the resolved look: og.css holds the
// light token values under :root[data-theme="light"]. Every page's HTML sets it
// in a small inline script in <head> before the first draw; this module keeps
// it up to date after that. The manager app's old page has the same functions
// (storedTheme / applyTheme / setTheme in schedule-manager.html) — keep them
// the same.
import { useEffect, useState } from 'react';

export type ThemeChoice = 'dark' | 'light' | 'system';
export const THEMES: ThemeChoice[] = ['dark', 'light', 'system'];
/** the browser bar colour of each look (the ground) */
const BAR = { dark: '#10141f', light: '#eef1f7' };

const media = () => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null);

/** This device's choice: Dark when none was made. */
export function storedTheme(): ThemeChoice {
  try {
    const t = localStorage.getItem('uiTheme');
    return t === 'light' || t === 'system' ? t : 'dark';
  } catch { return 'dark'; }
}

/** The look a choice draws now: System follows the device. */
export function resolveTheme(choice: ThemeChoice): 'dark' | 'light' {
  return choice === 'system' ? (media()?.matches ? 'light' : 'dark') : choice;
}

/** Puts the look on the page (<html data-theme>, the browser bar colour). */
export function applyTheme(choice: ThemeChoice = storedTheme()) {
  const look = resolveTheme(choice);
  document.documentElement.dataset.theme = look;
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach(m => { m.content = BAR[look]; });
}

const listeners = new Set<(c: ThemeChoice) => void>();
let watching = false;
function watchDevice() {
  if (watching) return;
  watching = true;
  // System follows the device's setting while the page is open.
  media()?.addEventListener?.('change', () => { if (storedTheme() === 'system') applyTheme('system'); });
  // Another tab of the same site switched: follow it.
  window.addEventListener('storage', e => {
    if (e.key !== 'uiTheme') return;
    const c = storedTheme();
    applyTheme(c);
    listeners.forEach(l => l(c));
  });
}

/**
 * Switches the theme: keeps it on this device, draws it at once and, when
 * `save` is given (a signed-in user), keeps it on their account.
 */
export function setTheme(choice: ThemeChoice, save?: (c: ThemeChoice) => void) {
  const c: ThemeChoice = THEMES.includes(choice) ? choice : 'dark';
  try { localStorage.setItem('uiTheme', c); } catch { /* private mode: this visit only */ }
  applyTheme(c);
  listeners.forEach(l => l(c));
  save?.(c);
}

/** A signed-in user's theme from login (it wins over this device's). */
export function adoptAccountTheme(t: unknown) {
  if (t === 'dark' || t === 'light' || t === 'system') setTheme(t);
}

/** The current choice and the switch, redrawn when it changes anywhere on the page. */
export function useTheme(): [ThemeChoice, (c: ThemeChoice, save?: (c: ThemeChoice) => void) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(storedTheme);
  useEffect(() => {
    watchDevice();
    applyTheme(storedTheme());
    listeners.add(setChoice);
    return () => { listeners.delete(setChoice); };
  }, []);
  return [choice, setTheme];
}
