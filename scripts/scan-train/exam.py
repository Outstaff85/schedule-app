"""Step 3 of /scan-train: the exam — the examples kept apart (never trained on) are
read by the old models (the lab's version) and the new ones; for each model: the
mean corner error (the farthest corner from where the user put it, 0..1 of the
part), the share within 2 % and the share not found. Writes ~/.scan-train/report.json
and prints "before → after"."""

import cv2
import numpy as np
import onnxruntime as ort

from common import MODELS, WORK, model_path, read_json, version_of, write_json

import docfind  # the corner reading (once the server's, kept here for the exam)


def score(path, examples):
    sess = ort.InferenceSession(str(path))
    errs = []
    for e in examples:
        img = cv2.imread(e["file"])
        if img is None:
            continue
        pts, conf = docfind.detect(sess, img)
        if not docfind.good_quad(pts, conf):
            errs.append(1.0)
            continue
        errs.append(float(max(np.hypot(p[0] - q[0], p[1] - q[1]) for p, q in zip(pts, e["fixed"]))))
    errs = np.array(errs) if errs else np.array([1.0])
    return {"n": int(len(errs)), "mean": round(float(errs.mean()), 4), "within2": round(float((errs <= 0.02).mean()), 3),
            "missed": round(float((errs >= 1.0).mean()), 3)}


def main():
    ex = read_json(WORK / "examples.json")
    exam = [e for e in ex if e["exam"]] or ex
    base = version_of("scan-lab")
    report = {"base": base, "examples": len(ex), "exam": len(exam), "models": {}}
    for name in MODELS:
        new = WORK / "new" / name
        if not new.exists():
            continue
        report["models"][name] = {"before": score(model_path(base, name), exam), "after": score(new, exam)}
    write_json(WORK / "report.json", report)
    print(f"Exam: {report['exam']} pages never trained on (of {report['examples']}); base {base}")
    for name, r in report["models"].items():
        b, a = r["before"], r["after"]
        print(f"  {name}: mean corner error {b['mean']:.3f} → {a['mean']:.3f}; within 2 %: {b['within2']:.0%} → {a['within2']:.0%}; not found: {b['missed']:.0%} → {a['missed']:.0%}")
    better = all(r["after"]["mean"] <= r["before"]["mean"] for r in report["models"].values()) and report["models"]
    print("Better on every model: yes" if better else "Better on every model: NO — do not publish")


if __name__ == "__main__":
    main()
