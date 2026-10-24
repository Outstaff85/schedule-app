"""Step 3 of /scan-train: the exam of the document edges models — the examples kept apart (never trained on) are read by
the new models (~/.scan-train/new/), by their parent (the version the training started from: --base, by default the
checkpoint's info.base, else the lab's version) and by the lab's version when it is another one, set by set:

  users      E1: the users' own pages kept apart (pull.py; by retake group) — a page whose corners nobody moved ("self":
             the old model's own answer) is not scored: the share of those each model still agrees with is shown apart
             ("agreement"), outside the gate;
  templates  made-up photos of the owner's real pages kept apart (synth_docs.py --templates --exam);
  e2         E2: the held-out templates on the exam backgrounds (python -m gen build --model edges --exam: seed 7,
             gen/runs/edges-s7-n300-exam), shown apart on seen backgrounds (procedural surfaces, in training too) and
             unseen ones (the exam's photos), and by background category;
  midv       E3: up to OPEN_N photos of MIDV-2020's exam documents (80–99) and SmartDoc's fifth page of each kind
  smartdoc   (midv.open_exam). The base DocAligner was trained on MIDV and SmartDoc: their exam documents are seen data for
             it, so these two are only no-regression checks;
  phone      E4: E2's pictures as the phone's camera gives them — each scene drawn again from its run's params at the
             camera's native size (gen/outputs/edges.py native_pictures: the 1920 × 1080 video or the photo at its
             natural size, no JPEG), shrunk to the 256 input by the phone's own path (gen/phone.py frame_to_S with the
             profile's exam kernel: the light model on the live frame, the accurate one on the capture) and kept in
             <home>/cache/e4/<key>/ (key: the run's manifest, the phone profile and the drawing code — phone_key). Not
             examined without an E2 run that can be drawn again (never on stored photos);
  golden     E5: a card lying on its ספח or another sheet — E2's card_on_sheet scenes and gen real's golden attempts — scored
             also by "mixed": the share of answers that are not the right page but take a corner of the other one.

Contaminated: every picture that lays one of the owner's real pages kept apart ("held": all of templates, E2's and so E4's
and golden's pictures that lay a real page) may have been seen by a model whose base chain holds a version heldout.json
marks (v3, v4 and the edges of v5). For such a chain a set holding them is "contaminated": the improvement may count only
on its other pictures (the drawn pages, gen real's golden attempts: "clean", scored apart), never on the whole set.

For each model and set: the mean corner error (the farthest corner from where it should be, 0..1 of the photo), the share
within 2 %, the share not found, the extra pages found where the user deleted one ("nothing here") and, on retaken
pages, how often the model answers other than the frame the user rejected.

The gate (gate(): each rule that fails is printed):
- new/ must differ by sha256 from both the parent's file and the lab's ("unchanged model — nothing to publish");
- midv / smartdoc: no regression beyond the tolerance — mean at most +0.002, within 2 % at most −0.01, not found not
  higher;
- users, templates, e2, phone, golden: not worse on any measure — mean, within 2 %, not found, the extra pages and the
  retaken pages when they have pages, mixed when it was measured;
- at least one set that is not saturated (within 2 % under 99 % before) and not an open one gets better by more than the
  noise margin: the mean corner error lower by more than 10 % (or golden's mixed share) — on a contaminated set only its
  clean part counts;
- each against the parent and against the lab's version when it is another one; with no set with pages: NO.

The exam sets are pinned in exam_sets.json (gen/exam_sets.py): a drawn set made under another heldout.json is refused
until it is drawn again; the parent's and the lab's answers are kept per set and examined again whenever a set's
manifest, heldout.json or the reader changes (reader_of: docfind.py, gen/phone.py and the phone profile's file; for E4
also its inputs' key) — so the parent and new/ are always read the same way. Writes exam_rows.jsonl (one row per photo, model and version), ~/.scan-train/report.json
— with the sha256 of each new file examined ("model_sha256"; publish.py refuses a report written for another file), the
parent's and the lab's ("files") and the rules that failed ("failed") —, prints "parent → new", and writes report.html: the
pages where the parent and the new model differ most, the parent's corners red, the new blue, the right ones green; it
stays on this PC (deleted with the copies)."""
import argparse
import base64
import json
import pathlib
import random
import webbrowser

