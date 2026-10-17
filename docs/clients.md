# Clients

Clients (sites/objects where workers work): the Clients tab, the client modal, the map picker, billing rates and the manual punch. Code is in `schedule-manager.html`.

## Data: the client record

Global `clients` array. It is saved with the schedule; each client is one document `tenants/{t}/clients/{id}`.

| Field | Meaning |
|---|---|
| `id`, `name`, `color` (from `CLIENT_COLORS`) | |
| `companyNumber` | ח.פ, plain text (leading zeros kept) |
| `object` | object / branch name, shown next to the name |
| `address` | |
| `lat`, `lng`, `radius` (m, default 100), `mapsUrl` | geofence for the worker punch page |
| `defaultHourlyRate`, `defaultOtRate`, `defaultShabbatRate` | **worker pay** default at this client, for workers without a rate of their own (tier 3 of `effectiveRates()`, see [accounting.md](accounting.md)); the client card sets only `defaultHourlyRate` and saves the other two empty (OT / Shabbat by the law) |
| `rateMode` | `tiered` (default), `fixed` or `daily` — how the **client is billed** |
| `billRate`, `billOtRate`, `billShabbatRate` | billing rates for `tiered` (empty OT/Shabbat = law tiers) |
| `fixedBillRate` | billing rate for `fixed` |
| `dailyBillRate` | ₪ per worked shift for `daily` |
| `notes` | old field, no longer shown or edited; kept on the record |

Worker pay and client billing are separate sets of fields. Billing never changes what a worker is paid.

## Clients tab (`#sectionClients`)

A header "Clients N" (`#clientsTitleCount`) with a glass **New** (`openAddClient`); Select (a button, the boxes after a tap) is above the plates (`startClientSelect`, [app-core.md](app-core.md) → Select). `renderClientsPage()` draws a plate per client (redesign stage 8, grid of plates, paged by 10): the client's colour as the bar (no letters avatar), the name with its notices (**No rate** — no billing or worker rate; **Hours waiting** — a pending hours batch for it), "N workers · address", this month's hours at the client (`salaryEntriesFor('month').byClient`) in green, a ⋮ (Edit, Manual punch, Delete) and a swipe left (Edit, Delete). A tap, a double click or a long press opens the editor. **Delete never asks** (`deleteClient(cid, el)` / `deleteClients(ids, els)`): the plate collapses behind the Undo snack and the client is left out meanwhile (`__clientDelPending`); after 5 s it is removed, taken off every worker (`clientIds`, `clientRates`) and the filter, and the page saves. Select's bulk Delete does the same for the picked ones.

## Client modal (`showClientModal(c)`, `#clientModal`)

`openAddClient()` / `openEditClient(cid)` set `editingClientId` and the color, then open the modal. The modal's labels are in Hebrew (per user request 2026-10-04); its layout stays left to right like every other window, and the note under it ("Changes are saved when the window closes" / "The client is created when the window closes") goes through `tr()`. It is an editor of section plates ([app-core.md](app-core.md) → Editors): a head (the client's colour, name, "N workers · Xh this month" — `clientEditorSub` — and a ⋮ with Manual punch and Delete, `deleteClientFromEditor`), then, in the owner's fixed order, **Client** (name — an empty one shows amber — ח.פ), **Place** (address; site / branch and the radius in a pair; a small map, `drawClientMapMini` — the radius as a circle and "150 m", "Tap to pick the place on the map" until a point is set; the map itself is the button — a tap opens the map picker, `openMapPicker`; no separate map button — then the pasted Google Maps link field), **Rates**, **Hours approval** (`clientLoginsHtml`: this client's client logins and their hours ticks from the users cache, editable by the firm admin — a tick is saved at once with `updateUser` (`saveLoginTicks`); "New client login" opens the user form with the role and client set, `newLoginFor`), and a **Save** button (`saveClient()`); closing the window still saves it too.

