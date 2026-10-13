A list line: solid plate, colored 4px bar on the left, name and subline, figure and ⋮ on the right. Every list in the app is made of plates.

## Anatomy
- Fill `plate` (solid, readable over the blobs), radius-lg, 8px between plates.
- Bar (inset 4px) is the status color: `green` OK, `accent` info / night shift, `amber` attention, `red` problem. Pass it as `--bar`.
- No letters avatar: the plate starts with the name. An icon (a firm, an alert, a document) sits in the bar's color.
- **Full name,** cut with … when it does not fit; it never runs under the chips or the figure.
- **Notices:** the first chip on its own line under the name, "+N" after the name: small chips for everything that concerns the worker (visa, missing documents, contract ending, no punch today…): red = urgent, amber = attention. One chip with its word plus "+N" for the rest. A tap on a chip opens the notices window (a bottom sheet: avatar, full name, site, today's punch, hours; one plate per notice with its action: Renew, Upload, Extend, Call; "Open worker card" at the end).
- **Under the name:** the site and today's punch, short: "Site A · ● In 07:58" (green), "● No punch" (red), "Out 22:00", "On vacation".
- **Right side:** the total hours this month in DM Mono 15px/500, one light, soft green (#9fe6c0); the same green for shift times in the open Schedule days and for money figures, no box, vertically centered, directly left of the ⋮; the ⋮ is a bare glyph (no box), 22px regular weight (thin dots), light ink.

## Behaviour
- **Tap** opens the item's card; **double click / long press** opens its edit form (app rule).
- **Swipe left** reveals Edit and Delete (128px, snaps open past half); tapping elsewhere closes it.
- Delete never asks: the plate collapses and the UndoSnack appears.
- Lists page by 10 (Show more at the end).
