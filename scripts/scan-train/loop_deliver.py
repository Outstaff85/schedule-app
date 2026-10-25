"""The automatic cycle's delivery (docs/scan-training.md → The automatic cycle → Delivery): a version the exams said
is worth publishing goes to the LAB on its own — the models on Hugging Face (publish.py), and a pull request that
points the lab at it (scripts/scan-lab/models-version). The site is never changed; nothing is ever merged.

  deliver(["edges", "doctype"], report, dry_run=False) -> {"version": "v7", "branch": "scan-train/v7", "prUrl": "https://…"}

loop.py calls it once a cycle decided to publish. What it does, in order:

1. The delivery checkout: a separate git worktree of the owner's clone at <WORK>/loop/repo (`git worktree add
   --detach`, a fresh clone of GitHub when that fails), set to origin/main. The owner's own checkout — its branch,
   its working tree, its index — is never touched: only `git fetch` and `git worktree` run against it, and they
   change neither.
2. publish.py runs FROM the delivery checkout (its scripts/scan-train/publish.py, with this venv's python), with
   exactly the models' flags (--edges, --doctypes, --mrz, --he; never a --force-*). publish.py writes the lab's
   version (scripts/scan-lab/models-version) and, when it marks the version, scripts/scan-train/heldout.json into
   the repo it runs from (common.ROOT, gen.common.HELDOUT): run from the delivery checkout, those writes land there
   and nowhere else — publish.py needs no new option and the owner's checkout is never written, not even for a
   moment (copying the change out of the owner's checkout and restoring it would race with the owner's own work).
   Before it runs, the lab's version on origin/main must be the one in the owner's checkout (the version the cycle
   trained and examined against); else nothing is published.
3. The change is checked: only scripts/scan-lab/models-version (naming the new v<N>) and heldout.json may differ;
   the site's files (scripts/scan/models-version, functions/scan_models_version.txt) or anything else in the diff
   aborts the delivery before a commit.
4. A branch scan-train/v<N> with one commit (the cycle's id and the attribution lines), pushed — never forced,
   never to main — with the owner's fine-grained GitHub token, and a pull request into main opened through the
   GitHub REST API. Its body: each model's verdict and failed rules from the report, and "Auto-published to the LAB
   by the training loop; the site is not changed". Merging it is the owner's (CLAUDE.md → Git workflow).

The token is the generic credential "scan-train-loop-github" (user Outstaff85) in Windows Credential Manager, read
with CredReadW. It is never printed, logged, written to a file or put in a URL: git gets it as an http.extraheader
through the GIT_CONFIG_* environment variables (not on the command line), the REST API in the Authorization header.

With dry_run: publish.py --dry-run (from the owner's checkout — it writes nothing) and no git or GitHub at all; the
result names the version and branch it would make, prUrl None.

Errors: DeliverError. Its `published` says whether the version is already on Hugging Face (publish.py finished): then
the lab's models-version still has to reach main — the message says so (loop.py puts it in needsOwner).
"""
import base64
import datetime
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

from home import WORK

ROOT = pathlib.Path(__file__).resolve().parents[2]          # the owner's clone (this script's repo)
LAB = "scripts/scan-lab/models-version"
HELDOUT = "scripts/scan-train/heldout.json"
SITE = ("scripts/scan/models-version", "functions/scan_models_version.txt")   # never in a delivery
ALLOWED = (LAB, HELDOUT)
CREDENTIAL = "scan-train-loop-github"
BASE = "main"
API = "https://api.github.com"
FLAGS = {"edges": "--edges", "doctype": "--doctypes", "doctypes": "--doctypes", "mrz": "--mrz", "he": "--he"}
WHAT = {"edges": "the document edges models", "doctype": "the document type model", "mrz": "the passport zone reader",
        "he": "the Hebrew field reader"}
