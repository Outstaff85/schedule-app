"""The generator tunes itself (scripts/scan-train/gen/capture.py, tune.py, ablate.py, bgfetch.py, needs.py;
docs/scan-training.md → "The automatic cycle" → "The generator tunes itself").

- the capture settings: bounded, read for a training run only (never the exam or the select set), recorded in the run's
  params; today's values draw the very same frames as the old path, an effect switched off changes only that effect;
  a gen build drawn with a tune.json is drawn again byte for byte from run.json;
- gen tune: a fake realism panel moves each setting a bounded step toward the real side, never past its limits, never
  twice on one panel nor on a panel of other settings; a setting stuck at its limit far from the real photos is a need
  for the owner; it writes nothing but its own files;
- gen bg fetch: Openverse faked — only CC0 / public domain, at least 1600 px, not mature, at most --limit a run, a pause
  before every request and the project's User-Agent; the photos catalogued with their licence, url, title, query and
  category, the bank made ready (mocked), the photos waiting to be pushed counted, a bucket pull keeping their sources
  entries; no network: exit 0 with a note;
- gen ablate: a fake exam — once every 4 cycles (a cycle counted once), the effects tested longest ago first, kept only
  when they help the real exam, a stopped run picked up again; its trials run in a home of their own whose links are
  removed without ever touching what they point to;
- what the generator cannot make goes to needs.json → the report's needsOwner; clean.py keeps the generator's state.
No network, no Firebase, no Hugging Face, no GitHub: everything outside is faked."""
import io
import json
import os
import pathlib
import random
import sys
import types

import pytest

HERE = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "scan-train"
sys.path.insert(0, str(HERE))

cv2 = pytest.importorskip("cv2")
np = pytest.importorskip("numpy")
pytest.importorskip("PIL")

from PIL import Image  # noqa: E402

import home  # noqa: E402
from gen import ablate as gab  # noqa: E402
from gen import backgrounds as gb  # noqa: E402
from gen import bgfetch  # noqa: E402
from gen import capture as gcap  # noqa: E402
from gen import needs as gneeds  # noqa: E402
from gen import tune as gtune  # noqa: E402


@pytest.fixture
def work(tmp_path, monkeypatch):
    w = tmp_path / "work"
    w.mkdir()
    monkeypatch.setattr(home, "WORK", w)
    return w


def files_under(root):
    return sorted(str(p.relative_to(root)).replace("\\", "/") for p in pathlib.Path(root).rglob("*") if p.is_file())


# ---------- the capture settings ----------
def test_settings_are_bounded_and_absent_without_the_files(work):
    assert gcap.settings(work) is None
    c = gcap.normal({"blurP": 5, "tiltMax": 0, "effects": {"jpeg": False}})
    assert c["blurP"] == gcap.LIMITS["blurP"][1] and c["tiltMax"] == gcap.LIMITS["tiltMax"][0]
    assert c["effects"] == {"mip": True, "shadow": True, "glare": True, "jpeg": False}
    assert gcap.normal(None) == {**gcap.DEFAULTS, "effects": {e: True for e in gcap.EFFECTS}}
    gcap.write(work / "gen" / "tune.json", {"capture": {"blurP": 0.6}})
    gcap.write(work / "gen" / "ablation.json", {"effects": {"glare": {"on": False}}})
    got = gcap.settings(work)
    assert got["capture"]["blurP"] == 0.6 and got["capture"]["effects"]["glare"] is False
    assert got["record"]["id"] == gcap.settings_id(got["capture"])


def test_only_a_training_run_reads_them(work, tmp_path):
    gcap.write(work / "gen" / "tune.json", {"capture": {"noiseP": 0.7}})
    a = types.SimpleNamespace(capture=None, no_tune=False)
    assert gcap.for_run(a, "train", work)[0]["noiseP"] == 0.7
    assert gcap.for_run(a, "exam", work) == (None, None) and gcap.for_run(a, "select", work) == (None, None)
    assert gcap.for_run(types.SimpleNamespace(capture=None, no_tune=True), "train", work) == (None, None)
    f = tmp_path / "cap.json"
    f.write_text(json.dumps({"capture": {"blurP": 0.3}}), encoding="utf-8")
    assert gcap.for_run(types.SimpleNamespace(capture=str(f), no_tune=False), "train", work)[0]["blurP"] == 0.3
    with pytest.raises(SystemExit):
        gcap.for_run(types.SimpleNamespace(capture=str(f), no_tune=False), "exam", work)


