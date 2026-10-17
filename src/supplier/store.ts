// The portal's screen state, outside React: a language change redraws the
// page from scratch (I18nProvider), the open tab, the picked month and the
// shift rows being typed stay.
import * as React from 'react';

export type Tab = 'dashboard' | 'workers' | 'hours' | 'review';
export interface SendRow { date: string; inTime: string; outTime: string }
export interface UiState {
  tab: Tab | '';
  /** the month on My Hours: 0 = this one, 1 = the one before … 11 */
  month: number;
  exportWorker: string;
  sendWorker: string;
  sendRows: SendRow[];
  /** the rows that could not be sent (outlined red) */
  badRows: number[];
}

let st: UiState = { tab: '', month: 0, exportWorker: '', sendWorker: '', sendRows: [], badRows: [] };
const subs = new Set<() => void>();
export const setUi = (p: Partial<UiState> | ((s: UiState) => Partial<UiState>)) => {
  st = { ...st, ...(typeof p === 'function' ? p(st) : p) };
  subs.forEach(f => f());
};
export const getUi = () => st;
export const useUi = () => React.useSyncExternalStore(cb => { subs.add(cb); return () => { subs.delete(cb); }; }, () => st);
