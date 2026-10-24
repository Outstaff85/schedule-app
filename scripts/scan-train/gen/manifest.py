"""What a made-up set was made of, one row per example, and what the run was (docs/scan-training.md → "Made-up
sets: build, verify, QA").

- manifest.jsonl (in the set's folder, sorted by index): id, model, split, seed, index, rng (the stream scheme,
  gen/rng.py), templateId ("tpl:<sha1 prefix>" or "drawn") with templateSha1 and every page laid (templates),
  backgroundId ("bg:<sha1 prefix>" or "procedural") with its category, the fonts, the vocabulary half (train /
  check), the scene and camera parameters, the labels, labelSource, weight, and each output file with its sha256.
  Hashes only: no file name of a real page, no name or number off a document.
- run.json: the git commit of scripts/scan-train, the libraries' versions, the sha256 of heldout.json and of the
  class table (DOCTYPES), the counts, the manifest's sha256 and the data fingerprint (the same seed, count and
  inputs give the same fingerprint, whatever --jobs), and the parameters to draw any example again (gen verify) —
  those name the local files laid, so run.json stays on this PC like the set.
- data_fingerprint / compare_data: what a training's checkpoint records of its data (checkpoint.py) and how two are
  told apart: the class table or heldout.json changed ("labels": --more refuses), or only the examples ("data").
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
             "albucore": "albucore", "python-bidi": "python-bidi"}


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
    r = {"id": ident, "model": model, "split": split, "seed": seed, "index": index, "rng": rng}
    r.update(template_fields(meta.get("templates") or []))
    r.update(background_fields(meta.get("bgSha1"), meta.get("bgCategory"), meta.get("bgKind")))
    r.update({"fonts": sorted(meta.get("fonts") or []), "vocabulary": meta.get("vocabulary", "train"),
              "class": meta.get("class"), "source": meta.get("source"), "scene": meta.get("scene") or {},
              "camera": meta.get("camera") or {}, "labels": meta.get("labels") or {},
              "labelSource": meta.get("labelSource", "drawn"), "weight": float(meta.get("weight", 1.0)),
              "outputs": [[p, h] for p, h in outputs]})
    if meta.get("open"):
        r["open"] = meta["open"]
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
    return {"examples": len(rows), "outputs": sum(len(r.get("outputs") or []) for r in rows), "byClass": by("class"),
            "bySource": by("source"), "byBackground": by("bgCategory"), "byTemplate": {"drawn": sum(r["templateId"] == DRAWN for r in rows),
                                                                                         "real": sum(r["templateId"] != DRAWN for r in rows)}}


def write_run(folder, model, split, params, rows, manifest_sha):
    info = {"id": pathlib.Path(folder).name, "model": model, "split": split,
            "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "git": git_state(), "libraries": libraries(), "heldoutSha256": gc.heldout_sha256(), "doctypesSha256": doctypes_sha256(),
            "counts": counts(rows), "manifestSha256": manifest_sha, "fingerprint": manifest_sha, "params": params}
    (pathlib.Path(folder) / RUN).write_text(json.dumps(info, indent=1, ensure_ascii=False, default=str), encoding="utf-8")
    return info


# ---------- what the exam keeps ----------
def held_refs(rows, held=None, work=None):
    """[(row id, why)] of the rows that reference what the exam keeps: a training row laying a held-out template,
    on an exam background, with an exam split key, or cut from an open set's exam document; an exam row laying a
    page that is not held out."""
    from . import sources
    import midv
    held = held or sources.Held(work)
    out = []
    for r in rows:
        shas = [s for s in [r.get("templateSha1")] + list(r.get("templates") or []) if s]
        if r.get("split") in gc.EXAM_SIDE:
            if any(s not in held.sha1s for s in shas):
                out.append((r["id"], "an exam row lays a page that is not held out"))
            continue
        if any(s in held.sha1s for s in shas):
            out.append((r["id"], "a held-out template"))
        bg = r.get("backgroundSha1")
        if bg and (bg in held.backgrounds or bg[:12] in held.backgrounds):
            out.append((r["id"], "an exam background"))
        if r.get("key") and r["key"] in held.keys:
            out.append((r["id"], "an exam split key"))
        o = r.get("open")
        if isinstance(o, dict) and midv.open_exam(o):
            out.append((r["id"], "an open-set exam document"))
    return out


# ---------- a training's data, for its checkpoint ----------
def ids_sha256(ids):
    return sha256_text("\n".join(sorted(str(i) for i in ids)))


def data_fingerprint(train=(), **parts):
    """What a checkpoint records of the data it was trained on: the class table's and heldout.json's sha256, the
    training examples' ids (sorted, hashed) and any other part given (a made-up set's run fingerprint, the sizes, the
    batch) — "sha" over all of it."""
    d = {"doctypes": doctypes_sha256(), "heldout": gc.heldout_sha256(), "train": ids_sha256(train), **parts}
    d["sha"] = sha256_text(canonical({k: v for k, v in d.items() if k != "sha"}))
    return d


LABEL_KEYS = ("doctypes", "heldout")


def compare_data(old, new):
    """→ ("same" | "labels" | "data", [the parts that differ]): "labels" when the class table or heldout.json changed
    (or the old checkpoint records no fingerprint: made before Training 4), "data" when only the examples did."""
    if not isinstance(old, dict) or "sha" not in old:
        return "labels", ["no data fingerprint"]
    keys = sorted((set(old) | set(new)) - {"sha"})
    diff = [k for k in keys if old.get(k) != new.get(k)]
    if not diff:
        return "same", []
    return ("labels" if any(k in LABEL_KEYS for k in diff) else "data"), diff


def run_fingerprint(folder):
    """A made-up set's data fingerprint (its run.json), None when it was not made through gen build."""
    info = read_run(folder)
    return info.get("fingerprint") if info else None