import cv2
import numpy as np

from midv import open_exam
from common import MODELS, WORK, model_hashes, model_path, read_json, sha256_of, version_of, write_json
from gen import exam_sets as es
from gen.common import contaminated

import docfind  # the corner reading (once the server's, kept here for the exam)

SHOWN = 10  # pages in the picture report
OPEN_N = 300  # photos of each open set's exam documents examined
SETS = {"users": "the users' pages (E1)", "templates": "your documents (made-up photos of the real pages kept apart)",
        "e2": "held-out templates on exam backgrounds (E2)", "midv": "MIDV-2020 exam documents (E3)",
        "smartdoc": "SmartDoc exam pages (E3)", "phone": "the phone's input path (E4)", "golden": "a card on its sheet (E5)"}
OPEN = ("midv", "smartdoc")          # seen by the base model: no-regression checks only
TOL_MEAN, TOL_WITHIN2 = 0.002, 0.01  # the open sets' tolerance
SATURATED = 0.99                     # within 2 % before at least this: nothing to improve there
MARGIN = 0.10                        # a strict improvement: more than 10 % lower (relative)
PHONE_OP = {"edges-lite.onnx": "live", "edges.onnx": "capture"}   # the input each model gets on the phone
PHONE_OPS = ("live", "capture")
READER = ("docfind.py", "gen/phone.py")   # the code that turns a picture into corners (with the phone profile)
# the code E4's inputs are drawn with: the scene drawn again at native size, then frame_to_S
E4_CODE = ("gen/scene.py", "gen/camera.py", "gen/pages.py", "gen/backgrounds.py", "gen/rng.py", "gen/phone.py",
           "gen/phone_run.py", "gen/outputs/edges.py")


def read_all(path, examples, resize=None):
    """Each example's answer by one model: [(pts or None)] — the picture shrunk by INTER_AREA, or by the phone's path
    (resize "live" / "capture"); an E4 example's input for that path ("phone": the 256 square already made from the
    native frame by frame_to_S) is read as it is."""
    import onnxruntime as ort   # here, not at the top: score / err are imported where ONNX Runtime is not installed (E4's tests)
    sess = ort.InferenceSession(str(path))
    out = []
    for e in examples:
        made = (e.get("phone") or {}).get(resize) if resize else None
        img = cv2.imread(made or e["file"])
        if img is None:
            out.append(None)
            continue
        pts, conf = docfind.detect(sess, img, resize) if resize and not made else docfind.detect(sess, img)
        out.append([list(map(float, p)) for p in pts] if docfind.good_quad(pts, conf) else None)
    return out


def _profile_sha():
    from gen import phone
    return phone.load_profile().get("_sha256")


def reader_of(*extra):
    """The reader's fingerprint the kept answers are tied to (gen/exam_sets.py reader_sha): docfind.py, gen/phone.py and
    the phone profile's file, and extra (E4's inputs' key)."""
    return es.reader_sha(READER, (_profile_sha(),) + extra)


def phone_key(run):
    """The key of E4's inputs: the run's manifest, the phone profile and the code that draws them (E4_CODE)."""
    return es.reader_sha([pathlib.Path(run) / "manifest.jsonl", *E4_CODE], [_profile_sha()])


def _name(f):
    return str(f).replace("\\", "/").rsplit("/", 1)[-1]


