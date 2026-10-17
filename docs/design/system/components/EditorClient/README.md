The client editor: where a firm sets up a client site, what its workers are paid there and what the client is billed. The window is in Hebrew and right to left, the only editor that is.

## Head
The client's color, name, "N workers · Xh this month" and a ⋮ with **Manual punch** (saves the window first, then opens the manual punch for this client) and **Delete**.

## Sections, in this order
1. **Client:** name (an empty one is outlined in amber) and company number (ח.פ).
2. **Place:** address; site / branch and the GPS radius in a pair; a small map that draws the radius as a circle with "150 m" (or "Tap to pick the place on the map" until a point is set). The map itself is the button that opens the map picker. Below it a field for a pasted Google Maps link. Coordinates are never typed; only the radius is.
3. **Rates:**
   - Pay unit: by the hour or by the day. By the day shows one field, "Client pays per day", billed once for every shift with hours.
   - Worker pay: the regular ₪/h every worker at this client gets unless the worker has an own rate. Overtime and Shabbat follow the law from it.
   - What the client pays the firm, beside it, with ₪/h inside the field.
   - Billing mode as two buttons: **Tiered** (by law: OT and Shabbat fields appear, empty means the law's figure shown as a placeholder) or **Fixed** (one flat rate, OT row hidden).
   - Margin figures: per regular hour in ₪ and in %, and what is billed this month; green, or red ("loss per hour") when the client pays less than the worker costs. Hidden while either rate is empty.
   - The section's summary line reads like "₪45 worker · ₪58 client · hourly".
4. **Hours approval:** the client logins of this client with their ticks (Hours, Approve, Dispute, Schedule, Export), editable by the firm owner; a tick saves at once. An "N waiting" badge shows hours waiting for the client. **New client login** opens the user editor with the role and client already set.

## Behaviour
- A tap outside the window saves it; there is a Save button at the bottom as well. A new client without a name is not created; an unchanged client closes without saving.
- A new client gets the next color from the palette automatically; there is no color picker.
- Deleting a client removes it from every worker; billing and pay figures stay separate and a client rate never changes a worker's pay.
