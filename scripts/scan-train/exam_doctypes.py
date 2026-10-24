"""Document types, step 3 (docs/scan-plan.md → S7; /scan-train): the exam of the phone's document type model
(doctype-lite.onnx; owner, 2026-10-24: the only one examined and published), set against the lab's doctype-lite (the
lab's version, scripts/scan-lab/models-version) on the very same pages. Each page is read as the phone reads it: drawn
onto the 256 square at the default smoothing (phone.doctype_input).

The sets:
  - real: the site's page copies kept apart (doctypes.json; by split_key: a worker's, a scan's or a retake group's pages
    are all on one side), shown by type and by document (a short sha1 of the split key — never a name);
  - yours: the owner's real pages kept apart (heldout.json; synth_docs.py --templates --exam's photos), each cut by its
    true corners as the editor cuts ("editor cut"), by type and by document ("byDocument", the short sha1 the drawing
    records for each real page);
  - phoneCut: the owner's held-out pages cut as the phone cuts them, from the camera's native frame — the doctype pages
    of a cut exam run (--phone-run, default the newest gen/runs/cuts-*-exam with doctype/pages.json; python -m gen build
    --model doctype,mrz,he,face --exam: each scene drawn at native size, the lab's own shot, the found page cut at the
    PREDICTED corners and turned by the face finder, drawn onto the 256 square as the phone draws it), only the pages
    that lay a real page kept apart ("phoneCutFrom": "native"). The run must be drawn under today's heldout.json. With no
    such run, the docs-exam photos (640 px JPEGs) are cut by the lab's shot here (gen/phone_run.py cut_scene) and the
    set is labelled "phoneCutFrom": "stored640" — the stored photo, not the phone's frame. A page the lab missed (or cut
    so badly a person would fix it) is counted ("phoneMissed") and left out. Its turn is known from the geometry
    (turn_k). The lab's cuts of the stored photos are kept in <home>/exams/ (gen/exam_sets.py), tied to the lab's edges
    and face models, gen/phone_run.py, gen/exam_phone.py, docfind.py, gen/phone.py and the phone profile (cut_reader).
For each set: the type right, how many it is sure of (≥ 0.9) and how right those are, by type, the confusion of
contract and other (and the whole confusion table), and the turn: every page whose turn is known shown at its 4 quarter
turns, the turn back read right, and how right the sure ones are (sureTurnRight). A turn is known for a made-up page and
a phone cut (turn_k), for "your documents" cut from the document's own top-left, and for a site copy only when the face
finder or the owner set it (turnBy face / owner, or turned by hand: turnFixed) — never Haiku's or the model's own guess;
a page whose turn is not known is never turned. The turn exam ("turnExam") is the same over every set's known pages.
The site's way (real pages): the model's type where it is sure of both the type and the turn (≥ 0.9 each, as the scan
window's Mixed mode, src/scan/Scanner.tsx), Haiku's elsewhere — against Haiku alone, on the pages whose record keeps
Haiku's own answer ("given", by Haiku). Haiku's pages are weighed by how they were sampled (sampleWeight: keepEvery — the
scan window keeps one right page in KEEP_EVERY, a changed page always — default 5 for an unchanged page and 1 for a
changed one), shown weighed and unweighed; with no Haiku page, site / haiku / haikuPages are null (not measured).

Worth publishing (needs the real pages: "publish" is null without them): the site's way (weighed) at least as right as
Haiku alone, the turn exam's sure turns right on ≥ 98 % (null — not measured — is a NO), and no worse than the lab's
doctype-lite on the type of any set; each rule that fails is printed (and kept in "failed"). Else the next size up is
suggested. Writes exam_rows.jsonl (one row per page, model and set), ~/.scan-train/report_doctypes.json — with the sha256
of the model examined ("model_sha256"; publish.py refuses a report written for another file) — and prints the report."""
import argparse
import hashlib

import cv2
import numpy as np
import onnxruntime as ort

from common import DOCTYPE_MODELS, DOCTYPE_SIZES, DOCTYPES, WORK, model_hashes, read_json, write_json
from gen import exam_sets as es
from gen import phone
from gen.real import KEEP_EVERY

EXAM_PHOTOS = WORK / "synth" / "docs-exam" / "examples.json"
PHONE = "doctype-lite.onnx"
SURE, S = 0.9, 256
TURN_AT = 0.98
KNOWN_BY = ("face", "owner")   # who sets a real copy's turn for sure (train_doctypes.KNOWN_BY: not the model, not Haiku)
SET_KEYS = {"real": "models", "yours": "yoursModels", "phoneCut": "phoneCutModels"}


