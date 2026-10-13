One Language button on every page — sign-in, manager app, supplier portal, client portal, punch page — identical everywhere: a glass button with a globe, the current language's own name and a small chevron.

- A tap opens a bottom sheet "Language" (a centered window on a computer): a search field, then every language as a line with its name in its own script and its English name ("עברית Hebrew", "Русский Russian"); the current one has a green tick box and the gradient line on its left. A tap switches at once and closes the sheet.
- The list is built from the dictionaries: adding a language means adding `i18n/<lang>.json` and its entry in `I18N_LANGS`; it then shows in the list on every page. Nothing else changes.
- The choice is remembered on the device and on the user's account, as today. The layout stays left to right in every language.
- The button sits at the top right of the header. Where the header is tight on a phone (bell and account circle too) the logo shows its mark only; the Language button stays the same.
- It replaces the language select in the account menu and the EN / HE / RU switch.
