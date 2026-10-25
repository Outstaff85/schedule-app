"""The automatic cycle's delivery (scripts/scan-train/loop_deliver.py; docs/scan-training.md → The automatic cycle →
Delivery): publish.py runs with exactly the models' flags (never --force-*) from a separate delivery checkout, so the
owner's own checkout is never written; only the lab's models-version (and heldout.json) reach a branch
scan-train/v<N>, the site's files abort the delivery; the token is never on a command line or in the log; the PR
goes into main and nothing is merged; a dry run touches neither git nor GitHub.

Real git on temporary repos (a bare "GitHub" origin, the owner's clone), a fake publish.py committed in them, a fake
credential reader and a fake GitHub REST API: nothing reaches GitHub, Hugging Face or Firebase."""
import json
import os
import pathlib
import subprocess
import sys

import pytest

HERE = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "scan-train"
sys.path.insert(0, str(HERE))

import loop_deliver as ld  # noqa: E402

TOKEN = "ghp_FAKE_TOKEN_never_shown_0123456789"
LAB, SITE_V, SITE_F, HELD = "scripts/scan-lab/models-version", "scripts/scan/models-version", "functions/scan_models_version.txt", "scripts/scan-train/heldout.json"

# publish.py's stand-in: writes into the repo it runs from, as the real one does (common.ROOT, gen.common.HELDOUT)
FAKE_PUBLISH = r'''
import json, os, pathlib, sys
root = pathlib.Path(__file__).resolve().parents[2]
pathlib.Path(os.environ["FAKE_PUBLISH_ARGS"]).write_text(json.dumps({"args": sys.argv[1:], "root": str(root)}))
mode = os.environ.get("FAKE_PUBLISH_MODE", "ok")
v = os.environ.get("FAKE_PUBLISH_VERSION", "v6")
if mode == "fail":
    raise SystemExit("report.json is for a different model; run the exam again")
if "--dry-run" in sys.argv:
    print(f"Dry run - the plan for {v} (the lab is on v5); nothing is written:")
    raise SystemExit(0)
(root / "scripts" / "scan-lab" / "models-version").write_text(v + "\n")
if mode == "heldout":
    (root / "scripts" / "scan-train" / "heldout.json").write_text('{"versions": {"%s": {}}}\n' % v)
if mode == "site":
    (root / "scripts" / "scan" / "models-version").write_text(v + "\n")
if mode == "other":
    (root / "README-x.md").write_text("x")
print(f"Published as {v} on Hugging Face")
'''


def sh(cwd, *args):
    return subprocess.run(["git", *args], cwd=str(cwd), check=True, capture_output=True, text=True).stdout