ATTRIBUTION = ("Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n"
               "Claude-Session: https://claude.ai/code/session_01PSirNvAfydZ5N2Jsbgcu6Z")


class DeliverError(RuntimeError):
    """A delivery that stopped. published: the version is already on Hugging Face (only the PR is missing)."""

    def __init__(self, msg, version=None, branch=None, published=False):
        super().__init__(msg)
        self.version, self.branch, self.published = version, branch, published


# ---------- the token (Windows Credential Manager) ----------
def read_token(target=CREDENTIAL):
    """The generic credential's secret, or None. Windows only (CredReadW); the secret is never printed."""
    if sys.platform != "win32":
        return None
    import ctypes
    from ctypes import wintypes

    class CREDENTIAL_W(ctypes.Structure):
        _fields_ = [("Flags", wintypes.DWORD), ("Type", wintypes.DWORD), ("TargetName", wintypes.LPWSTR),
                    ("Comment", wintypes.LPWSTR), ("LastWritten", wintypes.FILETIME), ("CredentialBlobSize", wintypes.DWORD),
                    ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)), ("Persist", wintypes.DWORD),
                    ("AttributeCount", wintypes.DWORD), ("Attributes", ctypes.c_void_p), ("TargetAlias", wintypes.LPWSTR),
                    ("UserName", wintypes.LPWSTR)]

    adv = ctypes.WinDLL("advapi32", use_last_error=True)
    adv.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.POINTER(CREDENTIAL_W))]
    adv.CredReadW.restype = wintypes.BOOL
    adv.CredFree.argtypes = [ctypes.c_void_p]
    p = ctypes.POINTER(CREDENTIAL_W)()
    if not adv.CredReadW(target, 1, 0, ctypes.byref(p)):   # 1: CRED_TYPE_GENERIC
        return None
    try:
        blob = bytes(p.contents.CredentialBlob[i] for i in range(p.contents.CredentialBlobSize))
    finally:
        adv.CredFree(p)
    return decode_secret(blob)


def decode_secret(blob):
    """A credential's blob as text: cmdkey and the Credential Manager store it UTF-16, other tools UTF-8."""
    if len(blob) >= 2 and len(blob) % 2 == 0 and all(b == 0 for b in blob[1::2]):
        return blob.decode("utf-16-le").strip() or None
    return blob.decode("utf-8", errors="replace").strip() or None


# ---------- the log ----------
class Log:
    """The cycle's log on this PC (report["log"]); whatever is written is scrubbed of the token first."""

    def __init__(self, path):
        self.path = pathlib.Path(path) if path else WORK / "loop" / "deliver.log"
        self.secrets = []

    def __call__(self, text):
        for s in self.secrets:
            text = text.replace(s, "***")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        stamp = datetime.datetime.now().isoformat(timespec="seconds")
        with open(self.path, "a", encoding="utf-8") as f:
            f.write("".join(f"[deliver {stamp}] {line}\n" for line in text.rstrip("\n").splitlines() or [""]))


# ---------- git ----------
def auth_env(token):
    """git's environment with the token as an http.extraheader for github.com (GIT_CONFIG_*: never on the command
    line, so never in a process listing or a logged command); no prompt ever waits at night."""
    env = {k: v for k, v in os.environ.items() if not re.fullmatch(r"GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)", k)}
    env["GIT_TERMINAL_PROMPT"] = "0"
    if token:
        basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
        env.update({"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
                    "GIT_CONFIG_VALUE_0": f"AUTHORIZATION: basic {basic}"})
    return env


