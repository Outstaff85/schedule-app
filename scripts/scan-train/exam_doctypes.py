"""Document types, step 3 (docs/scan-plan.md → S7; /scan-train): the exam — the page copies kept
apart (never trained on) are read by the new document type models and compared with Haiku's
answers on the same pages (the type it gave, kept in each record):
  - type: right answers; how many it is sure of (≥ 0.9) and how right those are;
  - turn: every exam page shown at its 4 quarter turns, the turn back read right;
  - the site's way: the model's type where it is sure, Haiku's elsewhere — against Haiku alone.
A model is worth publishing when the site's way is at least as right as Haiku alone and
its sure turns are right (≥ 98 %); else the next size up is suggested. Writes
~/.scan-train/report_doctypes.json and prints the report."""
import cv2
import numpy as np
import onnxruntime as ort

from common import DOCTYPE_MODELS, DOCTYPE_SIZES, DOCTYPES, WORK, read_json, write_json

SURE, S = 0.9, 256


def read(sess, img):
    x = cv2.cvtColor(cv2.resize(img, (S, S), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB).astype(np.float32) / 255
    k, t = sess.run(None, {"img": x.transpose(2, 0, 1)[None]})
    return k.reshape(-1), t.reshape(-1)


def score(path, exam):
    sess = ort.InferenceSession(str(path))
    right = sure = sure_right = site = haiku = n_h = turns = turn_right = sure_turns = sure_turn_right = 0
    per = {k: [0, 0] for k in DOCTYPES}
    for e in exam:
        img = cv2.imread(e["file"])
        if img is None:
            continue
        kp, _ = read(sess, img)
        k = DOCTYPES[int(kp.argmax())]
        ok = k == e["doctype"]
        right += ok; per[e["doctype"]][0] += ok; per[e["doctype"]][1] += 1
        if kp.max() >= SURE:
            sure += 1; sure_right += ok
        if e.get("by", "haiku") == "haiku":  # Haiku's own answer on this page (not an earlier model's)
            h_ok = e.get("given") == e["doctype"]
            n_h += 1; haiku += h_ok
            site += ok if kp.max() >= SURE else h_ok
        for q in range(4):
            _, tp = read(sess, np.ascontiguousarray(np.rot90(img, -q)) if q else img)
            t_ok = int(tp.argmax()) == (4 - q) % 4
            turns += 1; turn_right += t_ok
            if tp.max() >= SURE:
                sure_turns += 1; sure_turn_right += t_ok
    n = max(1, sum(v[1] for v in per.values()))
    pct = lambda a, b: round(a / b, 3) if b else None
    return {"n": n, "doctype": pct(right, n), "sure": pct(sure, n), "sureRight": pct(sure_right, sure),
            "site": pct(site, n_h), "haiku": pct(haiku, n_h), "haikuPages": n_h, "turn": pct(turn_right, turns), "sureTurnRight": pct(sure_turn_right, sure_turns),
            "byDoctype": {k: pct(v[0], v[1]) for k, v in per.items()}}


def main():
    ex = read_json(WORK / "doctypes.json")
    exam = [e for e in ex if e["exam"]]
    if not exam:
        raise SystemExit("no exam pages — run pull_doctypes.py first")
    archs = read_json(WORK / "new" / "doctypes-arch.json") if (WORK / "new" / "doctypes-arch.json").exists() else {}
    report = {"examples": len(ex), "exam": len(exam), "models": {}}
    for name in DOCTYPE_MODELS:
        p = WORK / "new" / name
        if p.exists():
            report["models"][name] = {"arch": archs.get(name, DOCTYPE_MODELS[name]), **score(p, exam)}
    if not report["models"]:
        raise SystemExit("no document type model trained — run train_doctypes.py first")
    good = {}
    print(f"Exam: {report['exam']} pages never trained on (of {report['examples']})")
    for name, r in report["models"].items():
        good[name] = (r["site"] or 0) >= (r["haiku"] or 0) and (r["sureTurnRight"] or 0) >= 0.98
        print(f"  {name} ({r['arch']}): type right {r['doctype']:.0%}; sure of {r['sure']:.0%}, right on those {r['sureRight'] or 0:.0%}; "
              f"turn right {r['turn']:.0%} (sure ones {r['sureTurnRight'] or 0:.0%})")
        print(f"    the site's way {r['site'] or 0:.0%} vs Haiku alone {r['haiku'] or 0:.0%} on {r['haikuPages']} pages Haiku read → {'better or equal' if good[name] else 'WORSE'}")
        print("    by type: " + ", ".join(f"{k} {v:.0%}" if v is not None else f"{k} —" for k, v in r["byDoctype"].items()))
        if not good[name]:
            i = DOCTYPE_SIZES.index(r["arch"]) if r["arch"] in DOCTYPE_SIZES else -1
            nxt = DOCTYPE_SIZES[i + 1] if 0 <= i < len(DOCTYPE_SIZES) - 1 else None
            flag = "--phone" if name == "doctype-lite.onnx" else "--server"
            print(f"    → train the next size up: python train_doctypes.py --only {'phone' if flag == '--phone' else 'server'} {flag} {nxt}" if nxt
                  else "    → already the largest size: more page copies are needed")
    report["publish"] = all(good.values())
    write_json(WORK / "report_doctypes.json", report)
    print("Worth publishing: yes" if report["publish"] else "Worth publishing: NO — do not publish the document type models yet")


if __name__ == "__main__":
    main()
