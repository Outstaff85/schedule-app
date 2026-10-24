"""Document types, step 3 (docs/scan-plan.md → S7; /scan-train): the exam — the page copies kept
apart (never trained on) are read by the new phone's document type model (doctype-lite.onnx; owner,
2026-10-24: the only one examined and published) and compared with Haiku's answers on the same pages
(the type it gave, kept in each record):
  - type: right answers; how many it is sure of (≥ 0.9) and how right those are;
  - turn: every exam page shown at its 4 quarter turns, the turn back read right;
  - the site's way: the model's type where it is sure of both the type and the turn (≥ 0.9 each, as the
    scan window's Mixed mode, src/scan/Scanner.tsx), Haiku's elsewhere — against Haiku alone. A page
    counts as Haiku's only when its record keeps Haiku's own answer ("given", by Haiku); with none,
    site / haiku / haikuPages are null (not measured), never 0.
With the owner's real pages kept apart for the exam (synth.held_out; synth_docs.py --templates --exam's
photos, each document cut by its known corners) the model is read on them too ("your documents") —
the one exam before the site has collected page copies: the type, by type and by document ("byDocument",
keyed by the short sha1 the drawing records for each real page, never its name), and the turn — each page
cut upright by the document's own top-left corner the drawing records ("upright"), then shown at its 4
quarter turns as above. A photo drawn before that was recorded is cut at an unknown turn and its turn is
not scored (null when no page has it: draw the exam photos again with --templates --exam). Each page is read as the
phone reads it: cut as the phone cuts (gen/phone.py warp_rgba) and drawn onto the 256 square at the default smoothing
(phone.doctype_input, the profile's exam kernel).
The model is worth publishing when the site's way is at least as right as Haiku alone and its sure
turns are right (≥ 98 %); else the next size up is suggested. Writes ~/.scan-train/report_doctypes.json
— with the sha256 of the model examined ("model_sha256"; publish.py refuses a report written for another
file) — and prints the report."""
import cv2
import numpy as np
import onnxruntime as ort

from common import DOCTYPE_MODELS, DOCTYPE_SIZES, DOCTYPES, WORK, model_hashes, read_json, write_json
from gen import phone

EXAM_PHOTOS = WORK / "synth" / "docs-exam" / "examples.json"

SURE, S = 0.9, 256


def read(sess, img):
    """The model's answer on a page (BGR) drawn onto its 256 square as the phone draws it (phone.doctype_input)."""
    k, t = sess.run(None, {"img": phone.doctype_input(img, bgr=True)[None]})
    return k.reshape(-1), t.reshape(-1)


def score(path, exam, turn=True):
    """The model's figures on exam pages ([{"img" or "file", "doctype", optional "given" / "by" / "doc" /
    "upright"}]); the turn is scored on the pages that lie upright (all but "upright": False), never with
    turn=False. What was not measured is None, never 0."""
    sess = ort.InferenceSession(str(path))
    right = sure = sure_right = site = haiku = n_h = turns = turn_right = sure_turns = sure_turn_right = 0
    per = {k: [0, 0] for k in DOCTYPES}
    docs = {}
    for e in exam:
        img = e["img"] if "img" in e else cv2.imread(e["file"])
        if img is None:
            continue
        kp, tp0 = read(sess, img)
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
            site += ok if kp.max() >= SURE and tp0.max() >= SURE else h_ok   # the site asks Haiku unless sure of both
        if not turn or e.get("upright") is False:
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
            "turn": pct(turn_right, turns), "sureTurnRight": pct(sure_turn_right, sure_turns), "turnPages": turns // 4 or None,
            "byDoctype": {k: pct(v[0], v[1]) for k, v in per.items()},
            "byDocument": {d: {"doctype": v["doctype"], "n": v["n"], "right": pct(v["right"], v["n"])} for d, v in sorted(docs.items())}}


def your_documents():
    """The owner's real pages kept apart, cut flat from their exam photos by the known corners — from the
    document's own top-left when the drawing recorded it ("upright": its index in "fixed"), so the page lies
    upright: [{"img", "doctype", "doc", "upright": bool}] (a photo with no document is left out)."""
    if not EXAM_PHOTOS.exists():
        return []
    out = []
    for e in read_json(EXAM_PHOTOS):
        kind = (e.get("kind") or "").split(":")[-1].split("+")[0]
        img = cv2.imread(e["file"])
        if e.get("none") or not e.get("fixed") or kind not in DOCTYPES or img is None:
            continue
        h, w = img.shape[:2]
        k = e.get("upright")
        up = isinstance(k, int) and 0 <= k < 4
        q = np.float64(e["fixed"])
        if up:
            q = np.roll(q, -k, axis=0)   # the document's own top-left first
        page = phone.warp_rgba(img, q.tolist())[..., :3]   # cut as the phone cuts (scan-core.js warpRGBA)
        if page.shape[0] < 2 or page.shape[1] < 2:
            continue
        out.append({"img": page, "doctype": kind, "doc": e.get("template"), "upright": up})
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
                report["yoursModels"][name] = {"arch": archs.get(name, DOCTYPE_MODELS[name]), **score(p, yours)}
    if not report["models"] and not report["yoursModels"]:
        raise SystemExit("no document type model trained — run train_doctypes.py first")
    report["model_sha256"] = model_hashes(DOCTYPE_MODELS, WORK / "new")   # the exact file examined
    pc = lambda v: "—" if v is None else f"{v:.0%}"
    if yours:
        print(f"Your documents: {len(yours)} pages cut from the exam photos of the real pages kept apart (never made into a training page)")
        for name, r in report["yoursModels"].items():
            turn = (f"turn right {pc(r['turn'])} (sure ones {pc(r['sureTurnRight'])}) on {r['turnPages']} pages" if r["turnPages"] else
                    "the turn: not measured (the exam photos were drawn before synth_docs.py recorded each document's top-left: draw them again with --templates --exam)")
            print(f"  {name} ({r['arch']}): type right {pc(r['doctype'])}; sure of {pc(r['sure'])}, right on those {pc(r['sureRight'])}; {turn}")
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