def read(sess, img):
    """The model's answer on a page (BGR) drawn onto its 256 square as the phone draws it (phone.doctype_input)."""
    k, t = sess.run(None, {"img": phone.doctype_input(img, bgr=True)[None]})
    return k.reshape(-1), t.reshape(-1)


def turn_known(e):
    """(known, needs): is a page's turn known, and the clockwise quarter turns it still needs as stored. A phone cut or a
    made-up crop: turn_k (None: not known); a site copy: only turnBy face / owner or turnFixed (pull_doctypes.py turns
    the copy upright by them); "your documents": "upright" (cut from the document's own top-left)."""
    if "turn_k" in e:
        return e["turn_k"] is not None, int(e["turn_k"] or 0)
    if e.get("synthPage"):
        return True, 0
    if e.get("source") == "copy" or "turnBy" in e or "turnFixed" in e:
        return e.get("turnBy") in KNOWN_BY or e.get("turnFixed") is not None, 0
    return e.get("upright") is True, 0


def weight_of(e):
    """How many pages a Haiku page stands for (the scan window's sampling): its sampleWeight, else KEEP_EVERY for a page
    whose type the user kept and 1 for a changed one."""
    w = e.get("sampleWeight")
    if isinstance(w, (int, float)) and not isinstance(w, bool) and w >= 1:
        return float(w)
    return 1.0 if e.get("given") != e["doctype"] else float(KEEP_EVERY)


def answers(sess, exam):
    """Per page: {"kind", "kp" (the type's top score), "tp" (the turn's top score as stored), "turns": [(answer, score)]
    at the 4 quarter turns — only for a page whose turn is known} (None for an unreadable picture)."""
    out = []
    for e in exam:
        img = e["img"] if "img" in e else cv2.imread(e["file"])
        if img is None:
            out.append(None)
            continue
        kp, tp0 = read(sess, img)
        a = {"kind": DOCTYPES[int(kp.argmax())], "kp": float(kp.max()), "tp": float(tp0.max()), "turns": None}
        if turn_known(e)[0]:
            a["turns"] = [(int(tp0.argmax()), float(tp0.max()))]
            for q in range(1, 4):
                _, tp = read(sess, np.ascontiguousarray(np.rot90(img, -q)))
                a["turns"].append((int(tp.argmax()), float(tp.max())))
        out.append(a)
    return out


def figures(ans, exam):
    """One model's figures on a set's pages ([{"img" or "file", "doctype", optional "given" / "by" / "doc" / "upright" /
    "turn_k" / "turnBy" / "sampleWeight"}]) from its answers. What was not measured is None, never 0."""
    pct = lambda a, b: round(a / b, 3) if b else None
    right = sure = sure_right = turns = turn_right = sure_turns = sure_turn_right = 0
    n_h, site, haiku, w_h, w_site, w_haiku = 0, 0, 0, 0.0, 0.0, 0.0
    per = {k: [0, 0] for k in DOCTYPES}
    conf = {k: {} for k in DOCTYPES}
    docs = {}
    for a, e in zip(ans, exam):
        if a is None:
            continue
        ok = a["kind"] == e["doctype"]
        right += ok
        per[e["doctype"]][0] += ok
        per[e["doctype"]][1] += 1
        conf[e["doctype"]][a["kind"]] = conf[e["doctype"]].get(a["kind"], 0) + 1
        if e.get("doc"):
            d = docs.setdefault(e["doc"], {"doctype": e["doctype"], "n": 0, "right": 0})
            d["n"] += 1
            d["right"] += ok
        if a["kp"] >= SURE:
            sure += 1
            sure_right += ok
        if e.get("by", "haiku") == "haiku" and "given" in e:  # Haiku's own answer on this page (not an earlier model's)
            h_ok = e.get("given") == e["doctype"]
            s_ok = ok if a["kp"] >= SURE and a["tp"] >= SURE else h_ok   # the site asks Haiku unless sure of both
            w = weight_of(e)
            n_h += 1
            haiku += h_ok
            site += s_ok
            w_h += w
            w_haiku += w * h_ok
            w_site += w * s_ok
        if a["turns"]:
            needs = turn_known(e)[1]
            for q, (t, p) in enumerate(a["turns"]):
                t_ok = t == (needs - q) % 4
                turns += 1
                turn_right += t_ok
                if p >= SURE:
                    sure_turns += 1
                    sure_turn_right += t_ok
    n = sum(v[1] for v in per.values())
    return {"n": n, "doctype": pct(right, n), "sure": pct(sure, n), "sureRight": pct(sure_right, sure),
            "site": pct(w_site, w_h), "haiku": pct(w_haiku, w_h), "haikuPages": n_h or None,
            "siteUnweighted": pct(site, n_h), "haikuUnweighted": pct(haiku, n_h), "haikuWeight": round(w_h, 1) if n_h else None,
            "turn": pct(turn_right, turns), "sureTurnRight": pct(sure_turn_right, sure_turns), "turnPages": turns // 4 or None,
            "sureTurns": sure_turns or None,
            "byDoctype": {k: pct(v[0], v[1]) for k, v in per.items()},
            "confusion": {k: v for k, v in conf.items() if v},
            "contractOther": {"contractAsOther": conf["contract"].get("other", 0), "otherAsContract": conf["other"].get("contract", 0),
                              "contract": per["contract"][1], "other": per["other"][1]},
            "byDocument": {d: {"doctype": v["doctype"], "n": v["n"], "right": pct(v["right"], v["n"])} for d, v in sorted(docs.items())}}


