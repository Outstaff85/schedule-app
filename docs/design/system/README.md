# Odinson Glass

The design system of the Odinson staff scheduling and punch-clock app: frosted glass controls over a dark ground lit by three colour blobs, solid plates for every list, and one animated gradient underline that marks whatever is active.

It is the target for the redesign of every page (manager app, supplier portal, client portal, worker punch page). New screens and changes are built from these tokens and components.

## Content fundamentals

- **Audience:** firm owners, HR, suppliers and clients managing hourly workers; workers punching in on their phones.
- **Language:** every UI text is written in English and goes through the dictionaries (English, Hebrew, Russian); the layout stays left to right in every language. Everything printed into Form 101 is Hebrew.
- **Voice:** short and literal. A control says what it does: "New worker", "Approve the month", "Export". Feedback says what happened: "Avi Cohen deleted", "2 workers deleted".
- **Names first:** a plate leads with the person's name; the subline says where and when ("Site A · 09–17") or what is wrong ("Documents missing", "Visa expired").
- **Numbers:** hours as `182h`, times as `09–17`, in DM Mono where they line up.

## Visual foundations

- **Ground:** a deep `ground` with three soft, wide radial blobs (indigo top left at ~42%, cyan right and pink bottom at ~30%, fading over 52–55%). Calm and dark; the blobs are light, never content.
- **Glass for controls, solid for content.** Buttons, tabs, menus, the Select bar, the Undo snack and sheets are glass (`glass*` tokens + backdrop blur). Plates and tick tiles are solid `plate` so names stay readable.
- **One highlight:** the animated underline, a 3px line in a flowing `uline-1 → uline-2 → uline-3` gradient with a soft glow (`shadow-uline`). It springs in (overshoot) on hover, focus and the active state of buttons, tabs, ⋮ and Undo; the same gradient runs as a 3px line on the left of a hovered menu item and as the Undo timer.
- **Status by the plate bar:** `green` OK, `accent` info, `amber` attention, `red` problem. Never color a whole plate.
- **Shape:** radius-lg (16) for buttons, plates, popovers; radius-md (14) for tabs and ticks; avatars are discs.
- **Motion:** shine across a glass button on tap (600ms); underline spring 450ms `cubic-bezier(.34,1.56,.64,1)`; slides 300ms `cubic-bezier(.3,.7,.3,1)`; check mark draws in 350ms; gradient flow loops every 2.4s. All of it stops under `prefers-reduced-motion`.

## Rules

1. **One primary button per screen.** At most one or two glass secondaries next to it; everything else goes under the header ⋮.
2. **Extra actions live under a vertical ⋮** (RowMenu): a glass popover with a tail. Delete is always last, in `red-soft`, under a hairline.
3. **Every list is plates.** Tap reads (opens the card), double click / long press edits, swipe left reveals Edit / Delete.
4. **Every list can Select.** Header ⋮ → Select… turns on SelectMode: drawn-tick boxes, Select all, glass bulk bar.
5. **Delete with Undo,** never a confirm dialog: the plate collapses, the UndoSnack runs 5 seconds.
6. **Checkboxes are tick tiles** whose check draws itself.
7. **Windows are bottom sheets on a phone**, closed by the backdrop or a swipe down; no close buttons.
8. **Lists page by 10;** totals always cover every item.

## Iconography

Tabler Icons, outline, stroke 2 (1.9 in menus), 17–18px, color `currentColor`; the app self-hosts only the subset it uses. Icons sit left of the label in buttons and menu items; an icon-only button carries an `aria-label`. ⋮ is the vertical dots glyph.

## Typography

DM Sans for everything, DM Mono for hours and amounts; Heebo backs DM Sans for Hebrew. Screen title 19/600, plate name 15/600, controls 14/600, subline 12/400, section labels 11/600 uppercase with 0.12em tracking.

## Accessibility

- Text on glass and plates is `ink` (white) or `ink-2`; `ink-3` is for borders and disabled marks only.
- The blobs sit under glass, never under bare body text.
- Focus shows the underline plus a 2px `uline-2` outline.
