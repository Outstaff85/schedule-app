"""What a made-up set was made of, one row per example, and what the run was (docs/scan-training.md → "Made-up
sets: build, verify, QA").

- manifest.jsonl (in the set's folder, sorted by index): id, model, split, seed, index, rng (the stream scheme,
  gen/rng.py), templateId ("tpl:<sha1 prefix>" or "drawn") with templateSha1 and every page laid (templates),
  backgroundId ("bg:<sha1 prefix>" or "procedural") with its category, the fonts, the vocabulary half (train /
  check), the scene and camera parameters, the labels, labelSource, weight, and each output file with its sha256.
  Hashes only: no file name of a real page, no name or number off a document.
- run.json: the git commit of scripts/scan-train, the libraries' versions, the sha256 of heldout.json and of the
  class table (DOCTYPES), the counts (by class, source, background category, recipe, tilt bucket…), the focus a
  `gen build --focus` drew by (gen mine's multipliers and the weights they gave), the manifest's sha256 and the data fingerprint (the same seed, count and
  inputs give the same fingerprint, whatever --jobs), and the parameters to draw any example again (gen verify) —
  those name the local files laid, so run.json stays on this PC like the set.
- data_fingerprint / compare_data: what a training's checkpoint records of its data (checkpoint.py) and how two are
  told apart: the class table or heldout.json changed, or trained examples are now on the exam side (exam_ids: a
  record's split moved from train to exam without heldout.json changing) — "labels": --more refuses —, or only the
  examples ("data").
- held_refs(rows): the rows that reference what the exam keeps (gen verify and gen qa).
Pure: no torch, no Google package."""
import datetime
import hashlib
import json
import pathlib
import subprocess
import sys

from . import common as gc

MANIFEST, RUN = "manifest.jsonl", "run.json"
DRAWN, PROCEDURAL = "drawn", "procedural"
LIBRARIES = {"numpy": "numpy", "opencv": "opencv-python-headless", "pillow": "pillow", "albumentations": "albumentations",
             "albucore": "albucore", "python-bidi": "python-bidi", "pymupdf": "pymupdf"}


# ---------- small helpers ----------
def canonical(obj):
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str)


