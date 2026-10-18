// How the data layer talks to the page: it never draws, never shows a toast
// and never asks the page what is on screen. It emits events, and the page
// (its wiring block in schedule-manager.html → "The data layer's events")
// decides what to redraw. A text for the user travels untranslated, as a
// Message built with tr() below, and the page translates it when it shows it
// (the dictionary check finds these texts like any other tr call).

export interface Message { text: string; vars?: Record<string, unknown> }
/** A text for the user, translated by the page when shown. */
export const tr = (text: string, vars?: Record<string, unknown>): Message => ({text, vars});

export interface DataEvents {
  /** workers / clients / suppliers were replaced or changed (the cache, a server load, an HR's live list) */
  data: void;
  /** the punch cache changed (the live listener, older months loaded) */
  punches: void;
  /** the hours batches changed (listenPendingHours) */
  hours: void;
  /** the save indicator */
  save: 'saving' | 'saved';
  /** a message for the user (a toast) */
  notice: {msg: Message | string; ms?: number};
  /** fresh server data was applied (the page then rebuilds Form 101s waiting on a firm edit) */
  loaded: void;
  /** the workers' requests (days off, shift offers) were read again */
  requests: void;
}
type Name = keyof DataEvents;
type Handler<K extends Name> = (payload: DataEvents[K]) => void;

const handlers: {[K in Name]?: Handler<K>[]} = {};
export function on<K extends Name>(name: K, fn: Handler<K>): void {
  ((handlers[name] ||= []) as Handler<K>[]).push(fn);
}
export function emit<K extends Name>(name: K, ...payload: DataEvents[K] extends void ? [] : [DataEvents[K]]): void {
  for (const fn of (handlers[name] || []) as Handler<K>[]) {
    try { fn(payload[0] as DataEvents[K]); } catch (e) { console.error('Data event ' + name + ' failed:', e); }
  }
}
/** A toast: a Message (the data layer, untranslated) or a text the logic already translated. */
export const notify = (msg: Message | string, ms?: number): void => emit('notice', {msg, ms});

// What the data layer needs to know from the page, set once by it
// (setHost): only questions, never drawing.
export interface Host {
  /** this login may write workers (the Workers or Schedule section) */
  canWriteWorkers(): boolean;
  /** a worker window, card or pay window is open: an HR's live list waits */
  workerWindowOpen(): boolean;
  /** the week on screen, kept with the cache (ISO) */
  weekStart(): string | null;
}
export const host: Host = {canWriteWorkers: () => true, workerWindowOpen: () => false, weekStart: () => null};
export function setHost(h: Partial<Host>): void { Object.assign(host, h); }
