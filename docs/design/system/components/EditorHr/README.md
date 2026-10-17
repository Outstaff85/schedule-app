The HR / user editor: one form for every login of a firm (Staff, HR, Supplier, Client). It is opened from Admin → Users; only the owner and the super-admin use it.

## Head
The avatar in the role's color with the initials, the full name (updates as you type), a one-line summary such as "HR · 14 own workers", a role pill under it, and for a saved login a ⋮ with **Delete**.

## Sections, in this order
1. **Person & login:** full name (required for HR; it is what the header and the list show) and phone in a pair; username and password in a pair; the **Role** switch (Staff / HR / Supplier / Client) at the end. Editing: the username is locked; the password reads "New password (empty = keep)", and a new one ends the user's sessions.
2. **Access** changes with the role:
   - Staff and HR: **Sections** as tick tiles with the icon and name of the tab or button each opens (Schedule, Workers, Clients, Suppliers, Accounting, Export). HR also has the tile "Edit own workers' pay"; picking HR ticks only Workers by default.
   - Supplier: a supplier select and its portal tabs (Dashboard, My Workers, My Hours).
   - Client: a client select and its portal ticks.
3. **Hours** (HR, Supplier, Client): tick tiles Hours, Approve, Dispute, Fix, Schedule, Export, and **Only own workers** at the bottom. An HR may untick it; for a supplier and a client it is locked on.
4. **HR commission** (HR, editing): commission rate per hour and per day; it is the HR's own figure and never changes a worker's pay.
5. **Own workers** (HR and Supplier, editing only): the workers that belong to this login, paged, each with **Unassign**, and **Add workers**, a picker with search and checkboxes where a worker of another HR or supplier is marked "now: <name>".

## Behaviour
- One primary **Save** at the end. A change of role, sections or "Only own workers" makes the user sign in again; a former HR's workers are unassigned when the role changes.
- An owner's row shows only name, phone and password.
- An HR with "Only own workers" on sees only its workers and their punches, and never gets the Today or Admin tabs.
