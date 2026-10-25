"""The document edges models' made-up set from scenes (docs/scan-training.md → "Scenes: one camera for the table and the
documents"): `python -m gen build --model edges`.

  python -m gen build --model edges --count 8000 --seed 1 --jobs 6               # → ~/.scan-train/gen/runs/edges-s1-n8000/
  python -m gen build --model edges --count 300 --exam                           # the exam: held-out pages, exam backgrounds
                                                                                 # and occluders, no PDF (drawn contract / other pages)
  python -m gen build --model edges --split select                               # a made-up select set: seeds SELECT_SEEDS and up
                                                                                 # (default 100001), 300 scenes, the training side's
                                                                                 # pages, backgrounds and occluders; split "select" in
                                                                                 # its manifest, run.json and entries — gen mix
                                                                                 # --select-run picks the epoch on it, never trains on it
  python -m gen qa --run ~/.scan-train/gen/runs/edges-s1-n8000                    # the QA sheet before train.py --synth-run

Each scene (gen/scene.py) is written as the phone would keep it: the frame at most 1600 px on its long side, JPEG 0.85
(gen/phone.py store_attempt), img/<n>.jpg, and examples.json in pull.py's form — one entry per picture, each naming its
manifest row ("manifest") and its role:
- answer: the frame, its answer the largest page in sight (fixed: its corners 0..1 as the model gives them, top-left
  first clockwise; "doc" the same in the page's own order; "upright" the index of its own top-left);
- next: the frame with the pages found before painted over in its border's colour (pull.painted, the lab's
  findNext), its answer the next page (img/<n>-n<k>.jpg); a "painted" scene's frame is one too;
- inside: a card lying on its ספח or another sheet — the flat cut of the outer page (gen/phone.py warp_rgba, as the
  lab's findInside cuts it, not turned), its answer the card's corners on that cut (img/<n>-in<k>.jpg). The card is
  never an answer on the frame itself, so one picture never carries two answers.
- none: no document (fixed null), partial: a document partly out of the frame (fixed null, "partial": true — no
  corners and conf 0, the owner's label to confirm; its weight is 0 by default).
Every entry carries the content sha1s of the real pages laid (templates), the background photo's sha1 (bg) and the
occluders' sha1 prefixes (occ), so train.py's assert_clean can check them; the manifest row has the scene, the camera and the labels (field texts only as
sha1 prefixes)."""
import hashlib
import json
import pathlib

import numpy as np

MODEL, CHUNK = "edges", 20
GENERATOR = "gen.outputs.edges"
SELECT_SEEDS = 100000   # a select run's seeds are SELECT_SEEDS and up, a training or exam run's below: never the same scene


def _h(text):
    return hashlib.sha1(str(text).encode("utf-8")).hexdigest()[:8] if text is not None else None


def gen_args(ap):
    ap.add_argument("--count", type=int, default=None, help="scenes (default 8000; with --exam or --split select 300)")
    ap.add_argument("--seed", type=int, default=None, help="default 1 (with --exam 7)")
    ap.add_argument("--out", default=None, help="default ~/.scan-train/gen/runs/edges-s<seed>-n<count> (with --exam …-exam)")
    ap.add_argument("--jobs", type=int, default=None, help="processes (default: all cores but two, gently)")
    ap.add_argument("--templates", nargs="?", const="", default="", help="the real pages (default ~/.scan-train/templates when there)")
    ap.add_argument("--template-share", type=float, default=0.4, help="the share of pages that are real pages, where there are")
    ap.add_argument("--pdf-share", type=float, default=0.5, help="the share of contract / other pages rendered from a PDF")
    ap.add_argument("--procedural-share", type=float, default=0.15, help="the share of scenes on a procedural surface")
    ap.add_argument("--recipes", default="", help="recipe weights, e.g. single=0.4,pair=0.3 (gen/scene.py WEIGHTS)")
    ap.add_argument("--partial-weight", type=float, default=0.0, help="partial scenes' weight (0 until the owner confirms the label)")
    ap.add_argument("--sharp", action="store_true", help="keep unmarked real pages' face and text (not washed out)")
    ap.add_argument("--exam", action="store_true", help="the exam: only the real pages kept apart, the exam backgrounds, the check vocabulary")
    ap.add_argument("--split", choices=("train", "select", "exam"), default=None,
                    help="train (the default) | select: a made-up select set — its own seeds (%d and up; default %d), "
                    "the training side's pages and backgrounds, picked on by gen mix --select-run, never trained on | "
                    "exam (= --exam)" % (SELECT_SEEDS, SELECT_SEEDS + 1))
    ap.add_argument("--focus", help="gen mine's focus.json: draw more of what the exams got wrong (a training run only)")
    ap.add_argument("--focus-model", help="whose multipliers --focus takes (default: edges; the phone's own cuts: the "
                    "first writer it has)")
    ap.add_argument("--latin", nargs="*")
    ap.add_argument("--hebrew", nargs="*")


