# Client portal (`client-portal.html`)

A client of the firm (a site where its workers work) signs in with its own login and reviews its workers' hours there. Routed at `/client`. A separate page like the supplier portal, for the same reason: a client must never see wages, rates, suppliers, GPS or documents, and Firestore rules can't hide fields — so the page never reads Firestore; everything comes from the `hours` Cloud Function and is drawn by the shared hours screen, `hours-review.js` ([hours-review.md](hours-review.md) — the ticks, the function, the per-day approve / dispute / fix, the owner's side).

## Logins

- Made in the manager app: Admin → Users → New user, role **Client** (`USER_ROLE_LABELS.client`): pick the client (`#userFormClientId`, `fillUserFormClientSelect`) and tick the **Hours** block (`hourPerms`, default hours, approve, dispute, fix). "Only own workers" is on and locked.
- Server side (`core.py`): `create_tenant_user` / `update_user` accept role `client` with `clientId` (required); `claims_for` gives it `role: 'client'`, `clientId`, `hp` (its hours ticks) and `perms: []`. The login reply carries `clientId` and `hourPerms`.
- The Users list shows a client login as "(client)" with its client and its hours ticks. A client login on the main site is handed over to `/client` (`goToClientPortal`, like `goToSupplierPortal`).
- `firestore.rules`: no rule lets a `client` role read or write anything (tested in `rules.test.mjs`).

## The page

- No login of its own (one login for every role, user request 2026-10-11): a client signs in on the manager app's login page, which hands over to `/client` (own session key `clientPortal_session`); without a kept session — or when `gateApp` finds the Firebase sign-in gone — the page goes to `schedule-manager.html`. The header holds the Language button (`i18n/<lang>.json`) and the account menu (as in the other pages) with **Sign out** (`logout()` → the login page).
- After the gate, `loadHoursReview()` loads `hours-review.js` and `hoursReviewMount(#hoursRoot, {hideOwner: true, call})` draws the month (the client's name and object are in the header, from the `load` reply). A session error from the function logs out.
