"""Step 3 of /scan-train: the exam — the examples kept apart (never trained on) are
read by the old models (the lab's version) and the new ones; for each model: the
mean corner error (the farthest corner from where the user put it, 0..1 of the
part), the share within 2 % and the share not found; from the scan attempts (S8) also
the extra pages found where the user deleted one ("nothing here" — lower is better) and,
on retaken pages, how often the model answers other than the frame the user rejected.
Writes ~/.scan-train/report.json, prints "before → after", and writes report.html — the
pages where the two models differ most, each with the old corners (red), the new (blue) and
the right ones (green) drawn on it — and opens it in the browser. The page shows workers'
documents: it stays on this PC and is deleted with the copies (publish.py / clean.py)."""
import base64
import pathlib
import webbrowser

import cv2
import numpy as np
import onnxruntime as ort

from common import MODELS, WORK, model_path, read_json, version_of, write_json

import docfind  # the corner reading (once the server's, kept here for the exam)

SHOWN = 10  # pages in the picture report


def read_all(path, examples):
    """Each example's answer by one model: [(pts or None)]."""
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
    return 1.0 if pts is None else float(max(np.hypot(p[0] - q[0], p[1] - q[1]) for p, q in zip(pts, right)))


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
    figures = "".join(f"<li><b>{n}</b>: mean corner error {r['before']['mean']:.3f} → {r['after']['mean']:.3f}; within 2 %: "
                      f"{r['before']['within2']:.0%} → {r['after']['within2']:.0%}; not found: {r['before']['missed']:.0%} → {r['after']['missed']:.0%}</li>"
                      for n, r in report["models"].items())
    return f"""<!doctype html><meta charset="utf-8"><title>Scanner exam</title>
<style>body{{font:15px system-ui;margin:20px;max-width:1100px}}figure{{margin:0 0 18px}}img{{max-width:100%;border-radius:8px}}
.key span{{display:inline-block;width:14px;height:4px;margin:0 4px 3px 12px}}</style>
<h1>Scanner exam — base {report['base']}</h1><p>{report['exam']} pages never trained on (of {report['examples']}).</p><ul>{figures}</ul>
<p class="key"><span style="background:#3cc83c"></span>right <span style="background:#e62828"></span>old model <span style="background:#1e78e6"></span>new model</p>
<h2>The {len(shown)} pages where the models differ most</h2>{"".join(rows)}"""


def main():
    ex = read_json(WORK / "examples.json")
    exam = [e for e in ex if e["exam"]] or ex
    base = version_of("scan-lab")
    report = {"base": base, "examples": len(ex), "exam": len(exam), "models": {}}
    diffs = []
    for name in MODELS:
        new = WORK / "new" / name
        if not new.exists():
            continue
        before, after = read_all(model_path(base, name), exam), read_all(new, exam)
        report["models"][name] = {"before": score(before, exam), "after": score(after, exam)}
        for e, b, a in zip(exam, before, after):
            right = e.get("fixed") or e.get("rejected")
            gap = abs(err(b, right) - err(a, right)) if right else float((b is None) != (a is None))
            diffs.append((gap, name, e, b, a))
    write_json(WORK / "report.json", report)
    print(f"Exam: {report['exam']} pages never trained on (of {report['examples']}); base {base}")
    for name, r in report["models"].items():
        b, a = r["before"], r["after"]
        print(f"  {name}: mean corner error {b['mean']:.3f} → {a['mean']:.3f}; within 2 %: {b['within2']:.0%} → {a['within2']:.0%}; not found: {b['missed']:.0%} → {a['missed']:.0%}")
        if b["extra"]["n"]:
            print(f"    extra pages found where the user deleted one: {b['extra']['found']:.0%} → {a['extra']['found']:.0%} (of {b['extra']['n']})")
        if b["retaken"]["n"]:
            print(f"    retaken pages answered other than the rejected frame: {b['retaken']['other']:.0%} → {a['retaken']['other']:.0%} (of {b['retaken']['n']})")
    better = all(r["after"]["mean"] <= r["before"]["mean"] for r in report["models"].values()) and report["models"]
    print("Better on every model: yes" if better else "Better on every model: NO — do not publish")
    shown = [(n, e, b, a) for _, n, e, b, a in sorted(diffs, key=lambda d: -d[0])[:SHOWN]]
    page = WORK / "report.html"
    page.write_text(report_page(report, shown))
    print(f"The pictures: {page}")
    webbrowser.open(pathlib.Path(page).as_uri())


if __name__ == "__main__":
    main()
