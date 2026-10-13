# Editors

Every edit window (worker, client, supplier, HR / user) has the same shape: a bottom sheet on a phone (a centered window on a computer), the header with the avatar, full name, a one-line summary and notice chips, the scan button where documents can be read, and ⋮ for the rest (delete, archive, punch link).

The body is a stack of **section plates**: a solid plate with an icon, a title and a one-line summary of what is filled in, and a colored left bar and an icon in the same color — `green` complete, `amber` something missing, `red` urgent (an expired document). A tap opens the plate; the flowing gradient line runs under an open plate's title. Inside: short fields in pairs, long fields alone, a missing field outlined in amber, choices of two to four as a segmented switch with the gradient line, options as tick tiles, documents as small plates with their action (Renew, Upload).

| Editor | Sections |
| --- | --- |
| Worker | Person (Form 101 fields in Hebrew), Address, Work (client, supplier, HR, start date), Documents, Form 101, Access. No Save button: the window saves itself when closed. |
| Client | Client, Place (address, branch, GPS radius on a small map), Rates (hourly / daily, worker and client rate, OT, Shabbat, margin figures), Hours approval (ticks). |
| Supplier | Company, Commission (per hour / per day, figures for the month), Portal login (username, password, what it sees), Workers (mini plates with hours). |
| HR / user | Person & login, Role (Staff / HR / Supplier / Client), Sections (tiles), Hours (ticks, Only own workers), HR commission, Own workers. |

One primary button at the bottom (Save), except the worker editor.
