# Client login (inside the manager app)

A client of the firm (a site where its workers work) signs in with its own login and reviews its workers' hours. Since 2026-10-19 (docs/permissions-plan.md → stages 3–4) it works **inside the manager app**, in the same frame, with one tab, **Hours**. A client must never see wages, rates, suppliers, GPS or documents, and Firestore rules can't hide fields — so nothing reads Firestore for it: everything comes from the `hours` Cloud Function and is drawn by the shared hours screen, `src/hours-review/` ([hours-review.md](hours-review.md) — the ticks, the function, the per-day approve / dispute / fix, the owner's side).

## Logins

- Made in the manager app: Admin → Users → New user, a **Client** template (the template says the role and its rights — the default Client template: Hours, Approve / Dispute / Fix hours), then the client (the user window's client picker, `src/manager/Users.tsx`). "Only own workers" is on and locked.
- Server side (`core.py`): `create_tenant_user` / `update_user` take a Client template with `clientId` (required); `claims_for` gives it `role: 'client'`, `clientId` and `rt` (its flat rights). The login reply carries `clientId` and `rights`.
- The Users list shows a client login as "(client)" with its client and its hours ticks.
- `firestore.rules`: no rule lets a `client` role read or write anything (tested in `rules.test.mjs`).

## In the manager app

- **The gate.** One login page for every role: after the sign-in the manager page's gate runs `startPortal` (`src/manager/page/gate.ts`) instead of the app's start — no firm data is loaded. It writes the client's session key `clientPortal_session` = `{uid, role:'client', tenantId, clientId, username}`, checks the Firebase sign-in (`loadFirestoreBackend().currentUser()`; gone or another user's → the sign-in), and gives the frame one tab, Hours (`portalTabs`, `src/manager/portal.ts`).
- **The tab.** `PortalView` (`src/manager/Portal.tsx`), drawn into the page's `#sectionPortal`: `HoursReview` with its client named on top and `sign={signer: the login's name}` — the approved month is signed with a finger and kept as a PDF with the client's documents ([hours-review.md](hours-review.md) → Signing the month); its `call` posts to the `hours` function with the ID token; a session error in the reply signs out.
- **The frame.** The manager app's: the side menu / bottom bar with Hours, the Language button (the pick kept on the device and the account) and the account menu (the person's name, the firm · client, the theme, **Sign out** → both sessions and the Firebase sign-in end, the sign-in opens).
- **`/client`** (`client-portal.html`, a small static page kept for bookmarks and installed apps) only sends to `/schedule-manager.html`; a `clientPortal_session` kept from the old portal is taken over by the gate (`adoptPortalSession`).
- What a client receives is only the `hours` function's reply for its client (names, shifts at its site, its day entries, when and by whom the month was signed) — the page reads nothing else; `tests/e2e/main.test.js` checks the replies and the page for money, suppliers, GPS, files and tokens, and that no firm data is loaded.
