# Components of the new stack

The React components every new page is built from (react-migration-plan.md → stage 1). Two folders:

- `src/components/ui/` — **shadcn/ui** components, restyled once to Odinson Glass. They are the shadcn source (Radix primitives, vaul, sonner, react-day-picker, cmdk, React Hook Form), written into the repo rather than added with `npx shadcn add`: the shadcn registry (`ui.shadcn.com`) is not reachable from the cloud sessions, the npm packages they sit on are. A later `npx shadcn add <name>` from a machine that reaches the registry writes the same files; restyle the result the same way.
- `src/components/shared/` — the app's own template pieces (the old pages' `t3Line`, `renderPagedList`, `undoDelete`, `startSelect`, the bottom bar, the Language button…), built on the ui components.

**Before writing a component, look here first.** A new one is written only when nothing in these two folders fits (CLAUDE.md → New code goes to the new stack). The gallery at `/next` (`src/next/App.tsx`) shows every component in its states; `tests/e2e/next.test.js` checks it on a computer and a phone.

## How they are styled

- **Colours and sizes come from the tokens** (`og.css`, docs/build.md → The tokens in the new stack): Tailwind classes such as `bg-plate`, `text-ink-2`, `text-muted-foreground`, `border-border`, `bg-ok`, `text-fig`, `rounded-lg` (16px). No raw colour or redefined token in a component.
- **What `og.css` already draws is used through its class**, so the old and new pages share one copy of the look: the glass button (`.og-btn`, with its shine and underline), plates (`.og-plate`, `.og-sw`), the ⋮ (`.og-kb`), swipe actions (`.og-acts`), the tick box (`.og-box`), the Undo snack (`.og-snack`), Select's head and bar (`.sel-head`, `.sel-bar`), the underline (`.og-uline`), the Language button and list (`.lang-btn`, `.lang-li`, `.lang-search`).
- **Surfaces as Tailwind utilities** (`src/styles/globals.css`): `og-glass-menu` (popovers, menus, toasts), `og-glass-sheet` (windows), `og-field` (a window's input: 38px, faint glass, cyan focus ring, red when `aria-invalid`), `og-label` (11/600 uppercase section label).
- `og.css` is not in a cascade layer, so it wins over Tailwind's utilities: to change an `og.css` property on such an element, the Tailwind class needs `!` (e.g. `!h-[34px]` on a small button).
- **Icons:** Tabler Icons from `@tabler/icons-react` (`<IconPencil />`), sized by the component (17–18px). The old pages keep the self-hosted subset (`icons/`).
- **Motion:** `motion/react` for heights that open and close (Section, a plate's details) and a removed plate collapsing (`AnimatePresence`); the rest are CSS (`tw-animate-css`'s `animate-in` / `animate-out`, the og.css keyframes `og-flow` / `og-pop`). All of it stops under `prefers-reduced-motion` (og.css).
- **Texts:** every UI text through `tr()` (`src/lib/i18n.tsx`, docs/translations.md → New stack); data (names, sites) never.

## ui (`src/components/ui/`)

| File | Exports | Notes |
|---|---|---|
| `button.tsx` | `Button`, `buttonVariants` | the GlassButton: `variant` default (glass) · `primary` (one per screen) · `danger` (red-soft) · `ghost`; `size` default (42px) · `sm` (34px) · `icon` · `icon-sm`; `on` keeps the underline; a create button adds `og-new`; the shine runs on every tap |
| `input.tsx`, `textarea.tsx`, `label.tsx` | `Input`, `Textarea`, `Label` | `og-field`; a long text fills its line |
| `badge.tsx` | `Badge` | chips and status pills: default · `ok` · `info` · `warn` · `bad` |
| `card.tsx` | `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardAction`, `CardContent`, `CardFooter` | a solid plate block that is not a list line (a pay card) |
| `separator.tsx`, `skeleton.tsx`, `spinner.tsx`, `progress.tsx` | `Separator`, `Skeleton`, `Spinner`, `Progress` | the progress bar is the flowing highlight gradient |
| `alert.tsx` | `Alert`, `AlertTitle`, `AlertDescription` | a notice plate; the status is its bar (`ok` · `info` · `warn` · `bad`), never a fill |
| `empty.tsx` | `Empty`, `EmptyMedia`, `EmptyTitle`, `EmptyDescription`, `EmptyContent` | an empty list with its one action |
| `checkbox.tsx` | `Checkbox`, `CheckTile`, `CheckGrid` | the drawn-tick box; `CheckTile` (the whole tile is the hit area, `hint`, `wide`) in a `CheckGrid` is how every set of checkboxes looks (CLAUDE.md → Checkboxes are tiles) |
| `switch.tsx`, `radio-group.tsx` | `Switch`, `RadioGroup`, `RadioGroupItem` | green when on / chosen |
| `select.tsx` | `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem`, `SelectGroup`, `SelectLabel`, `SelectSeparator` | the trigger is an `og-field`, the list menu glass with the gradient line on the hovered item |
| `combobox.tsx`, `command.tsx` | `Combobox` (`options`, `value`, `onChange`); `Command*` | a select with a search (substring of the label and hint); the chosen line ticked like the language list |
| `date-picker.tsx`, `calendar.tsx` | `DatePicker` (`value` / `onChange` as `YYYY-MM-DD`), `Calendar` | replaces every `type="date"` field; shows `dd/mm/yyyy`; month and weekday names in the chosen language; the week starts on Sunday |
| `tabs.tsx` | `Tabs`, `TabsList`, `TabsTrigger` (`count` → red pill), `TabsContent` | glass pills, the underline under the active one; up to 4 |
| `toggle-group.tsx` | `ToggleGroup`, `ToggleGroupItem` | the segmented switch of a window (Info / Docs / Hours, ₪/h or ₪/day) |
| `button-group.tsx` | `ButtonGroup` (`attached`) | buttons that belong together |
| `accordion.tsx`, `collapsible.tsx` | `Accordion*` (`AccordionItem color`, `AccordionTrigger icon summary badge`), `Collapsible*` | the accordion is the editor's section plates (Editors.md) |
| `tooltip.tsx`, `scroll-area.tsx` | `Tooltip*`, `TooltipProvider`, `ScrollArea`, `ScrollBar` | |
| `popover.tsx`, `dropdown-menu.tsx` | `Popover*` (`tail`), `DropdownMenu*` (`DropdownMenuItem destructive`) | menu glass with a tail; the dropdown is the RowMenu: Delete last, in red-soft, under a `DropdownMenuSeparator` |
| `dialog.tsx`, `drawer.tsx`, `sheet.tsx` | `Dialog*`, `Drawer*`, `Sheet*` (`side`) | windows: closed by the backdrop (and Escape; a swipe down for the Drawer); **no ✕ and no Cancel** — shadcn's close button is left out. Use `shared/Window`, which picks Drawer or Dialog |
| `alert-dialog.tsx` | `AlertDialog*` (`AlertDialogAction danger`) | the only window that asks first — for an action that cannot be undone (Clear Log); never for a delete |
| `sonner.tsx` | `Toaster` | message toasts (`toast()`, `toast.success()`, `toast.error()` from `sonner`); mounted once per page |
| `table.tsx` | `Table*` (`TableHead num`, `TableCell num`) | a computer table; numbers in DM Mono to the right; `TableFooter` is the totals row and covers every item |
| `form.tsx` | `Form`, `FormField`, `FormItem`, `FormLabel`, `FormControl`, `FormMessage`, `FormDescription`, `FieldRow`, `FormSection` | React Hook Form + Zod; a schema's messages are English and shown through `tr()`; `FieldRow` puts two short fields on a line (CLAUDE.md → Short fields in pairs), `FormSection` splits a long form |

## shared (`src/components/shared/`)

| File | Exports | What it is |
|---|---|---|
| `shell.tsx` | `Shell`, `Brand`, `ShellSection` | the frame of a page: a glass title bar (`brand` left, `tools` right — the bell, the Language button, the account); on a computer the sections as tabs, each in its colour with a glowing line under the active one; on a phone (≤ 700px) the bottom bar (variant 11: the active item in its colour, a soft tile of it behind the icon, a glowing line, a red `count`, a short vibration); more than five sections → four and **More**, which opens the rest in a window; without `sections` (a portal with one screen) only the title bar. `Brand({name, sub?})`: the 11C mark and the name (hidden on a phone); with `sub` (a portal's client or supplier) the name stays and the line goes under it |
| `page-head.tsx` | `PageHead` | the screen title (19/600) and its count; then the one primary, at most one or two secondaries, the header ⋮ |
| `section.tsx` | `Section`, `Figures` | a section label with its count, its tools, folding (`folded` / `onFold`); the figures on top of a screen, each a filter with `onPick` |
| `plate.tsx` | `Plate`, `PlateAction` | the list line: `title`, `chips`, `sub`, `right` (the soft-green figure), `color` (the bar: green OK, accent info, amber attention, red problem), `icon`, `size` (`sm` · `md` · `lg`); **tap → `onOpen`, double click / long press → `onEdit`, swipe left → Edit / Delete, ⋮ → `onEdit`, `actions`, `onDelete` (last, red-soft)**; `selecting` / `selected` / `onToggle` for Select mode; `expanded` shows `children` under the line; inside `AnimatePresence` a removed plate collapses |
| `paged-list.tsx` | `PagedList` | 10 rows and a "Show more (N left)" row (CLAUDE.md → Lists page by 10), with the old `renderPagedList` rules (docs/app-core.md → Long lists): the next 10 on a tap on that row, or when a scroll that follows the user's own input (wheel, touch, a key, a pointer press) brings it into view; an upward input never loads; a downward input with the row already in view loads too; one page per input, no pre-loading margin; the visible area is the viewport or the nearest scrolling ancestor |
| `undo.tsx` | `undoDelete(text, commit, restore)`, `UndoHost` | Delete never asks: the snack offers Undo for 5 s with the gradient timer; `commit` runs when it ends or when another delete replaces it, `restore` on Undo; `UndoHost` is mounted once per page |
| `select-mode.tsx` | `useSelection(ids)`, `SelectHead`, `SelectBar` | the Select button above a list → tick boxes, "N selected · Select all", the glass bulk bar (the list's bulk actions, Delete, ✕) |
| `window.tsx` | `Window` | every window: a bottom sheet on a phone, a centred glass window on a computer; `title`, `description`, `footer` (the one primary). A window opened from another goes back to it: the caller keeps which is open (the gallery's Pay → Bank details) |
| `language.tsx` | `LanguageButton` | the bare globe at the top right and its window: search, every language of `I18N_LANGS` (own name + English name), the current one ticked; a tap switches at once |
| `account-menu.tsx` | `AccountMenu({name, sub, onSignOut, children})` | the account at the top right, after the Language button (header variant C, the old pages' `.acct`): a round button with the first letter (and the name on a computer); its Dropdown Menu holds the name and `sub` (role or firm), the page's items (`children`) and **Sign out** last, in red |

Hooks: `src/hooks/use-phone.ts` — `useIsPhone()` (≤ 700px). Translations: `src/lib/i18n.tsx` (docs/translations.md → New stack). Other modules for pages: `src/lib/backend.ts` — `loadBackend()` (loads `/firestore-backend.js` once and returns its typed API: `currentUser`, `signOut`, `idToken`, `handleAction`) and `loadScript(src)` / `XLSX_URL` (SheetJS on demand; its types in `src/lib/xlsx.d.ts`); `src/lib/version-watch.ts` — `useVersionWatch(files)` (the old pages' new version check: ETags on return and every 30 min, a toast with **Update**); `src/lib/payroll.ts` (docs/accounting.md → Payroll module); `src/hours-review/` — the hours review screen ([hours-review.md](hours-review.md)).

## A page's root

```tsx
<I18nProvider onSave={saveToAccount}>
  <TooltipProvider>
    <App />          {/* a Shell inside */}
    <UndoHost />
    <Toaster />
  </TooltipProvider>
</I18nProvider>
```
