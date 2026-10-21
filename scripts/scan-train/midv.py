"""Real photos of mock identity documents for the document edges models (docs/scan-training.md → 4,
"MIDV"): MIDV-2020 (Smart Engines and L3i — 1000 mock documents of 10 kinds, each photographed,
scanned and filmed with phones on tables, keyboards, cloths, outdoors, in low light, at a slant,
with glare; every picture with the document's corners) and MIDV-500 / MIDV-2019 (50 documents,
15 000 video frames). Made-up data and generated faces, no real person.

Downloaded on the owner's PC from the authors' FTP (ftp://smartengines.com), turned into examples
in pull.py's form: each picture made smaller (the long side 640), its corners 0..1 in the model's
order (the photo's top-left first, clockwise — MIDV gives the document's own top-left first). A
frame where the document goes out of the picture is left out (the model's corners are inside it).
Nothing is uploaded.

  python midv.py --download midv2020                  # photos and scans → ~/.scan-train/midv/raw/
  python midv.py --download midv2020 --clips          # + the video frames (a very large download)
  python midv.py --download midv500                   # MIDV-500's 50 documents (video frames)
  python midv.py                                      # → ~/.scan-train/midv/img/, examples.json (+ midv_mrz.py's)
  python midv.py --download midv2020 --drop-raw       # the same, then the download deleted (only the sets kept)
  python midv.py --src D:/datasets/midv-2020          # from a copy already downloaded

The data's terms: docs/scan-training.md → MIDV (the source images are Wikimedia Commons samples,
the faces Generated Photos' — read the terms before training a model the firm uses)."""
import argparse
import ftplib
import json
import pathlib
import tarfile
import zipfile


from home import WORK
from synth import order_corners

OUT = WORK / "midv"   # kept by common.clear_work
FTP_HOST = "smartengines.com"
MIDV2020 = ("templates.tar", "photo.tar", "scan_rotated.tar", "scan_upright.tar")   # templates: the passports' zone text (midv_mrz.py)
MIDV2020_CLIPS = ("clips.tar",)
MIDV500_DIR, MIDV2019_DIR = "midv-500/dataset", "midv-500/extra/midv-2019/dataset"
LONG = 640
IMAGES = (".jpg", ".jpeg", ".png", ".tif", ".tiff")


# ---------- reading the annotations (pure: tested without OpenCV) ----------

def _poly(shape):
    """A VIA polygon / polyline → its points, or None."""
    xs, ys = shape.get("all_points_x"), shape.get("all_points_y")
    if shape.get("name") in ("polygon", "polyline") and xs and ys and len(xs) == len(ys):
        return [[float(x), float(y)] for x, y in zip(xs, ys)]
    return None


def _is_quad(attrs):
    return any(v == "doc_quad" for v in (attrs or {}).values()) or "doc_quad" in (attrs or {})


def quads_of(ann):
    """One annotation file's documents: [(file name or None, the 4 corners in pixels)].
    MIDV-500 / 2019: {"quad": [[x, y] × 4]} (the frame named like the file); MIDV-2020: a VGG Image
    Annotator project — {"_via_img_metadata": {…}} or its entries — each image's region whose
    field_name is doc_quad."""
    if isinstance(ann, dict) and isinstance(ann.get("quad"), list) and len(ann["quad"]) == 4:
        return [(None, [[float(x), float(y)] for x, y in ann["quad"]])]
    meta = ann.get("_via_img_metadata", ann) if isinstance(ann, dict) else {}
    out = []
    for entry in (meta.values() if isinstance(meta, dict) else []):
        if not isinstance(entry, dict) or "filename" not in entry:
            continue
        regions = entry.get("regions") or []
        regions = regions.values() if isinstance(regions, dict) else regions   # VIA 1 kept them by number
        for r in regions:
            pts = _poly(r.get("shape_attributes") or {})
            if pts and len(pts) == 4 and _is_quad(r.get("region_attributes")):
                out.append((entry["filename"], pts))
    return out


def inside(quad, w, h, slack=0.002):
    return all(-slack * w <= x <= (1 + slack) * w and -slack * h <= y <= (1 + slack) * h for x, y in quad)


def normalised(quad, w, h):
    """The corners 0..1 in the model's order; None when the document goes out of the picture."""
    if not inside(quad, w, h):
        return None
    return order_corners([[min(max(x / w, 0.0), 1.0), min(max(y / h, 0.0), 1.0)] for x, y in quad])


def kind_of(path):
    """The page kind by the document's folder name (alb_id, 05_aze_passport, rus_internalpassport…)."""
    s = str(path).lower()
    return "passport" if "passport" in s and "passportcard" not in s else "id_front"


# ---------- download ----------