def score(path, exam):
    """The figures of the model at path on a set's pages (answers, then figures)."""
    return figures(answers(ort.InferenceSession(str(path)), exam), exam)


def turn_exam(parts):
    """The turn exam over every set: [(answers, exam)] → {pages, turn, sureTurnRight, sureTurns} on the pages whose turn
    is known (each at its 4 quarter turns)."""
    pages = [(a, e) for ans, exam in parts for a, e in zip(ans, exam) if a is not None and a["turns"]]
    f = figures([a for a, _ in pages], [e for _, e in pages]) if pages else None
    return {"pages": len(pages), "turn": f["turn"] if f else None, "sureTurnRight": f["sureTurnRight"] if f else None,
            "sureTurns": f["sureTurns"] if f else None}


def doc_key(key):
    """A real page's document in the report: a short sha1 of its split key (never the key or a name)."""
    return hashlib.sha1(str(key).encode("utf-8")).hexdigest()[:10] if key else None


def real_exam(ex):
    """The site's page copies on the exam side (split "exam", else an old entry's exam flag), each with its document."""
    out = []
    for e in ex:
        side = e.get("split") if "split" in e else ("exam" if e.get("exam") else "train")
        if side == "exam":
            out.append({**e, "doc": doc_key(e.get("key"))})
    return out


def your_documents():
    """The owner's real pages kept apart, cut flat from their exam photos by the known corners — from the
    document's own top-left when the drawing recorded it ("upright": its index in "fixed"), so the page lies
    upright: [{"img", "doctype", "doc", "upright": bool, …}] (a photo with no document is left out)."""
    if not EXAM_PHOTOS.exists():
        return []
    out = []
    drawn = (EXAM_PHOTOS.parent / "manifest.jsonl").exists()   # drawn through gen build: each photo's manifest row has its id
    for e in read_json(EXAM_PHOTOS):
        kind = (e.get("kind") or "").split(":")[-1].split("+")[0]
        img = cv2.imread(e["file"])
        if e.get("none") or not e.get("fixed") or kind not in DOCTYPES or img is None:
            continue
        k = e.get("upright")
        up = isinstance(k, int) and not isinstance(k, bool) and 0 <= k < 4
        q = np.float64(e["fixed"])
        if up:
            q = np.roll(q, -k, axis=0)   # the document's own top-left first
        page = phone.warp_rgba(img, q.tolist())[..., :3]   # cut as the phone cuts (geometry.ts warpRGBA)
        if page.shape[0] < 2 or page.shape[1] < 2:
            continue
        out.append({"img": page, "doctype": kind, "doc": e.get("template"), "upright": up, "id": e.get("id"),
                    "manifest": e.get("manifest") or (e.get("id") if drawn else None), "file": e["file"], "fixed": e["fixed"], "docQuad": e.get("doc")})
    return out


