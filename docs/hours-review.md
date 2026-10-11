# Hours review (`hours-review.js`, the `hours` function)

One screen, one Cloud Function and one store for every login that reviews its workers' hours: a **client** (in the client portal), a **supplier** (the supplier portal's Hours approval tab) and an **HR** (the manager app, Accounting). The same ticks, the same per-day actions, the same code (per user request 2026-10-11: "one template and one set of functions for hours").

## Ticks (`users.hourPerms` → claim `hp`)

`HOUR_PERMS` in `functions-auth/core.py` (and `HOUR_PERM_LABELS` in the manager app):

- **hours** — see the month's shifts (in / out / hours per day);
- **approve** — approve a day, or the whole month at once;
- **dispute** — dispute a day with a comment;
- **fix** — propose the right in / out of a day (with a comment); applied only when a manager accepts it;
- **schedule** — the workers' planned shifts;
- **export** — the month to Excel.

Set in Admin → Users, in the user form's **Hours** block (`.userFormHourPermCb`, `setUserFormHourPerms`), shown for HR, supplier and client (`HOUR_ROLES`). A new HR, supplier or client login starts with `HOUR_DEFAULT` (hours, approve, dispute, fix — the form pre-ticks them); a login with no ticks stored (made before `hourPerms`) gets the same (`claims_for`, `_stored_hour_perms` in `list_users`), except a client made before then, whose old `permissions` list are its ticks. Ticks set to none stay none. The login reply and the Users list carry `hourPerms`; a change ends the user's sessions like any rights change. The pages read the ticks from the ID token (`firestore-backend.js` `hourPerms()`).

Whose workers: a client — the workers at its site (`punches.clientId`); a supplier — its own (`workers.supplierId`); an HR — the workers assigned to it (`workers.hrId`), or every worker of the firm when its "Only own workers" is off (claim `own`). "Only own workers" closes the user form: an HR may untick it, a supplier and a client always have it on (locked).

## The `hours` function (`functions-auth/hours.py` → `hours_action(db, caller, body)`)

`caller` = the ID token's `uid, role, tenantId, clientId, supplierId, own, hp, perms` (`main.py`). A superadmin passes `tenantId` in the body. `scope_of(caller)` gives `(kind, ownerId)`: `client`/clientId, `supplier`/supplierId, `hr`/uid; any other role → "Not available for this login". A missing tick → "Not allowed for this login". Never returns a wage, a rate, a supplier, GPS, notes, documents or a token.

- `load {month}` → `{owner: {kind, id, name, object}, perms, month, workers, punches?, days?}` — `workers` `{id, name}` (+ `schedule` / `dates` with the schedule tick, `portal._week` / `_dates`; a worker who worked here this month and has since moved is listed too); with the hours tick, the scope's `punches` of the month with a day of margin (`{id, workerId, type, time, date, ts}`) and `days` (the stored day entries).
- `approve {month, lines}` → each line `"<worker>|<day>|<ins>|<outs>"` (a day's shifts comma-joined; ≤ 3000, the scope's workers only) stored as `approved`.
- `dispute {month, workerId, day, line, comment}` → `disputed` with the comment; an empty comment takes a dispute back.
- `fix {month, workerId, day, line, shift?, inT, outT, comment}` → `fix` (HH:MM checked); `shift` picks one of the day's shifts (0 = the first; out of range → "Bad shift"), stored with its old times `oldIn` / `oldOut`, which the accept looks for; the day's line then gets that shift's new times.
- Managers only (`_is_manager`: owner, super-admin, staff with Accounting): `list {month}` → every login's document of the month; `resolve {docId, key, accept}` → a proposed fix accepted (the shift's in / out punches matching the old line get the new times as Israel time — an out before the in moves to the next day; `editedBy: 'approval'`; status `fixed`, the line updated) or rejected (`rejected`); `resolvedBy` / `resolvedAt` stored. A shift whose punches can't be matched (several shifts, edited since) → "edit them in the punch log".

Store: `tenants/{t}/hourApprovals/{kind}_{ownerId}_{YYYY-MM}` = `{kind, ownerId, ownerName, month, days: {"<workerId>|<YYYY-MM-DD>": {status, line, comment?, inT?, outT?, byName, at, resolvedBy?, resolvedAt?}}}` — written only by the function; managers read it (`firestore.rules`).

## The screen (`hours-review.js`)

Loaded on demand (a `<script>` tag, like `scan-pipeline.js`) and run in the page's global scope; it uses the page's own `esc`, `tr`, `uiLocale`, `localYMD`, `showToast`, `closeModal`, `loadXlsx`, `groupPunchesIntoShifts` / `analyzeDayPunches`. `hoursReviewMount(el, {call, hideOwner})` draws into `el`; `call(body)` posts to the `hours` function with the page's ID token (`hoursCall`). `hoursReviewReload()` reloads; the pages add `hours-review.js` to `startVersionWatch` once loaded.

- Month arrows (no future months) and tabs **Hours** / **Schedule**, each with its tick.
- **Hours**: `hrvMonthDays()` pairs the punches like the app and groups them by worker and day (a day may hold several shifts); a card per worker, a row per day: its state icon, date, times, hours and the actions — ✓ approve the day, ⚠ dispute, ✎ propose a fix (a day with several shifts first asks which shift, `hrvFixShiftPicked`). The workers come 10 at a time ("Show more", `hrvMore`, also when it scrolls into view). The windows have no Save button: closing one sends (dispute: empty = take it back; fix: only when a time differs from the punches).
- A day's state (`hrvDayState`): its stored status, or **changed** when an approved / fixed day's line no longer matches its shifts. States: waiting, approved, fix accepted, changed after approval, disputed, fix proposed, fix rejected (`HRV_STATES`).
- Figures on top (`.hrv-stats`: approved, waiting, disputed or changed, fixes proposed); a worker is a section line and each day a line with its state as a colored mark on the left (template 3).
- The status bar counts the days ("N of M days approved", changed, disputed, fixes waiting); "Approve the month" (`hrvApproveMonth`) approves every day waiting, changed or with a rejected fix — a day under an open dispute or fix stays until the firm answers. "Export" writes `hours-<month>.xlsx` (worker, date, in, out, hours, status).

Where it runs:

- **Client portal** — the whole page ([client-portal.md](client-portal.md)).
- **Supplier portal** — the **Hours approval** tab (`#sectionReview`, `openHoursReview`), shown with an hours or schedule tick.
- **Manager app, an HR login** — Accounting → `#accSecReview` (`openHrHoursReview`), shown with an hours or schedule tick (`hrHourReview()`); such an HR gets the Accounting tab for it even without the Accounting section, and then sees only this part.

## Accounting → Hours approvals (the owner)

`renderHourApprovals(period)` (`#accSecApprovals`, `#hourApprovalsWrap`; a month period only, never for an HR): every login's document of the month (`hourApprovalsOf(month)` → `list`), one card per login (kind: Client / Supplier / HR) with "N of M days approved" and each day that needs a look — disputed (comment), fix proposed (old → new times, comment, **Accept** / **Reject** → `resolveHourFix`), fix rejected, changed after approval. "Changed" and the day count come from `hourDayLines(doc, month)`: the scope's punches in the owner's punch log paired into the same lines as the review (supplier: its workers; HR: its workers, or all when its own-only is off; client: punches at the client). After an accept the punch listener brings the moved punches.

The accountant report (a month) has a sheet **Hours approvals**: login, role, worker, date, status, proposed fix, comment, by, when.
