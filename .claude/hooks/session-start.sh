#!/usr/bin/env bash
# SessionStart: bring the checkout up to date with GitHub, then report git status.
# Only fast-forwards, never merges or discards anything:
#   - dirty working tree -> left alone;
#   - branch with no commits of its own beyond origin/main -> fast-forwarded to origin/main;
#   - otherwise -> fast-forwarded to its own origin/<branch> if that is strictly ahead;
#   - anything else (own unmerged commits) -> left alone, only reported.
# Also run outside Claude Code by the local PC's scheduled sync (scripts/install-local-sync.ps1),
# where CLAUDE_PROJECT_DIR is unset and the repo root is found from this file's own path.
# $1 = the hook event (SessionStart by default). As UserPromptSubmit it runs before every
# message of a live session and stays silent unless the checkout changed or needs attention.
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" 2>/dev/null || exit 0

event=${1:-SessionStart}
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
note=""
quiet=""

# UserPromptSubmit: at most one sync per THROTTLE seconds, and a notice only when it differs
# from the last one given (both kept inside .git, so nothing shows up in git status).
THROTTLE=300
gitdir=$(git rev-parse --git-dir 2>/dev/null)
stamp="$gitdir/claude-sync-at"
lastnote="$gitdir/claude-sync-note"
now=$(date +%s)
if [ "$event" = UserPromptSubmit ]; then
  last=$(cat "$stamp" 2>/dev/null || echo 0)
  [ $((now - last)) -lt $THROTTLE ] 2>/dev/null && exit 0
fi
echo "$now" > "$stamp" 2>/dev/null

if ! git fetch -q origin 2>/dev/null; then
  note="git fetch failed (offline?) - checkout NOT synced with GitHub."
  quiet=1
elif [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  note="Uncommitted changes present - checkout NOT auto-synced."
elif git merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
    git merge -q --ff-only origin/main 2>/dev/null && note="Fast-forwarded $branch to origin/main." && moved=1
  else
    note="$branch is up to date with origin/main."
    quiet=1
  fi
elif git rev-parse -q --verify "origin/$branch" >/dev/null && [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$branch")" ] \
    && git merge-base --is-ancestor HEAD "origin/$branch"; then
  git merge -q --ff-only "origin/$branch" 2>/dev/null && note="Fast-forwarded $branch to origin/$branch."
else
  ahead=$(git rev-list --count origin/main..HEAD 2>/dev/null)
  behind=$(git rev-list --count HEAD..origin/main 2>/dev/null)
  note="$branch has $ahead own commit(s) not in main and is $behind behind origin/main - not auto-updated; merge origin/main if needed."
  [ "$behind" = 0 ] && quiet=1
fi

prev=$(cat "$lastnote" 2>/dev/null)
printf '%s' "$note" > "$lastnote" 2>/dev/null
if [ "$event" = UserPromptSubmit ]; then
  [ -n "$quiet" ] && exit 0
  [ "$note" = "$prev" ] && exit 0
fi

status=$(git status --short 2>/dev/null)
ctx="git status for $PWD (branch: $branch): $note
$status"

py=$(command -v python3 || command -v python)
if [ -n "$py" ]; then
  EV="$event" CTX="$ctx" "$py" -c 'import json,os;print(json.dumps({"hookSpecificOutput":{"hookEventName":os.environ["EV"],"additionalContext":os.environ["CTX"]}}))'
else
  printf '%s\n' "$ctx"
fi