def _fetch(ftp, remote, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size == ftp.size(remote):
        print(f"  {remote}: already here")
        return
    print(f"  {remote} ({(ftp.size(remote) or 0) / 1e9:.1f} GB)…")
    with open(dest, "wb") as f:
        ftp.retrbinary(f"RETR {remote}", f.write, blocksize=1 << 20)


def download(which, clips, raw):
    ftp = ftplib.FTP(FTP_HOST, timeout=120)
    ftp.login()
    ftp.voidcmd("TYPE I")
    if which == "midv2020":
        for name in MIDV2020 + (MIDV2020_CLIPS if clips else ()):
            arc = raw / "midv-2020" / name
            _fetch(ftp, f"midv-2020/dataset/{name}" if _exists(ftp, f"midv-2020/dataset/{name}") else f"midv-2020/{name}", arc)
            with tarfile.open(arc) as t:
                kw = {"filter": "data"} if hasattr(tarfile, "data_filter") else {}
                t.extractall(arc.parent / name[:-4], **kw)
    else:
        for d in ((MIDV500_DIR,) if which == "midv500" else (MIDV2019_DIR,)):
            for name in sorted(n.rsplit("/", 1)[-1] for n in ftp.nlst(d) if n.endswith(".zip")):
                arc = raw / which / name
                _fetch(ftp, f"{d}/{name}", arc)
                with zipfile.ZipFile(arc) as z:
                    z.extractall(arc.parent / name[:-4])
    ftp.quit()


def _exists(ftp, remote):
    try:
        return ftp.size(remote) is not None
    except ftplib.error_perm:
        return False


# ---------- examples ----------

def _image_for(ann_path, name, index):
    """The picture an annotation names (MIDV-500: its frame, named like the file, under images/ for
    its ground_truth/; MIDV-2020: the file name in the project) — of the pictures with that name, the
    one nearest the annotation (the most folders in common, its document type's folder first)."""
    stem = pathlib.Path(name).stem if name else ann_path.stem
    found = index.get(stem.lower(), [])
    if not found:
        return None
    def near(p):
        common = 0
        for x, y in zip(p.parts, ann_path.parts):
            if x != y:
                break
            common += 1
        same_kind = ann_path.stem.lower() in (q.lower() for q in p.parts) if name else False
        mirrored = [("images" if q == "ground_truth" else q) for q in ann_path.parent.parts] == list(p.parent.parts)
        return (mirrored, same_kind, common)
    return max(found, key=near)


def pictures(src, clip_step=3):
    """Every annotated picture under src: (annotation file, picture, its corners in pixels — the
    document's own top-left first, as MIDV gives them), every clip_step-th frame of a clip."""
    index = {}
    for p in pathlib.Path(src).rglob("*"):
        if p.suffix.lower() in IMAGES:
            index.setdefault(p.stem.lower(), []).append(p)
    for ann_path in sorted(pathlib.Path(src).rglob("*.json")):
        try:
            ann = json.loads(ann_path.read_text(encoding="utf-8"))
        except (ValueError, UnicodeDecodeError):
            continue
        for name, quad in quads_of(ann):
            img_path = _image_for(ann_path, name, index)
            if img_path is None:
                continue
            rel = img_path.relative_to(src)
            if (is_clip(rel, ann_path)) and clip_step > 1:
                digits = "".join(c for c in img_path.stem if c.isdigit())
                n = int(digits) if digits else 0
                if (n // (6 if "clips" in rel.parts else 1)) % clip_step:
                    continue   # the next frames of a clip are nearly the same picture
            yield ann_path, img_path, quad


def is_clip(rel, ann_path):
    return "clips" in rel.parts or "ground_truth" in ann_path.parts


def build(src, out, clip_step=3):
    import cv2
    (out / "img").mkdir(parents=True, exist_ok=True)
    ex, outside = [], 0
    for ann_path, img_path, quad in pictures(src, clip_step):
        rel = img_path.relative_to(src)
        img = cv2.imread(str(img_path))
        if img is None:
            continue
        h, w = img.shape[:2]
        fixed = normalised(quad, w, h)
        if fixed is None:
            outside += 1
            continue
        s = LONG / max(w, h)
        small = cv2.resize(img, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)
        eid = "midv-" + "-".join(rel.with_suffix("").parts)
        f = out / "img" / f"{eid}.jpg"
        cv2.imwrite(str(f), small, [cv2.IMWRITE_JPEG_QUALITY, 92])
        ex.append({"id": eid, "file": str(f), "model": None, "fixed": fixed, "moved": 0, "exam": False,
                   "midv": True, "kind": kind_of(rel), "source": "/".join(rel.parts[:2])})
    (out / "examples.json").write_text(json.dumps(ex), encoding="utf-8")
    return ex, outside


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--download", choices=("midv2020", "midv500", "midv2019"))
    ap.add_argument("--clips", action="store_true", help="MIDV-2020's video frames too (a very large download)")
    ap.add_argument("--src", help="the downloaded MIDV folders (default ~/.scan-train/midv/raw)")
    ap.add_argument("--clip-step", type=int, default=3, help="every n-th annotated frame of a clip")
    ap.add_argument("--drop-raw", action="store_true", help="delete the download once the sets are made (they are all training needs)")
    a = ap.parse_args()
    raw = pathlib.Path(a.src) if a.src else OUT / "raw"
    if a.download:
        download(a.download, a.clips, raw)
    ex, outside = build(raw, OUT, a.clip_step)
    by = {}
    for e in ex:
        by[e["kind"]] = by.get(e["kind"], 0) + 1
    print(f"{len(ex)} pictures in {OUT} ({', '.join(f'{k} {n}' for k, n in sorted(by.items()))}); "
          f"{outside} left out: the document goes out of the picture")
    import midv_mrz   # the passports' zone lines too, while the download is here (it needs the templates)
    try:
        lines, pages = midv_mrz.build(raw, midv_mrz.OUT, a.clip_step if a.clips else 0)
        print(f"{lines} zone lines to train on, {pages} passport pages for the exam in {midv_mrz.OUT}")
    except SystemExit as e:
        print(f"no zone lines: {e}")
    if a.drop_raw:
        if a.src:
            print(f"--drop-raw does not delete a folder given with --src ({raw})")
        else:
            import shutil
            shutil.rmtree(raw, ignore_errors=True)
            print(f"deleted the download {raw}; the sets stay")


if __name__ == "__main__":
    main()
