// /client — the client portal (docs/client-portal.md, react-migration-plan.md → stage 3).
// A client works in the manager app now (docs/permissions-plan.md → stage 3):
// this page only sends there; a session kept here is taken over by the
// manager page's gate (adoptPortalSession, src/manager/page/gate.ts).
location.replace('schedule-manager.html');