def lab_cuts(yours, version, cut=None):
    """[{"quad", "cutBy", "iou", "faceK", "turnK"} or None] — each of "your documents" cut by the lab's own shot
    (gen/phone_run.py cut_scene with the lab's models: the found page at its predicted corners, turned by the face);
    cut(frame, truths) → one doc of cut_scene stands in for it in the tests. A photo drawn before synth_docs.py recorded
    the document's own corners ("doc") has no known turn: None."""
    from gen import phone_run as pr
    from gen import rng as grng
    lab = pr.Lab({"labVersion": version}) if cut is None else None
    out = []
    for i, y in enumerate(yours):
        frame = cv2.imread(y["file"])
        if frame is None or not y.get("docQuad"):
            out.append(None)
            continue
        h, w = frame.shape[:2]
        truths = pr._real_truth({"fixed": y["fixed"], "doc": y["docQuad"], "doctype": y["doctype"]}, w, h)
        if cut is not None:
            d = cut(frame, truths)
        else:
            res, _ = pr.cut_scene(frame, truths, lab.shot, lab.face, grng.py_stream(7, i, "phone"))
            d = res["docs"][0]
        out.append({"quad": [list(map(float, p)) for p in d["quad"]], "cutBy": d["cutBy"], "iou": float(d["iou"]),
                    "faceK": int(d["faceK"]), "turnK": d["turnK"]})
    return out


def phone_cut_pages(yours, cuts):
    """(the phone-cut pages, how many the lab missed or cut so badly a person would fix them): each page cut from its
    photo at the lab's corners and turned by the face as the phone does, its turn known from the geometry (turn_k)."""
    pages, missed = [], 0
    for y, c in zip(yours, cuts):
        if c is None:
            continue
        if c["cutBy"] != "phone":
            missed += 1
            continue
        frame = cv2.imread(y["file"])
        cut = np.ascontiguousarray(phone.warp_rgba(frame, c["quad"])[..., :3])
        crop = phone.turned(cut, c["faceK"]) if c["faceK"] > 0 else cut
        if crop.shape[0] < 2 or crop.shape[1] < 2:
            missed += 1
            continue
        pages.append({"img": crop, "doctype": y["doctype"], "doc": y["doc"], "turn_k": c["turnK"], "id": y.get("id"),
                      "manifest": y.get("manifest"), "iou": c["iou"]})
    return pages, missed


def cut_reader(paths, edges):
    """The fingerprint the lab's kept cuts are tied to (gen/exam_sets.py reader_sha): the edges models (edges), the face
    model, the code that shoots, cuts and turns (gen/phone_run.py, gen/exam_phone.py, docfind.py, gen/phone.py) and the
    phone profile."""
    from gen import phone
    from gen.phone_run import FACE_FILE
    face = paths.get(FACE_FILE)
    return es.reader_sha(("gen/phone_run.py", "gen/exam_phone.py", "docfind.py", "gen/phone.py", *([face] if face else [])),
                         (edges, phone.load_profile().get("_sha256")))


def run_cut_pages(run):
    """(the phone-cut pages of a cut exam run, how many the lab missed or cut so badly a person would fix them): the
    doctype pages (<run>/doctype/pages.json, cut from the native frame) of the real pages kept apart (templateSha1),
    each the 256 square the phone draws."""
    import json
    import pathlib
    import re
    run = pathlib.Path(run)
    pages, missed = [], 0
    for e in json.loads((run / "doctype" / "pages.json").read_text(encoding="utf-8")):
        if not e.get("templateSha1") or e.get("doctype") not in DOCTYPES:
            continue
        if e.get("cut_by") != "phone":
            missed += 1
            continue
        pages.append({"file": str(run / e["file"]), "doctype": e["doctype"], "doc": str(e["templateSha1"])[:10],
                      "turn_k": e.get("turn_k"), "id": e.get("id"), "manifest": re.sub(r"-d\d+$", "", str(e.get("id"))),
                      "iou": e.get("iou")})   # the scene's manifest id (cut-<seed>-<i>); the page's is its id (-d<j>)
    return pages, missed


def suggest(r):
    i = DOCTYPE_SIZES.index(r["arch"]) if r["arch"] in DOCTYPE_SIZES else -1
    nxt = DOCTYPE_SIZES[i + 1] if 0 <= i < len(DOCTYPE_SIZES) - 1 else None
    return f"→ train the next size up: python train_doctypes.py --phone {nxt}" if nxt else "→ already the largest size: more page copies are needed"


