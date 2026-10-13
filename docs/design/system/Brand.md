# Brand, greeting and notifications

## Name and logo
The app is called **Interactive Manager** ("Manager" in a soft indigo → cyan text gradient). Under it, small, two lines: "Connecting people and business" (ink-2) and "Everything under one roof" (soft green).

The mark is **11C "Under one roof"**: a light roof line (a chevron), three people under it in indigo, cyan and pink, and a short connection line beneath them. A gradient light runs over the roof again and again; each person lights up and lifts a little as the light passes over them; a light also runs along the connection line — people connected to the business. Seamless loop, no jumps. The same mark on the blob ground is the app icon (PWA). Where a phone header is tight, the mark shows without the words.

## Greeting
Under the header of the manager app and on the punch page: "Good morning / Good afternoon / Good evening / Good night, <first name>", chosen by the device's local time — morning 5–12, afternoon 12–17, evening 17–21, night 21–5. No box and no summary line: just the words (21px, bold) with a small animated icon right after the name (about the size of a capital letter): morning — a sun rising over a horizon line, afternoon — a full sun with slowly turning rays, evening — a pink sun setting behind the horizon, night — a floating crescent moon with two twinkling stars; a short gradient line under the words. The day's figures and the shift are shown below it already, so the greeting does not repeat them. The texts are English and go through the dictionaries.

## Notifications (managers)
A glass bell in the header with a red count that pulses; the bell swings now and then while there is something new. A tap opens a glass panel with a tail: newest first, each line with an icon in its importance color (red urgent, amber attention, green done), a title, one detail line and the time; unread ones carry a glowing cyan dot. "Mark all read" at the top. A tap on a line opens what it is about (the worker, the hours, the client).

## Punch button (chosen: hold)
The round glass Punch button works by **holding** it about one second; the colour always says what will happen:
- **Punch in** — green: green dot before the words, green-tinted face and border, a green ring fills while held, green glow.
- **Punch out** — red: red dot, red-tinted face and border, a red-to-pink ring, red glow.
While held the face presses in and glows; a short vibration on press. Let go early and the ring rolls back — nothing is sent. When the ring closes the face flashes its colour, a check draws, a vibration confirms, and the line under it reads in the same colour: "Punched in at 07:58 · have a good shift" (green) or "Punched out at 17:04 · 8h 04m today" (red). Then the button turns to the other action. The label under the words: "hold to punch".
Works with touch: the button takes the whole gesture (no page scroll, no long-press menu or text selection while held).

## Punch page: no ⋮
The punch page has no ⋮ menu. Everything is on the main screen: one Language button at the top right (a globe and the current language name; a tap opens a bottom sheet with every language in its own script plus its English name, a search field, the current one ticked — however many languages are added, the screen keeps one button); under the greeting a plate "Your schedule was updated · View" when the manager changed shifts; under the Punch button two large glass tiles — "My Schedule" (the next shift; an "Updated" tag when something changed) and "My Hours" (this month's hours in soft green). A tap on a tile opens the schedule or the hours.

## Language
One Language button everywhere (see the LanguageButton component): globe + the current language's own name + chevron, top right on every page; a tap opens the same sheet with search and the full list. New languages come only from the dictionaries.

## Punch page windows: My Schedule, My Hours
A tap on a tile opens a full-height glass sheet (swipe down or tap outside to close) with the tile's icon and title.
- **My Schedule:** month switcher (‹ October 2026 ›); two figures (work days, planned hours, in soft green); a month calendar of soft tiles — green work, blue night shift, amber off, a glowing cyan dot on a day the manager changed, today ringed with the gradient line; a legend; then day plates (date block, site · time, "This date only · changed", "Night shift — ends the next day", hours at the right); the note "Your manager plans this schedule; changes show here at once."
- **My Hours:** month switcher; figures (days worked, hours worked); a plate per shift (date, site, in–out, hours at the right; the current one cyan "on shift"); a tap opens its punches — IN / OUT pills, time, site and GPS distance; then a Pay card (regular, overtime, Shabbat, Total in green, total with travel) and the note "An estimate before deductions — your payslip is the final figure."

## Weather in the greeting (planned)
The greeting icon can follow the real weather: clear (sun or moon by time of day), clouds, rain, thunder, snow, fog — same small animated style — with the temperature next to it ("Good morning, Avi 🌧 14°"). Source: OpenWeatherMap (free tier, 1,000 calls a day) through our own Cloud Function, the key in Secret Manager, never in the page. Location: the worker's site coordinates on the punch page (no extra permission), the firm's main site for managers. The answer is cached 30 minutes per area, so a firm uses a few dozen calls a day. If the weather can't be read, the time-of-day icon shows.
