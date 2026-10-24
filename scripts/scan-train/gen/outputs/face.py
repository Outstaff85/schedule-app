"""The face finder's exam pages from the phone's own cut (gen/phone_run.py; docs/scan-training.md → "The phone's own
cuts"): each page with a holder's photo (an ID card's front, a passport) as the lab cut it, BEFORE the face's turn, with
the turn it truly needs from the geometry — the face finder is not trained; this is only for its exam (how often
face_turn gives the right turn, how often it finds no face, by page type).

  <run>/face/img/<scene>-<page>.jpg
  <run>/face/faces.json   [{file, turn (the clockwise quarter turns the cut needs), faceK (the face finder's answer on
                            the run: -1 none), right, doctype, cut_by, use: "exam"}]"""
import json
import pathlib

DIR = "face"
CROP_MAX = 1024


def write(folder, res, ctx):
    import cv2
    from .. import phone
    folder = pathlib.Path(folder)
    ents, files = [], []
    for d in res["docs"]:
        t = d["truth"]
        if not t.get("face") or d["geomTurn"] is None or not d["cut"].size:
            continue
        cut = d["cut"]
        h, w = cut.shape[:2]
        k = min(1.0, CROP_MAX / max(h, w))
        if k < 1:
            cut = phone.resample(cut, (max(1, phone.js_round(w * k)), max(1, phone.js_round(h * k))), "area")
        name = f"{DIR}/img/{ctx['index']}-{d['j']}.jpg"
        cv2.imwrite(str(folder / name), cut, [cv2.IMWRITE_JPEG_QUALITY, 92])
        ents.append({"doc": d["j"], "file": name, "turn": d["geomTurn"], "faceK": d["faceK"], "right": d["faceK"] == d["geomTurn"],
                     "doctype": t["doctype"], "cut_by": d["cutBy"], "page": d["id"], "use": "exam"})
        files.append(name)
    return ents, files


def finish(folder, entries, params):
    folder = pathlib.Path(folder)
    (folder / DIR / "faces.json").write_text(json.dumps(entries), encoding="utf-8")
    by = {}
    for e in entries:
        c = by.setdefault(e["doctype"], {"crops": 0, "right": 0, "noFace": 0})
        c["crops"] += 1
        c["right"] += bool(e["right"])
        c["noFace"] += e["faceK"] < 0
    return {"crops": len(entries), "right": sum(bool(e["right"]) for e in entries), "noFace": sum(e["faceK"] < 0 for e in entries),
            "byDoctype": by}