- **Fields:** שם הלקוח, ח.פ, אתר / סניף, כתובת.
- **Rates block** (mockup 04): "Pay mode" with the billing mode as two buttons; worker pay and what the client pays side by side (₪/שעה inside the fields, no icons); OT / Shabbat inline in tiered mode; the margin figures. The section's summary is "₪45 worker · ₪58 client · hourly" (set by `updateClientMargin`); its Hours approval head shows the client logins and an "N waiting" badge (`clientApprovalAttrs`).
- **Manual punch:** the head's ⋮ of an existing client has Manual punch (`punchFromClientModal`): it saves the window first (as a tap outside does), then opens the manual punch for this client; closing the punch brings the client window back.
- **Saving:** there is no Save button — a tap outside the window saves it (`clientOverlay.__onUserClose` → `saveClient({auto:true})`; a hint line at the bottom says so). A new client without a name is not created; an unchanged client closes without a save.
- **Two rates**: **worker pay** ("שכר העובד", `#cDefRate` → `defaultHourlyRate`) — the regular ₪/h every worker at this client gets unless the worker has an own rate; OT and Shabbat always follow the law from it (saving the card clears an older client's `defaultOtRate` / `defaultShabbatRate`) — and **what the client pays the firm** ("תשלום הלקוח", `#cBillMain`): the main billing rate (`clientBillMain()`: `fixedBillRate` in fixed mode, else `billRate`), typed straight in (`onClientBillMainInput`); never changes a worker's pay.
- **By the hour / By the day** (`#cPayUnit` → `setClientPayUnit`): by the day (`daily`) hides the hourly fields and shows "Client pays per day" (`#cBillDaily` → `dailyBillRate`): `clientBillPay` bills that sum once for each shift with hours, whatever their length; by the hour goes back to the hourly mode last picked (`__cBill.hourMode`).
- **Client billing mode** (by the hour; `#cRateMode`, two buttons → `setClientRateMode`):
  - `tiered` ("לפי החוק (נוספות + שבת)") — the regular rate is `#cBillMain` (`billRate`); OT and Shabbat (`#cBillOt`, `#cBillShab` → `billOtRate`, `billShabbatRate`) sit in the form under the buttons, empty = by law (the placeholder shows the law's figure from the regular rate, `PAY_RULES.otMult` / `shabbatMult`);
  - `fixed` ("קבוע") — `#cBillMain` is one flat ₪/h (`fixedBillRate`), the OT / Shabbat row is hidden;
  - values are kept in `__cBill` while the modal is open (`syncClientBillFields()` refreshes the main field, the placeholders and the margin); `__cBill.billRate` falls back to `defaultHourlyRate` for clients saved before `billRate` existed.
- **Margin** (`#cBillMargin`, `updateClientMargin()`): three figures — what the client pays minus the worker pay per regular hour in ₪, the same in % of the client's rate ("Margin"), and, for a saved client, what it is billed this month (`salaryEntriesFor('month').byClient`, "This month"); green, red ("הפסד לשעה") when the client pays less; hidden while either rate is empty.
- **Geolocation:** set it on the map (below), by pasting a Google Maps link (`parseGoogleMapsUrl()` understands `@lat,lng`, `?q=`, `?ll=`, `/lat,lng` and a plain `lat, lng`), The coordinates are hidden inputs (`cLat`, `cLng`) filled by those two — there are no Latitude / Longitude fields to type; only the radius (`cRadius`) is typed. `updateLocStatus()` / `locSetHtml()` show the result ("המיקום נקבע: lat, lng").
- **No color picker:** a new client gets the next `CLIENT_COLORS` color automatically (`openAddClient`); an edited one keeps its color.

`saveClient()` builds the record from the fields plus `__cBill`. It updates in place or pushes a new client (`uid()`), then saves. `deleteClient(cid)` removes the client, removes its id from every worker's `clientIds` and `clientRates`, clears the Schedule sidebar filter if it was this client, and saves.

## Map picker (`openMapPicker()`, `#mapPickOverlay`)

- **Loading:** `GOOGLE_MAPS_API_KEY` is a browser key restricted to the app's domains. Without it, the button opens Google Maps in a new tab so a link can be pasted back. The Maps script loads on first use (`loadGoogleMaps()`); `window.gm_authFailure` toasts when the key is rejected.
- **Map:**
  - it starts at the saved coordinates, or geocodes the address/name (`region:'il'`), or falls back to Tel Aviv (`MAP_PICK_DEFAULT_CENTER`);
  - the classic `Marker` is draggable and a tap on the map moves it;
  - a `Circle` shows the radius.
- **Search box:** `PlaceAutocompleteElement` limited to Israel. It handles both `gmp-select` and the older `gmp-placeselect` event.
- **Helpers:** `mapPickSetPos(lat,lng,recenter)`, `mapPickSetRadius(v)`, `mapPickUseMyLocation()` (device GPS).
- **Saving:** `saveMapPick()` writes lat/lng (6 decimals), the radius and a `https://www.google.com/maps?q=lat,lng` link back into the modal.

## Manual punch (client window → החתמה ידנית)

- `openManualPunch(cid)` opens `#manualPunchOverlay`: a worker select (workers assigned to this client, or everyone if none), IN/OUT (`setMpType`), date, time and a note.
- `saveManualPunch(cid)` creates the punch `{id: Date.now(), workerId, workerName, type, time, date (en-GB), ts, site, clientId, dist:null, gpsVerified:false, manual:true, notes, gpsWarnings:['Manual entry by manager']}`. It adds the punch to the local punch log and sends it to Firestore with `gsSavePunch()` (see [app-core.md](app-core.md)).
- `openPunchClock(cid)` (stores the client in `localStorage.punchClockSite` and opens `worker-punch.html`) is defined but has no caller.

## Where clients are used elsewhere

- **Schedule sidebar:** `renderSidebarClients()` filters the roster by client (`selectedClientId`) and sorts by name or worker count (`#clientSort`).
- **Workers:** assigned with the chip picker in the worker modal ([workers.md](workers.md)).
- **Pay and billing:** `effectiveRates()` and `clientBillPay()`, and the Accounting rate matrix and "Billable by client" table ([accounting.md](accounting.md)).
- **Punch page:** the geofence ([punch.md](punch.md)).
- **Supplier portal:** sees a client only as `{id, name, object}` ([supplier-portal.md](supplier-portal.md)).
- **Isolation:** no client-facing surface ever shows supplier data.