def test_todays_values_draw_what_synth_docs_camera_draws():
    pytest.importorskip("albumentations")
    import synth_docs as sd
    img = (np.random.default_rng(3).random((96, 128, 3)) * 255).astype(np.uint8)
    for seed in (1, 7, 99, 12345):
        a = sd.camera(seed)(image=img.copy())["image"]
        b = gcap.pipeline(seed, gcap.normal(None))(image=img.copy())["image"]
        assert np.array_equal(a, b)


# ---------- scenes with capture settings ----------
def card(rng):
    from gen import pages as gp
    w, h = 856, 540
    im = Image.new("RGBA", (w, h), (235, 230, 220, 255))
    return gp.Page(im, (w / 10, h / 10), "id_front", "id_front", "card", [], None, None, "drawn", (0, 0, w, h), 10)


class CardPool:
    def page(self, rng, F, kind):
        return card(rng)

    def any(self, rng, F, kinds=None):
        return card(rng)


def frame(seed, i, capture, recipe="single"):
    from gen import rng as grng
    from gen import scene as gs
    for k in range(8):
        r = grng.streams(seed, i * 10 + k)
        sc = gs.plan(r, CardPool(), None, None, None, recipe=recipe, capture=capture)
        if sc is not None:
            return sc, gs.render(sc, r["camera"])
    raise AssertionError("no pose")


def test_todays_capture_settings_draw_the_same_frame_and_an_effect_off_only_changes_it():
    pytest.importorskip("albumentations")
    same = 0
    for i in range(6):
        sc0, a = frame(5, i, None)
        sc1, b = frame(5, i, gcap.normal(None))
        assert sc0.cam.info() == sc1.cam.info() and np.array_equal(a, b)
        same += 1
    assert same == 6
    # the mip pyramid off: the same scene and camera, other pixels
    sc2, c = frame(5, 0, gcap.normal({"effects": {"mip": False}}))
    assert sc2.cam.info() == frame(5, 0, None)[0].cam.info() and not np.array_equal(c, frame(5, 0, None)[1])
    # a camera pushed to tilt at most 30°
    for i in range(10):
        sc, _ = frame(9, i, gcap.normal({"tiltMax": 30}))
        assert sc.cam.tilt <= 30 + 1e-9


def test_gen_build_records_the_settings_and_draws_them_again_byte_for_byte(work, tmp_path):
    pytest.importorskip("albumentations")
    import synth_docs as sd
    if not sd.latin_fonts() or not sd.hebrew_fonts():
        pytest.skip("no Latin or Hebrew font on this machine")
    from gen import build, manifest
    from gen.outputs import edges as ge
    gcap.write(work / "gen" / "tune.json", {"capture": {"blurP": 0.8, "nearPower": 3.0, "tiltMax": 35}})
    gcap.write(work / "gen" / "ablation.json", {"effects": {"shadow": {"on": False}}})

    def args(**kw):
        base = dict(count=3, seed=4, out=str(tmp_path / "run"), jobs=1, templates="", template_share=0.4, pdf_share=0.5,
                    procedural_share=0.15, recipes="", partial_weight=0.0, sharp=False, exam=False, split=None, latin=None,
                    hebrew=None, focus=None, no_tune=False, capture=None)
        base.update(kw)
        return types.SimpleNamespace(**base)
    params = ge.gen_params(args())
    assert params["capture"]["blurP"] == 0.8 and params["capture"]["effects"]["shadow"] is False
    assert params["tune"]["id"] == gcap.settings_id(params["capture"])
    folder, rows, info = build.build("edges", params, 1)
    assert info["capture"]["settings"] == params["capture"]
    assert all(r["camera"]["tilt"] <= 35 + 1e-9 for r in rows)
    # tune.json changes afterwards: the run is still drawn again from its own run.json
    gcap.write(work / "gen" / "tune.json", {"capture": {"blurP": 0.2}})
    again = build.regenerate(manifest.read_run(folder), [r["index"] for r in rows], tmp_path / "again", 1, work)
    assert [x["outputs"] for x in again] == [r["outputs"] for r in rows]
    # the exam and the select set never take them
    assert "capture" not in ge.gen_params(args(exam=True, seed=None, out=str(tmp_path / "exam")))
    assert "capture" not in ge.gen_params(args(split="select", seed=None, out=str(tmp_path / "sel")))
    assert "capture" not in ge.gen_params(args(no_tune=True))