def _weights(a):
    from .. import scene as gs
    w = dict(gs.WEIGHTS)
    for part in filter(None, (a.recipes or "").split(",")):
        k, _, v = part.partition("=")
        if k.strip() not in gs.RECIPES:
            raise SystemExit(f"unknown recipe {k!r} (one of {', '.join(gs.RECIPES)})")
        w[k.strip()] = float(v)
    w["partial"] = a.partial_weight
    return w


def split_of(a):
    """The run's side from --split / --exam (--split exam sets --exam) → train | select | exam; a select run's seed
    is SELECT_SEEDS and up and a training or exam run's below (SystemExit otherwise), so a select scene is never a
    training or exam one."""
    if getattr(a, "split", None) == "exam":
        a.exam = True
    split = "exam" if a.exam else (getattr(a, "split", None) or "train")
    if split == "select":
        a.seed = a.seed or SELECT_SEEDS + 1
        if a.seed < SELECT_SEEDS:
            raise SystemExit(f"--split select: the seed must be {SELECT_SEEDS} or more (the select set's own range)")
        if getattr(a, "focus", None):
            raise SystemExit("--focus is for a training run: the select set is drawn plainly")
    elif a.seed is not None and a.seed >= SELECT_SEEDS:
        raise SystemExit(f"--seed {a.seed}: seeds from {SELECT_SEEDS} up are the select set's (--split select)")
    return split


def gen_params(a):
    import synth
    import synth_docs as sd
    from home import WORK
    from .. import backgrounds as gb
    from .. import common as gc
    from .. import pages as gp
    split = split_of(a)
    count, seed = a.count or (300 if split != "train" else 8000), a.seed or (7 if a.exam else 1)
    out = a.out or str(WORK / "gen" / "runs" / f"edges-s{seed}-n{count}{'' if split == 'train' else '-' + split}")
    folder = a.templates or (str(WORK / "templates") if (WORK / "templates").is_dir() else None)
    pages = sd.templates_in(folder) if folder else []
    pages = [pg for pg in pages if (synth.exam_page(pg[0]) if a.exam else not synth.held_out(pg[0]))]
    if a.exam and not pages:
        print("no real page kept apart here: the exam's pages are all drawn (with the check vocabulary)")
    side = "exam" if split == "exam" else "train"   # a select run draws the training side's pages and backgrounds
    gb.require_ready(WORK)
    bank = gb.Bank(WORK, side, a.procedural_share)
    occ = gb.Occluders(WORK, side)
    pdfs = [] if a.exam else gp.pdf_sources(WORK)   # every PDF is on the training side: the exam's contract / other pages are drawn
    # an exam run draws every font (each row records its font split); a training or select run never an exam font
    font_side = "exam" if split == "exam" else "train"
    latin = gc.fonts_for(a.latin or sd.latin_fonts(), font_side, given=bool(a.latin))
    hebrew = gc.fonts_for(a.hebrew or sd.hebrew_fonts("all"), font_side, given=bool(a.hebrew))
    if not latin or not hebrew:
        raise SystemExit("no Latin or Hebrew font found: give --latin / --hebrew")
    print(f"pages: {len(pages)} real, {len(pdfs)} PDFs ({'PyMuPDF here' if gp.has_pdf() else 'no PyMuPDF: PDF pages skipped'}); "
          f"backgrounds: {bank.info()['photos']} photos {bank.info()['categories']}; occluders: {len(occ)}")
    keep = ("category", "series", "licence", "size", "widthMm", "text_present", "status", "split")
    params = {"model": MODEL, "generator": GENERATOR, "split": split, "count": count, "seed": seed, "out": out,
            "pages": [{"path": p, "sha1": gc.file_sha1(p), "kind": k} for p, k in pages],
            "pdfs": [{"path": p, "sha1": gc.file_sha1(p), "kind": k} for p, k in pdfs],
            "photos": [{"path": e["path"], "sha1": e["sha1"], **{k: e.get(k) for k in keep}} for e in bank.entries],
            "occluders": [{"path": e["path"], "sha1": e["sha1"], "category": e.get("category"), "sizeMm": e.get("sizeMm"),
                           "licence": e.get("licence")} for e in occ.items],
            "weights": _weights(a), "templateShare": a.template_share, "pdfShare": a.pdf_share,
              "proceduralShare": a.procedural_share, "sharp": a.sharp, "held": bool(a.exam),
            "latin": list(latin), "hebrew": list(hebrew)}
    if getattr(a, "focus", None):
        if a.exam:
            raise SystemExit("--focus is for a training run: the exam is drawn the same every time")
        from .. import mine
        models = [m for m in str(getattr(a, "models", "") or "").split(",") if m] or [MODEL]
        got = mine.read_focus(a.focus) or {"models": {}}
        model = getattr(a, "focus_model", None) or next((m for m in models if m in got["models"]), models[0])
        rec = mine.focus_params(a.focus, model, params, categories=bank.by.keys())
        print(f"focus ({model}, run {rec['run']}): recipes {rec['weights']['recipe']}; "
              f"procedural share {rec['weights']['proceduralShare']}")
    return params


