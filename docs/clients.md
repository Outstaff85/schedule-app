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
| `defaultHourlyRate`, `defaultOtRate`, `defaultShabbatRate` | **worker pay** default at this client, for workers without a rate of their own (tier 3 of `effectiveRates()`, see [accounting.md](accounting.md)) |
| `rateMode` | `tiered` (default) or `fixed` — how the **client is billed** |
| `billRate`, `billOtRate`, `billShabbatRate` | billing rates for `tiered` (empty OT/Shabbat = law tiers) |
| `fixedBillRate` | billing rate for `fixed` |
| `notes` | old field, no longer shown or edited; kept on the record |

Worker pay and client billing are separate sets of fields. Billing never changes what a worker is paid.

## Clients tab (`#sectionClients`)

`renderClientsPage()` draws a card per client in `#clientsGrid`. Each card shows the name, ח.פ, object, address and the names of the assigned workers (workers whose `clientIds` include it), with two buttons: **Punch Clock** (manual punch) and **Remove**. A tap anywhere else on the card opens its edit form (`isPlainTap` → `openEditClient`).

## Client modal (`showClientModal(c)`, `#clientModal`)

`openAddClient()` / `openEditClient(cid)` set `editingClientId` and the color, then open the modal. The modal and its billing-rate popup are in Hebrew, right to left (per user request 2026-10-04).

- **Fields:** שם הלקוח, ח.פ, אתר / סניף, כתובת.
- **Worker pay at this client** ("שכר העובד אצל לקוח זה"): the three default rates (Regular / OT / Shabbat) every worker at this client gets unless the worker has an own rate for it.
- **What the client pays the firm** ("תשלום הלקוח לחברה") — the billing mode below; never changes a worker's pay.
- **Client billing mode** (`#cRateMode`):
  - picking a mode (`onClientRateModeChange()`) opens the billing-rate popup at once (`openClientBillRatePopup(true)`):
    - `fixed` → one flat ₪/h (`cbFixed`);
    - `tiered` → Regular / OT / Shabbat (`cbReg`, `cbOt`, `cbShab`);
  - values are kept in `__cBill` while the modal is open, summarized by `clientBillSummary()`, and edited again through "עריכה";
  - `saveClientBillRatePopup()` stores them;
  - `cancelClientBillRatePopup(true)` (cancelling a popup opened by a mode switch) puts the previous mode back (`__cBillPrevMode`);
  - `__cBill.billRate` falls back to `defaultHourlyRate` for clients saved before `billRate` existed.
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

## Manual punch (client card → Punch Clock)

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
