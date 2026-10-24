"""E4, the edges exam on the phone's own path (docs/scan-training.md → "The phone mirror"): `python -m gen exam-phone
--model edges`. Today's lab edges models (the lab's version, scripts/scan-lab/models-version) examined without
retraining on a fixed set — up to --count photos of each exam set (the made-up photos of the owner's pages kept apart,
synth/docs-exam; MIDV-2020's and SmartDoc's exam documents, midv.open_exam), the same ones every run — twice: with the
256 input shrunk by INTER_AREA (as every exam did so far) and through the phone's path (gen/phone.py frame_to_S: the
light model on the camera frame's createImageBitmap 'low', the accurate one on smallRGBA), with the kernels the
phone profile gives the exams (the mix's heaviest while no phone is measured; its name is in the report).

For each model and set: mean corner error, the share within 2 % and the share not found (exam.score), by INTER_AREA,
by "live" and by "capture" — "phone" names the light model's live and the accurate one's capture. Then the lab's
whole shot (index.html takeShot), on each path: the light model's live corners (no four corners: no shot), the
accurate model's confirming them (sure: they are the first document's), up to three more documents by find_next and
one lying on each found by find_inside (at most 5) — counted: shots, confirmed, moved, documents found, the photos
with two documents where both were found, the photos with none where a shot was taken. Nothing is trained, nothing
is published: it reports the gap. Writes <out>/exam_phone.json."""
import json
import pathlib
import random
import time

import numpy as np

SETS = {"templates": "your documents (made-up photos of the real pages kept apart)",
        "midv": "MIDV-2020 exam documents", "smartdoc": "SmartDoc exam pages"}
NAMES = ("edges-lite.onnx", "edges.onnx")
PHONE_OP = {"edges-lite.onnx": "live", "edges.onnx": "capture"}   # the input each model gets on the phone
RESIZES = ("area", "live", "capture")
MAX_DOCS = 5


def _name(f):
    return str(f).replace("\\", "/").rsplit("/", 1)[-1]


def _read(f):
    return json.loads(pathlib.Path(f).read_text(encoding="utf-8"))


def exam_sets(work, count):
    """{set: [examples]} — up to count of each set, by random.Random(0) (the same every run); a set not made here is
    left out. The files are looked for beside the set's examples.json (a set copied from another PC)."""
    from midv import open_exam
    work = pathlib.Path(work)
    out = {}
    f = work / "synth" / "docs-exam" / "examples.json"
    if f.exists():
        out["templates"] = [{**e, "file": str(f.parent / "img" / _name(e["file"]))} for e in _read(f)]
    for s in ("midv", "smartdoc"):
        f = work / s / "examples.json"
        if f.exists():
            out[s] = [{**e, "file": str(f.parent / "img" / _name(e["file"]))} for e in _read(f) if open_exam(e)]
    return {s: random.Random(0).sample(ex, min(count, len(ex))) for s, ex in out.items() if ex}


def shot(models, img, path):
    """The lab's shot on one photo (index.html takeShot, findNext, findInside): path "phone" (the live frame by
    createImageBitmap, smallRGBA after) or "area" (INTER_AREA everywhere)."""
    import docfind
    lite, acc = models
    rl, rc = ("live", "capture") if path == "phone" else ("area", "area")
    lp, _ = docfind.detect(lite, img, rl)
    if lp is None:
        return {"shot": False, "first": None, "found": 0, "next": 0, "inside": 0, "confirmed": False, "moved": False}
    cp, cc = docfind.detect(acc, img, rc)
    confirmed = cp is not None and cc >= 0.5
    first = cp if confirmed else lp
    moved = bool(confirmed and max(float(np.hypot(*(cp[k] - lp[k]))) for k in range(4)) > 0.002)
    found = [first]
    for _ in range(3):
        q = docfind.find_next([acc, lite], img, found, rc)
        if q is None:
            break
        found.append(q)
    nxt = len(found) - 1
    for q in list(found):
        if len(found) >= MAX_DOCS:
            break
        c = docfind.find_inside(acc, img, q, found, rc)
        if c is not None:
            found.append(c)
    return {"shot": True, "first": first, "found": len(found), "next": nxt, "inside": len(found) - 1 - nxt,
            "confirmed": confirmed, "moved": moved}