def sha256_text(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def doctypes_sha256():
    """The class table's identity: its order is the label index of the document type model."""
    return sha256_text(canonical(list(gc.DOCTYPES)))


class FontLog(list):
    """A font list that remembers which fonts were picked (random.choice reads seq[i]): the manifest's fonts,
    with not one draw of the stream changed."""

    def __init__(self, items=()):
        super().__init__(items)
        self.seen = set()

    def __getitem__(self, i):
        got = super().__getitem__(i)
        if isinstance(i, int):
            self.seen.add(pathlib.Path(got).name)
        return got

    def take(self):
        out, self.seen = sorted(self.seen), set()
        return out


# ---------- one row ----------
def template_fields(shas):
    """templateId / templateSha1 / templates of the pages laid (the first: the answer's own page)."""
    shas = [s for s in shas if s]
    if not shas:
        return {"templateId": DRAWN, "templateSha1": None, "templates": []}
    return {"templateId": "tpl:" + shas[0][:12], "templateSha1": shas[0], "templates": sorted(set(shas))}


def background_fields(sha=None, category=None, kind=None):
    if sha:
        return {"backgroundId": "bg:" + sha[:12], "backgroundSha1": sha, "bgCategory": category or "uncategorised"}
    return {"backgroundId": PROCEDURAL, "backgroundSha1": None, "bgCategory": PROCEDURAL, **({"bgKind": kind} if kind else {})}


def row(model, split, seed, index, ident, meta, outputs, rng="legacy"):
    """A manifest row: meta from the generator (templates, background, fonts, vocabulary, scene, camera, class,
    source, labels, open), outputs [(path relative to the set's folder, sha256)]."""
    r = {"id": ident, "model": model, "split": split, "seed": seed, "index": index, "rng": meta.get("rng", rng)}
    r.update(template_fields(meta.get("templates") or []))
    r.update(background_fields(meta.get("bgSha1"), meta.get("bgCategory"), meta.get("bgKind")))
    r.update({"fonts": sorted(meta.get("fonts") or []), "vocabulary": meta.get("vocabulary", "train"),
              "class": meta.get("class"), "source": meta.get("source"), "scene": meta.get("scene") or {},
              "camera": meta.get("camera") or {}, "labels": meta.get("labels") or {},
              "labelSource": meta.get("labelSource", "drawn"), "weight": float(meta.get("weight", 1.0)),
              "outputs": [[p, h] for p, h in outputs]})
    if meta.get("open"):
        r["open"] = meta["open"]
    if meta.get("recipe"):
        r["recipe"] = meta["recipe"]   # a scene's recipe (gen/scene.py): the QA sheet's strata
    return r


def write_manifest(folder, rows):
    """manifest.jsonl, sorted by index → its sha256 (the data fingerprint of the set)."""
    rows = sorted(rows, key=lambda r: r["index"])
    text = "".join(canonical(r) + "\n" for r in rows)
    (pathlib.Path(folder) / MANIFEST).write_bytes(text.encode("utf-8"))   # its bytes are the ones hashed (no CRLF on Windows)
    return sha256_text(text)


def read_manifest(folder):
    p = pathlib.Path(folder) / MANIFEST
    if not p.exists():
        return []
    return [json.loads(line) for line in p.read_text(encoding="utf-8").splitlines() if line.strip()]


def read_run(folder):
    p = pathlib.Path(folder) / RUN
    try:
        got = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return got if isinstance(got, dict) else None


# ---------- run.json ----------
def git_state():
    """The commit of scripts/scan-train the set was drawn with, and whether its files had changes not committed."""
    def git(*args):
        try:
            return subprocess.run(["git", "-C", str(gc.HERE), *args], capture_output=True, text=True, timeout=20).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return ""
    return {"head": git("rev-parse", "HEAD") or None, "scripts": git("log", "-1", "--format=%H", "--", ".") or None,
            "dirty": bool(git("status", "--porcelain", "--", "."))}


def libraries():
    """The versions of what the drawing's pixels depend on (requirements-synth.txt pins them)."""
    from importlib import metadata
    out = {"python": sys.version.split()[0]}
    for name, dist in LIBRARIES.items():
        try:
            out[name] = metadata.version(dist)
        except metadata.PackageNotFoundError:
            out[name] = None
    try:
        from PIL import features
        out["raqm"] = bool(features.check("raqm"))
    except Exception:
        out["raqm"] = None
    return out


def counts(rows):
    def by(k):
        c = {}
        for r in rows:
            v = str(r.get(k))
            c[v] = c.get(v, 0) + 1
        return dict(sorted(c.items()))
    out = {"examples": len(rows), "outputs": sum(len(r.get("outputs") or []) for r in rows), "byClass": by("class"),
           "bySource": by("source"), "byBackground": by("bgCategory"), "byTemplate": {"drawn": sum(r["templateId"] == DRAWN for r in rows),
                                                                                        "real": sum(r["templateId"] != DRAWN for r in rows)}}
    if any(r.get("recipe") for r in rows):   # scenes (gen/scene.py): by recipe, every page laid by its source, PDFs skipped
        out["byRecipe"] = by("recipe")
        laid = {}
        for r in rows:
            for p in (r.get("scene") or {}).get("pages") or []:
                laid[str(p.get("source"))] = laid.get(str(p.get("source")), 0) + 1
        out["pagesBySource"] = dict(sorted(laid.items()))
        out["backgroundSeries"] = len({(r.get("scene") or {}).get("bgSeries") for r in rows} - {None})
        out["pdfSkipped"] = sum(int((r.get("scene") or {}).get("pdfSkipped") or 0) for r in rows)
    if any((r.get("camera") or {}).get("tilt") is not None for r in rows):   # the camera's tilt by gen mine's buckets
        from .mine import tilt_bucket
        tilt = {}
        for r in rows:
            b = str(tilt_bucket((r.get("camera") or {}).get("tilt")))
            tilt[b] = tilt.get(b, 0) + 1
        out["byTilt"] = dict(sorted(tilt.items()))
    return out


def write_run(folder, model, split, params, rows, manifest_sha):
    info = {"id": pathlib.Path(folder).name, "model": model, "split": split,
            "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "git": git_state(), "libraries": libraries(), "heldoutSha256": gc.heldout_sha256(), "doctypesSha256": doctypes_sha256(),
            "counts": counts(rows), "manifestSha256": manifest_sha, "fingerprint": manifest_sha, "params": params}
    if params.get("focus"):   # gen build --focus: gen mine's multipliers and the weights they gave (also in params)
        info["focus"] = params["focus"]
    (pathlib.Path(folder) / RUN).write_text(json.dumps(info, indent=1, ensure_ascii=False, default=str), encoding="utf-8")
    return info


# ---------- what the exam keeps ----------
def held_refs(rows, held=None, work=None):
    """[(row id, why)] of the rows that reference what the exam keeps: a training row laying a held-out template,
    on an exam background, with an exam occluder, with an exam split key, drawn in an exam font (heldout.json
    examFonts), or cut from an open set's exam document;
    an exam row laying a page that is not held out, on a training background, laying a PDF (every PDF is on the
    training side) or with a training occluder."""
    from . import sources
    import midv
    held = held or sources.Held(work)
    fonts = getattr(held, "fonts", None)
    fonts = gc.exam_fonts() if fonts is None else fonts
    out = []
    for r in rows:
        shas = [s for s in [r.get("templateSha1")] + list(r.get("templates") or []) if s]
        sc = r.get("scene") if isinstance(r.get("scene"), dict) else {}
        occ = [o for o in sc.get("occluderSha1s") or [] if o]
        bg = r.get("backgroundSha1")
        exam_bg = bool(bg) and (bg in held.backgrounds or bg[:12] in held.backgrounds)
        if r.get("split") in gc.EXAM_SIDE:
            if any(s not in held.sha1s for s in shas):
                out.append((r["id"], "an exam row lays a page that is not held out"))
            if bg and not exam_bg:
                out.append((r["id"], "an exam row on a training background"))
            if any(isinstance(p, dict) and p.get("pdf") for p in sc.get("pages") or []):
                out.append((r["id"], "an exam row lays a training PDF"))
            if any(o not in getattr(held, "occluders", ()) for o in occ):
                out.append((r["id"], "an exam row with a training occluder"))
            continue
        if any(s in held.sha1s for s in shas):
            out.append((r["id"], "a held-out template"))
        if exam_bg:
            out.append((r["id"], "an exam background"))
        if any(o in getattr(held, "occluders", ()) for o in occ):
            out.append((r["id"], "an exam occluder"))
        if r.get("key") and r["key"] in held.keys:
            out.append((r["id"], "an exam split key"))
        if any(gc.is_exam_font(f, fonts) for f in r.get("fonts") or []):
            out.append((r["id"], "an exam font"))
        o = r.get("open")
        if isinstance(o, dict) and midv.open_exam(o):
            out.append((r["id"], "an open-set exam document"))
    return out


# ---------- a training's data, for its checkpoint ----------
def ids_sha256(ids):
    return sha256_text("\n".join(sorted(str(i) for i in ids)))


def short_id(i):
    """An example's id as the checkpoint keeps it: sha1(id)[:12] (the ids themselves are not stored)."""
    return hashlib.sha1(str(i).encode("utf-8")).hexdigest()[:12]


def data_fingerprint(train=(), **parts):
    """What a checkpoint records of the data it was trained on: the class table's and heldout.json's sha256, the
    training examples' ids (sorted and hashed as a whole — "train" — and each one's short_id — "trainIds", so --more
    can tell which of them are on the exam side today) and any other part given (a made-up set's run fingerprint, the
    sizes, the batch) — "sha" over all of it."""
    d = {"doctypes": doctypes_sha256(), "heldout": gc.heldout_sha256(), "train": ids_sha256(train),
         "trainIds": sorted({short_id(i) for i in train}), **parts}
    d["sha"] = sha256_text(canonical({k: v for k, v in d.items() if k != "sha"}))
    return d


def exam_ids(work=None):
    """The short_ids of the real examples on the exam side today (examples.json and doctypes.json entries, and gen real's
    real/index.jsonl rows, whose split is exam or golden, by gen.sources' rule): a record moves there when its split key
    changes (a session linked to a worker) or pull.py keeps more exam keys — with heldout.json unchanged."""
    from . import sources
    import home
    work = pathlib.Path(work or home.WORK)
    out = set()
    for f in ("examples.json", "doctypes.json"):
        try:
            got = json.loads((work / f).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for e in got if isinstance(got, list) else []:
            if isinstance(e, dict) and e.get("id") is not None and sources._real_split(e) in gc.EXAM_SIDE:
                out.add(short_id(e["id"]))
    try:
        lines = (work / "real" / "index.jsonl").read_text(encoding="utf-8").splitlines()
    except OSError:
        lines = []
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if isinstance(e, dict) and e.get("id") is not None and e.get("split") in gc.EXAM_SIDE:
            out.add(short_id(e["id"]))
    return out


LABEL_KEYS = ("doctypes", "heldout")
MOVED = "trained examples now on the exam side"
NO_IDS = "no training ids recorded"


def compare_data(old, new, exam=None):
    """→ ("same" | "labels" | "data", [the parts that differ]): "labels" when the class table or heldout.json changed,
    when the old checkpoint records no fingerprint (made before Training 4), or — exam given (exam_ids) — when any of
    its training examples is on the exam side today ("N trained examples now on the exam side"; a checkpoint with no
    trainIds cannot be checked: "no training ids recorded", "labels" too); "data" when only the examples did."""
    if not isinstance(old, dict) or "sha" not in old:
        return "labels", ["no data fingerprint"]
    keys = sorted((set(old) | set(new)) - {"sha"})
    diff = [k for k in keys if old.get(k) != new.get(k)]
    moved = []
    if exam is not None:
        if not isinstance(old.get("trainIds"), list):
            moved = [NO_IDS]
        else:
            n = len(set(old["trainIds"]) & set(exam))
            moved = [f"{n} {MOVED}"] if n else []
    if not diff and not moved:
        return "same", []
    return ("labels" if moved or any(k in LABEL_KEYS for k in diff) else "data"), diff + moved


def run_fingerprint(folder):
    """A made-up set's data fingerprint (its run.json), None when it was not made through gen build."""
    info = read_run(folder)
    return info.get("fingerprint") if info else None