def phone_set(run, e2, work=None):
    """E4: ([E2's examples, each with "phone": {live, capture: its 256 input}], the inputs' key) — each scene drawn
    again from the run's params at the camera's native size (gen/outputs/edges.py native_pictures) and shrunk by
    frame_to_S (the profile's exam kernel), kept as PNG in <work>/cache/e4/<key>/ and drawn only when missing. ([], None)
    when there is no E2 run or it cannot be drawn again (no params in its run.json)."""
    from gen import phone
    from gen.manifest import read_run
    if not run or not e2:
        return [], None
    params = (read_run(run) or {}).get("params") or {}
    if "seed" not in params or "photos" not in params:
        print(f"  E4: {pathlib.Path(run).name} cannot be drawn again (no params in its run.json) — the phone's path not examined")
        return [], None
    key = phone_key(run)
    folder = pathlib.Path(work or WORK) / "cache" / "e4" / key[:16]
    by = {}
    for e in e2:
        try:
            by.setdefault(int(str(e.get("manifest")).rsplit("-", 1)[-1]), []).append(e)
        except ValueError:
            continue
    tools_, out, drawn = None, [], 0

    def made(e, op):
        return folder / f"{_name(e['file']).rsplit('.', 1)[0]}-{op}.png"
    for i, ents in sorted(by.items()):
        if not all(made(e, op).exists() for e in ents for op in PHONE_OPS):
            from gen.outputs import edges as ge
            tools_ = tools_ or ge.tools(params)
            pics = ge.native_pictures(params, i, tools_)
            folder.mkdir(parents=True, exist_ok=True)
            for e in ents:
                img = pics.get(_name(e["file"]))
                for op in PHONE_OPS if img is not None else ():
                    cv2.imwrite(str(made(e, op)), phone.frame_to_S(img, op))
            drawn += 1
        out += [{**e, "phone": {op: str(made(e, op)) for op in PHONE_OPS}, "from": "native"}
                for e in ents if all(made(e, op).exists() for op in PHONE_OPS)]
    if drawn:
        print(f"  E4: {drawn} scenes of {pathlib.Path(run).name} drawn again at the camera's native size → the phone's 256 inputs in {folder}")
    return out, key


def err(pts, right):
    return 1.0 if pts is None else docfind.quad_error(pts, right)   # whichever corner the model starts from


def mixed(pts, right, other):
    """An answer that is not the right page (more than 2 % off) yet takes a corner of the other page in sight (within
    2 %): the card and its sheet mixed into one frame."""
    if pts is None or other is None or err(pts, right) <= 0.02:
        return False
    p, o = np.asarray(pts, float), np.asarray(other, float)
    return bool(min(float(np.hypot(*(o - q).T).min()) for q in p) <= 0.02)


def score(answers, examples):
    edges = [(a, e) for a, e in zip(answers, examples) if not e.get("none") and not e.get("hard")]
    errs = np.array([err(a, e["fixed"]) for a, e in edges]) if edges else np.array([1.0])
    none = [a for a, e in zip(answers, examples) if e.get("none")]
    hard = [(a, e) for a, e in zip(answers, examples) if e.get("hard")]
    pair = [(a, e) for a, e in edges if e.get("other")]
    out = {"n": int(len(edges)), "mean": round(float(errs.mean()), 4), "within2": round(float((errs <= 0.02).mean()), 3),
           "missed": round(float((errs >= 1.0).mean()), 3),
           "extra": {"n": len(none), "found": round(sum(a is not None for a in none) / len(none), 3) if none else None},
           "retaken": {"n": len(hard), "other": round(sum(err(a, e["rejected"]) > 0.02 for a, e in hard) / len(hard), 3) if hard else None}}
    if pair:
        out["mixed"] = {"n": len(pair), "rate": round(sum(mixed(a, e["fixed"], e["other"]) for a, e in pair) / len(pair), 3)}
    return out


def ok_of(a, e):
    """(error, ok) of one answer: the corner error and within 2 %; nothing here → found nothing; a retaken page → other
    than the rejected frame (no error measured: None)."""
    if e.get("none"):
        return None, a is None
    if e.get("hard"):
        return None, err(a, e["rejected"]) > 0.02
    x = err(a, e["fixed"])
    return x, x <= 0.02


# ---------- the gate ----------
def _has_pages(r):
    return bool(r["n"] or r["extra"]["n"] or r["retaken"]["n"])