def decide(report):
    """(publish, [the rules that failed]); publish None with no real page kept apart (nothing to set against Haiku)."""
    r = (report.get("models") or {}).get(PHONE)
    if not r:
        return None, ["no page copies from the site kept apart: nothing to set against Haiku"]
    fails = []
    if r["site"] is None:
        fails.append("the site's way: not measured (no exam page keeps Haiku's own answer)")
    elif r["site"] < r["haiku"]:
        fails.append(f"the site's way {r['site']:.1%} < Haiku alone {r['haiku']:.1%} (weighed by sampling)")
    t = report.get("turnExam") or {}
    if t.get("sureTurnRight") is None:
        fails.append("the turn exam: not measured (no page whose turn is known, or none it is sure of)")
    elif t["sureTurnRight"] < TURN_AT:
        fails.append(f"the turn exam: sure turns right {t['sureTurnRight']:.1%} < {TURN_AT:.0%}")
    for s, lab in (report.get("lab") or {}).items():
        new = (report.get(SET_KEYS[s]) or {}).get(PHONE)
        if new and lab and new["doctype"] is not None and lab["doctype"] is not None and new["doctype"] < lab["doctype"]:
            fails.append(f"{s}: type right {new['doctype']:.1%} < the lab's doctype-lite {lab['doctype']:.1%}")
    return not fails, fails