# ---------- gen tune ----------
def panel_run(work, name, ks, made, ref, n=80, capture=None, at="2026-10-25T03:00:00+00:00", fp="f" * 64):
    d = work / "gen" / "runs" / name
    d.mkdir(parents=True)
    info = {"id": name, "model": "edges", "split": "train", "fingerprint": fp, "counts": {"byClass": {"id_front": 3}},
            "params": {"capture": capture} if capture else {},
            "realism": {"kind": "frames", "at": at, "against": {"real": {"n": n, "ks": ks, "median": {"made": made, "ref": ref}}}}}
    (d / "run.json").write_text(json.dumps(info), encoding="utf-8")
    return d


KS = {"sharpness": 0.4, "noise": 0.2, "brightness": 0.05, "fill": 0.3, "tilt": 0.1}
MADE = {"sharpness": 2.5, "noise": 1.0, "brightness": 0.5, "fill": 0.3, "tilt": 6.0}
REAL = {"sharpness": 2.0, "noise": 1.6, "brightness": 0.6, "fill": 0.45, "tilt": 4.0}


def test_tune_moves_each_setting_a_bounded_step_toward_the_real_photos(work):
    panel_run(work, "edges-s1-n8000", KS, MADE, REAL)
    got = gtune.tune(work)
    moved = {s["setting"]: s for s in got["moved"]}
    t = json.loads((work / "gen" / "tune.json").read_text(encoding="utf-8"))["capture"]
    rng = lambda k: gcap.LIMITS[k][1] - gcap.LIMITS[k][0]
    assert t["blurP"] > gcap.DEFAULTS["blurP"]                          # made-up sharper → more blur
    assert t["noiseP"] > gcap.DEFAULTS["noiseP"] and t["noiseMax"] > gcap.DEFAULTS["noiseMax"]   # cleaner → more noise
    assert t["nearPower"] > gcap.DEFAULTS["nearPower"]                  # pages smaller → nearer
    assert t["tiltMax"] < gcap.DEFAULTS["tiltMax"]                      # more tilted than real → less tilt
    assert "brightnessShift" not in moved                               # KS under KS_OK: left alone
    for k, s in moved.items():
        assert abs(s["to"] - s["from"]) <= gtune.STEP * rng(k) + 1e-9
    assert abs(t["tiltMax"] - 45) < abs(t["blurP"] - 0.5) / rng("blurP") * rng("tiltMax")   # a smaller gap, a smaller step
    # the same panel again: nothing moves
    assert gtune.tune(work)["why"] == "same panel"
    # a newer panel drawn with the OLD settings: waiting for one of today's
    panel_run(work, "edges-s2-n8000", KS, MADE, REAL, at="2026-10-26T03:00:00+00:00", fp="e" * 64)
    assert gtune.tune(work)["why"] == "other settings"
    # one drawn with today's settings moves them again, still within the limits
    for k in range(30):
        cap = gtune.current(work)
        panel_run(work, f"edges-s{3 + k}-n8000", KS, MADE, REAL, capture=cap, at=f"2026-11-{1 + k:02d}T03:00:00+00:00", fp=f"{k:064d}")
        gtune.tune(work)
    t = gtune.current(work)
    assert all(gcap.LIMITS[k][0] <= t[k] <= gcap.LIMITS[k][1] for k in gcap.DEFAULTS)
    assert t["blurP"] == gcap.LIMITS["blurP"][1]
    needs = gneeds.collect(work)["needsOwner"]
    assert any("sharpness" in x and "new effect" in x for x in needs)
    hist = json.loads((work / "gen" / "tune.json").read_text(encoding="utf-8"))["history"]
    assert len(hist) <= gtune.HISTORY