def _worse(kind, b, a):
    """What set result `a` (after) does worse than `b` (before), by the set's rules: [lines]."""
    out = []
    if kind == "open":
        if a["mean"] > b["mean"] + TOL_MEAN:
            out.append(f"mean corner error {b['mean']:.4f} → {a['mean']:.4f} (more than +{TOL_MEAN})")
        if a["within2"] < b["within2"] - TOL_WITHIN2:
            out.append(f"within 2 % {b['within2']:.1%} → {a['within2']:.1%} (more than −{TOL_WITHIN2:.0%})")
        if a["missed"] > b["missed"]:
            out.append(f"not found {b['missed']:.1%} → {a['missed']:.1%}")
        return out
    if b["n"]:
        if a["mean"] > b["mean"]:
            out.append(f"mean corner error {b['mean']:.4f} → {a['mean']:.4f}")
        if a["within2"] < b["within2"]:
            out.append(f"within 2 % {b['within2']:.1%} → {a['within2']:.1%}")
        if a["missed"] > b["missed"]:
            out.append(f"not found {b['missed']:.1%} → {a['missed']:.1%}")
    if b["extra"]["n"] and (a["extra"]["found"] or 0) > (b["extra"]["found"] or 0):
        out.append(f"extra pages found {b['extra']['found']:.0%} → {a['extra']['found']:.0%}")
    if b["retaken"]["n"] and (a["retaken"]["other"] or 0) < (b["retaken"]["other"] or 0):
        out.append(f"retaken pages answered other than the rejected frame {b['retaken']['other']:.0%} → {a['retaken']['other']:.0%}")
    if (b.get("mixed") or {}).get("n") and (a.get("mixed") or {}).get("rate", 0) > b["mixed"]["rate"]:
        out.append(f"mixed corners {b['mixed']['rate']:.0%} → {a['mixed']['rate']:.0%}")
    return out


def _better(b, a):
    """A strict improvement on a set that is not saturated: the mean (or the mixed share) lower by more than MARGIN."""
    if not b["n"] or b["within2"] >= SATURATED:
        return False
    if b["mean"] - a["mean"] > MARGIN * b["mean"]:
        return True
    m0, m1 = (b.get("mixed") or {}).get("rate"), (a.get("mixed") or {}).get("rate")
    return bool(m0) and m1 is not None and m0 - m1 > MARGIN * m0


def kind_of(s):
    return "open" if s in OPEN else "strict"


def improvable(r):
    """The part of a set an improvement may count on: the whole set, or — contaminated — only its pictures that lay no
    held-out real page ("clean"; None when it has none)."""
    return r.get("clean") if r.get("contaminated") else r


def gate(report):
    """(publish, [the rules that failed]) — the rules in the module's docstring."""
    fails = []
    models = report.get("models") or {}
    if not models:
        return False, ["no new model in new/ to examine"]
    unchanged = set()
    for name, f in (report.get("files") or {}).items():
        same = [w for w in ("parent", "lab") if f.get(w) and f.get("new") == f[w]]
        if same:
            unchanged.add(name)
            fails.append(f"{name}: unchanged model — nothing to publish (new/{name} is the very file of the "
                         + " and ".join(f"{w} {f.get(w + 'Version')}" for w in same) + ")")
    if unchanged == set(models):
        return False, fails
    if not any(_has_pages(r["before"]) for sets in models.values() for r in sets.values()):
        fails.append("no exam pages in any set")
    for name, sets in models.items():
        if name in unchanged:
            continue
        for ref, label in (("before", "the parent"), ("lab", "the lab's version")):
            if not any(ref in r for r in sets.values()):
                continue
            for s, r in sets.items():
                if ref in r:
                    fails += [f"{name}, {s} vs {label}: {w}" for w in _worse(kind_of(s), r[ref], r["after"])]
            if not any(p is not None and ref in p and _better(p[ref], p["after"]) for s, r in sets.items()
                       if s not in OPEN for p in [improvable(r)]):
                fails.append(f"{name} vs {label}: no set that is not saturated (within 2 % under {SATURATED:.0%}) and not "
                             f"MIDV / SmartDoc got better by more than {MARGIN:.0%} (on a contaminated set: its clean part only)")
    return not fails, fails


# ---------- the sets ----------
def _local(e, folder):
    return {**e, "file": str(pathlib.Path(folder) / "img" / str(e["file"]).replace("\\", "/").rsplit("/", 1)[-1])}


def templates_set():
    """The exam photos of the owner's real pages kept apart (synth_docs.py --templates --exam: never laid on a
    training photo); [] when not drawn here."""
    f = WORK / "synth" / "docs-exam" / "examples.json"
    if not f.exists():
        return []
    drawn = (f.parent / "manifest.jsonl").exists()   # drawn through gen build: each photo's manifest row has its id
    return [{**e, "manifest": e.get("manifest") or (e.get("id") if drawn else None), "held": True} for e in read_json(f)]


