"""The background bank (docs/scan-training.md → "The background bank"): the photos of tables, cloths, floors… the scenes
lay their documents on, catalogued, checked and split — and the cut-outs that lie over a document (occluders).

  python -m gen bg pull                       # datasets/backgrounds and backgrounds-own from the private bucket (datasets_hf.py)
  python -m gen bg add DIR --category auto    # catalog DIR's photos (CC0 downloads: their sources.json; --owner: the owner's shots)
  python -m gen bg check                      # size, near-duplicates, the lab's edges model, text → each photo's status
  python -m gen bg split                      # ~20 % of the surfaces to the exam, by the crc of a sha1
  python -m gen bg push                       # the bank → the private bucket (the owner's step, after looking at it)
  python -m gen occluders add DIR --category cup --size-mm 80   # cut-outs (PNG with alpha) laid over documents

<home>/backgrounds/catalog.json: {"version": 1, "files": {name: {category, series, licence, url, size [w, h], sha1, split,
ownerShot, text_present, status, phash, docConf}}}. status: ok, small (under MIN_SIDE on its long side), duplicate (a
near-duplicate of a larger photo by pHash), document (the lab's edges model sees a document in it with conf ≥ DOC_CONF:
a background with paper teaches the model to pass documents by), new (not checked yet). A photo is used only when its
status is ok AND its licence is confirmed (CONFIRMED: CC0, public domain, the owner's own); text_present marks a photo
with text but no document's shape: a hard negative ("nothing here" scenes prefer it). split: train, exam or none (a
series' photos past EXAM_PER_SERIES in the exam: in neither set, so no near twin trains).

Bank(work, split) samples balanced by category — then by series (a series of one surface counts once), then a photo;
PROCEDURAL_SHARE of the scenes get a procedural surface instead (synth_docs.surface: a category of its own,
"procedural"). heldout.json's examBackgrounds are the exam's too. Nothing here writes to the bucket but `bg push`."""
import json
import pathlib
import shutil
import zlib
from functools import lru_cache

from . import common as gc

PICTURES = (".jpg", ".jpeg", ".png", ".webp")
CATALOG = "catalog.json"
CONFIRMED = ("cc0", "pdm", "public-domain", "owner")
MIN_SIDE = 1600          # px on the long side
DUP_DIST = 6             # pHash bits (of 64) at most: a near-duplicate
SERIES_DIST = 12         # pHash bits at most, same category: one surface shot again (a series)
DOC_CONF = 0.5           # the lab's edges model as sure as this: a document in the photo
TEXT_MIN = 12            # text-like marks in lines: text present
EXAM_SHARE, EXAM_PER_SERIES = 0.2, 3
PROCEDURAL_SHARE = 0.15
PROCEDURAL = "procedural"
# a download's words (its search query, title) → its category; the first match wins
CATEGORY_WORDS = (
    ("car", ("car ", "car-", "car_", "vehicle", "dashboard", "seat")),
    ("desk", ("office", "desk", "keyboard", "laptop")),
    ("bed-sofa", ("sofa", "couch", "cushion", "bed sheet", "bed sheets", "bedding", "pillow", "mattress")),
    ("tablecloth", ("tablecloth", "table cloth", "oilcloth")),
    ("rug", ("rug", "carpet", "mat ")),
    ("glass", ("glass",)),
    ("light", ("white", "light ", "pale")),
    ("dark", ("black", "dark ")),
    ("stone", ("granite", "marble", "stone", "concrete", "countertop", "terrazzo")),
    ("tile", ("tile",)),
    ("wood", ("wood", "parquet", "bench", "plank", "oak", "walnut")),
    ("fabric", ("fabric", "linen", "knit", "denim", "wool", "blanket", "cloth", "leather", "textile", "cotton")),
    ("hand", ("hand",)),
)


# ---------- the catalog ----------
def folder(work=None):
    import home
    return pathlib.Path(work or home.WORK) / "backgrounds"


def load(work=None, name="backgrounds"):
    p = (pathlib.Path(work) / name if work else folder().parent / name) / CATALOG
    try:
        got = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        got = {}
    if not isinstance(got, dict):
        got = {}
    got.setdefault("version", 1)
    got.setdefault("files", {})
    return got