def test_tune_with_nothing_to_do_exits_quietly_and_writes_only_its_own_files(work):
    from gen.__main__ import main
    assert main(["tune"]) == 0
    assert not (work / "gen" / "tune.json").exists()
    assert "no realism panel" in gneeds.collect(work)["notes"][0]
    panel_run(work, "edges-s1-n8000", KS, MADE, REAL, n=5)
    assert gtune.tune(work)["why"] == "too few real"
    before = set(files_under(work))
    panel_run(work, "edges-s2-n8000", {k: 0.01 for k in KS}, MADE, REAL, at="2026-10-26T00:00:00+00:00")
    assert gtune.tune(work)["why"] == "close"
    after = set(files_under(work)) - before
    assert after <= {"gen/runs/edges-s2-n8000/run.json", "gen/notes/tune.json", "gen/needs.json"}


# ---------- gen bg fetch ----------
def jpeg(w, h, seed=0):
    r = np.random.default_rng(seed)
    a = cv2.resize(r.random((6, 6, 3)).astype(np.float32), (w, h)) * 200 + 20
    buf = io.BytesIO()
    Image.fromarray(a.astype(np.uint8)).save(buf, "JPEG", quality=80)
    return buf.getvalue()


class FakeOpenverse:
    """The API's pages and the photos, by URL; offline: every request fails as without a network."""

    def __init__(self, offline=False):
        self.offline, self.calls, self.n = offline, [], 0

    def __call__(self, url):
        import urllib.error
        import urllib.parse
        self.calls.append(url)
        if self.offline:
            raise urllib.error.URLError("no route")
        if url.startswith(bgfetch.API):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
            assert q["license"] == ["cc0,pdm"] and q["mature"] == ["false"]
            page = int(q["page"][0])
            if page > 2:
                return json.dumps({"results": []}).encode()
            res = []
            for k in range(6):
                self.n += 1
                n = self.n
                res.append({"id": f"id-{n}", "title": f"{q['q'][0]} {n}", "license": "cc0", "url": f"https://img.example/{n}.jpg",
                            "foreign_landing_url": f"https://example.org/{n}", "width": 2000, "height": 1500})
            res[0]["license"] = "by"              # not CC0 / PD: skipped
            res[1]["mature"] = True               # skipped
            res[2]["width"], res[2]["height"] = 1200, 900   # too small by the API's own size: skipped
            res[3]["width"] = res[3]["height"] = None        # size unknown: the small download is refused after
            res[3]["url"] = "https://img.example/small.jpg"
            return json.dumps({"results": res}).encode()
        if url.endswith("small.jpg"):
            return jpeg(1000, 700)
        return jpeg(2400, 1800, seed=len(self.calls))


