# Client portal (`client-portal.html`)

A client of the firm (a site where its workers work) signs in with its own login and sees its workers' hours there, and approves or disputes them. Routed at `/client`. A separate page like the supplier portal, for the same reason: a client must never see wages, rates, suppliers, GPS or documents, and Firestore rules can't hide fields — so the page never reads Firestore; everything comes from the `client` Cloud Function (`functions-auth/portal.py` → `client_action`).

## Logins and ticks

- Made in the manager app: Admin → Users → New user, role **Client** (`USER_ROLE_LABELS.client`): pick the client (`#userFormClientId`, `fillUserFormClientSelect`) and tick what it may do (`.userFormClientPermCb`; `CLIENT_DEFAULT_PERMS` = hours, approve, dispute):
  - **hours** — its workers' in / out times and hours;
  - **approve** — approve the month (needs hours too);
  - **dispute** — dispute a day with a comment;
  - **schedule** — its workers' planned shifts;
  - **export** — the month's hours to Excel.
- Server side (`core.py`): `create_tenant_user` / `update_user` accept role `client` with `clientId` (required); its permissions are filtered to `CLIENT_PERMS`. `claims_for` gives it `role: 'client'`, `clientId`, `perms` (the ticks). The login reply carries `clientId`. A changed tick or client ends the user's sessions like any rights change.
- The Users list shows a client login as "(client)" with its client and ticks. A client login on the main site is handed over to `/client` (`goToClientPortal`, like `goToSupplierPortal`).
- `firestore.rules`: no rule lets a `client` role read or write anything (tested in `rules.test.mjs`).

## The `client` function (`portal.client_action(db, caller, body)`)

`caller` = the ID token's `uid, role, tenantId, clientId, perms`; anything but role `client` with a tenant and a client → "Client role only". Every action takes `month` (`YYYY-MM`, else "Bad month").

- `load` → `{client: {id, name, object}, perms, month, workers, punches?, approval?}`:
  - `workers`: the workers whose `clientIds` hold this client, plus any worker with a punch at this client this month (moved since) — `{id, name}`, with the `schedule` tick also `schedule` (`_week`) and `dates` (`_dates`);
  - with the `hours` tick: `punches` — this client's punches (`clientId` + `ts` index) of the month with a day of margin, each `{id, workerId, type, time, date, ts}` (never GPS, notes, site, supplier, rates); and `approval` (below).
- `approve` (ticks approve + hours) `{month, snapshot}` → stores the month approved: `status`, `approvedAt`, `approvedBy` (uid), `approvedByName` (the user's full name or login), `snapshot` (the shift lines the client saw, ≤ 3000) and clears the disputes.
- `dispute` (tick dispute) `{month, workerId, date: 'YYYY-MM-DD' of that month, comment}` → adds the day's dispute `{comment, byName, at}` under `"<workerId>|<date>"`; an empty comment takes it back. Status: `disputed` while any dispute is open, else `approved` if the month was approved before, else `pending`.

Approvals live in `tenants/{t}/clientApprovals/{clientId}_{YYYY-MM}` (`clientId, month, status, approvedAt, approvedBy, approvedByName, snapshot, disputes`) — written only by the function, read by managers (`manager(t)` in the rules).

## The page

- Login (`submitLogin` → `firestore-backend.js` `login`; only a `client` role is let in — "This login is not a client account"), own session key `clientPortal_session`; language select as on the other pages (`i18n/<lang>.json`).
- A month at a time (‹ › arrows, no future months); tabs **Hours** and **Schedule**, each only with its tick.
- **Hours** (`renderHours`): the month's shifts paired like the app (`monthShifts`: punches of the month by `ts`, `groupPunchesIntoShifts` / `analyzeDayPunches` — the same copies as the other pages), a card per worker (days, hours, each shift: date, in – out, hours). A status bar: waiting for approval / approved by … · when / N days disputed / **changed after approval** (the shift lines `snapshotOf` differ from the approved `snapshot` — a shift was added or edited after the approval). "Approve the month" (tick approve; a confirm) sends the lines; the ⚠ on a shift (tick dispute) opens the dispute window — no Save button, closing it saves the comment (`__onUserClose`), empty = no dispute. "Export" (tick export) writes `hours-<month>.xlsx` (Worker, Date, In, Out, Hours, a total) with SheetJS loaded on demand.
- **Schedule** (`renderSchedule`): each worker's planned day for every day of the month (weekly roster, a single-date change wins).

## In the manager app

- **Accounting → Client approvals** (`renderClientApprovals(period)`, `#accSecApprovals`; only for a month period — This Month or a past month — and not for a pay-only HR): the clients that have an active client login or an approval this month, with their hours, status (Approved / Waiting for the client / Disputed / **Changed after approval**), who approved and when, and each disputed day (worker, date, comment). "Changed" compares `clientShiftLines(cid, month)` with the approved snapshot — the same lines the portal builds. Reads `clientApprovalsOf(t, month)` (`firestore-backend.js`).
- The accountant report (a month) adds a sheet **Client approvals** (client, status, approved by, when, disputed days).