def git(log, cwd, *args, env=None, check=True):
    """One git command (logged without its environment) → its stdout."""
    log("git " + " ".join(args) + f"   (in {cwd})")
    r = subprocess.run(["git", *args], cwd=str(cwd), env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.stdout.strip() or r.stderr.strip():
        log((r.stdout + r.stderr).strip())
    if check and r.returncode:
        raise DeliverError(f"git {args[0]} failed ({r.returncode}): {(r.stderr or r.stdout).strip()[:300]}")
    return r.stdout


def github_slug(url):
    """"owner/repo" of a GitHub remote (https or ssh), else None."""
    m = re.match(r"^(?:https://(?:[^@/]+@)?github\.com/|git@github\.com:|ssh://git@github\.com/)([^/]+/[^/]+?)(?:\.git)?/?$", url.strip())
    return m.group(1) if m else None


def push_target(slug):
    """Where the branch is pushed and a fresh clone comes from: always https (the token's header is for https)."""
    return f"https://github.com/{slug}.git"


def changed_paths(log, repo):
    """The paths git sees changed or new in the delivery checkout (renames: both sides)."""
    out = []
    for line in git(log, repo, "status", "--porcelain=v1", "--untracked-files=all").splitlines():
        p = line[3:].strip()
        out += [s.strip().strip('"') for s in p.split(" -> ")] if " -> " in p else [p.strip('"')]
    return out


def checkout(log, owner, repo, env, slug):
    """The delivery checkout at origin/main: the worktree reused (reset, cleaned), else added from the owner's clone,
    else a fresh clone. The owner's own checkout: only fetch and worktree, never its branch or files."""
    if (repo / ".git").exists():
        try:
            git(log, repo, "fetch", "origin", BASE, env=env)
            git(log, repo, "checkout", "-f", "--detach", f"origin/{BASE}")
            git(log, repo, "clean", "-fd")
            return
        except DeliverError as e:
            log(f"the delivery checkout could not be reset ({e}); made again")
        git(log, owner, "worktree", "remove", "--force", str(repo), check=False)
    shutil.rmtree(repo, ignore_errors=True)
    repo.parent.mkdir(parents=True, exist_ok=True)
    try:
        git(log, owner, "worktree", "prune")
        git(log, owner, "fetch", "origin", BASE, env=env)
        git(log, owner, "worktree", "add", "--detach", str(repo), f"origin/{BASE}")
        return
    except DeliverError as e:
        log(f"no worktree of the owner's clone ({e}); a fresh clone instead")
    shutil.rmtree(repo, ignore_errors=True)
    git(log, repo.parent, "clone", "--branch", BASE, push_target(slug), str(repo), env=env)
    git(log, repo, "checkout", "--detach", f"origin/{BASE}")


# ---------- GitHub ----------
def http(method, url, token, body=None):
    """One GitHub REST call → (status, parsed JSON). The token only in the Authorization header."""
    req = urllib.request.Request(url, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                                          "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "scan-train-loop",
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"null")
        except ValueError:
            return e.code, None


def open_loop_prs(slug, token):
    """The training loop's PRs still open (branch scan-train/…): [(number, branch)]; [] when they cannot be listed."""
    try:
        status, got = http("GET", f"{API}/repos/{slug}/pulls?state=open&base={BASE}&per_page=100", token)
    except Exception:
        return []
    if status != 200 or not isinstance(got, list):
        return []
    return [(p["number"], p["head"]["ref"]) for p in got if str((p.get("head") or {}).get("ref", "")).startswith("scan-train/")]


def open_pr(slug, token, branch, title, body):
    """The PR into main → its html_url (an open one for the branch already there is reused)."""
    status, got = http("POST", f"{API}/repos/{slug}/pulls", token, {"title": title, "head": branch, "base": BASE, "body": body})
    if status == 201:
        return got["html_url"]
    if status == 422:
        owner = slug.split("/")[0]
        s2, have = http("GET", f"{API}/repos/{slug}/pulls?state=open&head={owner}:{branch}", token)
        if s2 == 200 and have:
            return have[0]["html_url"]
    msg = (got or {}).get("message") if isinstance(got, dict) else None
    raise DeliverError(f"the pull request was not opened (GitHub {status}: {msg or 'no message'})")


# ---------- the texts ----------
def model_lines(models, report):
    out = []
    for m in models:
        r = (report.get("models") or {}).get(m) or {}
        verdict = {"yes": "worth publishing", "no": "NOT worth publishing"}.get(r.get("verdict"), "not decided")
        out.append(f"- **{WHAT.get(m, m)}** (`{m}`): trained {'yes' if r.get('trained') else 'no'}; the exam: {verdict}; "
                   + ("rules failed: " + "; ".join(r["failed"]) if r.get("failed") else "no rule failed")
                   + (f"; exam report on the PC: `{r['examReport']}`" if r.get("examReport") else ""))
    return out


def pr_body(models, report, version, others):
    due = report.get("due") or {}
    lines = [f"Auto-published to the LAB by the training loop; the site is not changed.", "",
             f"The training loop's cycle `{report.get('id')}` published **{version}** on Hugging Face (`OutStaff/scanner-models`, "
             f"tag `{version}`) and points the lab at it: `{LAB}` → `{version}`.", "", "## The models", *model_lines(models, report)]
    if due:
        lines += ["", "## Why the cycle ran", "", "```", json.dumps(due, indent=2, ensure_ascii=False, sort_keys=True), "```"]
    if report.get("notes"):
        lines += ["", "## Notes", *[f"- {n}" for n in report["notes"]]]
    if others:
        lines += ["", "## Older loop PRs still open", *[f"- #{n} (`{b}`): superseded — this version is newer" for n, b in others]]
    lines += ["", "Merging this PR still needs the owner's yes (CLAUDE.md → Git workflow). The site (`scripts/scan/models-version`, "
              "`functions/scan_models_version.txt`) is never changed by the loop: it follows only on the owner's word, after the lab.",
              "", "🤖 Generated with [Claude Code](https://claude.com/claude-code)", "",
              "https://claude.ai/code/session_01PSirNvAfydZ5N2Jsbgcu6Z"]
    return "\n".join(lines)


def commit_message(models, report, version):
    return (f"Scanner: the lab's models {version} ({', '.join(models)}) — the training loop\n\n"
            f"Auto-published to the LAB by the training loop; the site is not changed.\n"
            f"Cycle: {report.get('id')}\n\n{ATTRIBUTION}\n")


# ---------- publish.py ----------
def flags_of(models):
    if not models:
        raise DeliverError("no model to publish")
    bad = [m for m in models if m not in FLAGS]
    if bad:
        raise DeliverError(f"unknown model(s): {', '.join(bad)}")
    return sorted({FLAGS[m] for m in models}, key=["--edges", "--doctypes", "--mrz", "--he"].index)


def run_publish(log, where, flags, dry_run):
    """publish.py of the repo `where` with exactly these flags (never --force-*) → its output; DeliverError on a
    non-zero exit."""
    args = [sys.executable, str(where / "scripts" / "scan-train" / "publish.py"), *flags] + (["--dry-run"] if dry_run else [])
    assert not any(a.startswith("--force") for a in args)
    log("run: publish.py " + " ".join(args[2:]) + f"   (in {where})")
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8"}
    r = subprocess.run(args, cwd=str(where / "scripts" / "scan-train"), env=env, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    log((r.stdout + r.stderr).strip() or "(no output)")
    if r.returncode:
        tail = (r.stderr.strip() or r.stdout.strip()).splitlines()[-1:] or [""]
        raise DeliverError(f"publish.py stopped ({r.returncode}): {tail[0][:300]}")
    return r.stdout


def lab_version(repo):
    try:
        return (repo / LAB).read_text(encoding="utf-8").strip()
    except OSError:
        return None


# ---------- the delivery ----------
def deliver(models, report, dry_run=False, *, owner=None, repo=None, token_reader=None):
    """Publish exactly `models` to the LAB and open the PR → {"version", "branch", "prUrl"}. owner (the owner's clone),
    repo (the delivery checkout) and token_reader are for the tests."""
    owner = pathlib.Path(owner or ROOT)
    repo = pathlib.Path(repo or WORK / "loop" / "repo")
    log = Log(report.get("log"))
    flags = flags_of(models)
    log(f"cycle {report.get('id')}: deliver {', '.join(models)}" + (" (dry run)" if dry_run else ""))
    if dry_run:   # the owner's publish.py --dry-run writes nothing; no git, no GitHub
        out = run_publish(log, owner, flags, True)
        m = re.search(r"the plan for (v\d+)", out)
        v = m.group(1) if m else None
        return {"version": v, "branch": f"scan-train/{v}" if v else None, "prUrl": None, "dryRun": True}

    token = (token_reader or read_token)()
    if not token:
        raise DeliverError(f"no GitHub token: the generic credential \"{CREDENTIAL}\" is not in Windows Credential Manager — nothing published")
    log.secrets.append(token)
    env = auth_env(token)
    slug = github_slug(git(log, owner, "remote", "get-url", "origin").strip())
    if not slug:
        raise DeliverError("the owner's clone has no GitHub origin — nothing published")
    checkout(log, owner, repo, env, slug)
    if changed_paths(log, repo):
        raise DeliverError("the delivery checkout is not clean after the reset — nothing published")
    trained_from, on_main = lab_version(owner), lab_version(repo)
    if trained_from != on_main:
        raise DeliverError(f"the lab's version on {BASE} is {on_main}, but this cycle trained and examined against {trained_from} "
                           f"(the owner's checkout) — nothing published; the next cycle examines against {on_main}")

    run_publish(log, repo, flags, False)   # from here on the version is on Hugging Face
    v = lab_version(repo)
    branch = f"scan-train/{v}"
    fail = lambda msg: DeliverError(f"{v} is on Hugging Face, but {msg} — point the lab at it by hand ({LAB} → {v}, a PR)",
                                    version=v, branch=branch, published=True)
    if not v or not re.fullmatch(r"v\d+", v) or v == on_main:
        raise fail(f"publish.py did not name a new version in {LAB} (it reads {v!r})")
    changed = changed_paths(log, repo)
    site = [p for p in changed if p in SITE]
    if site:
        raise fail(f"the site's files changed ({', '.join(site)}): the loop never changes the site — aborted, not committed")
    other = [p for p in changed if p not in ALLOWED]
    if other:
        raise fail(f"publish.py changed more than the lab's version ({', '.join(other)}) — aborted, not committed")
    if LAB not in changed:
        raise fail(f"{LAB} is not in the diff")
    try:
        git(log, repo, "checkout", "-B", branch)
        git(log, repo, "add", "--", *changed)
        staged = git(log, repo, "diff", "--cached", "--name-only").split()
        if any(p in SITE for p in staged) or set(staged) - set(ALLOWED):
            raise DeliverError(f"unexpected files staged: {', '.join(staged)}")
        git(log, repo, "commit", "-m", commit_message(models, report, v))
        assert branch.startswith("scan-train/") and branch != BASE
        git(log, repo, "push", push_target(slug), f"refs/heads/{branch}:refs/heads/{branch}", env=env)   # never forced, never main
    except DeliverError as e:
        raise fail(f"the branch was not pushed ({e})")
    others = [(n, b) for n, b in open_loop_prs(slug, token) if b != branch]
    title = f"Scanner: the lab's models {v} — the training loop"
    try:
        url = open_pr(slug, token, branch, title, pr_body(models, report, v, others))
    except DeliverError as e:
        raise fail(f"{branch} is pushed and {e}")
    finally:   # the owner's clone keeps no local branch of the loop's (the remote one is the PR's)
        git(log, repo, "checkout", "--detach", check=False)
        git(log, repo, "branch", "-D", branch, check=False)
    log(f"delivered {v}: {url}")
    return {"version": v, "branch": branch, "prUrl": url}
