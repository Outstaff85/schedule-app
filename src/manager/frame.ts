// The manager app's frame state (React migration stage 8e-1): what the React
// frame (Frame.tsx, the Shell with `app`) draws — the open section, the
// sections this login may see, the breadcrumb, the greeting, the bell, the
// save state, the account. The page's modules write it (switchTab,
// applyNavPermissions, renderCrumb, renderGreeting, refreshBell,
// setSaveStatus, renderAccountControl…); the frame redraws on every change.
import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';

export type FrameState = {
  /** the page's language (I18N_LANG): the frame redraws in it, mirrored in Hebrew */
  lang: string;
  /** the screen shown: the sign-in, the super-admin's Firms list, or the app (the frame) */
  screen: 'login' | 'firms' | 'app';
  /** the open section (the page's currentTab) */
  tab: string;
  /** the sections this login may see, in menu order */
  tabs: string[];
  /** a count on a section (Accounting: hours batches waiting) */
  counts: Record<string, number>;
  /** the breadcrumb after the section: its count and the open sub-tab */
  crumb: { count?: number; sub?: string };
  /** the greeting's name and weather; null = not signed in yet */
  greet: { name: string; wx: { kind: string; temp?: number } | null } | null;
  save: 'saved' | 'saving';
  /** the bell: shown for the roles that have notifications, its unread count */
  bell: { shown: boolean; count: number };
  /** the account button and the head of its menu */
  account: { name: string; firm: string; sub: string } | null;
  /** the Admin section's icon warns (the firm profile is incomplete) */
  adminWarn: boolean;
  /** "Install app" in the account menu (until the app is installed) */
  install: boolean;
};

let state: FrameState = {
  lang: 'en', screen: 'app', tab: 'dashboard', tabs: [], counts: {}, crumb: {}, greet: null, save: 'saved',
  bell: { shown: false, count: 0 }, account: null, adminWarn: false, install: false,
};
const listeners = new Set<() => void>();

export function setFrame(p: Partial<FrameState>): void {
  let changed = false;
  for (const k of Object.keys(p) as (keyof FrameState)[]) {
    if (JSON.stringify(state[k]) !== JSON.stringify(p[k])) { changed = true; break; }
  }
  if (!changed) return;
  state = { ...state, ...p };
  // Drawn at once, as the page's tabs are (main.tsx), so the page's code and a
  // test that run right after see the new frame.
  flushSync(() => listeners.forEach(fn => fn()));
}
export const frameState = (): FrameState => state;

export function useFrame(): FrameState {
  return useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => state);
}