def print_report(report):
    pc = lambda v: "—" if v is None else f"{v:.0%}"
    titles = {"real": "Real pages kept apart (the site's page copies, by split key)", "yours": "Your documents, editor cut (the true corners)",
              "phoneCut": "Your documents, phone cut (the lab's own shot, " + (
                  "from the native frame" if report.get("phoneCutFrom") == "native"
                  else "from the stored 640-px photos — not the phone's frame") + ")"}
    for s, title in titles.items():
        for name, r in (report.get(SET_KEYS[s]) or {}).items():
            lab = (report.get("lab") or {}).get(s)
            print(f"{title}: {r['n']} pages — {name} ({r['arch']}): type right {pc(r['doctype'])}"
                  + (f" (the lab's {report['labVersion']}: {pc(lab['doctype'])}, its turn {pc(lab['turn'])})" if lab else "")
                  + f"; sure of {pc(r['sure'])}, right on those {pc(r['sureRight'])}; "
                  + (f"turn right {pc(r['turn'])} (sure ones {pc(r['sureTurnRight'])}) on {r['turnPages']} pages" if r["turnPages"]
                     else "the turn: not measured (no page whose turn is known)"))
            print("    by type: " + ", ".join(f"{k} {pc(v)}" for k, v in r["byDoctype"].items()))
            co = r["contractOther"]
            print(f"    contract read as other {co['contractAsOther']} of {co['contract']}; other read as contract {co['otherAsContract']} of {co['other']}")
            if r["byDocument"]:
                print(f"    by document ({len(r['byDocument'])}): " + ", ".join(f"{d} {v['doctype']} {pc(v['right'])} of {v['n']}" for d, v in r["byDocument"].items()))
            if s == "real":
                if r["haikuPages"]:
                    print(f"    the site's way {pc(r['site'])} vs Haiku alone {pc(r['haiku'])} weighed by sampling (unweighed {pc(r['siteUnweighted'])} vs "
                          f"{pc(r['haikuUnweighted'])}) on {r['haikuPages']} pages Haiku read")
                else:
                    print("    the site's way: not measured (no exam page keeps Haiku's own answer)")
    if report.get("phoneMissed"):
        print(f"  the lab's shot missed or badly cut {report['phoneMissed']} of your documents (left out of the phone-cut figures)")
    t = report["turnExam"]
    print(f"Turn exam: {t['pages']} pages whose turn is known, each at its 4 quarter turns — right {pc(t['turn'])}, "
          f"sure ones right {pc(t['sureTurnRight'])} (needed {TURN_AT:.0%})")
    if report["publish"] is None:
        print("No page copies from the site kept apart yet: nothing to set against Haiku — the lab (then the site's shadow) shows how it does")
        return
    if report["publish"]:
        print("Worth publishing: yes")
        return
    print("Worth publishing: NO — do not publish the document type model yet:")
    for f in report["failed"]:
        print(f"  - {f}")
    r = report["models"].get(PHONE)
    if r:
        print("  " + suggest(r))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-phone-cut", action="store_true", help="leave out the phone-cut figures (no lab shot)")
    ap.add_argument("--phone-run", help="the cut exam run (default: the newest gen/runs/cuts-*-exam with doctype/pages.json)")
    a = ap.parse_args(argv)
    import pathlib
    from common import model_path, sha256_of, version_of
    ex = read_json(WORK / "doctypes.json") if (WORK / "doctypes.json").exists() else []
    exam = real_exam(ex)
    yours = your_documents()
    if not exam and not yours:
        raise SystemExit("no exam pages — run pull_doctypes.py (and synth_docs.py --templates --exam) first")
    p = WORK / "new" / PHONE
    if not p.exists():
        raise SystemExit("no document type model trained — run train_doctypes.py first")
    archs = read_json(WORK / "new" / "doctypes-arch.json") if (WORK / "new" / "doctypes-arch.json").exists() else {}
    arch = archs.get(PHONE, DOCTYPE_MODELS[PHONE])
    version = version_of("scan-lab")
    try:
        lab_path = model_path(version, PHONE)
    except SystemExit:
        lab_path = None   # a lab version with no document type model: nothing to set it against
    cuts, missed, pcut, cut_from, cut_run = [], None, [], None, None
    if yours:
        es.require_fresh({"yours": "synth/docs-exam"}, WORK)
    if not a.no_phone_cut:
        cut_run = pathlib.Path(a.phone_run) if a.phone_run else es.latest_run("cuts-", WORK)
        if cut_run and not (cut_run / "doctype" / "pages.json").exists():
            cut_run = None
    if cut_run:   # cut from the native frame by the lab's shot (gen build … --exam)
        es.require_fresh({"phoneCut": cut_run}, WORK)
        pcut, missed = run_cut_pages(cut_run)
        cut_from = "native"
    elif yours and not a.no_phone_cut:   # no cut exam run: the stored 640-px photos, labelled so
        from gen.phone_run import edges_sha, lab_paths
        _, paths = lab_paths(version)
        e_sha = edges_sha(paths)
        cuts, _ = es.answers_of(e_sha, "doctypes-phone-cut", es.identity(yours, ("fixed", "doctype", "docQuad")),
                                lambda: lab_cuts(yours, version), WORK, reader=cut_reader(paths, e_sha))
        pcut, missed = phone_cut_pages(yours, cuts)
        cut_from = "stored640"
    sets = {s: v for s, v in (("real", exam), ("yours", yours), ("phoneCut", pcut)) if v}
    pinned = es.refresh({f"doctypes/{s}": ([{k: v for k, v in e.items() if k != "img"} for e in v], None) for s, v in sets.items()}, WORK)
    new_sess = ort.InferenceSession(str(p))
    lab_sess = ort.InferenceSession(str(lab_path)) if lab_path else None
    n_sha, l_sha = sha256_of(p), (sha256_of(lab_path) if lab_path else None)
    report = {"examples": len(ex), "exam": len(exam), "yours": len(yours), "phoneCut": len(pcut), "phoneMissed": missed,
              "phoneCutFrom": cut_from if pcut else None, "phoneCutRun": str(cut_run) if cut_run else None,
              "labVersion": version, "labSha256": l_sha, "examSets": pinned, "models": {}, "yoursModels": {}, "phoneCutModels": {},
              "lab": {}}
    rows, parts = [], []
    for s, pages in sets.items():
        ans = answers(new_sess, pages)
        report[SET_KEYS[s]][PHONE] = {"arch": arch, **figures(ans, pages)}
        parts.append((ans, pages))
        rows += [es.row("doctypes", PHONE, "new", n_sha, s, e.get("id"), e.get("manifest"), None,
                        None if x is None else x["kind"] == e["doctype"]) for x, e in zip(ans, pages)]
        if lab_sess is not None:
            la = answers(lab_sess, pages)
            report["lab"][s] = figures(la, pages)
            rows += [es.row("doctypes", PHONE, "lab", l_sha, s, e.get("id"), e.get("manifest"), None,
                            None if x is None else x["kind"] == e["doctype"]) for x, e in zip(la, pages)]
    report["turnExam"] = turn_exam(parts)
    report["model_sha256"] = model_hashes(DOCTYPE_MODELS, WORK / "new")   # the exact file examined
    report["publish"], report["failed"] = decide(report)
    es.write_rows("doctypes", rows, WORK)
    write_json(WORK / "report_doctypes.json", report)
    print_report(report)
    return report


if __name__ == "__main__":
    main()
