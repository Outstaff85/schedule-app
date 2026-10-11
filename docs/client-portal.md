# Client portal (`client-portal.html`)

A client of the firm (a site where its workers work) signs in with its own login and reviews its workers' hours there. Routed at `/client`. A separate page like the supplier portal, for the same reason: a client must never see wages, rates, suppliers, GPS or documents, and Firestore rules can't hide fields — so the page never reads Firestore; everything comes from the `hours` Cloud Function and is drawn by the shared hours screen, `hours-review.js` ([hours-review.md](hours-review.md) — the ticks, the function, the per-day approve / dispute / fix, the owner's side).

## Logins

- Made in the manager app: Admin → Users → New user, role **Client** (`USER_ROLE_LABELS.client`): pick the client (`#userFormClientId`, `fillUserFormClientSelect`) and tick the **Hours** block (`hourPerms`, default hours, approve, dispute, fix). "Only own workers" is on and locked.
- Server side (`core.py`): `create_tenant_user` / `update_user` accept role `client` with `clientId` (required); `claims_for` gives it `role: 'client'`, `clientId`, `hp` (its hours ticks) and `perms: []`. The login reply carries `clientId` and `hourPerms`.
- The Users list shows a client login as "(client)" with its client and its hours ticks. A client login on the main site is handed over to `/client` (`goToClientPortal`, like `goToSupplierPortal`).
- `firestore.rules`: no rule lets a `client` role read or write anything (tested in `rules.test.mjs`).

## The page

- Login (`submitLogin` → `firestore-backend.js` `login`; only a `client` role is let in — "This login is not a client account"), own session key `clientPortal_session`; a "Manager" button in the header and a "Manager login" link on the login screen go back to the manager app (`goToManager`, as in the supplier portal); a kept session opens the portal at once (no login-screen flash, class `has-session`), and `gateApp` brings the login back only when the Firebase sign-in is gone; language select as on the other pages (`i18n/<lang>.json`).
- After the gate, `loadHoursReview()` loads `hours-review.js` and `hoursReviewMount(#hoursRoot, {hideOwner: true, call})` draws the month (the client's name and object are in the header, from the `load` reply). A session error from the function logs out.
