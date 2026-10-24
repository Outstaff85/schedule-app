"""Document types, step 3 (docs/scan-plan.md → S7; /scan-train): the exam — the page copies kept
apart (never trained on) are read by the new phone's document type model (doctype-lite.onnx; owner,
2026-10-24: the only one examined and published) and compared with Haiku's answers on the same pages
(the type it gave, kept in each record):
  - type: right answers; how many it is sure of (≥ 0.9) and how right those are;
  - turn: every exam page shown at its 4 quarter turns, the turn back read right;
  - the site's way: the model's type where it is sure, Haiku's elsewhere — against Haiku alone. A page
    counts as Haiku's only when its record keeps Haiku's own answer ("given", by Haiku); with none,
    site / haiku / haikuPages are null (not measured), never 0.
With the owner's real pages kept apart for the exam (synth.held_out; synth_docs.py --templates --exam's
photos, each document cut by its known corners) the model is read on them too ("your documents") —
the one exam before the site has collected page copies: the type only, by type and by document
("byDocument", keyed by the short sha1 the drawing records for each real page, never its name). The turn
there is null: the known corners start at any corner of the document, so a cut page lies at any turn.
The model is worth publishing when the site's way is at least as right as Haiku alone and its sure
turns are right (≥ 98 %); else the next size up is suggested. Writes ~/.scan-train/report_doctypes.json
— with the sha256 of the model examined ("model_sha256"; publish.py refuses a report written for another
file) — and prints the report."""
import cv2
import numpy as np
import onnxruntime as ort

from common import DOCTYPE_MODELS, DOCTYPE_SIZES, DOCTYPES, WORK, model_hashes, read_json, write_json

EXAM_PHOTOS = WORK / "synth" / "docs-exam" / "examples.json"

SURE, S = 0.9, 256


