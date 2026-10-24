"""Step 3 of /scan-train: the exam — the examples kept apart (never trained on) are
read by the old models (the lab's version) and the new ones, set by set: the users' own pages
kept apart (pull.py), made-up photos of the owner's real pages kept apart from the training (synth_docs.py
--templates --exam: one page in five, by its name), and up to OPEN_N photos of each open set's exam documents (MIDV-2020's
documents 80–99, SmartDoc's fifth page of each kind: midv.open_exam — real photos of documents
never trained on, so the exam means something before the site has collected pages). For each
model and set: the
mean corner error (the farthest corner from where the user put it, 0..1 of the
part), the share within 2 % and the share not found; from the scan attempts (S8) also
the extra pages found where the user deleted one ("nothing here" — lower is better) and,
on retaken pages, how often the model answers other than the frame the user rejected.
A model is better when it is no worse on any set with pages ("publish" in the report; with no
pages in any set there is nothing to measure: NO). The templates set is "contaminated" for a model whose base chain
(the lab's version, the version its checkpoint was trained from) holds a version heldout.json's "versions" marks
heldout_clean false (v3, v4 and the edges carried in v5 may have seen those pages): the report says so
("contaminated") and it is never the gate alone — with no other set with pages the answer is NO. Writes ~/.scan-train/report.json — with the sha256 of
each new file examined ("model_sha256"; publish.py refuses a report written for another file) —, prints
"before → after", and writes report.html — the
pages where the two models differ most, each with the old corners (red), the new (blue) and
the right ones (green) drawn on it — and opens it in the browser. The page shows workers'
documents: it stays on this PC and is deleted with the copies (publish.py / clean.py)."""
import base64
import pathlib
import random
import webbrowser

import cv2
import numpy as np

from midv import open_exam
from common import MODELS, WORK, model_hashes, model_path, read_json, version_of, write_json
from gen.common import contaminated

import docfind  # the corner reading (once the server's, kept here for the exam)

SHOWN = 10  # pages in the picture report
OPEN_N = 300  # photos of each open set's exam documents examined
SETS = {"users": "the users' pages", "templates": "your documents (made-up photos of the real pages kept apart)",
        "midv": "MIDV-2020 exam documents", "smartdoc": "SmartDoc exam pages"}


def read_all(path, examples):
    """Each example's answer by one model: [(pts or None)]."""
    import onnxruntime as ort   # here, not at the top: score / err are imported where ONNX Runtime is not installed (E4's tests)
    sess = ort.InferenceSession(str(path))
    out = []
    for e in examples:
        img = cv2.imread(e["file"])
        if img is None:
            out.append(None)
            continue
        pts, conf = docfind.detect(sess, img)
        out.append([list(map(float, p)) for p in pts] if docfind.good_quad(pts, conf) else None)
    return out


def err(pts, right):
    return 1.0 if pts is None else docfind.quad_error(pts, right)   # whichever corner the model starts from


def score(answers, examples):
    edges = [(a, e) for a, e in zip(answers, examples) if not e.get("none") and not e.get("hard")]
    errs = np.array([err(a, e["fixed"]) for a, e in edges]) if edges else np.array([1.0])
    none = [a for a, e in zip(answers, examples) if e.get("none")]
    hard = [(a, e) for a, e in zip(answers, examples) if e.get("hard")]
    return {"n": int(len(edges)), "mean": round(float(errs.mean()), 4), "within2": round(float((errs <= 0.02).mean()), 3),
            "missed": round(float((errs >= 1.0).mean()), 3),
            "extra": {"n": len(none), "found": round(sum(a is not None for a in none) / len(none), 3) if none else None},
            "retaken": {"n": len(hard), "other": round(sum(err(a, e["rejected"]) > 0.02 for a, e in hard) / len(hard), 3) if hard else None}}


def picture(e, before, after):
    """The example's photo with the old (red), new (blue) and right (green) corners, as a data URL."""
    img = cv2.imread(e["file"])
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
    return f"""<!doctype html><meta charset="utf-8"><title>Scanner exam</title>
<style>body{{font:15px system-ui;margin:20px;max-width:1100px}}figure{{margin:0 0 18px}}img{{max-width:100%;border-radius:8px}}
.key span{{display:inline-block;width:14px;height:4px;margin:0 4px 3px 12px}}</style>
<h1>Scanner exam — base {report['base']}</h1><p>{report['exam']} pages never trained on: {', '.join(f"{SETS[s]} {n}" for s, n in report['sets'].items())}.</p><ul>{figures}</ul>
<p class="key"><span style="background:#3cc83c"></span>right <span style="background:#e62828"></span>old model <span style="background:#1e78e6"></span>new model</p>
<h2>The {len(shown)} pages where the models differ most</h2>{"".join(rows)}"""


