// /supplier — the supplier portal (docs/supplier-portal.md, react-migration-plan.md → stage 4).
// A supplier works in the manager app now (docs/permissions-plan.md → stage 3):
// this page only sends there; a session kept here is taken over by the
// manager page's gate (adoptPortalSession, src/manager/page/gate.ts).
location.replace('schedule-manager.html');