def test_bg_fetch_brings_licensed_large_photos_for_the_short_categories(work):
    fake, slept, prepared = FakeOpenverse(), [], []
    got = bgfetch.fetch(work, limit=5, http=fake, sleep=slept.append, prepare=prepared.append)
    assert sum(got["fetched"].values()) == 5 and not got["offline"]
    assert len(slept) == len(fake.calls) and all(s == bgfetch.PAUSE for s in slept)   # a pause before every request
    assert prepared == [work]                                                           # the bank made ready
    cat = gb.load(work)["files"]
    assert len(cat) == 5
    for name, e in cat.items():
        assert e["licence"] == "cc0" and e["url"].startswith("https://example.org/") and e["category"] in bgfetch.QUERIES
        im = Image.open(work / "backgrounds" / name)
        assert max(im.size) >= gb.MIN_SIDE and max(im.size) <= bgfetch.MAX_SIDE
    src = json.loads((work / "backgrounds" / "sources.json").read_text(encoding="utf-8"))
    assert {s["file"] for s in src} == set(cat) and all(s["query"] and s["license"] == "cc0" for s in src)
    assert got["waiting"] == 5 and bgfetch.waiting(work) == 5
    assert "wait to be pushed" in " ".join(gneeds.collect(work)["notes"])
    assert not (work / "gen" / "bg-fetch").exists()                                     # the staging folders emptied
    # a bucket pull that brought an older sources.json keeps the fetched photos' entries
    (work / "backgrounds" / "sources.json").write_text("[]", encoding="utf-8")
    assert bgfetch.reapply(work) == 5
    assert len(json.loads((work / "backgrounds" / "sources.json").read_text(encoding="utf-8"))) == 5
    bgfetch.mark_pushed(work)
    assert bgfetch.waiting(work) == 0
    # the next run goes on from the next page, never fetching a photo twice
    got2 = bgfetch.fetch(work, limit=3, http=fake, sleep=lambda s: None, prepare=lambda w: None)
    assert sum(got2["fetched"].values()) == 3 and len(gb.load(work)["files"]) == 8


def test_bg_fetch_without_network_exits_0_with_a_note(work, monkeypatch):
    got = bgfetch.fetch(work, http=FakeOpenverse(offline=True), sleep=lambda s: None, prepare=lambda w: None)
    assert got["offline"] and not got["fetched"] and not gb.load(work)["files"]
    assert "no network" in " ".join(gneeds.collect(work)["notes"])
    from gen.__main__ import main
    monkeypatch.setattr(bgfetch, "http_get", FakeOpenverse(offline=True))
    monkeypatch.setattr(bgfetch.time, "sleep", lambda s: None)
    assert main(["bg", "fetch", "--limit", "2"]) == 0


def test_bg_fetch_names_the_project_and_its_queries_map_to_their_categories(monkeypatch):
    seen = {}

    class R:
        def __init__(self, req):
            seen["ua"] = req.get_header("User-agent")

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self, n):
            return b"{}"
    monkeypatch.setattr(bgfetch.urllib.request, "urlopen", lambda req, timeout=30: R(req))
    assert bgfetch.http_get(bgfetch.API) == b"{}" and "OutStaff-scan-train" in seen["ua"]
    for cat, qs in bgfetch.QUERIES.items():
        assert all(gb.auto_category(q) == cat for q in qs), cat


def test_a_category_no_free_source_fills_is_the_owners(work):
    class Empty:
        def __call__(self, url):
            return json.dumps({"results": []}).encode()
    for _ in range(2):
        bgfetch.fetch(work, limit=200, http=Empty(), sleep=lambda s: None, prepare=lambda w: None)
    needs = gneeds.collect(work)["needsOwner"]
    assert len(needs) == len(bgfetch.QUERIES) and all("--owner" in x for x in needs)


# ---------- gen ablate ----------
class FakeExam:
    """runner(capture) → the real exam's figure: each effect in `hurts` makes the error larger when on."""

    def __init__(self, hurts=(), fail_after=None, n=50):
        self.hurts, self.calls, self.fail_after, self.n = set(hurts), [], fail_after, n

    def __call__(self, cap):
        if self.fail_after is not None and len(self.calls) >= self.fail_after:
            raise gab.TrialFailed("stopped")
        self.calls.append(cap)
        fx = cap["effects"]
        err = 0.05 + sum(0.01 for e in self.hurts if fx[e]) - sum(0.01 for e in gcap.EFFECTS if e not in self.hurts and fx[e])
        return {"mean": round(err, 5), "n": self.n}


