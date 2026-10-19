// The manager page's Vite entry (schedule-manager.html; docs/build.md → The
// manager app). In this order: the data layer and the logic put their old
// global names on window (../globals.ts); the page's own script runs — split by
// section into the modules below, imported in the order the inline script had
// them (React migration stages 8c-2, 8c-3) —; then the React pieces mount and
// fire manager-island-ready (../main.tsx). One bundle: one copy of the state.
import '../globals';
import './base';
import './language';
import './nav';
import './header';
import './render';
import './worker-window';
import './clients';
import './workers';
import './suppliers';
import './windows';
import './wiring';
import './gate';
import './admin';
import './bridge';
import './toast';
import './scan';
import './form101';
import './init';
import '../main';
