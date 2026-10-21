"""Real photos of passports' machine-readable zones for the passport zone reader (docs/scan-training.md →
4, "The passport zone reader"; docs/hf-plan.md → H8b): MIDV-2020's passports (Azerbaijan, Greece,
Latvia, Serbia, Russia's internal passport) — each one's zone text is in its template's annotation,
and every photo, scan and video frame of it has the document's corners. Each picture is cut flat by
its corners the way the scanner cuts a page (the document's own top-left first, at the template's
size), then:
- **train** (documents 00–79 of each kind): the two zone lines cut out where the template has them,
  with a margin, in grey — ~/.scan-train/midv-mrz/train/<n>.png and labels.tsv (train_mrz.py --midv);
- **exam** (documents 80–99, never trained on): the flat page as it is — ~/.scan-train/midv-mrz/exam/
  <n>.png and exam.json with its two true lines; exam_mrz.py finds the lines on it the way the phone
  does (mrzmodel.find_lines) and reads them.

Run after midv.py --download midv2020 (its templates.tar holds the zone text); nothing is uploaded.

  python midv_mrz.py                    # the photos and scans
  python midv_mrz.py --clip-step 6      # + the video frames, every 6th (after --download … --clips)

The data's terms: docs/scan-training.md → MIDV."""
import argparse
import json
import pathlib
import re

from home import WORK
from midv import OUT as MIDV, is_clip, pictures

OUT = WORK / "midv-mrz"   # kept by common.clear_work
TYPES = ("alb_id", "aze_passport", "esp_id", "est_id", "fin_id", "grc_passport", "lva_passport",
         "rus_internalpassport", "srb_passport", "svk_id")
EXAM_FROM = 80          # documents 80–99 of each kind: the exam
LINE = re.compile(r"[A-Z0-9<]{44}")
PAGE_W = 1000           # the flat page's width (the scanner's cut pages are about this size)


# ---------- the zone in a template's annotation (pure: tested without OpenCV) ----------

def _regions(ann):
    meta = ann.get("_via_img_metadata", ann) if isinstance(ann, dict) else {}
    for entry in (meta.values() if isinstance(meta, dict) else []):
        if not isinstance(entry, dict) or "filename" not in entry:
            continue
        regions = entry.get("regions") or []
        for r in (regions.values() if isinstance(regions, dict) else regions):
            yield entry["filename"], r.get("shape_attributes") or {}, r.get("region_attributes") or {}


def _box(shape):
    """A VIA rect or polygon → (x, y, w, h)."""
    if shape.get("name") == "rect":
        return float(shape["x"]), float(shape["y"]), float(shape["width"]), float(shape["height"])
    xs, ys = shape.get("all_points_x"), shape.get("all_points_y")
    if xs and ys:
        return float(min(xs)), float(min(ys)), float(max(xs) - min(xs)), float(max(ys) - min(ys))
    return None


def zones(ann):
    """A template annotation's zones: {file name: [(box, line 1), (box, line 2)]} — a field whose value
    is a 44-character zone line (any attribute: the field's name does not matter), or one field holding
    both lines (split in two, top and bottom half); only templates with exactly two lines."""
    found = {}
    for name, shape, attrs in _regions(ann):
        box = _box(shape)
        if box is None:
            continue
        for v in attrs.values():
            if not isinstance(v, str):
                continue
            parts = [p.strip().replace(" ", "") for p in v.strip().splitlines() if p.strip()]
            if len(parts) == 1 and LINE.fullmatch(parts[0]):
                found.setdefault(name, []).append((box, parts[0]))
            elif len(parts) == 2 and all(LINE.fullmatch(p) for p in parts):
                x, y, w, h = box
                found.setdefault(name, []).extend([((x, y, w, h / 2), parts[0]), ((x, y + h / 2, w, h / 2), parts[1])])
    return {k: sorted(v, key=lambda b: b[0][1]) for k, v in found.items() if len(v) == 2}


def type_of(path):
    return next((p for p in pathlib.Path(path).parts if p in TYPES), None)


def template_id(img_path, ann_path, rel):
    """Which template a picture shows: a clip frame's clip folder (clips/…/<type>/<NN>/000001.jpg), else
    the picture's own name (photo/…/<type>/<NN>.jpg)."""
    p = pathlib.Path(img_path)
    if is_clip(rel, ann_path) and p.parent.name.isdigit():
        return p.parent.name
    return p.stem


