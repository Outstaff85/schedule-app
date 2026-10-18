// The manager page's Vite entry (schedule-manager.html; React migration stage
// 8c-2, docs/build.md → The manager app). In this order: the data layer and the
// logic put their old global names on window (../globals.ts), the page's own
// script runs (./app.ts), then the React pieces mount and fire
// manager-island-ready (../main.tsx). One bundle: one copy of the state.
import '../globals';
import './app';
import '../main';
