"""The document type model's pages from the phone's own cut (gen/phone_run.py; docs/scan-training.md → "The phone's own
cuts"): each true page of a scene as the lab cut it — by the corners its edges model found (or, missed, as a person
leaves them in the editor) and turned by the face on it — drawn onto the model's 256 square HERE, from the full-size
cut in one step, as the phone draws it (gen/phone.py doctype_input: index.html doctypeAnswer's one drawImage, the
kernel drawn from the phone profile's capture mix — no pre-shrink, no JPEG), and saved as PNG; train_doctypes.square
then copies the 256 square as it is.

  <run>/doctype/img/<scene>-<page>.png
  <run>/doctype/pages.json   [{id, file, doctype, turn_k, face_k, cut_by, iou, edges_sha, source, kernel, cut_size,
                               cut_from, …}]

turn_k: the clockwise quarter turns the crop still needs (geometry: the page's own corner order against the cut's,
less the face's turn; None for a real attempt with no own top-left — its turn is not known); face_k: the face finder's
turn (-1: no face); cut_by: phone | editor; iou: the cut's overlap with the true page; kernel: the one the square was
drawn with; cut_size: the cut's own size; cut_from: native (a scene's full frame) | stored1600 (a real attempt's
stored photo). A bad cut (IoU 0.6–0.8) is kept within the run's bad share. finish() counts the crops by class and the
distinct pages (templates) behind them: a class under MIN_CROPS crops or MIN_TEMPLATES distinct pages is reported short. pages.json is read by train_doctypes.py
--synth-run <run> (its entries count as turn known when turn_k is known)."""
import json
import pathlib

DIR = "doctype"
MIN_CROPS, MIN_TEMPLATES = 300, 2


def kernel_rng(ctx, j):
    """The stream a page's square kernel is drawn from: its own, by the run's seed, the scene and the page (the same
    every drawing, whatever the batch)."""
    import random
    return random.Random(f"doctype:{ctx['seed']}:{ctx['index']}:{j}")


def write(folder, res, ctx):
    """One scene's pages → (entries, files)."""
    import cv2
    from .. import common as gc
    from .. import phone
    folder = pathlib.Path(folder)
    ents, files = [], []
    for d in res["docs"]:
        t = d["truth"]
        crop = d["crop"]
        if t.get("doctype") not in gc.DOCTYPES or not crop.size:
            continue
        kernel = phone.kernel_for("capture", kernel_rng(ctx, d["j"]))
        square = phone.resample(crop[..., :3], (phone.S, phone.S), kernel)   # doctypeAnswer: the cut onto 256 × 256 at once
        name = f"{DIR}/img/{ctx['index']}-{d['j']}.png"
        cv2.imwrite(str(folder / name), square)
        e = {"id": d["id"], "doc": d["j"], "file": name, "doctype": t["doctype"], "turn_k": d["turnK"], "face_k": d["faceK"],
             "kernel": kernel, "cut_size": [int(crop.shape[1]), int(crop.shape[0])], "cut_from": ctx.get("cutFrom", "native"),
             "cut_by": d["cutBy"], "iou": d["iou"], "edges_sha": ctx["edgesSha"][:16], "source": t["source"], "kind": t["kind"],
             "pageId": t["pageId"], "role": t.get("role"), "how": d["how"], "synth": t["source"] != "attempt",
             "turnKnown": d["turnK"] is not None, "split": ctx["split"], "exam": ctx["split"] == "exam"}
        if t.get("templateSha1"):
            e.update({"templateSha1": t["templateSha1"], "templates": [t["templateSha1"]]})
        if ctx.get("key"):
            e["key"] = ctx["key"]
        ents.append(e)
        files.append(name)
    return ents, files


def finish(folder, entries, params):
    """pages.json and the counts by class → the summary (cuts.json "doctype")."""
    from .. import common as gc
    folder = pathlib.Path(folder)
    (folder / DIR / "pages.json").write_text(json.dumps(entries, ensure_ascii=False), encoding="utf-8")
    by = {}
    for e in entries:
        c = by.setdefault(e["doctype"], {"crops": 0, "pages": set(), "editor": 0, "bad": 0, "turnKnown": 0})
        c["crops"] += 1
        c["pages"].add(e["pageId"])
        c["editor"] += e["cut_by"] == "editor"
        c["bad"] += e["cut_by"] == "phone" and e["iou"] < 0.8
        c["turnKnown"] += bool(e["turnKnown"])
    out = {k: {"crops": by[k]["crops"] if k in by else 0, "templates": len(by[k]["pages"]) if k in by else 0,
               "editor": by.get(k, {}).get("editor", 0), "bad": by.get(k, {}).get("bad", 0),
               "turnKnown": by.get(k, {}).get("turnKnown", 0)} for k in gc.DOCTYPES}
    short = [k for k, v in out.items() if v["crops"] < MIN_CROPS or v["templates"] < MIN_TEMPLATES]
    return {"crops": len(entries), "byClass": out, "short": short, "minCrops": MIN_CROPS, "minTemplates": MIN_TEMPLATES}
