"""PreToolUse guard for Bash: blocks a force-push, a push to main, and any push
while the checkout is on main (CLAUDE.md → Git workflow).

Reads the hook's JSON from stdin; prints {} to allow, or a deny decision.
Checks every `git … push` in the command (`git -C dir push`, chained
commands), not only the first one.
"""
import json
import os
import re
import shlex
import subprocess
import sys

PUSH = re.compile(r"(?:^|[;&|\n(]|\$\()\s*git((?:\s+-[Cc]\s+\S+|\s+--[\w-]+(?:=\S+)?)*)\s+push\b([^\n;&|)]*)")


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                             "permissionDecision": "deny",
                                             "permissionDecisionReason": reason}}))
    sys.exit(0)


def words(s):
    try:
        return shlex.split(s)
    except ValueError:
        return s.split()


def main():
    try:
        cmd = json.load(sys.stdin).get("tool_input", {}).get("command", "") or ""
    except Exception:
        cmd = ""
    pushes = list(PUSH.finditer(cmd))
    if not pushes:
        print("{}")
        return
    for m in pushes:
        args = words(m.group(2))
        if any(a in ("-f", "--force", "--force-with-lease", "--force-if-includes") or a.startswith("--force-with-lease=")
               or (a.startswith("+") and len(a) > 1) for a in args):
            deny("Force-push is blocked by project policy: ask the user explicitly before force-pushing.")
        for a in args:
            if a.startswith("-"):
                continue
            dst = a.split(":")[-1]
            if dst in ("main", "refs/heads/main"):
                deny("Direct push to main is blocked: land changes via a PR from My_Work_Befor_PR (see CLAUDE.md PR merge policy).")
    cwd = os.environ.get("CLAUDE_PROJECT_DIR") or "."
    branch = subprocess.run(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
                            capture_output=True, text=True).stdout.strip()
    if branch == "main":
        deny("Pushing while on main is blocked: switch to My_Work_Befor_PR (see CLAUDE.md PR merge policy).")
    print("{}")


main()
