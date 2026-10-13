Checkbox tile: a faint tile (`rgba(255,255,255,.06)`) with a 24px box; when ticked the box turns green and the check mark draws itself as a line (350ms).

- Every set of checkboxes is a wrap of tiles (the app's `.check-grid` rule); one long option takes the full width (`wide`).
- Unticked: box border ink-3, label ink-2. Ticked: tile `tick-on`, box `green`, label ink, mark `tick-mark`.
- Height 46px, radius-md, label 15px/400.
- The whole tile is the hit area; it is a `button` (or a `label` around a hidden checkbox) with a visible focus ring.
