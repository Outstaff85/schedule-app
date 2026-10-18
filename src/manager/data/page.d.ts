// What the manager page's own script (schedule-manager.html) still defines and
// the data layer (src/manager/data/, built into manager-data.js) uses by name.
// They are the page's globals: the data layer runs in the same window, so a
// bare name reaches them when it is called (React migration stage 8b; 8c moves
// them into src/ and this file goes).
/* eslint-disable @typescript-eslint/no-explicit-any */

type PageRec = Record<string, any>;

declare global {
  // the page's state (its `let`s)
  let workers: PageRec[];
  let clients: PageRec[];
  let suppliers: PageRec[];
  let weekStart: Date;
  let currentTab: string;
  let __dataReady: boolean;
  // the page's functions
  function tr(text: string, vars?: Record<string, unknown>): string;
  function showToast(msg: string, dur?: number): void;
  function render(): void;
  function renderDashboard(): void;
  function renderSchedulePage(): void;
  function renderAccounting(): void;
  function renderAdmin(): void;
  function refreshBell(): void;
  function uid(): string;
  function genToken(): string;
  function hasPermission(section: string): boolean;
  function isHrSession(): boolean;
  function maybeRegenAfterFirmEdit(): void;

  interface Window {
    ManagerIsland?: { refreshWindows(): void } & Record<string, unknown>;

  }
}

export {};
