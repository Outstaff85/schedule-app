# Archived Claude Code hooks

Hooks taken out of `.claude/settings.json`. Not active.

- `auto-commit-push.json` — `PostToolUse` hook (Write/Edit/NotebookEdit) that ran `git add -A`, committed "auto: update via Claude Code" and pushed to the current branch after every file edit. Archived 2026-10-18 at the user's request: commits and pushes are now made deliberately. To restore it, copy its entry back into `hooks.PostToolUse` in `.claude/settings.json`.
