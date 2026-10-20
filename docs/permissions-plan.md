# Permissions plan — one flat list of rights, templates only

The approved plan for a login's rights (owner, 2026-10-19), stage by stage, with each stage's status. What is built today is in [admin.md](admin.md) → Users pane (the templates), [hr.md](hr.md), [supplier-portal.md](supplier-portal.md) and [client-portal.md](client-portal.md); this file is the target and the way there.

## The rules (owner's)

- **Rights are not tangled.** Every right means exactly one thing and depends on no other. One tab tick opens one tab; nothing else opens it.
- **Templates are global.** One set for every firm; a change reaches every login on it in every firm (done — [admin.md](admin.md) → Users pane).
- **Only the super-admin and the firm's admin choose rights.** The super-admin creates, edits and deletes the templates (picks the ticks); the firm's admin (`tenant_admin`) puts each of its logins on a template and, for a supplier or client login, picks which supplier or client. No other role ever picks ticks or templates — the server refuses it, the Users section is not shown to them.
- **A role grants nothing by itself.** Everything a login may do comes from its template; the template also says *whose workers* the login works with (below). After stage 1 the role is part of the template, not a separate choice.

## The list of rights (target)

**Tabs** — one tick, one tab:
Today · Schedule · Workers · Clients · Suppliers · Accounting · Punch log · Commission · Hours

**Actions:**
Edit shifts · Edit workers · Edit / delete punches · Edit pay · Export · Approve hours · Dispute hours · Fix hours · Set the signing date (`setSignDate`, docs/contracts.md → Signing: the date printed on Form 101 and the contract; staff and HR templates may have it, off by default — not in Full access; the owner and the super-admin always may; the `sign_documents` function refuses a whole send with a date from a login without it)

**What is shown:**
See workers' pay (rates and pay). Its own commission is what the Commission tab shows, so it needs no tick of its own.

**Whose workers** (one choice per template, not a tick):
all of the firm's · assigned to this login · its supplier's · at its client's site

**One cap:** a supplier's or client's template can't get the ticks whose data those logins must never receive — Clients, Accounting, Punch log for both, every money tick for a client (CLAUDE.md → Firm data isolation). The template window shows them greyed with the reason; the server refuses them too.

**The two new tabs:**
- **Commission** (HR, supplier): its own workers for the period picked — hours, days, the rate (₪/h or ₪/day), the pay (with See workers' pay) and its own commission, each worker and the total, export. One screen for both roles: an HR reads its workers through the Firestore rules (it may see the whole worker record), a supplier through the `supplier` function (the rules can't hide single fields — a token, file links, GPS, a client's bill rate — so the function sends an allow-listed copy). Hours, pay and commission are worked out by the same code in the browser for both (`src/lib/payroll.ts`), never on the server — no second calculation.
- **Hours** (HR, supplier, client): approve, dispute, fix by day and sign the month — the shared hours review screen (`src/hours-review/`), no money; a client gets only this tab.

With them an HR no longer needs the reduced Accounting (`hrPayOnly`): Accounting is only the full tab, for the owner and logins with that tick.

## Stages

Each stage is its own PR, merged only with the owner's OK.

1. **The flat list of rights** — the server's rights and claims, the Firestore rules' checks, the template window and Who gets what on the new list; the role becomes part of the template. Every login's and template's current rights are converted one to one, so nothing changes on the day it ships; the super-admin then sets the ticks once in each template. — *done* (2026-10-19). How it is built: [admin.md](admin.md) → Permission templates. Templates and logins keep `rights` (the flat list; the old fields that were worked out from it are gone — Done after the plan). In the app, a staff login's Today and Punch log are their own ticks and its pay edits need Edit pay. Whose workers for a supplier / client is fixed (its own). The user window has no role switch: the template picked says the role.
2. **The Commission and Hours tabs** in the manager app; an HR moves to them, its reduced Accounting goes. — *done* (2026-10-19) for an HR: Commission is the Accounting tab's pay view for its own workers (`#commissionRoot`), Hours the shared hours review (`#hoursRoot`); an HR never gets the Accounting tab ([accounting.md](accounting.md)). The supplier's use of the same tabs comes with stage 3.
3. **The supplier and the client inside the manager app** — after the sign-in a supplier or client stays in the manager app with the same frame, its tabs from the new list (a supplier: Today as its dashboard, Workers, Commission, Hours; a client: Hours), its data still only through the `supplier` / `hours` functions (no direct Firestore read; a browser check proves it); `/supplier` and `/client` send to the manager app. No Firestore rule changes. — *done* (2026-10-19): `startPortal` (`src/manager/page/gate.ts`), `portalTabs` (`src/manager/portal.ts`), `PortalView` (`src/manager/Portal.tsx`, the portals' own screens); the manager page and the portal screens share one load of `firestore-backend.js` (`window.__fsBackendLoad`); the browser check counts no Firestore request for a supplier.
4. **Cleanup** — the portals' pages and entries removed; `/supplier` and `/client` stay as small redirect pages (bookmarks, installed apps); docs and tests. — *done* (2026-10-19): `src/client/`, `src/supplier/App.tsx` and `main.tsx` removed; `client-portal.html` / `supplier-portal.html` are static pages (copied, checked by `tests/build/check.js`) that send to `/schedule-manager.html`; the service worker no longer keeps them (`schedule-mgr-v135`).

Unchanged throughout: the worker punch page (`/punch`), the `supplier` and `hours` functions, and every limit on what a supplier or client may see.

## Done before this plan

- Global permission templates, linked to their logins, edited only by the super-admin; Put them on templates; Full access among the defaults (PR #293).
- The edit ticks (Edit shifts, Edit workers, Edit / delete punches) enforced by the rules, and Who gets what (PR #294).
- **One place for logins** (owner, 2026-10-19): every login is made and changed only in Admin → Users (the user window, its template); the client and supplier windows have no login section any more. Add workers there gives an HR or a supplier its own workers. A worker has no login: its access is the punch link (the worker window's Access section).

## Done after the plan

- **The rules and the functions read the flat rights** (owner, 2026-10-19): every token carries the flat list (claim `rt`); `firestore.rules` / `storage.rules` check one right per check (`can(k)`), the functions read `core.caller_rights`, the manager app `session.rights`. One untangling came with it: a staff login writes workers with the Workers or the Schedule tab and its edit rights, clients with the Clients tab, suppliers with the Suppliers tab (before: all of them with the schedule section).
- **The old rights fields dropped** (owner, 2026-10-20: "do it now", everyone signs in once more): logins and templates keep only `rights` (and an HR's `ownOnly`); `permissions`, `editPerms`, `hourPerms`, `supplierSections`, `showPay` and their claims (`perms`, `ed`, `hp`, `ss`, `pay`, `r`) are gone. The first call after the deploy converts every doc that still had them, one to one (`convert_old_rights`, [backend.md](backend.md) → Login); a session signed in before the flat rights (no `rights`, no `rt` claim) is sent to the sign-in by the app. A new login needs a template; a role changes only with a template.

## Not planned now

- **Separate money ticks inside Accounting** (owner, 2026-10-19: not needed for now): real protection would need the rates moved out of the worker and client records; the Commission tab covers what an HR and a supplier need.
- **Own workers for a staff login:** an HR template with Only own workers and no commission does it today.