def shot_counts(results, examples):
    from exam import score
    docs = {}
    for r in results:
        docs[str(r["found"])] = docs.get(str(r["found"]), 0) + 1
    pairs = [(r, e) for r, e in zip(results, examples) if "+2" in str(e.get("kind", ""))]
    none = [r for r, e in zip(results, examples) if e.get("none")]
    first = [[list(map(float, p)) for p in r["first"]] if r["first"] is not None else None for r in results]
    return {"n": len(results), "shots": sum(r["shot"] for r in results), "confirmed": sum(r["confirmed"] for r in results),
            "moved": sum(r["moved"] for r in results), "documents": dict(sorted(docs.items())),
            "withNext": sum(r["next"] > 0 for r in results), "withInside": sum(r["inside"] > 0 for r in results),
            "pairs": {"n": len(pairs), "bothFound": sum(r["found"] >= 2 for r, _ in pairs)},
            "none": {"n": len(none), "shot": sum(r["shot"] for r in none)},
            "first": score(first, examples)}


def main(model, count, version=None, out=None):
    import cv2
    import onnxruntime as ort

    import docfind
    from common import WORK, model_path, version_of
    from exam import score
    from home import sha256_of
    from . import phone
    from .common import contaminated

    assert model == "edges"
    version = version or version_of("scan-lab")
    out = pathlib.Path(out) if out else WORK
    out.mkdir(parents=True, exist_ok=True)
    sets = exam_sets(WORK, count)
    if not sets:
        raise SystemExit(f"no exam set in {WORK}: synth/docs-exam (synth_docs.py --templates --exam), midv/, smartdoc/ "
                         "(midv.py, smartdoc.py or datasets_hf.py pull)")
    paths = {n: model_path(version, n) for n in NAMES}
    sess = {n: ort.InferenceSession(str(p)) for n, p in paths.items()}
    kernels = {op: phone.kernel_for(op) for op in ("live", "capture")}
    report = {"model": model, "version": version, "profile": phone.profile_id(), "kernels": kernels,
              "measured": bool(phone.load_profile().get("measured")),
              "model_sha256": {n: sha256_of(p) for n, p in paths.items()},
              "count": count, "sets": {s: len(ex) for s, ex in sets.items()}, "models": {}, "shots": {}}
    t0 = time.time()
    for s, examples in sets.items():
        imgs = [cv2.imread(e["file"]) for e in examples]
        keep = [i for i, im in enumerate(imgs) if im is not None]
        examples, imgs = [examples[i] for i in keep], [imgs[i] for i in keep]
        report["sets"][s] = len(examples)
        for n in NAMES:
            row = {}
            for rz in RESIZES:
                answers = []
                for im in imgs:
                    pts, conf = docfind.detect(sess[n], im, rz)
                    answers.append([list(map(float, p)) for p in pts] if docfind.good_quad(pts, conf) else None)
                row[rz] = score(answers, examples)
            row["phone"] = PHONE_OP[n]
            dirty = contaminated([version], n) if s == "templates" else []
            if dirty:
                row["contaminated"] = dirty
            report["models"].setdefault(n, {})[s] = row
        report["shots"][s] = {p: shot_counts([shot((sess["edges-lite.onnx"], sess["edges.onnx"]), im, p) for im in imgs], examples)
                              for p in ("area", "phone")}
        print(f"  {SETS[s]}: {len(examples)} photos ({time.time() - t0:.0f} s)", flush=True)
    report["seconds"] = round(time.time() - t0, 1)
    (out / "exam_phone.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    print_table(report)
    print(f"report: {out / 'exam_phone.json'}")
    return report


def print_table(report):
    print(f"E4 — the lab's edges models ({report['version']}) on INTER_AREA vs the phone's path "
          f"(profile {report['profile']}: live {report['kernels']['live']}, capture {report['kernels']['capture']})")
    print(f"  {'model':<16} {'set':<10} {'input':<8} {'n':>4} {'mean':>7} {'within2':>8} {'missed':>7}")
    for n, sets in report["models"].items():
        for s, row in sets.items():
            for rz in ("area", row["phone"]):
                r = row[rz]
                tag = rz + ("*" if rz != "area" else "")
                print(f"  {n:<16} {s:<10} {tag:<8} {r['n']:>4} {r['mean']:>7.3f} {r['within2']:>8.0%} {r['missed']:>7.0%}"
                      + ("  (contaminated)" if row.get("contaminated") and rz == "area" else ""))
    print("  * the phone's path for that model (live: the light model's camera frame; capture: the accurate model's)")
    print(f"  {'shot':<27} {'path':<6} {'shots':>6} {'conf.':>6} {'moved':>6} {'+next':>6} {'+in':>5} {'pairs':>7} {'none':>6} {'first mean':>10}")
    for s, by in report["shots"].items():
        for p, c in by.items():
            print(f"  {s:<27} {p:<6} {c['shots']:>3}/{c['n']:<2} {c['confirmed']:>6} {c['moved']:>6} {c['withNext']:>6} {c['withInside']:>5} "
                  f"{c['pairs']['bothFound']:>3}/{c['pairs']['n']:<3} {c['none']['shot']:>2}/{c['none']['n']:<3} {c['first']['mean']:>10.3f}")