def save(cat, work=None, name="backgrounds"):
    d = pathlib.Path(work) / name if work else folder().parent / name
    d.mkdir(parents=True, exist_ok=True)
    (d / CATALOG).write_text(json.dumps(cat, indent=1, ensure_ascii=False, sort_keys=True), encoding="utf-8")


def confirmed(e):
    return str(e.get("licence") or "").lower() in CONFIRMED


def usable(e):
    """A photo the scenes may lay documents on: checked ok and its licence confirmed."""
    return e.get("status") == "ok" and confirmed(e)


def auto_category(*texts):
    s = " " + " ".join(str(t or "") for t in texts).lower() + " "
    for cat, words in CATEGORY_WORDS:
        if any(w in s for w in words):
            return cat
    return "uncategorised"


def read_sources(d):
    """A download folder's sources.json (datasets/backgrounds: [{file, query, license, source, title}]) → {file: info}."""
    try:
        got = json.loads((pathlib.Path(d) / "sources.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    items = got if isinstance(got, list) else [dict(v, file=k) for k, v in got.items()] if isinstance(got, dict) else []
    return {str(x.get("file")): x for x in items if isinstance(x, dict) and x.get("file")}


def _size(p):
    from PIL import Image
    try:
        with Image.open(p) as im:
            return list(im.size)
    except Exception:
        return None


def add(src, category="auto", work=None, series=None, licence=None, url=None, owner=False, name="backgrounds"):
    """Catalog the photos of src (copied into <home>/<name>/ unless they are there already) → (added, updated).
    category "auto": from the download's sources.json words (CATEGORY_WORDS); licence: --licence, else the sources.json
    one, else "owner" for the owner's shots (--owner), else none (the photo is then never used)."""
    src = pathlib.Path(src)
    dest = (pathlib.Path(work) if work else folder().parent) / name
    dest.mkdir(parents=True, exist_ok=True)
    cat = load(work, name)
    files, info = cat["files"], read_sources(src)
    added = updated = 0
    for p in sorted(src.rglob("*")):
        if p.suffix.lower() not in PICTURES or not p.is_file():
            continue
        sha = gc.file_sha1(p)
        fname = p.name
        target = dest / fname
        if target.resolve() != p.resolve():
            if target.exists() and gc.file_sha1(target) != sha:
                fname = f"{sha[:8]}-{p.name}"
                target = dest / fname
            if not target.exists():
                shutil.copy2(p, target)
        src_info = info.get(p.name) or {}
        lic = licence or src_info.get("license") or src_info.get("licence") or ("owner" if owner else None)
        cat_name = category if category != "auto" else auto_category(src_info.get("query"), src_info.get("title"),
                                                                      src_info.get("category"))
        old = files.get(fname)
        e = dict(old or {})
        e.update({"sha1": sha, "size": _size(target), "ownerShot": bool(owner or e.get("ownerShot"))})
        if src_info.get("title"):
            e["title"] = str(src_info["title"])[:120]   # a download's own title (its series: _series)
        if not old or old.get("sha1") != sha:
            e.update({"status": "new", "split": None, "text_present": None, "phash": None, "docConf": None})
        if category != "auto" or not e.get("category"):
            e["category"] = cat_name
        if series:
            e["series"] = series
        if lic:
            e["licence"] = str(lic).lower()
        e.setdefault("licence", None)
        if url or src_info.get("source") or src_info.get("url"):
            e["url"] = url or src_info.get("source") or src_info.get("url")
        e.setdefault("url", None)
        files[fname] = e
        added += old is None
        updated += old is not None
    save(cat, work, name)
    return added, updated


# ---------- the checks ----------
def phash(img):
    """A 64-bit perceptual hash (hex): the 32 × 32 grey picture's DCT, its 8 × 8 lowest frequencies (not the DC) against
    their median."""
    import cv2
    import numpy as np
    g = img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    small = cv2.resize(g, (32, 32), interpolation=cv2.INTER_AREA).astype(np.float32)
    d = cv2.dct(small)[:8, :8].reshape(-1)
    bits = d[1:] > np.median(d[1:])
    v = 0
    for b in bits:
        v = (v << 1) | int(b)
    return f"{v:016x}"


def hamming(a, b):
    return bin(int(a, 16) ^ int(b, 16)).count("1")


TEXT_INK, TEXT_CHAIN, TEXT_COVER = 45, 6, 0.2


def text_score(img):
    """How many text-like marks stand in lines: dark, sharp marks of a letter's size (the black-hat above TEXT_INK),
    chained left to right on one baseline with a letter's gaps, TEXT_CHAIN of them at least. A woven or knitted
    texture also chains its marks — but all over the picture: when the chains cover more than TEXT_COVER of it, it is a
    texture (0). A photo with text and no document's shape scores high: a hard negative."""
    import cv2
    import numpy as np
    g = img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    k = 1024 / max(g.shape)
    if k < 1:
        g = cv2.resize(g, (round(g.shape[1] * k), round(g.shape[0] * k)), interpolation=cv2.INTER_AREA)
    bh = cv2.morphologyEx(g, cv2.MORPH_BLACKHAT, cv2.getStructuringElement(cv2.MORPH_RECT, (21, 21)))
    m = (bh >= TEXT_INK).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    marks = []
    for i in range(1, n):
        x, y, w, h, a = (int(v) for v in stats[i])
        if 7 <= h <= 40 and 0.12 <= w / h <= 1.6 and 0.2 <= a / (w * h) <= 0.85:
            marks.append((x, y, w, h))
    if len(marks) < TEXT_CHAIN:
        return 0
    marks.sort()
    used, chains = set(), []
    for i, (x, y, w, h) in enumerate(marks):
        if i in used:
            continue
        chain, cur = [i], (x, y, w, h)
        for j in range(i + 1, len(marks)):
            if j in used:
                continue
            x2, y2, w2, h2 = marks[j]
            cx, cy, cw, ch = cur
            gap = x2 - (cx + cw)
            if gap > ch * 1.0:
                if x2 - cx > ch * 6:
                    break
                continue
            if gap >= -0.1 * ch and abs((y2 + h2) - (cy + ch)) < 0.25 * ch and abs(h2 - ch) < 0.35 * ch:
                chain.append(j)
                cur = marks[j]
        if len(chain) >= TEXT_CHAIN:
            used.update(chain)
            chains.append(chain)
    if not chains:
        return 0
    cover = sum((marks[c[-1]][0] + marks[c[-1]][2] - marks[c[0]][0]) * max(marks[j][3] for j in c) for c in chains)
    if cover > TEXT_COVER * g.shape[0] * g.shape[1]:
        return 0
    return sum(len(c) for c in chains)


def edges_detector(work=None, version=None):
    """The lab's edges models (scripts/scan-lab/models-version, <home>/models/<version>/, fetched from the public repo
    when missing) as a detector: picture → the highest conf they give on the whole picture and its four overlapping
    quarters (each model through the phone's own input path: the light one as the live frame, the accurate one as the
    capture)."""
    import onnxruntime as ort
    import home
    import docfind
    v = version or (gc.HERE.parents[1] / "scripts" / "scan-lab" / "models-version").read_text().strip()
    sess = []
    for name, op in (("edges-lite.onnx", "live"), ("edges.onnx", "capture")):
        p = pathlib.Path(work or home.WORK) / "models" / v / name
        if not p.exists():
            from common import model_path
            p = model_path(v, name)
        sess.append((ort.InferenceSession(str(p), providers=["CPUExecutionProvider"]), op))

    def detect(img):
        h, w = img.shape[:2]
        parts = [img] + [img[y:y + int(h * 0.6), x:x + int(w * 0.6)] for y in (0, h - int(h * 0.6)) for x in (0, w - int(w * 0.6))]
        best = 0.0
        for part in parts:
            for s, op in sess:
                _, conf = docfind.detect(s, part, op)
                best = max(best, float(conf or 0))
        return best
    detect.version = v
    return detect


def _read(p):
    import cv2
    return cv2.imread(str(p))


def check(work=None, detector=None, min_side=MIN_SIDE, dup=DUP_DIST, doc_conf=DOC_CONF, name="backgrounds"):
    """Check every catalogued photo (status, phash, docConf, text_present, series) → the report {counts by category of
    the photos used, rejected by reason, the hard negatives}. detector: picture → conf (edges_detector by default)."""
    cat = load(work, name)
    files = cat["files"]
    d = (pathlib.Path(work) if work else folder().parent) / name
    detector = detector or edges_detector(work)
    imgs = {}
    for fname, e in sorted(files.items()):
        img = _read(d / fname)
        if img is None:
            e["status"] = "unreadable"
            continue
        imgs[fname] = img
        e["size"] = [int(img.shape[1]), int(img.shape[0])]
        e["phash"] = phash(img)
        e["status"] = "small" if max(img.shape[:2]) < min_side else "ok"
        e.pop("dupOf", None)
    # near-duplicates: the larger photo (then the name) is kept
    order = sorted(imgs, key=lambda f: (-(files[f]["size"][0] * files[f]["size"][1]), f))
    kept = []
    for f in order:
        twin = next((k for k in kept if hamming(files[k]["phash"], files[f]["phash"]) <= dup), None)
        if twin:
            if files[f]["status"] == "ok":
                files[f]["status"] = "duplicate"
            files[f]["dupOf"] = twin
        else:
            kept.append(f)
    for f in order:
        e = files[f]
        e["docConf"] = round(float(detector(imgs[f])), 4)
        if e["status"] == "ok" and e["docConf"] >= doc_conf:
            e["status"] = "document"
        e["text_present"] = text_score(imgs[f]) >= TEXT_MIN
    _series(files)
    save(cat, work, name)
    return report(cat)


def title_key(t):
    """A download's title as its series: lowercase, letters only, the first four words ("Brown animal carpet texture,
    close-up 3" and "… 4" are one)."""
    import re
    words = re.sub(r"[^a-z ]+", " ", str(t or "").lower()).split()
    return " ".join(words[:4]) if len(words) >= 2 else None


def _series(files):
    """One surface shot again is one series: an explicit series, else photos of one category with the same download
    title (title_key) or close pHashes (SERIES_DIST) — the series' id is "s:" + the smallest sha1's prefix of its
    members."""
    names = sorted(f for f, e in files.items() if e.get("phash"))
    parent = {f: f for f in names}

    def root(f):
        while parent[f] != f:
            parent[f] = parent[parent[f]]
            f = parent[f]
        return f
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            ea, eb = files[a], files[b]
            same = ea.get("series") and ea.get("series") == eb.get("series") and not str(ea["series"]).startswith("s:")
            close = ea.get("category") == eb.get("category") and (
                hamming(ea["phash"], eb["phash"]) <= SERIES_DIST
                or (title_key(ea.get("title")) is not None and title_key(ea.get("title")) == title_key(eb.get("title"))))
            if same or close:
                parent[root(a)] = root(b)
    groups = {}
    for f in names:
        groups.setdefault(root(f), []).append(f)
    for members in groups.values():
        given = next((files[m]["series"] for m in members if files[m].get("series") and not str(files[m]["series"]).startswith("s:")), None)
        sid = given or "s:" + min(files[m]["sha1"] for m in members)[:10]
        for m in members:
            files[m]["series"] = sid


def report(cat):
    files = cat["files"]
    used, rejected, hard, unlicensed = {}, {}, 0, 0
    for e in files.values():
        if usable(e):
            used[e.get("category")] = used.get(e.get("category"), 0) + 1
            hard += bool(e.get("text_present"))
        elif e.get("status") != "ok":
            rejected[e.get("status")] = rejected.get(e.get("status"), 0) + 1
        else:
            unlicensed += 1
    series = {}
    for e in files.values():
        if usable(e):
            series.setdefault(e.get("category"), set()).add(e.get("series"))
    return {"photos": len(files), "used": dict(sorted(used.items())), "rejected": dict(sorted(rejected.items())),
            "unlicensed": unlicensed, "hardNegatives": hard,
            "surfaces": {k: len(v) for k, v in sorted(series.items())},
            "splits": {s: sum(1 for e in files.values() if usable(e) and e.get("split") == s) for s in ("train", "exam", "none")}}


def split(work=None, share=EXAM_SHARE, cap=EXAM_PER_SERIES, name="backgrounds"):
    """~share of the surfaces (series) to the exam by the crc32 of their key (the smallest sha1 of the series); at most
    `cap` photos of one series per category there, the rest of it in neither set. → the report."""
    cat = load(work, name)
    files = cat["files"]
    groups = {}
    for f, e in sorted(files.items()):
        if not usable(e):
            e["split"] = None
            continue
        groups.setdefault((e.get("category"), e.get("series") or "s:" + e["sha1"][:10]), []).append(f)
    for (category, sid), members in sorted(groups.items()):
        key = min(files[m]["sha1"] for m in members)
        exam = zlib.crc32(key.encode()) % 1000 < share * 1000
        for n, m in enumerate(sorted(members, key=lambda f: files[f]["sha1"])):
            files[m]["split"] = ("exam" if n < cap else "none") if exam else "train"
    save(cat, work, name)
    return report(cat)


# ---------- the private bucket (datasets_hf.py) ----------
def pull(names=("backgrounds", "backgrounds-own")):
    import datasets_hf
    datasets_hf.pull(list(names))


def push(names=("backgrounds", "backgrounds-own")):
    """The bank → the private bucket. The owner's step after looking at the bank (never run by a generator)."""
    import datasets_hf
    datasets_hf.push(list(names))


# ---------- sampling ----------
@lru_cache(maxsize=6)
def _image(path):
    return _read(path)


class Bank:
    """The usable photos of one side (train / exam), balanced by category then series; procedural surfaces apart."""

    def __init__(self, work=None, split="train", procedural_share=PROCEDURAL_SHARE, names=("backgrounds", "backgrounds-own")):
        import home
        work = pathlib.Path(work or home.WORK)
        exam = set(gc.heldout().get("examBackgrounds") or [])
        self.procedural_share, self.by = procedural_share, {}
        self.entries = []
        for name in names:
            cat = load(work, name)
            for f, e in sorted(cat["files"].items()):
                if not usable(e):
                    continue
                side = "exam" if (e["sha1"] in exam or e["sha1"][:12] in exam) else (e.get("split") or "train")
                if side != split:
                    continue
                item = {**e, "path": str(work / name / f), "name": f}
                self.entries.append(item)
                self.by.setdefault(e.get("category") or "uncategorised", {}).setdefault(e.get("series") or f, []).append(item)

    def __len__(self):
        return len(self.entries)

    def sample(self, rng, hard=False):
        """A photo (its catalog entry with "path") or None (a procedural surface); hard: one with text when there is."""
        if hard:
            pool = [e for e in self.entries if e.get("text_present")]
            if pool:
                return rng.choice(pool)
        if not self.by or rng.random() < self.procedural_share:
            return None
        cat = rng.choice(sorted(self.by))
        series = self.by[cat]
        return rng.choice(series[rng.choice(sorted(series))])

    @staticmethod
    def image(entry):
        return _image(entry["path"])

    def info(self):
        return {"photos": len(self.entries), "categories": {k: sum(len(v) for v in s.values()) for k, s in sorted(self.by.items())}}


# ---------- occluders: cut-outs lying over a document ----------
def occluders_add(src, category, size_mm, work=None, licence="owner"):
    """Cut-outs (PNG with an alpha channel: a cup, keys, a pen…) into <home>/occluders/ with their size in mm (the long
    side) → (added, skipped: pictures with no alpha)."""
    from PIL import Image
    src = pathlib.Path(src)
    dest = (pathlib.Path(work) if work else folder().parent) / "occluders"
    dest.mkdir(parents=True, exist_ok=True)
    cat = load(work, "occluders")
    added = skipped = 0
    for p in sorted(src.rglob("*")):
        if p.suffix.lower() not in PICTURES or not p.is_file():
            continue
        with Image.open(p) as im:
            if im.mode not in ("RGBA", "LA") and "transparency" not in im.info:
                skipped += 1
                continue
            size = list(im.size)
        sha = gc.file_sha1(p)
        fname = f"{sha[:12]}.png"
        if not (dest / fname).exists():
            Image.open(p).convert("RGBA").save(dest / fname)
        cat["files"][fname] = {"category": category, "sizeMm": float(size_mm), "licence": licence, "sha1": sha, "size": size,
                               "status": "ok"}
        added += 1
    save(cat, work, "occluders")
    return added, skipped


class Occluders:
    """The cut-outs with a confirmed licence; sample(rng) → (RGBA numpy, its long side in mm, category) or None."""

    def __init__(self, work=None):
        import home
        work = pathlib.Path(work or home.WORK)
        cat = load(work, "occluders")
        self.items = [{**e, "path": str(work / "occluders" / f)} for f, e in sorted(cat["files"].items()) if confirmed(e)
                      and e.get("status", "ok") == "ok"]

    def __len__(self):
        return len(self.items)

    def sample(self, rng):
        if not self.items:
            return None
        import cv2
        e = rng.choice(self.items)
        img = cv2.imread(e["path"], cv2.IMREAD_UNCHANGED)
        if img is None or img.ndim != 3 or img.shape[2] != 4:
            return None
        return img, float(e.get("sizeMm") or 80), e.get("category"), e["sha1"]