@pytest.fixture
def world(tmp_path, monkeypatch):
    """A bare origin with main, the owner's clone of it, and the fakes wired in."""
    gcfg = tmp_path / "gitconfig"
    gcfg.write_text("[user]\n\tname = Test\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(gcfg))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.setenv("FAKE_PUBLISH_ARGS", str(tmp_path / "publish-args.json"))
    monkeypatch.delenv("FAKE_PUBLISH_MODE", raising=False)
    bare = tmp_path / "origin.git"
    sh(tmp_path, "init", "--bare", "-b", "main", str(bare))
    seed = tmp_path / "seed"
    sh(tmp_path, "clone", str(bare), str(seed))
    for path, text in {LAB: "v5\n", SITE_V: "base-v1\n", SITE_F: "base-v1\n", HELD: "{}\n",
                       "scripts/scan-train/publish.py": FAKE_PUBLISH, ".gitignore": "__pycache__/\n"}.items():
        (seed / path).parent.mkdir(parents=True, exist_ok=True)
        (seed / path).write_text(text)
    sh(seed, "add", "-A")
    sh(seed, "commit", "-m", "seed")
    sh(seed, "push", "origin", "HEAD:main")
    owner = tmp_path / "owner"
    sh(tmp_path, "clone", str(bare), str(owner))
    sh(owner, "checkout", "-b", "My_Work_Befor_PR")
    (owner / "notes.txt").write_text("the owner's own unsaved work\n")   # a dirty tree stays as it is

    calls, prs = [], []
    real_run = subprocess.run

    def run(args, **kw):
        calls.append({"args": list(args), "env": kw.get("env")})
        return real_run(args, **kw)

    def http(method, url, token, body=None):
        assert token == TOKEN
        prs.append({"method": method, "url": url, "body": body})
        if method == "POST":
            return world_state["post"]
        return 200, []

    world_state = {"post": (201, {"html_url": "https://github.com/o/r/pull/77"})}
    monkeypatch.setattr(ld.subprocess, "run", run)
    monkeypatch.setattr(ld, "http", http)
    monkeypatch.setattr(ld, "github_slug", lambda url: "o/r")
    monkeypatch.setattr(ld, "push_target", lambda slug: str(bare))
    log = tmp_path / "cycle.log"
    report = {"id": "2026-10-26T02-00", "log": str(log), "due": {"edgesSince": 240, "retrainAt": 200},
              "models": {"edges": {"trained": True, "verdict": "yes", "failed": [], "examReport": "C:/x/report.json"},
                         "doctype": {"trained": True, "verdict": "yes", "failed": [], "examReport": None}},
              "notes": [], "needsOwner": []}
    w = dict(tmp_path=tmp_path, bare=bare, owner=owner, repo=tmp_path / "work" / "loop" / "repo", calls=calls, prs=prs,
             report=report, log=log, state=world_state, args=tmp_path / "publish-args.json")
    return w


def go(w, models=("edges", "doctype"), dry_run=False, token=TOKEN):
    return ld.deliver(list(models), w["report"], dry_run, owner=w["owner"], repo=w["repo"], token_reader=lambda: token)


def owner_state(w):
    o = w["owner"]
    return (sh(o, "rev-parse", "--abbrev-ref", "HEAD").strip(), sh(o, "status", "--porcelain"), (o / LAB).read_text(),
            (o / HELD).read_text())


def pushed(w, branch):
    return sh(w["bare"], "diff", "--name-only", "main", branch).split()


def no_secret(w):
    assert TOKEN not in w["log"].read_text(encoding="utf-8")
    for c in w["calls"]:
        assert not any(TOKEN in a for a in c["args"]), c["args"]


def test_delivers_lab_version_on_a_branch_and_opens_a_pr(world):
    before = owner_state(world)
    out = go(world)
    assert out == {"version": "v6", "branch": "scan-train/v6", "prUrl": "https://github.com/o/r/pull/77"}
    got = json.loads(world["args"].read_text())
    assert got["args"] == ["--edges", "--doctypes"]                      # exactly the models' flags, no --force-*
    assert pathlib.Path(got["root"]) == world["repo"].resolve()           # publish ran in the delivery checkout
    assert pushed(world, "scan-train/v6") == [LAB]
    msg = sh(world["bare"], "log", "-1", "--format=%B", "scan-train/v6")
    assert "Cycle: 2026-10-26T02-00" in msg and "Co-Authored-By: Claude Opus 5.5" in msg and "Claude-Session:" in msg
    assert sh(world["bare"], "show", "main:" + LAB).strip() == "v5"       # main untouched, nothing merged
    post = [p for p in world["prs"] if p["method"] == "POST"][0]
    assert post["url"].endswith("/repos/o/r/pulls")
    assert post["body"]["head"] == "scan-train/v6" and post["body"]["base"] == "main"
    assert "Auto-published to the LAB by the training loop; the site is not changed." in post["body"]["body"]
    assert "worth publishing" in post["body"]["body"]
    assert not any("merge" in p["url"] for p in world["prs"])
    assert owner_state(world) == before                                   # the owner's checkout as it was
    assert "scan-train/v6" not in sh(world["owner"], "branch", "--list")  # no local branch left behind
    no_secret(world)
    push = [c for c in world["calls"] if c["args"][:2] == ["git", "push"]][0]
    assert not any("--force" in a or a.startswith("+") for a in push["args"])
    assert push["env"]["GIT_CONFIG_KEY_0"] == "http.https://github.com/.extraheader"
    assert TOKEN not in push["env"]["GIT_CONFIG_VALUE_0"]                 # base64 in a header, never plain


def test_heldout_change_goes_with_it(world, monkeypatch):
    monkeypatch.setenv("FAKE_PUBLISH_MODE", "heldout")
    go(world)
    assert sorted(pushed(world, "scan-train/v6")) == sorted([LAB, HELD])
    assert (world["owner"] / HELD).read_text() == "{}\n"


@pytest.mark.parametrize("mode,word", [("site", "site's files"), ("other", "more than the lab's version")])
def test_site_or_other_files_abort_before_a_commit(world, monkeypatch, mode, word):
    monkeypatch.setenv("FAKE_PUBLISH_MODE", mode)
    with pytest.raises(ld.DeliverError) as e:
        go(world)
    assert word in str(e.value) and e.value.published and e.value.version == "v6"
    assert "scan-train/v6" not in sh(world["bare"], "branch", "--list")
    assert not world["prs"]


def test_version_on_main_differs_from_the_trained_one(world):
    (world["owner"] / LAB).write_text("v4\n")
    with pytest.raises(ld.DeliverError) as e:
        go(world)
    assert "nothing published" in str(e.value) and not e.value.published
    assert not world["args"].exists()


def test_no_token_nothing_runs(world):
    with pytest.raises(ld.DeliverError) as e:
        go(world, token=None)
    assert "scan-train-loop-github" in str(e.value)
    assert not world["calls"] and not world["args"].exists()


def test_publish_failure_is_not_published(world, monkeypatch):
    monkeypatch.setenv("FAKE_PUBLISH_MODE", "fail")
    with pytest.raises(ld.DeliverError) as e:
        go(world)
    assert not e.value.published and "different model" in str(e.value)


def test_dry_run_touches_no_git_or_github(world):
    out = go(world, models=["mrz"], dry_run=True)
    assert out["version"] == "v6" and out["branch"] == "scan-train/v6" and out["prUrl"] is None
    got = json.loads(world["args"].read_text())
    assert got["args"] == ["--mrz", "--dry-run"]
    assert pathlib.Path(got["root"]) == world["owner"].resolve()
    assert not any(c["args"][0] == "git" for c in world["calls"]) and not world["prs"]
    assert not world["repo"].exists()


def test_reused_checkout_is_reset_for_the_next_version(world, monkeypatch):
    go(world)
    (world["repo"] / "junk.txt").write_text("left over")
    monkeypatch.setenv("FAKE_PUBLISH_VERSION", "v7")
    world["state"]["post"] = (201, {"html_url": "https://github.com/o/r/pull/78"})
    out = go(world)
    assert out["version"] == "v7" and pushed(world, "scan-train/v7") == [LAB]
    assert sh(world["bare"], "rev-parse", "scan-train/v7~1") == sh(world["bare"], "rev-parse", "main")   # from origin/main


def test_fresh_clone_when_no_worktree(world, monkeypatch):
    real_git = ld.git

    def git(log, cwd, *args, **kw):
        if args[:2] == ("worktree", "add"):
            raise ld.DeliverError("worktree add refused")
        return real_git(log, cwd, *args, **kw)
    monkeypatch.setattr(ld, "git", git)
    out = go(world)
    assert out["prUrl"] and pushed(world, "scan-train/v6") == [LAB]
    assert sh(world["owner"], "worktree", "list").count("\n") == 1   # only the owner's own


def test_existing_pr_is_reused_and_a_failed_pr_says_what_is_out(world, monkeypatch):
    def http(method, url, token, body=None):
        if method == "POST":
            return 422, {"message": "A pull request already exists"}
        if "head=" in url:
            return 200, [{"html_url": "https://github.com/o/r/pull/5"}]
        return 200, []
    monkeypatch.setattr(ld, "http", http)
    assert go(world)["prUrl"] == "https://github.com/o/r/pull/5"
    monkeypatch.setattr(ld, "http", lambda method, url, token, body=None: (403, {"message": "Resource not accessible"}) if method == "POST" else (200, []))
    monkeypatch.setenv("FAKE_PUBLISH_VERSION", "v7")
    with pytest.raises(ld.DeliverError) as e:
        go(world)
    assert e.value.published and "v7 is on Hugging Face" in str(e.value) and "pushed" in str(e.value)
    assert "scan-train/v7" in sh(world["bare"], "branch", "--list")


def test_pr_body_and_flags():
    report = {"id": "c1", "due": {"edgesSince": 3},
              "models": {"he": {"trained": True, "verdict": "yes", "failed": [], "examReport": None},
                         "mrz": {"trained": True, "verdict": "no", "failed": ["E1 worse"], "examReport": None}}}
    body = ld.pr_body(["he"], report, "v9", [(4, "scan-train/v8")])
    assert body.startswith("Auto-published to the LAB by the training loop; the site is not changed.")
    assert "the Hebrew field reader" in body and "#4" in body and "mrz" not in body.split("## The models")[1].split("##")[0]
    assert ld.flags_of(["he", "edges", "doctype"]) == ["--edges", "--doctypes", "--he"]
    with pytest.raises(ld.DeliverError):
        ld.flags_of([])
    with pytest.raises(ld.DeliverError):
        ld.flags_of(["site"])


def test_secret_decoding_and_slugs():
    assert ld.decode_secret("ghp_x1".encode("utf-16-le")) == "ghp_x1"
    assert ld.decode_secret(b"ghp_x1") == "ghp_x1"
    assert ld.decode_secret(b"") is None
    assert ld.github_slug("https://github.com/Outstaff85/schedule-app.git") == "Outstaff85/schedule-app"
    assert ld.github_slug("git@github.com:Outstaff85/schedule-app.git") == "Outstaff85/schedule-app"
    assert ld.github_slug("C:/x/origin.git") is None
    env = ld.auth_env("tok")
    assert env["GIT_TERMINAL_PROMPT"] == "0" and "tok" not in env["GIT_CONFIG_VALUE_0"]


def test_log_is_scrubbed(tmp_path):
    log = ld.Log(tmp_path / "l.log")
    log.secrets.append("s3cr3t")
    log("pushed with s3cr3t")
    assert "s3cr3t" not in (tmp_path / "l.log").read_text(encoding="utf-8")


def test_site_paths_never_allowed():
    assert not set(ld.SITE) & set(ld.ALLOWED)
    assert ld.SITE == ("scripts/scan/models-version", "functions/scan_models_version.txt")
    assert os.path.basename(ld.LAB) == "models-version" and "scan-lab" in ld.LAB