def is_exam(tid):
    return tid.isdigit() and int(tid) >= EXAM_FROM


# ---------- building ----------

def templates(src):
    """{(type, id): (template width, height, [(box, line)] × 2)} from every template annotation under src
    (a folder named templates; the type by the folders or the annotation file's name)."""
    import cv2
    from midv import IMAGES
    images = {}
    for p in pathlib.Path(src).rglob("*"):
        if p.suffix.lower() in IMAGES and "templates" in [q.lower() for q in p.parts]:
            images[(type_of(p), p.stem)] = p
    out = {}
    for ann_path in pathlib.Path(src).rglob("*.json"):
        if "templates" not in [q.lower() for q in ann_path.parts]:
            continue
        try:
            ann = json.loads(ann_path.read_text(encoding="utf-8"))
        except (ValueError, UnicodeDecodeError):
            continue
        kind = type_of(ann_path) or next((t for t in TYPES if t in ann_path.stem), None)
        for name, lines in zones(ann).items():
            img = images.get((kind, pathlib.Path(name).stem))
            size = cv2.imread(str(img)).shape[:2] if img is not None else None
            if size:
                out[(kind, pathlib.Path(name).stem)] = (size[1], size[0], lines)
    return out


def build(src, out, clip_step=0):
    import cv2
    import numpy as np
    tpl = templates(src)
    if not tpl:
        raise SystemExit(f"no passport zone in the templates under {src} — run midv.py --download midv2020 first")
    for d in ("train", "exam"):
        (out / d).mkdir(parents=True, exist_ok=True)
    labels, exam, n = [], [], 0
    for ann_path, img_path, quad in pictures(src, max(clip_step, 1)):
        rel = img_path.relative_to(src)
        if "templates" in [q.lower() for q in rel.parts] or (is_clip(rel, ann_path) and not clip_step):
            continue
        key = (type_of(rel), template_id(img_path, ann_path, rel))
        if key not in tpl:
            continue
        tw, th, lines = tpl[key]
        img = cv2.imread(str(img_path), cv2.IMREAD_GRAYSCALE)
        if img is None:
            continue
        s = PAGE_W / tw
        W, H = PAGE_W, round(th * s)
        M = cv2.getPerspectiveTransform(np.float32(quad), np.float32([[0, 0], [W, 0], [W, H], [0, H]]))
        zone = np.float32([[[x * s, y * s]] for (x, y, w, h), _ in lines for x, y in ((x, y), (x + w, y + h))])
        back = cv2.perspectiveTransform(zone, np.linalg.inv(M)).reshape(-1, 2)
        if not ((back >= 0).all() and (back[:, 0] < img.shape[1]).all() and (back[:, 1] < img.shape[0]).all()):
            continue   # the zone is out of the picture
        page = cv2.warpPerspective(img, M, (W, H), flags=cv2.INTER_AREA, borderValue=255)
        n += 1
        if is_exam(key[1]):
            f = out / "exam" / f"{n}.png"
            cv2.imwrite(str(f), page)
            exam.append({"page": f.name, "lines": [t for _, t in lines], "kind": key[0], "source": "/".join(rel.parts[:2])})
            continue
        for k, ((x, y, w, h), text) in enumerate(lines):
            mx, my = w * 0.02, h * 0.3
            x0, y0 = max(0, int((x - mx) * s)), max(0, int((y - my) * s))
            x1, y1 = min(W, int((x + w + mx) * s) + 1), min(H, int((y + h + my) * s) + 1)
            name = f"{n}-{k + 1}.png"
            cv2.imwrite(str(out / "train" / name), page[y0:y1, x0:x1])
            labels.append(f"{name}\t{text}")
    (out / "train" / "labels.tsv").write_text("\n".join(labels) + "\n", encoding="utf-8")
    (out / "exam" / "exam.json").write_text(json.dumps(exam), encoding="utf-8")
    return len(labels), len(exam)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", help="the downloaded MIDV folders (default ~/.scan-train/midv/raw)")
    ap.add_argument("--clip-step", type=int, default=0, help="the video frames too, every n-th (0: none)")
    a = ap.parse_args()
    src = pathlib.Path(a.src) if a.src else MIDV / "raw"
    lines, pages = build(src, OUT, a.clip_step)
    print(f"{lines} zone lines to train on in {OUT / 'train'}; {pages} passport pages for the exam in {OUT / 'exam'}")


if __name__ == "__main__":
    main()
