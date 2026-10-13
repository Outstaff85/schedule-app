Filter tabs for a list: one glass pill slides to the active tab and its underline pops in again on every switch.

- Up to 4 tabs; more go into a filter in the header ⋮.
- Text 14px/600 in ink on the ground; the indicator is glass-active with a glass-edge border.
- Indicator moves with a 300ms ease; the underline replays `og-pop` (spring) each time (`.moved`).
- Markup: `.og-tabs > .ind + button.on + button…`; the page sets the indicator's left/width from the active button.