def templates_set():
    """The exam photos of the owner's real pages kept apart (synth_docs.py --templates --exam: never laid on a
    training photo); [] when not drawn here."""
    f = WORK / "synth" / "docs-exam" / "examples.json"
    return read_json(f) if f.exists() else []


def open_set(folder):
    """Up to OPEN_N of an open set's exam examples (midv.open_exam), the same ones every time; [] when not made here."""
    f = WORK / folder / "examples.json"
    if not f.exists():
        return []
    ex = [{**e, "file": str(WORK / folder / "img" / pathlib.Path(e["file"]).name)} for e in read_json(f) if open_exam(e)]
    return random.Random(0).sample(ex, min(OPEN_N, len(ex)))


def chain_of(name, base):
    """The versions a model's exam rests on: the lab's (the "before") and the ones its checkpoint was trained from (its
    info.base and info.from.base — read when torch is here, else left out)."""
    chain = [base]
    try:
        import checkpoint
        info = (checkpoint.load(name) or {}).get("info") or {}
        chain += [info.get("base"), (info.get("from") or {}).get("base")]
    except Exception:
        pass
    return [c for c in chain if c]


def gate(report):
    """publish: no worse on every model and set — and at least one set with pages that is not contaminated."""
    models = report["models"]
    clean = [s for m, sets in models.items() for s, r in sets.items() if not r.get("contaminated") and r["before"]["n"]]
    return bool(report["sets"] and models and clean) and all(
        r["after"]["mean"] <= r["before"]["mean"] for m in models.values() for r in m.values())


def main():
    ex = read_json(WORK / "examples.json") if (WORK / "examples.json").exists() else []
    sets = {"users": [e for e in ex if e["exam"]], "templates": templates_set(), "midv": open_set("midv"), "smartdoc": open_set("smartdoc")}
    sets = {s: pages for s, pages in sets.items() if pages}
    base = version_of("scan-lab")
    report = {"base": base, "examples": len(ex), "exam": sum(map(len, sets.values())), "sets": {s: len(p) for s, p in sets.items()}, "models": {}}
    diffs = []
    for name in MODELS:
        new = WORK / "new" / name
        if not new.exists():
            continue
        report["models"][name] = {}
        dirty = contaminated(chain_of(name, base), name)
        for s, exam in sets.items():
            before, after = read_all(model_path(base, name), exam), read_all(new, exam)
            report["models"][name][s] = {"before": score(before, exam), "after": score(after, exam)}
            if s == "templates" and dirty:
                report["models"][name][s]["contaminated"] = dirty   # its base chain may have seen these pages
                report.setdefault("contaminated", {})[name] = dirty
            for e, b, a in zip(exam, before, after):
                right = e.get("fixed") or e.get("rejected")
                gap = abs(err(b, right) - err(a, right)) if right else float((b is None) != (a is None))
                diffs.append((gap, name, e, b, a))
    report["publish"] = gate(report)
    report["model_sha256"] = model_hashes(report["models"], WORK / "new")   # the exact files examined
    write_json(WORK / "report.json", report)
    print(f"Exam: {report['exam']} pages never trained on — "
          + (", ".join(f"{SETS[s]} {n}" for s, n in report["sets"].items()) or "none") + f"; base {base}")
    if not sets:
        print("  no exam pages: no user's page kept apart, and no MIDV / SmartDoc set here (midv.py, smartdoc.py or datasets_hf.py pull)")
    for name, m in report["models"].items():
        for s, r in m.items():
            b, a = r["before"], r["after"]
            print(f"  {name}, {SETS[s]}: mean corner error {b['mean']:.3f} → {a['mean']:.3f}; within 2 %: {b['within2']:.0%} → {a['within2']:.0%}; not found: {b['missed']:.0%} → {a['missed']:.0%}")
            if r.get("contaminated"):
                print(f"    contaminated: the base chain ({', '.join(r['contaminated'])}) may have seen these pages — never the gate alone")
            if b["extra"]["n"]:
                print(f"    extra pages found where the user deleted one: {b['extra']['found']:.0%} → {a['extra']['found']:.0%} (of {b['extra']['n']})")
            if b["retaken"]["n"]:
                print(f"    retaken pages answered other than the rejected frame: {b['retaken']['other']:.0%} → {a['retaken']['other']:.0%} (of {b['retaken']['n']})")
    print("Better on every model and set: yes" if report["publish"] else "Better on every model and set: NO — do not publish")
    shown = [(n, e, b, a) for _, n, e, b, a in sorted(diffs, key=lambda d: -d[0])[:SHOWN]]
    page = WORK / "report.html"
    page.write_text(report_page(report, shown), encoding="utf-8")
    print(f"The pictures: {page}")
    webbrowser.open(pathlib.Path(page).as_uri())


if __name__ == "__main__":
    main()