def gen_prepare(folder, params):
    (pathlib.Path(folder) / "img").mkdir(parents=True, exist_ok=True)


def gen_jobs(params, indices, folder):
    return [(params, chunk, folder) for chunk in (indices[k:k + CHUNK] for k in range(0, len(indices), CHUNK))]


class _Bank:
    """The run's backgrounds as recorded in its params (the same photos when a sample is drawn again)."""

    def __init__(self, photos, share, category_weights=None):
        from ..backgrounds import Bank
        self.b = Bank.__new__(Bank)
        self.b.procedural_share, self.b.by, self.b.entries = share, {}, []
        self.b.category_weights = category_weights
        for e in photos:
            item = dict(e)
            self.b.entries.append(item)
            self.b.by.setdefault(item.get("category") or "uncategorised", {}).setdefault(item.get("series") or item["sha1"], []).append(item)

    def sample(self, rng, hard=False):
        return self.b.sample(rng, hard)


class _Occluders:
    def __init__(self, items):
        self.items = list(items)

    def __len__(self):
        return len(self.items)

    def sample(self, rng):
        from ..backgrounds import Occluders
        o = Occluders.__new__(Occluders)
        o.items = self.items
        return o.sample(rng)


def entries_of(sc, frame, labels, roles, folder, i, seed, split, meta_common, store=None):
    """The pictures of one scene and their examples.json entries → (entries, files written). store(name, picture) →
    the path an entry names takes each picture instead of writing it as the phone keeps it (exam.py's E4: the same
    pictures from the frame at its native size, never stored as JPEG)."""
    import synth
    from .. import phone, scene as gs
    folder = pathlib.Path(folder)
    out, files = [], []

    def write(name, img):
        if store is not None:
            return store(name, img)
        data, _ = phone.store_attempt(img)
        (folder / "img" / name).write_bytes(data)
        files.append(f"img/{name}")
        return str(folder / "img" / name)

    def entry(ident, f, fixed, role, doc=None, up=None, kind="none", **more):
        e = {"id": ident, "file": f, "model": None, "fixed": fixed, "moved": 0, "exam": split == "exam", "synth": True,
             "kind": kind, "none": fixed is None, "role": role, "recipe": sc.recipe, "manifest": f"gen-{seed}-{i}", **meta_common, **more,
             **({"split": split} if split == "select" else {})}
        if fixed is not None:
            e.update({"upright": up, "doc": doc})
        return e

    base = f"gen-{seed}-{i}"
    main = write(f"{i}.jpg", frame)
    tops = [(l, r) for l, r in roles if r in ("answer", "next")]
    if sc.recipe == "partial":
        out.append(entry(base, main, None, "answer", partial=True, kind=labels[0]["doctype"] if labels else "none"))
    elif not tops:
        out.append(entry(base, main, None, "answer"))
    else:
        l0 = tops[0][0]
        out.append(entry(base, main, l0["quadModel"], "next" if sc.recipe == "painted" else "answer", l0["quad01"], l0["upright"], l0["doctype"]))
        found = [l0["quad01"]]
        for k, (l, _) in enumerate(tops[1:], 1):
            f = write(f"{i}-n{k}.jpg", gs.paint(frame, found))
            out.append(entry(f"{base}-n{k}", f, l["quadModel"], "next", l["quad01"], l["upright"], l["doctype"]))
            found.append(l["quad01"])
    for k, (l, r) in enumerate([x for x in roles if x[1] == "inside"], 1):
        outer = labels[l["insideOf"]]
        cut = phone.warp_rgba(frame, outer["quadModel"])[..., :3]
        if cut.size == 0:
            continue
        Hq = phone.homography(outer["quadModel"], [[0, 0], [1, 0], [1, 1], [0, 1]])
        doc = [list(phone.apply_h(Hq, x, y)) for x, y in l["quad01"]]
        fixed = synth.order_corners(doc)
        import synth_docs as sd
        f = write(f"{i}-in{k}.jpg", np.ascontiguousarray(cut))
        out.append(entry(f"{base}-in{k}", f, fixed, "inside", doc, sd.upright_index(fixed, doc[0]), l["doctype"],
                         insideOf=f"{base}"))
    return out, files


