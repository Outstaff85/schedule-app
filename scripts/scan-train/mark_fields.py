"""Marks a new real page's fields from one already marked with the same layout (docs/scan-training.md →
"Variations of the real pages"): the two pages are matched on what every card of the layout prints alike
(the emblem, the titles, the labels — SIFT features, a homography fitted with RANSAC), each marked box is
carried onto the new page by it, and the page is shown with them to look at. The entry is printed (or
added to template_fields.json with --write); a box that came out wrong is set by hand in the file.

  python mark_fields.py ~/.scan-train/templates/id_front/own-3.jpg --like id_front/new_type.jpg \
      --like-page ~/.scan-train/templates/id_front/own-new_type.jpg --show marked.png
  python mark_fields.py <page> --like id_front/new_type.jpg --like-page <its page> --write id_front/3.jpg
"""
import argparse
import json

import cv2
import numpy as np

import template_vary

WIDTH = 1000   # both pages matched at this width


def _gray(img):
    s = WIDTH / img.shape[1]
    return cv2.cvtColor(cv2.resize(img, (WIDTH, round(img.shape[0] * s)), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)


def register(ref, page):
    """The homography carrying shares of the marked page onto shares of the new one, or None when they do
    not match well (fewer than 25 features agree)."""
    a, b = _gray(ref), _gray(page)
    sift = cv2.SIFT_create(4000)
    ka, da = sift.detectAndCompute(a, None)
    kb, db = sift.detectAndCompute(b, None)
    if da is None or db is None:
        return None
    pairs = [m for m, n in cv2.BFMatcher().knnMatch(da, db, k=2) if m.distance < 0.75 * n.distance]
    if len(pairs) < 25:
        return None
    src = np.float32([ka[m.queryIdx].pt for m in pairs]) / [a.shape[1], a.shape[0]]
    dst = np.float32([kb[m.trainIdx].pt for m in pairs]) / [b.shape[1], b.shape[0]]
    M, inl = cv2.findHomography(src, dst, cv2.RANSAC, 0.01)
    return M if M is not None and inl.sum() >= 25 else None


def carry(M, box):
    """A box (shares) carried by the homography: the box around its four corners."""
    x, y, w, h = box
    pts = cv2.perspectiveTransform(np.float32([[[x, y]], [[x + w, y]], [[x + w, y + h]], [[x, y + h]]]), M).reshape(-1, 2)
    x0, y0 = np.clip(pts.min(0), 0, 1)
    x1, y1 = np.clip(pts.max(0), 0, 1)
    return [round(float(x0), 4), round(float(y0), 4), round(float(x1 - x0), 4), round(float(y1 - y0), 4)]


def mark(page_bgr, like, ref_bgr):
    """The marked entry `like` (of the page ref_bgr) carried onto page_bgr; None when they do not match."""
    M = register(ref_bgr, page_bgr)
    if M is None:
        return None
    out = {}
    out["fields"] = [{**f, "box": carry(M, f["box"])} for f in like["fields"]]
    for k in ("photo",):
        if like.get(k):
            out[k] = carry(M, like[k])
    for k in ("scramble", "erase"):
        if like.get(k):
            out[k] = [carry(M, b) for b in like[k]]
    return out


def show(page_bgr, spec, path):
    v = page_bgr.copy()
    H, W = v.shape[:2]
    for f in spec["fields"]:
        x, y, w, h = f["box"]
        cv2.rectangle(v, (int(x * W), int(y * H)), (int((x + w) * W), int((y + h) * H)), (0, 0, 255), 1)
        cv2.putText(v, f["kind"][:5], (int(x * W), int(y * H) - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (255, 0, 0), 1)
    if spec.get("photo"):
        x, y, w, h = spec["photo"]
        cv2.rectangle(v, (int(x * W), int(y * H)), (int((x + w) * W), int((y + h) * H)), (0, 160, 0), 2)
    cv2.imwrite(str(path), v)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("page", help="the new real page (as uploaded)")
    ap.add_argument("--like", required=True, help="a marked entry with the same layout, e.g. id_front/new_type.jpg")
    ap.add_argument("--like-page", required=True, help="that entry's page (e.g. ~/.scan-train/templates/id_front/own-new_type.jpg)")
    ap.add_argument("--crop", nargs=4, type=float, help="the document's box on the upload (shares)")
    ap.add_argument("--turn", type=int, default=0, help="clockwise quarter turns that set it upright")
    ap.add_argument("--kind", help="its type when uploaded into another kind's folder")
    ap.add_argument("--write", help="add the entry to template_fields.json under this key (<kind folder>/<file name>)")
    ap.add_argument("--show", help="write the page with the boxes drawn here")
    a = ap.parse_args()
    fixes = {k: v for k, v in (("crop", a.crop), ("turn", a.turn or None), ("kind", a.kind)) if v}
    page = template_vary.load_page(a.page, fixes)
    like = template_vary.specs()[a.like]
    carried = mark(page, like, template_vary.load_page(a.like_page, like))
    if carried is None:
        raise SystemExit("the pages do not match — not the same layout, or the page is too small or blurred")
    spec = {**fixes, **carried}
    if a.show:
        show(page, spec, a.show)
    if a.write:
        p = template_vary.HERE / "template_fields.json"
        marks = json.loads(p.read_text(encoding="utf-8"))
        marks[a.write] = spec
        p.write_text(json.dumps(marks, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"{a.write} written to {p}")
    else:
        print(json.dumps(spec, ensure_ascii=False))


if __name__ == "__main__":
    main()