def open_set(folder):
    """Up to OPEN_N of an open set's exam examples (midv.open_exam), the same ones every time; [] when not made here."""
    f = WORK / folder / "examples.json"
    if not f.exists():
        return []
    ex = [_local(e, WORK / folder) for e in read_json(f) if open_exam(e)]
    return random.Random(0).sample(ex, min(OPEN_N, len(ex)))


def users_sets(ex):
    """(the users' exam pages scored, those whose corners nobody moved — the old model's own answer, shown apart)."""
    exam = [e for e in ex if e.get("exam")]
    return [e for e in exam if not e.get("self")], [e for e in exam if e.get("self") and e.get("fixed")]


def _manifest(folder):
    rows = {}
    p = pathlib.Path(folder) / "manifest.jsonl"
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            try:
                r = json.loads(line)
            except ValueError:
                continue
            rows[r.get("id")] = r
    return rows


def e2_set(run):
    """E2's pictures (a gen build --model edges --exam run): every example but the partial ones, each with its
    background's kind (a photo: unseen — the exam's photos; procedural: seen) and category, and, on a card lying on a
    sheet, the other page's corners ("other": the card's, on the frame)."""
    if not run:
        return []
    f = pathlib.Path(run) / "examples.json"
    if not f.exists():
        return []
    rows = _manifest(run)
    out = []
    for e in read_json(f):
        if e.get("partial"):
            continue
        m = rows.get(e.get("manifest")) or {}
        bg = m.get("backgroundId")
        e = {**_local(e, run), "bgKind": None if not bg else "procedural" if bg == "procedural" else "photo",
             "bgCategory": m.get("bgCategory"), "held": bool(e.get("templates") or e.get("templateSha1"))}   # lays a real page kept apart
        if e.get("recipe") == "card_on_sheet" and e.get("role") == "answer" and e.get("fixed"):
            card = next((d for d in (m.get("labels") or {}).get("docs") or [] if d.get("role") == "inside"), None)
            if card:
                e["other"] = card.get("quadModel")
        out.append(e)
    return out


def golden_set(e2, work=None):
    """E5: E2's card_on_sheet pictures (the frame and the card cut from its sheet) and gen real's golden attempts."""
    out = [e for e in e2 if e.get("recipe") == "card_on_sheet"]
    p = pathlib.Path(work or WORK) / "real" / "index.jsonl"
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            try:
                r = json.loads(line)
            except ValueError:
                continue
            t = (r.get("targets") or {}).get("edges") or {}
            if r.get("split") == "golden" and t.get("fixed"):
                out.append({"id": r["id"], "file": str(p.parent / r["file"]), "fixed": t["fixed"], "none": False, "held": False})
    return out


def parent_of(name, lab):
    """The version a model was trained from: its checkpoint's info.base (read when torch is here), else the lab's."""
    try:
        import checkpoint
        info = (checkpoint.load(name) or {}).get("info") or {}
        return info.get("base") or lab
    except Exception:
        return lab


def chain_of(name, base):
    """The versions a model's exam rests on: the parent and the ones its checkpoint was trained from (its info.base and
    info.from.base — read when torch is here, else left out)."""
    chain = [base]
    try:
        import checkpoint
        info = (checkpoint.load(name) or {}).get("info") or {}
        chain += [info.get("base"), (info.get("from") or {}).get("base")]
    except Exception:
        pass
    return [c for c in dict.fromkeys(chain) if c]


def _file(version, name):
    """(path, sha256) of a version's model on this PC (fetched when missing), (None, None) when it has none."""
    try:
        p = model_path(version, name)
    except SystemExit:
        return None, None
    return p, sha256_of(p)


# ---------- the picture report ----------
def picture(e, before, after):
    """The example's photo with the parent's (red), new (blue) and right (green) corners, as a data URL."""
    img = cv2.imread(e["file"])
    if img is None:
        return ""
    h, w = img.shape[:2]
    k = 720 / max(h, w)
    img = cv2.resize(img, (int(w * k), int(h * k)))
    h, w = img.shape[:2]
    for q, colour in ((e.get("fixed"), (60, 200, 60)), (before, (40, 40, 230)), (after, (230, 120, 30))):
        if q:
            cv2.polylines(img, [np.array([[x * w, y * h] for x, y in q], np.int32)], True, colour, 3)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode()