def tools(params):
    """What a run's scenes are drawn with: (fonts, the page pool, the background bank, the occluders) — as recorded in
    its params (gen/phone_run.py draws its scenes with them too)."""
    import synth_docs as sd
    from .. import pages as gp
    F = sd.Fonts(params["latin"], params["hebrew"])
    pool = gp.Pool([(e["path"], e["kind"]) for e in params["pages"]], [(e["path"], e["kind"]) for e in params["pdfs"]],
                   held=params.get("held", False), sharp=params.get("sharp", False),
                   template_share=params.get("templateShare", 0.4), pdf_share=params.get("pdfShare", 0.5),
                   kind_weights=params.get("kindWeights"))
    return F, pool, _Bank(params["photos"], params.get("proceduralShare", 0.15), params.get("bgCategoryWeights")), \
        _Occluders(params.get("occluders") or [])


def scene_of(params, i, F, pool, bank, occ):
    """Scene i of a run: (its streams, the scene or None when no pose fits in 8 tries)."""
    from .. import rng as grng
    from .. import scene as gs
    r = grng.streams(params["seed"], i)
    for _ in range(8):   # a pose that fits: the next draws of the same streams (the same every run)
        sc = gs.plan(r, pool, F, bank, occ, weights=params["weights"], tilt_weights=params.get("tiltWeights"))
        if sc is not None:
            return r, sc
    return r, None


def native_pictures(params, i, tools_):
    """Scene i's pictures — {file name its examples.json entry names: picture (BGR)} — drawn again from the frame at the
    camera's native size (gen/phone_run.py native_scene: the 1920 × 1080 video or the photo at its natural size, as the
    lab takes it), never stored as JPEG: the frame, its painted next pictures and the inside cuts, made from that frame
    as entries_of makes them. tools_: tools(params). {} when no pose fits."""
    from .. import phone_run as pr
    from .. import scene as gs
    F, pool, bank, occ = tools_
    r, sc = scene_of(params, i, F, pool, bank, occ)
    if sc is None:
        return {}
    sc = pr.native_scene(sc)
    frame = gs.render(sc, r["camera"])
    labels = gs.doc_labels(sc)
    roles = gs.roles(sc, labels)
    pics = {}

    def keep(name, img):
        pics[name] = img
        return name
    entries_of(sc, frame, labels, roles, ".", i, params["seed"], params["split"], {}, store=keep)
    return pics


def scene_meta(params, sc, labels, roles, F, skipped0):
    """The manifest fields every scene's row has (pages and background laid, fonts, the scene, the camera) — the
    caller adds class, source and labels."""
    from .. import pages as gp
    from .. import rng as grng
    laid = [l["templateSha1"] for l, _ in roles if l["templateSha1"]] + [l["templateSha1"] for l in labels if l["templateSha1"]]
    laid = list(dict.fromkeys(laid))
    return {"templates": laid, "bgSha1": sc.bg.get("sha1"), "bgCategory": sc.bg.get("category"), "bgKind": sc.bg.get("kind"),
            "fonts": F.used(), "vocabulary": "check" if params.get("held") else "train", "recipe": sc.recipe, "rng": grng.STAGED,
            "scene": {"recipe": sc.recipe, "pages": [{"kind": l["kind"], "doctype": l["doctype"], "source": l["source"],
                                                      "material": l["material"], "insideOf": l["insideOf"], "painted": l["painted"],
                                                      "bend": (l["bend"] or {}).get("kind"), "visible": l["visible"],
                                                      **({"pdf": l["fileSha1"][:12]} if l["fileSha1"] else {})} for l in labels],
                      "occluders": [o["kind"] for o in sc.occluders],
                      "occluderSha1s": [o["sha1"][:12] for o in sc.occluders if o.get("sha1")],
                      "finger": bool(sc.fingers), "worn": sorted(sc.worn),
                      "bgSeries": sc.bg.get("series"), "pdfSkipped": gp.SKIPPED["pdf"] - skipped0,
                      "bgPpm": round(float(sc.bg.get("ppm") or 0), 3), "framePpm": round(float(sc.bg.get("framePpm") or 0), 3)},
            "camera": sc.cam.info()}


