"""Real phone video frames of printed A4 pages for the document edges models (docs/scan-training.md
→ 4, "SmartDoc"): SmartDoc 2015, Challenge 1 (ICDAR 2015; L3i, La Rochelle — licensed CC BY 4.0):
30 pages (data sheets, letters, magazines, papers, patents, tax forms) printed on paper and filmed by
hand on 5 backgrounds, ~25 000 frames, each with the page's corners. Paper as the ספח, a sheet put
into a passport or a contract is — where MIDV has cards and passports.

Downloaded on the owner's PC from the authors' release (jchazalon/smartdoc15-ch1-dataset on GitHub,
frames.tar.gz, ~1 GB), turned into examples in pull.py's form like midv.py's: the frame made smaller
(the long side 640), the corners 0..1 in the model's order, a frame where the page goes out of it
left out, every third frame of a clip, half of them turned a quarter (the frames are landscape). Nothing is uploaded.

  python smartdoc.py --download          # → ~/.scan-train/smartdoc/raw/, then the examples
  python smartdoc.py                     # the examples again (another --step)
  python smartdoc.py --download --drop-raw   # the same, then the download deleted (only the set kept)

Attribution (CC BY 4.0): J.-C. Burie, J. Chazalon, M. Coustaty, S. Eskenazi, M. M. Luqman, M. Mehri,
N. Nayef, J.-M. Ogier, S. Prum, M. Rusiñol: "ICDAR2015 Competition on Smartphone Document Capture
and OCR (SmartDoc)", ICDAR 2015."""
import argparse
import csv
import gzip
import io
import json
import pathlib
import tarfile
import urllib.request

from home import WORK
from midv import LONG, normalised
from synth import order_corners

OUT = WORK / "smartdoc"   # kept by common.clear_work
URL = "https://github.com/jchazalon/smartdoc15-ch1-dataset/releases/download/v2.0.0/frames.tar.gz"
CORNERS = ("tl", "tr", "br", "bl")   # the page's own top-left first, clockwise (the file lists tl, bl, br, tr)


def rows(metadata_csv):
    """The metadata's frames: [(image path, its kind, the 4 corners in pixels)]."""
    out = []
    for r in csv.DictReader(io.StringIO(metadata_csv)):
        out.append((r["image_path"], r["modeltype_name"], [[float(r[f"{c}_x"]), float(r[f"{c}_y"])] for c in CORNERS]))
    return out


def frame_no(path):
    digits = "".join(c for c in pathlib.Path(path).stem if c.isdigit())
    return int(digits) if digits else 0


def turned(corners):
    """The corners (0..1) of a frame turned a quarter clockwise — the frames are all landscape, a
    phone's photos mostly portrait: half of them are turned."""
    return order_corners([[1 - y, x] for x, y in corners])


def download(raw):
    raw.mkdir(parents=True, exist_ok=True)
    arc = raw / "frames.tar.gz"
    if not arc.exists():
        print(f"  {URL} (~1 GB)…")
        urllib.request.urlretrieve(URL, arc)
    with tarfile.open(arc) as t:
        kw = {"filter": "data"} if hasattr(tarfile, "data_filter") else {}
        t.extractall(raw / "frames", **kw)


def build(raw, out, step=3):
    import cv2
    root = raw / "frames"
    meta = next(root.rglob("metadata.csv.gz"), None)
    if meta is None:
        raise SystemExit(f"no metadata.csv.gz under {root} — run with --download first")
    base = meta.parent
    (out / "img").mkdir(parents=True, exist_ok=True)
    ex, outside = [], 0
    for path, kind, quad in rows(gzip.decompress(meta.read_bytes()).decode("utf-8")):
        if step > 1 and (frame_no(path) - 1) % step:
            continue   # the next frames of a clip are nearly the same picture
        img = cv2.imread(str(base / path))
        if img is None:
            continue
        h, w = img.shape[:2]
        fixed = normalised(quad, w, h)
        if fixed is None:
            outside += 1
            continue
        s = LONG / max(w, h)
        small = cv2.resize(img, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)
        if (frame_no(path) // max(step, 1)) % 2:
            small, fixed = cv2.rotate(small, cv2.ROTATE_90_CLOCKWISE), turned(fixed)
        eid = "smartdoc-" + "-".join(pathlib.Path(path).with_suffix("").parts)
        f = out / "img" / f"{eid}.jpg"
        cv2.imwrite(str(f), small, [cv2.IMWRITE_JPEG_QUALITY, 92])
        ex.append({"id": eid, "file": str(f), "model": None, "fixed": fixed, "moved": 0, "exam": False,
                   "smartdoc": True, "kind": kind, "source": pathlib.Path(path).parts[0]})
    (out / "examples.json").write_text(json.dumps(ex), encoding="utf-8")
    return ex, outside


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--download", action="store_true")
    ap.add_argument("--step", type=int, default=3, help="every n-th frame of a clip")
    ap.add_argument("--drop-raw", action="store_true", help="delete the download once the set is made")
    a = ap.parse_args()
    raw = OUT / "raw"
    if a.download:
        download(raw)
    ex, outside = build(raw, OUT, a.step)
    print(f"{len(ex)} frames in {OUT}; {outside} left out: the page goes out of the frame")
    if a.drop_raw:
        import shutil
        shutil.rmtree(raw, ignore_errors=True)
        print(f"deleted the download {raw}; the set stays")


if __name__ == "__main__":
    main()
