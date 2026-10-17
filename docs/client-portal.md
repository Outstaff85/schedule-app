# Client portal (`client-portal.html`)

A client of the firm (a site where its workers work) signs in with its own login and reviews its workers' hours there. Routed at `/client`. A separate page like the supplier portal, for the same reason: a client must never see wages, rates, suppliers, GPS or documents, and Firestore rules can't hide fields — so the page never reads Firestore; everything comes from the `hours` Cloud Function and is drawn by the shared hours screen, `hours-review.js` ([hours-review.md](hours-review.md) — the ticks, the function, the per-day approve / dispute / fix, the owner's side).

## Logins

- Made in the manager app: Admin → Users → New user, role **Client** (`USER_ROLE_LABELS.client`): pick the client (`#userFormClientId`, `fillUserFormClientSelect`) and tick the **Hours** block (`hourPerms`, default hours, approve, dispute, fix). "Only own workers" is on and locked.
- Server side (`core.py`): `create_tenant_user` / `update_user` accept role `client` with `clientId` (required); `claims_for` gives it `role: 'client'`, `clientId`, `hp` (its hours ticks) and `perms: []`. The login reply carries `clientId` and `hourPerms`.
- The Users list shows a client login as "(client)" with its client and its hours ticks. A client login on the main site is handed over to `/client` (`goToClientPortal`, like `goToSupplierPortal`).
- `firestore.rules`: no rule lets a `client` role read or write anything (tested in `rules.test.mjs`).

## The page (React, `src/client/`)

A page of the new stack (stage 3 of [react-migration-plan.md](react-migration-plan.md); [build.md](build.md)): `client-portal.html` at the repo root is its Vite entry (built into `dist/client-portal.html` and `dist/assets/`, never copied as an old page); `/client` is rewritten to it.

- **The gate.** No login of its own (one login for every role, user request 2026-10-11): a client signs in on the manager app's login page, which hands over to `client-portal.html` (`goToClientPortal`, own session key `clientPortal_session` = `{uid, role:'client', tenantId, clientId, username}`). Without that session a small script in the HTML head goes to `schedule-manager.html` before anything loads; after loading, `passGate()` (`src/client/App.tsx`, once per load) also checks the Firebase sign-in (`loadBackend().currentUser()`, `src/lib/backend.ts` → `firestore-backend.js`) and, when it is gone, drops the session and goes to the login page.
- **The frame.** `Shell` without sections: the 11C brand with "Client Portal" and, under it, the client's name and object (from the `load` reply, `useHoursOwner`); at the right the Language button and the account menu (`AccountMenu`: the login's name, "Client", **Sign out** → `logout()`: the session and the Firebase sign-in end, the login page opens). A language pick is kept on the device (`uiLang`) and on the account (`updateMyLanguage`, `src/client/main.tsx`).
- **The hours.** `HoursReview` with `hideOwner` ([hours-review.md](hours-review.md) → The screen in the new stack); its `call` posts to the `hours` function with the ID token (`idToken()`); a session error in the reply logs out.
- The new version check (`useVersionWatch`: the page's own HTML, which names its hashed bundle, and `firestore-backend.js`) offers **Update** in a toast after a deploy.
- What a client receives is only the `hours` function's reply for its client (names, shifts at its site, its day entries) — the page reads nothing else; `tests/e2e/main.test.js` checks the replies and the page for money, suppliers, GPS, files and tokens.