def _batch(job):
    params, indices, folder = job
    from .. import pages as gp
    from .. import scene as gs
    F, pool, bank, occ = tools(params)
    seed, split = params["seed"], params["split"]
    out = []
    for i in indices:
        skipped0 = gp.SKIPPED["pdf"]
        r, sc = scene_of(params, i, F, pool, bank, occ)
        if sc is None:
            F.used()
            continue
        frame = gs.render(sc, r["camera"])
        labels = gs.doc_labels(sc)
        roles = gs.roles(sc, labels)
        base_meta = scene_meta(params, sc, labels, roles, F, skipped0)
        laid = base_meta["templates"]
        common = {**({"templateSha1": roles[0][0]["templateSha1"]} if roles and roles[0][0]["templateSha1"] else {}),
                  **({"templates": sorted(set(laid))} if laid else {}), **({"bg": sc.bg["sha1"]} if sc.bg.get("sha1") else {}),
                  **({"occ": [o["sha1"][:12] for o in sc.occluders if o.get("sha1")]} if any(o.get("sha1") for o in sc.occluders) else {})}
        entries, files = entries_of(sc, frame, labels, roles, folder, i, seed, split, common)
        answer = next((l for l, rl in roles if rl == "answer"), None)
        cls = answer["doctype"] if answer and sc.recipe != "partial" else (labels[0]["doctype"] if sc.recipe == "partial" and labels else "none")
        meta = {**base_meta, "class": cls,
                "source": answer["source"] if answer else (labels[0]["source"] if labels else "none"),
                "labels": {"fixed": entries[0]["fixed"], "doc": entries[0].get("doc"), "upright": entries[0].get("upright"),
                           "none": entries[0]["fixed"] is None, "partial": sc.recipe == "partial",
                           "entries": [{"file": pathlib.Path(e["file"]).name, "role": e["role"], "fixed": e["fixed"]} for e in entries],
                           "docs": [{"role": rl, "pageId": l["pageId"], "doctype": l["doctype"], "insideOf": l["insideOf"],
                                     "quad01": l["quad01"], "quadModel": l["quadModel"],
                                     "fields": [{"role": f["role"], "text": _h(f["text"]),
                                                 "quad": [[x / sc.cam.W, y / sc.cam.H] for x, y in f["quad"]]} for f in l["fields"]],
                                     "face": [[x / sc.cam.W, y / sc.cam.H] for x, y in l["face"]] if l["face"] else None,
                                     "mrz": _h(l["mrz"])} for l, rl in roles + [(l, "painted") for l in labels if l["painted"]]]}}
        out.append({"index": i, "id": f"gen-{seed}-{i}", "entry": entries, "files": files, "meta": meta})
    return out


def gen_write(folder, params, items):
    from collections import Counter
    from .. import common as gc
    ex = [e for it in items for e in it["entry"]]
    (pathlib.Path(folder) / "examples.json").write_text(json.dumps(ex, ensure_ascii=False), encoding="utf-8")
    if params["split"] == "exam":
        import home
        try:
            own = pathlib.Path(folder).resolve().is_relative_to((pathlib.Path(home.WORK) / "gen" / "runs").resolve())
        except OSError:
            own = False
        if own:
            gc.record_exam_set(f"gen/{pathlib.Path(folder).name}", pathlib.Path(folder) / "examples.json")
    rec = Counter(it["meta"]["recipe"] for it in items)
    role = Counter(e["role"] for e in ex)
    print(f"{len(items)} scenes, {len(ex)} pictures in {folder}: " + ", ".join(f"{k} {n}" for k, n in sorted(rec.items()))
          + " — roles " + ", ".join(f"{k} {n}" for k, n in sorted(role.items())))