def read(sess, img):
    x = cv2.cvtColor(cv2.resize(img, (S, S), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB).astype(np.float32) / 255
    k, t = sess.run(None, {"img": x.transpose(2, 0, 1)[None]})
    return k.reshape(-1), t.reshape(-1)


def score(path, exam, turn=True):
    """The model's figures on exam pages ([{"img" or "file", "doctype", optional "given" / "by" / "doc"}]);
    turn=False: the turn is not scored (null). What was not measured is None, never 0."""
    sess = ort.InferenceSession(str(path))
    right = sure = sure_right = site = haiku = n_h = turns = turn_right = sure_turns = sure_turn_right = 0
    per = {k: [0, 0] for k in DOCTYPES}
    docs = {}
    for e in exam:
        img = e["img"] if "img" in e else cv2.imread(e["file"])
        if img is None:
            continue
        kp, _ = read(sess, img)
        k = DOCTYPES[int(kp.argmax())]
        ok = k == e["doctype"]
        right += ok; per[e["doctype"]][0] += ok; per[e["doctype"]][1] += 1
        if e.get("doc"):
            d = docs.setdefault(e["doc"], {"doctype": e["doctype"], "n": 0, "right": 0})
            d["n"] += 1; d["right"] += ok
        if kp.max() >= SURE:
            sure += 1; sure_right += ok
        if e.get("by", "haiku") == "haiku" and "given" in e:  # Haiku's own answer on this page (not an earlier model's)
            h_ok = e.get("given") == e["doctype"]
            n_h += 1; haiku += h_ok
            site += ok if kp.max() >= SURE else h_ok
        if not turn:
            continue
        for q in range(4):
            _, tp = read(sess, np.ascontiguousarray(np.rot90(img, -q)) if q else img)
            t_ok = int(tp.argmax()) == (4 - q) % 4
            turns += 1; turn_right += t_ok
            if tp.max() >= SURE:
                sure_turns += 1; sure_turn_right += t_ok
    n = max(1, sum(v[1] for v in per.values()))
    pct = lambda a, b: round(a / b, 3) if b else None
    return {"n": n, "doctype": pct(right, n), "sure": pct(sure, n), "sureRight": pct(sure_right, sure),
            "site": pct(site, n_h), "haiku": pct(haiku, n_h), "haikuPages": n_h or None,
            "turn": pct(turn_right, turns) if turn else None, "sureTurnRight": pct(sure_turn_right, sure_turns) if turn else None,
            "byDoctype": {k: pct(v[0], v[1]) for k, v in per.items()},
            "byDocument": {d: {"doctype": v["doctype"], "n": v["n"], "right": pct(v["right"], v["n"])} for d, v in sorted(docs.items())}}


def your_documents():
    """The owner's real pages kept apart, cut flat from their exam photos by the known corners:
    [{"img", "doctype"}] (a photo with no document is left out)."""
    if not EXAM_PHOTOS.exists():
        return []
    out = []
    for e in read_json(EXAM_PHOTOS):
        kind = (e.get("kind") or "").split(":")[-1].split("+")[0]
        img = cv2.imread(e["file"])
        if e.get("none") or not e.get("fixed") or kind not in DOCTYPES or img is None:
            continue
        h, w = img.shape[:2]
        q = np.float32([[x * w, y * h] for x, y in e["fixed"]])
        W = int(max(np.linalg.norm(q[1] - q[0]), np.linalg.norm(q[2] - q[3])))
        H = int(max(np.linalg.norm(q[3] - q[0]), np.linalg.norm(q[2] - q[1])))
        M = cv2.getPerspectiveTransform(q, np.float32([[0, 0], [W, 0], [W, H], [0, H]]))
        out.append({"img": cv2.warpPerspective(img, M, (W, H)), "doctype": kind, "doc": e.get("template")})
    return out


def main():
    ex = read_json(WORK / "doctypes.json") if (WORK / "doctypes.json").exists() else []
    exam = [e for e in ex if e["exam"]]
    yours = your_documents()
    if not exam and not yours:
        raise SystemExit("no exam pages — run pull_doctypes.py (and synth_docs.py --templates --exam) first")
    archs = read_json(WORK / "new" / "doctypes-arch.json") if (WORK / "new" / "doctypes-arch.json").exists() else {}
    report = {"examples": len(ex), "exam": len(exam), "yours": len(yours), "models": {}, "yoursModels": {}}
    for name in DOCTYPE_MODELS:
        p = WORK / "new" / name
        if p.exists():
            if exam:
                report["models"][name] = {"arch": archs.get(name, DOCTYPE_MODELS[name]), **score(p, exam)}
            if yours:
                report["yoursModels"][name] = {"arch": archs.get(name, DOCTYPE_MODELS[name]), **score(p, yours, turn=False)}
    if not report["models"] and not report["yoursModels"]:
        raise SystemExit("no document type model trained — run train_doctypes.py first")
    report["model_sha256"] = model_hashes(DOCTYPE_MODELS, WORK / "new")   # the exact file examined
    pc = lambda v: "—" if v is None else f"{v:.0%}"
    if yours:
        print(f"Your documents: {len(yours)} pages cut from the exam photos of the real pages kept apart (never made into a training page)")
        for name, r in report["yoursModels"].items():
            # the turn is not scored here: the known corners start at any corner of the document, so a cut page lies at any turn
            print(f"  {name} ({r['arch']}): type right {pc(r['doctype'])}; sure of {pc(r['sure'])}, right on those {pc(r['sureRight'])}; the turn: not measured here")
            print("    by type: " + ", ".join(f"{k} {pc(v)}" for k, v in r["byDoctype"].items()))
            if r["byDocument"]:
                print(f"    by document ({len(r['byDocument'])}): " + ", ".join(f"{d} {v['doctype']} {pc(v['right'])} of {v['n']}" for d, v in r["byDocument"].items()))
            else:
                print("    by document: the exam photos name no document (drawn before synth_docs.py recorded it: draw them again with --templates --exam)")
    if not exam:
        report["publish"] = None
        write_json(WORK / "report_doctypes.json", report)
        print("No page copies from the site kept apart yet: nothing to set against Haiku — the lab (then the site's shadow) shows how it does")
        return
    good = {}
    print(f"Exam: {report['exam']} pages never trained on (of {report['examples']})")
    for name, r in report["models"].items():
        good[name] = r["site"] is not None and r["site"] >= r["haiku"] and (r["sureTurnRight"] or 0) >= 0.98
        print(f"  {name} ({r['arch']}): type right {pc(r['doctype'])}; sure of {pc(r['sure'])}, right on those {pc(r['sureRight'])}; "
              f"turn right {pc(r['turn'])} (sure ones {pc(r['sureTurnRight'])})")
        if r["haikuPages"]:
            print(f"    the site's way {pc(r['site'])} vs Haiku alone {pc(r['haiku'])} on {r['haikuPages']} pages Haiku read → {'better or equal' if good[name] else 'WORSE'}")
        else:
            print("    the site's way: not measured (no exam page keeps Haiku's own answer) → nothing to set against Haiku")
        print("    by type: " + ", ".join(f"{k} {pc(v)}" for k, v in r["byDoctype"].items()))
        if not good[name]:
            i = DOCTYPE_SIZES.index(r["arch"]) if r["arch"] in DOCTYPE_SIZES else -1
            nxt = DOCTYPE_SIZES[i + 1] if 0 <= i < len(DOCTYPE_SIZES) - 1 else None
            print(f"    → train the next size up: python train_doctypes.py --phone {nxt}" if nxt
                  else "    → already the largest size: more page copies are needed")
    report["publish"] = good.get("doctype-lite.onnx", False)   # the phone's model alone decides (the only one published)
    write_json(WORK / "report_doctypes.json", report)
    print("Worth publishing: yes" if report["publish"] else "Worth publishing: NO — do not publish the document type model yet")


if __name__ == "__main__":
    main()
