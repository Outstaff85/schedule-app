Frosted glass button over the blob ground: a shine runs across it on tap, and the animated underline springs in on hover, focus and while it is active.

## Kinds
- `primary` (glass-strong fill): **one per screen**, the main action (Approve the month, Save). A create button (New, New user, New firm) is plain glass (`og-new`, glass fill) — owner 2026-10-17.
- default (glass fill): secondary actions that stay on screen.
- `icon`: 42×42, a single icon (Search, ⋮). An icon button always has an `aria-label`.
- `danger` (red-soft text): destructive actions in bars and sheets.

## Rules
- Anything beyond the one primary and one or two secondaries goes under the header ⋮ (RowMenu).
- Height 42px (38px inside the Select bar), radius-lg, 1px glass-edge, shadow-glass.
- The underline is the only hover/active signal: never change the fill on hover.
- The shine (`.shine` class for 700ms) runs on every tap.
- Classes: `og-btn`, plus `primary` / `icon` / `danger`; `on` keeps the underline (an open menu's ⋮).