def test_ablate_runs_once_every_4_cycles_and_keeps_only_what_helps_the_real_exam(work):
    ex = FakeExam(hurts={"mip"})
    got = gab.ablate(work, cycle="c1", runner=ex)
    assert got["ran"] and set(got["decided"]) == {"mip", "shadow"}            # PER_RUN, in the table's order at first
    assert got["decided"] == {"mip": "hurts", "shadow": "helps"}
    assert len(ex.calls) == 3                                                   # today's settings once, then each one off
    st = gab.load(work)
    assert st["effects"]["mip"]["on"] is False and st["effects"]["shadow"]["on"] is True
    assert gcap.settings(work)["capture"]["effects"]["mip"] is False            # the next training run draws without it
    assert gab.ablate(work, cycle="c1", runner=ex)["ran"] is False             # the same cycle: counted once
    for c in ("c2", "c3", "c4"):
        r = gab.ablate(work, cycle=c, runner=ex)
        assert r["ran"] is False
    r = gab.ablate(work, cycle="c5", runner=ex)
    assert r["ran"] and set(r["decided"]) == {"glare", "jpeg"}                  # the ones tested longest ago
    notes = gneeds.collect(work)["notes"]
    assert any("glare" in x for x in notes)


def test_a_stopped_ablation_goes_on_with_the_trials_it_kept(work):
    ex = FakeExam(fail_after=2)
    r = gab.ablate(work, cycle="a", runner=ex)
    assert r["failed"] and gab.load(work)["current"] and len(gab.load(work)["current"]["trials"]) == 2
    ex2 = FakeExam()
    r = gab.ablate(work, cycle="b", runner=ex2)
    assert r["ran"] and not r["failed"] and len(ex2.calls) == 1               # only the trial still missing
    assert gab.load(work)["current"] is None


def test_too_few_real_exam_pages_decide_nothing():
    assert gab.verdict({"mean": 0.02, "n": 5}, {"mean": 0.09, "n": 5})[0] == "unclear"
    assert gab.verdict({"mean": 0.05, "n": 50}, {"mean": 0.051, "n": 50})[0] == "unclear"
    assert gab.verdict({"mean": 0.04, "n": 50}, {"mean": 0.05, "n": 50})[0] == "helps"
    assert gab.verdict({"mean": 0.06, "n": 50}, {"mean": 0.05, "n": 50})[0] == "hurts"
    rep = {"models": {gab.MODEL: {"users": {"after": {"mean": 0.03, "n": 40}}, "e2": {"after": {"mean": 0.5, "n": 300}}}}}
    assert gab.real_score(rep) == {"mean": 0.03, "n": 40}


def test_the_trials_run_in_a_home_of_their_own_and_never_touch_what_they_link(work):
    (work / "real").mkdir()
    (work / "real" / "index.jsonl").write_text("{}\n", encoding="utf-8")
    (work / "models").mkdir()
    (work / "gen" / "runs" / "edges-s7-n300-exam").mkdir(parents=True)
    (work / "gen" / "runs" / "edges-s7-n300-exam" / "run.json").write_text("{}", encoding="utf-8")
    (work / "new").mkdir()
    (work / "new" / "edges-lite.onnx").write_bytes(b"the cycle's own model")
    calls = []

    def run(argv, cwd=None, env=None):
        calls.append((argv, env["SCAN_TRAIN_HOME"]))
        h = pathlib.Path(env["SCAN_TRAIN_HOME"])
        if argv[1] == "exam.py":
            (h / "report.json").write_text(json.dumps({"models": {gab.MODEL: {"users": {"after": {"mean": 0.02, "n": 30}}}}}),
                                           encoding="utf-8")
        if argv[1] == "train.py":
            (h / "new").mkdir(exist_ok=True)
            (h / "new" / "edges-lite.onnx").write_bytes(b"a trial's model")
        return types.SimpleNamespace(returncode=0)
    t = gab.Trials(work, python="py", run=run)
    got = t(gcap.normal(None))
    assert got["mean"] == 0.02 and got["n"] == 30
    home_ = str(work / "gen" / "ablation" / "home")
    assert all(h == home_ for _, h in calls)
    steps = [a[1] if a[1] != "-m" else " ".join(a[2:4]) for a, _ in calls]
    assert steps == ["gen build", "gen qa", "gen mix", "train.py", "exam.py"]
    assert "--capture" in calls[0][0]
    assert (work / "new" / "edges-lite.onnx").read_bytes() == b"the cycle's own model"
    assert gab._is_link(work / "gen" / "ablation" / "home" / "real")
    t.close()
    assert not (work / "gen" / "ablation" / "home").exists()
    assert (work / "real" / "index.jsonl").exists() and (work / "gen" / "runs" / "edges-s7-n300-exam" / "run.json").exists()

    def bad(argv, cwd=None, env=None):
        return types.SimpleNamespace(returncode=1)
    with pytest.raises(gab.TrialFailed):
        gab.Trials(work, python="py", run=bad)(gcap.normal(None))