def report_page(report, shown):
    rows = []
    for name, e, b, a in shown:
        what = "nothing here (a page the user deleted)" if e.get("none") else "a retaken page (the user rejected the red frame)" if e.get("hard") else \
            f"corner error {err(b, e['fixed']):.3f} → {err(a, e['fixed']):.3f}"
        rows.append(f'<figure><img src="{picture(e, b, a)}"><figcaption>{name} · {e["id"]} · {what}</figcaption></figure>')
    figures = "".join(f"<li><b>{n}</b>, {SETS[s]} ({r['before']['n']}): mean corner error {r['before']['mean']:.3f} → {r['after']['mean']:.3f}; within 2 %: "
                      f"{r['before']['within2']:.0%} → {r['after']['within2']:.0%}; not found: {r['before']['missed']:.0%} → {r['after']['missed']:.0%}"
                      + (f" — <b>contaminated</b> ({', '.join(r['contaminated'])} may have seen these pages; never the gate alone)" if r.get("contaminated") else "")
                      + "</li>"
                      for n, sets in report["models"].items() for s, r in sets.items())
    fails = "".join(f"<li>{f}</li>" for f in report.get("failed") or [])
    return f"""<!doctype html><meta charset="utf-8"><title>Scanner exam</title>
<style>body{{font:15px system-ui;margin:20px;max-width:1100px}}figure{{margin:0 0 18px}}img{{max-width:100%;border-radius:8px}}
.key span{{display:inline-block;width:14px;height:4px;margin:0 4px 3px 12px}}</style>
<h1>Scanner exam — parent {report['base']}, lab {report['lab']}</h1><p>{report['exam']} pages never trained on: {', '.join(f"{SETS[s]} {n}" for s, n in report['sets'].items())}.</p><ul>{figures}</ul>
<p><b>{'Worth publishing' if report['publish'] else 'Not worth publishing — the rules that failed:'}</b></p><ul>{fails}</ul>
<p class="key"><span style="background:#3cc83c"></span>right <span style="background:#e62828"></span>parent <span style="background:#1e78e6"></span>new model</p>
<h2>The {len(shown)} pages where the models differ most</h2>{"".join(rows)}"""


def _sub(answers, examples, keep):
    pick = [i for i, e in enumerate(examples) if keep(e)]
    return score([answers[i] for i in pick], [examples[i] for i in pick]) if pick else None


def sets_of(a, ex):
    """{set: [examples]} (only the sets with pages; E4 — "phone" — is added by main once the sets are known fresh:
    phone_set), E2's run, the users' pages nobody corrected."""
    users, own = users_sets(ex)
    run = pathlib.Path(a.e2) if a.e2 else es.latest_run("edges-s7-", WORK)
    e2 = e2_set(run)
    tpl = templates_set()
    sets = {"users": users, "templates": tpl, "e2": e2,
            "midv": [] if a.no_open else open_set("midv"), "smartdoc": [] if a.no_open else open_set("smartdoc"),
            "golden": golden_set(e2)}
    return {s: pages for s, pages in sets.items() if pages}, run, own


