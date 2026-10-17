#!/usr/bin/env bash
# SessionStart: bring the checkout up to date with GitHub, then report git status.
# Only fast-forwards, never merges or discards anything:
#   - dirty working tree -> left alone;
#   - branch with no commits of its own beyond origin/main -> fast-forwarded to origin/main;
#   - otherwise -> fast-forwarded to its own origin/<branch> if that is strictly ahead;
#   - anything else (own unmerged commits) -> left alone, only reported.
cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
note=""

if ! git fetch -q origin 2>/dev/null; then
  note="git fetch failed (offline?) - checkout NOT synced with GitHub."
elif [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  note="Uncommitted changes present - checkout NOT auto-synced."
elif git merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
    git merge -q --ff-only origin/main 2>/dev/null && note="Fast-forwarded $branch to origin/main."
  else
    note="$branch is up to date with origin/main."
  fi
elif git rev-parse -q --verify "origin/$branch" >/dev/null && git merge-base --is-ancestor HEAD "origin/$branch"; then
  git merge -q --ff-only "origin/$branch" 2>/dev/null && note="Fast-forwarded $branch to origin/$branch."
else
  ahead=$(git rev-list --count origin/main..HEAD 2>/dev/null)
  behind=$(git rev-list --count HEAD..origin/main 2>/dev/null)
  note="$branch has $ahead own commit(s) not in main and is $behind behind origin/main - not auto-updated; merge origin/main if needed."
fi

status=$(git status --short 2>/dev/null)
ctx="git status for $CLAUDE_PROJECT_DIR (branch: $branch): $note
$status"

py=$(command -v python3 || command -v python)
if [ -n "$py" ]; then
  CTX="$ctx" "$py" -c 'import json,os;print(json.dumps({"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":os.environ["CTX"]}}))'
else
  printf '%s\n' "$ctx"
fi