# ---------- needs and clean.py ----------
def test_needs_are_listed_until_solved_and_clean_keeps_the_generators_state(work, monkeypatch):
    gneeds.need(work, "effect:noise", "a new effect for noise", "tune")
    gneeds.need(work, "effect:noise", "a new effect for noise", "tune")
    assert gneeds.collect(work)["needsOwner"] == ["a new effect for noise"]
    gneeds.resolve(work, "effect:noise")
    assert gneeds.collect(work)["needsOwner"] == []
    gneeds.note(work, "tune", ["moved"])
    assert gneeds.collect(work, since="2999-01-01")["notes"] == []
    import common
    monkeypatch.setattr(common, "WORK", work)
    gcap.write(work / "gen" / "tune.json", {"capture": {}})
    (work / "gen" / "runs" / "x").mkdir(parents=True)
    (work / "new").mkdir()
    common.clear_work()
    assert sorted(p.name for p in (work / "gen").iterdir()) == ["needs.json", "notes", "tune.json"]
    assert not (work / "new").exists()


# ---------- the review's checks ----------
def test_collect_compares_the_cycles_start_as_an_instant_whatever_its_offset(work):
    import datetime
    at = datetime.datetime(2026, 10, 25, 1, 30, tzinfo=datetime.timezone.utc)
    gneeds.note(work, "tune", ["moved"], now=at)
    # 03:00 in Israel (+02:00) is 01:00 UTC: the note (01:30 UTC) came after the start, though "01:30" < "03:00" as text
    assert gneeds.collect(work, since="2026-10-25T03:00:00+02:00")["notes"] == ["tune: moved"]
    assert gneeds.collect(work, since="2026-10-25T01:00:00Z")["notes"] == ["tune: moved"]
    assert gneeds.collect(work, since="2026-10-25T04:00:00+02:00")["notes"] == []
    assert gneeds.collect(work, since=at)["notes"] == ["tune: moved"]


def test_a_trial_that_keeps_failing_is_given_up_and_waits_for_its_next_turn(work):
    calls = []

    def broken(cap):
        calls.append(cap)
        raise gab.TrialFailed("train.py exited 1")
    for k in range(gab.MAX_FAILED - 1):
        r = gab.ablate(work, cycle=f"x{k}", runner=broken)
        assert r["failed"] and gab.load(work)["current"]
    r = gab.ablate(work, cycle="xlast", runner=broken)
    st = gab.load(work)
    assert r["failed"] and st["current"] is None and st["calls"] == 0 and st["lastRun"]["failed"]
    assert all(st["effects"][e]["on"] for e in gcap.EFFECTS)                    # nothing switched by a failure
    assert "given up" in " ".join(gneeds.collect(work)["notes"])
    n = len(calls)
    assert gab.ablate(work, cycle="next", runner=broken)["ran"] is False and len(calls) == n   # not every night


def test_bg_fetch_comes_back_to_a_page_it_left_half_way(work):
    bgfetch.fetch(work, limit=1, http=FakeOpenverse(), sleep=lambda s: None, prepare=lambda w: None)
    pages = bgfetch.load_state(work)["pages"]
    assert pages and all(p == 1 for p in pages.values())     # one photo of page 1 taken, the rest of it still to see


def test_tune_never_asks_for_the_other_kind(work, monkeypatch):
    from gen import real as greal
    rows = [{"split": "train", "targets": {"doctype": {"doctype": "other"}}},
            {"split": "train", "targets": {"doctype": {"doctype": "passport"}}}]
    monkeypatch.setattr(greal, "read_index", lambda folder: rows)
    assert gtune.missing_kinds(work, {"counts": {"byClass": {"id_front": 3}}}) == {"passport": 1}