def print_report(report, pinned, examined):
    lab = report["lab"]
    print(f"Exam: {report['exam']} pages never trained on — "
          + (", ".join(f"{SETS[s]} {n}" for s, n in report["sets"].items()) or "none") + f"; parent {report['base']}, lab {lab}")
    for s, p in pinned.items():
        if p["status"] != "same":
            print(f"  exam set {s}: {p['status']} — pinned {p['sha256'][:12]} ({p['of']}) in exam_sets.json")
    if examined:
        print("  examined again (a set or heldout.json changed since their answers were kept): " + "; ".join(examined))
    if not report["sets"]:
        print("  no exam pages: no user's page kept apart, no E2 run, no MIDV / SmartDoc set here (midv.py, smartdoc.py or datasets_hf.py pull)")
    for name, m in report["models"].items():
        f = report["files"][name]
        print(f"  {name}: new {f['new'][:12]}, parent {f['parentVersion']} {str(f['parent'])[:12]}, lab {f['labVersion']} {str(f['lab'])[:12]}")
        for s, r in m.items():
            b, an = r["before"], r["after"]
            tag = " (no-regression check)" if s in OPEN else ""
            print(f"    {SETS[s]}{tag}: mean corner error {b['mean']:.3f} → {an['mean']:.3f}; within 2 %: {b['within2']:.0%} → {an['within2']:.0%}; "
                  f"not found: {b['missed']:.0%} → {an['missed']:.0%}" + (" — saturated" if b["n"] and b["within2"] >= SATURATED else ""))
            if "lab" in r:
                print(f"      the lab's version {lab}: mean {r['lab']['mean']:.3f}, within 2 % {r['lab']['within2']:.0%}, not found {r['lab']['missed']:.0%}")
            if r.get("contaminated"):
                c = r.get("clean")
                print(f"      contaminated: the base chain ({', '.join(r['contaminated'])}) may have seen its held-out real pages — "
                      + (f"an improvement counts only on its {c['before']['n']} other pictures: mean {c['before']['mean']:.3f} → "
                         f"{c['after']['mean']:.3f}" if c else "no other picture: it never counts as the improvement"))
            if b["extra"]["n"]:
                print(f"      extra pages found where the user deleted one: {b['extra']['found']:.0%} → {an['extra']['found']:.0%} (of {b['extra']['n']})")
            if b["retaken"]["n"]:
                print(f"      retaken pages answered other than the rejected frame: {b['retaken']['other']:.0%} → {an['retaken']['other']:.0%} (of {b['retaken']['n']})")
            if b.get("mixed"):
                print(f"      mixed corners (card and sheet): {b['mixed']['rate']:.0%} → {an['mixed']['rate']:.0%} (of {b['mixed']['n']})")
            for k, v in ((r.get("byBackground") or {}).get("after") or {}).items():
                if v:
                    print(f"      {k} backgrounds: within 2 % {v['within2']:.0%} of {v['n']}")
        ag = (report.get("agreement") or {}).get(name)
        if ag:
            print(f"    users' pages nobody corrected ({ag['n']}, not the gate): still the old answer — "
                  + ", ".join(f"{w} {ag[w]:.0%}" for w in ("parent", "lab", "new") if w in ag))
    if report["publish"]:
        print("Worth publishing: yes — no rule failed")
    else:
        print("Worth publishing: NO — do not publish. Rules failed:")
        for f in report["failed"]:
            print(f"  - {f}")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", help="the parent version (default: the checkpoint's info.base, else the lab's version)")
    ap.add_argument("--e2", help="E2's run (default: the newest gen/runs/edges-s7-*-exam)")
    ap.add_argument("--no-open", action="store_true", help="leave MIDV / SmartDoc out (they are no-regression checks only)")
    ap.add_argument("--no-browser", action="store_true", help="do not open report.html")
    a = ap.parse_args(argv)
    ex = read_json(WORK / "examples.json") if (WORK / "examples.json").exists() else []
    sets, run, own = sets_of(a, ex)
    es.require_fresh({"templates": "synth/docs-exam" if "templates" in sets else None, "e2": run if "e2" in sets else None}, WORK)
    phone, pkey = phone_set(run, sets.get("e2") or [], WORK)
    if phone:   # E4 after E2, before golden
        sets = {**{s: v for s, v in sets.items() if s != "golden"}, "phone": phone,
                **({"golden": sets["golden"]} if "golden" in sets else {})}
    folders = {"e2": run, "templates": WORK / "synth" / "docs-exam"}   # whole drawn sets: pinned by their manifest.jsonl
    pinned = es.refresh({s: (pages, folders.get(s)) for s, pages in sets.items()}, WORK)
    lab = version_of("scan-lab")
    report = {"lab": lab, "examples": len(ex), "exam": sum(len(p) for s, p in sets.items() if s not in ("phone", "golden")),
              "sets": {s: len(p) for s, p in sets.items()}, "examSets": pinned, "models": {}, "files": {},
              "e2Run": str(run) if run else None, "phoneInputs": pkey, "phoneFrom": "native" if phone else None}
    diffs, rows, examined, bases = [], [], [], {}
    readers = {s: reader_of(pkey) if s == "phone" else reader_of() for s in list(sets) + ["users-self"]}
    for name in MODELS:
        new = WORK / "new" / name
        if not new.exists():
            continue
        base = a.base or parent_of(name, lab)
        bases[name] = base
        p_path, p_sha = _file(base, name)
        if p_path is None:
            raise SystemExit(f"{name} of the parent {base} is not on this PC, Hugging Face or Storage — name the parent with --base")
        l_path, l_sha = _file(lab, name) if lab != base else (p_path, p_sha)
        n_sha = sha256_of(new)
        report["files"][name] = {"new": n_sha, "parent": p_sha, "parentVersion": base, "lab": l_sha, "labVersion": lab}
        report["models"][name] = {}
        if n_sha in (p_sha, l_sha):
            continue   # the very file of the parent or the lab: nothing to examine (gate: unchanged model)
        dirty = contaminated(chain_of(name, base) + [lab], name)
        whos = [("parent", p_path, p_sha, True)] + ([("lab", l_path, l_sha, True)] if lab != base and l_path else []) + \
            [("new", new, n_sha, False)]
        for s, exam in sets.items():
            rz = PHONE_OP.get(name) if s == "phone" else None
            got = {}
            for who, path, msha, keep in whos:
                got[who], fresh = es.answers_of(msha, s + (f"@{rz}" if rz else ""), pinned[s]["sha256"],
                                                lambda: read_all(path, exam, rz), WORK, keep, readers[s])
                if fresh and keep:
                    examined.append(f"{who} {name} on {s}")
                for e, ans in zip(exam, got[who]):
                    x, ok = ok_of(ans, e)
                    rows.append(es.row("edges", name, who, msha, s, e.get("id"), e.get("manifest"), x, ok))
            r = {"before": score(got["parent"], exam), "after": score(got["new"], exam)}
            if "lab" in got:
                r["lab"] = score(got["lab"], exam)
            if s == "e2":
                for who, g in (("before", got["parent"]), ("after", got["new"])):
                    r.setdefault("byBackground", {})[who] = {
                        "unseen": _sub(g, exam, lambda e: e.get("bgKind") not in (None, "procedural")),
                        "seen": _sub(g, exam, lambda e: e.get("bgKind") == "procedural")}
                    r.setdefault("byCategory", {})[who] = {c: _sub(g, exam, lambda e, c=c: str(e.get("bgCategory")) == c)
                                                           for c in sorted({str(e.get("bgCategory")) for e in exam})}
            if dirty and any(e.get("held") for e in exam):   # its held-out real pages: the base chain may have seen them
                r["contaminated"] = dirty
                report.setdefault("contaminated", {})[name] = dirty
                clean = [k for k, e in enumerate(exam) if not e.get("held")]
                if clean:   # the pictures that lay none: the only part an improvement may count on
                    r["clean"] = {w: score([got[x][k] for k in clean], [exam[k] for k in clean])
                                  for w, x in (("before", "parent"), ("after", "new"), ("lab", "lab")) if x in got}
            report["models"][name][s] = r
            for e, b, an in zip(exam, got["parent"], got["new"]):
                right = e.get("fixed") or e.get("rejected")
                gap = abs(err(b, right) - err(an, right)) if right else float((b is None) != (an is None))
                diffs.append((gap, name, e, b, an))
        if own:   # the pages nobody corrected: how often each still gives the old model's own answer (not the gate)
            ag = {"n": len(own)}
            for who, path, msha, keep in whos:
                ans, _ = es.answers_of(msha, "users-self", es.identity(own), lambda: read_all(path, own), WORK, keep,
                                       readers["users-self"])
                ag[who] = round(sum(err(x, e["fixed"]) <= 0.02 for x, e in zip(ans, own)) / len(own), 3)
            report.setdefault("agreement", {})[name] = ag
    report["base"] = ", ".join(sorted(set(bases.values()))) if bases else lab
    report["publish"], report["failed"] = gate(report)
    report["model_sha256"] = model_hashes(report["models"], WORK / "new")   # the exact files examined
    report["examinedAgain"] = examined
    es.write_rows("edges", rows, WORK)
    write_json(WORK / "report.json", report)
    print_report(report, pinned, examined)
    if report["models"]:
        shown = [(n, e, b, a_) for _, n, e, b, a_ in sorted(diffs, key=lambda d: -d[0])[:SHOWN]]
        page = WORK / "report.html"
        page.write_text(report_page(report, shown), encoding="utf-8")
        print(f"The pictures: {page}")
        if not a.no_browser:
            webbrowser.open(pathlib.Path(page).as_uri())
    return report


if __name__ == "__main__":
    main()
