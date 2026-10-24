"""Upright cut pages of every document type for the document type model before the site has collected
its own (docs/scan-training.md → "The page kinds", made-up pages): the page as the scanner cuts it, upright,
with the type the model must answer (common.DOCTYPES) —
- id_front, id_back, passport, sefach: drawn (synth_docs.DRAW, a passport's data page only) and the owner's
  real pages made other people's (template_vary.py; a page with no fields marked is washed out);
- contract: a drawn employment contract (Hebrew or English: clauses, a table, the lines to sign);
- other: a loose sheet put into a passport (synth_docs.insert) and SmartDoc's printed pages (smartdoc.py:
  letters, papers, forms — cut by their own corners);
- MIDV's ID cards and passports (midv.py), cut by their own corners, as id_front / passport.
Each a little changed (light, blur, noise, JPEG, a cut a little off); the model learns the turn itself
(train_doctypes.py turns every page). Nothing is uploaded: the same seed draws the same pages.

  python synth_pages.py --count 6000          # → ~/.scan-train/synth/pages/ (img/, pages.json)
  python train_doctypes.py --synth 6000       # the made-up pages beside the site's (or alone, at first)
"""
import argparse
import json
import pathlib
import random

import cv2
import numpy as np
from PIL import ImageDraw

import synth
import synth_docs as sd
from home import WORK, gentle

OUT = WORK / "synth" / "pages"
LONG = 512
SHARE = {"id_front": 0.18, "id_back": 0.14, "passport": 0.16, "sefach": 0.16, "contract": 0.18, "other": 0.18}
HE_WORDS = ("העובד", "המעסיק", "הסכם", "עבודה", "שכר", "שעות", "חודש", "תנאים", "זכויות", "חובות", "הודעה", "מוקדמת",
            "חופשה", "מחלה", "פנסיה", "הפרשות", "תקופת", "ניסיון", "תפקיד", "מקום", "בהתאם", "לחוק", "ישולם", "עד", "יום",
            "לכל", "שעה", "נוספת", "הצדדים", "מסכימים", "כי", "על", "פי", "זה", "יהיה", "רשאי", "לסיים", "את", "ההתקשרות")
EN_WORDS = ("the", "employee", "employer", "agreement", "salary", "hours", "month", "terms", "rights", "notice", "leave",
            "sick", "pension", "trial", "period", "position", "workplace", "according", "to", "law", "shall", "be", "paid",
            "per", "hour", "overtime", "parties", "agree", "that", "may", "terminate", "this", "contract", "of", "and")


def contract(rng, F):
    """A drawn employment contract page (A4): a title, numbered clauses, sometimes a table, lines to sign."""
    w, h = 1050, 1485
    im = sd.paper(rng, w, h)
    d = ImageDraw.Draw(im)
    he = rng.random() < 0.7
    words = HE_WORDS if he else EN_WORDS
    which = "hebrew" if he else "latin"
    title = rng.choice(("הסכם העסקה", "חוזה עבודה", "הודעה לעובד על תנאי העסקה")) if he else rng.choice(("EMPLOYMENT AGREEMENT", "Employment Contract", "Terms of Employment"))
    sd.put(d, (w - 70 if he else 70, 60), title, F.get(which, rng.randint(34, 44), rng), (20, 20, 30), he)
    y, n = 150, 1
    size = rng.randint(17, 22)
    while y < h - 260:
        if rng.random() < 0.12:   # a table
            rows = rng.randint(3, 6)
            for r in range(rows + 1):
                d.line((70, y + r * 34, w - 70, y + r * 34), fill=(60, 60, 70), width=2)
            for c in (70, w // 2, w - 70):
                d.line((c, y, c, y + rows * 34), fill=(60, 60, 70), width=2)
            y += rows * 34 + 30
            continue
        for k in range(rng.randint(2, 5)):
            line = " ".join(rng.choice(words) for _ in range(rng.randint(6, 12)))
            if k == 0:
                line = f"{n}. " + line if not he else line + f" .{n}"
            sd.put(d, (w - 70 if he else 70, y), line, F.get(which, size, rng), (25, 25, 35), he)
            y += size + 10
        n += 1
        y += 16
    for k, label in enumerate(("חתימת העובד", "חתימת המעסיק") if he else ("Employee signature", "Employer signature")):
        x = 90 + k * (w // 2)
        d.line((x, h - 150, x + 330, h - 150), fill=(40, 40, 50), width=2)
        sd.put(d, (x + 330 if he else x, h - 140), label, F.get(which, 18, rng), (60, 60, 70), he)
    return im


def drawn(rng, F, kind):
    """A drawn page of a kind: upright RGB."""
    if kind == "contract":
        return contract(rng, F)
    if kind == "other":
        im, rect = sd.insert(rng, F)
    else:
        im, rect = sd.DRAW[kind](rng, F)
    return im.convert("RGB").crop(rect)   # a passport: its data page only


def cut(img, doc):
    """A picture's document cut flat by its own corners (0..1, its top-left first): upright."""
    h, w = img.shape[:2]
    P = np.float32([[x * w, y * h] for x, y in doc])
    W = int(max(np.linalg.norm(P[1] - P[0]), np.linalg.norm(P[2] - P[3])))
    H = int(max(np.linalg.norm(P[3] - P[0]), np.linalg.norm(P[2] - P[1])))
    M = cv2.getPerspectiveTransform(P, np.float32([[0, 0], [W, 0], [W, H], [0, H]]))
    return cv2.warpPerspective(img, M, (max(8, W), max(8, H)), flags=cv2.INTER_AREA)


def card(rng, F, by_kind):
    """An ID card to lay on a ספח: one of the owner's made another person's, else a drawn one (BGR, upright)."""
    if by_kind.get("id_front") and rng.random() < 0.5:
        p = rng.choice(by_kind["id_front"])
        im = sd.template(rng, F, p, sd.kind_of_page(p, "id_front"), False)[0]
    else:
        im = drawn(rng, F, "id_front")
    return cv2.cvtColor(np.asarray(im.convert("RGB")), cv2.COLOR_RGB2BGR)


def sefach_like(rng, F, img, by_kind):
    """A ספח as the phone sees it (owner, 2026-10-24: the type model took a ספח for an ID card — 88 % right): its
    ID card lying on it (a third of them), only the holder's part of the sheet, a fold's shadow, faded print."""
    h, w = img.shape[:2]
    if rng.random() < 0.3:   # only a part of the sheet (the holder's part, a sheet cut by the photo)
        cw, ch = int(w * rng.uniform(0.55, 0.9)), int(h * rng.uniform(0.55, 0.9))
        x, y = rng.randint(0, w - cw), rng.randint(0, h - ch)
        img = img[y:y + ch, x:x + cw].copy()
        h, w = img.shape[:2]
    if rng.random() < 0.35:  # the ID card lying on it, a little turned, its shadow under it
        c = card(rng, F, by_kind)
        cw = int(w * rng.uniform(0.25, 0.5))
        c = cv2.resize(c, (cw, max(8, round(c.shape[0] * cw / c.shape[1]))), interpolation=cv2.INTER_AREA)
        ch = c.shape[0]
        if ch < h - 4:
            M = cv2.getRotationMatrix2D((cw / 2, ch / 2), rng.uniform(-12, 12), 1.0)
            x, y = rng.randint(0, w - cw), rng.randint(0, h - ch)
            M[0, 2] += x; M[1, 2] += y
            mask = cv2.warpAffine(np.full((ch, cw), 255, np.uint8), M, (w, h))
            shadow = cv2.GaussianBlur(cv2.warpAffine(mask, np.float32([[1, 0, 4], [0, 1, 5]]), (w, h)), (0, 0), 4)
            img = (img.astype(np.float32) * (1 - shadow[..., None] / 255 * 0.35)).astype(np.uint8)
            laid = cv2.warpAffine(c, M, (w, h))
            img = np.where(mask[..., None] > 127, laid, img)
    if rng.random() < 0.3:   # a fold: a darker band across
        g = img.astype(np.float32)
        if rng.random() < 0.5:
            x = rng.randint(w // 4, 3 * w // 4)
            band = np.exp(-((np.arange(w) - x) ** 2) / (2 * (w * 0.01) ** 2))[None, :, None]
        else:
            y = rng.randint(h // 4, 3 * h // 4)
            band = np.exp(-((np.arange(h) - y) ** 2) / (2 * (h * 0.01) ** 2))[:, None, None]
        img = np.clip(g * (1 - band * rng.uniform(0.15, 0.35)), 0, 255).astype(np.uint8)
    if rng.random() < 0.3:   # faded print: less contrast, a bluish paper
        g = img.astype(np.float32)
        g = 255 - (255 - g) * rng.uniform(0.45, 0.8)
        g = g * np.float32([rng.uniform(1.0, 1.08), rng.uniform(0.97, 1.03), rng.uniform(0.9, 0.98)])
        img = np.clip(g, 0, 255).astype(np.uint8)
    return img


def changed(rng, bgr):
    """A cut page a little changed: light, blur, noise, JPEG."""
    g = bgr.astype(np.float32) * rng.uniform(0.8, 1.15) + rng.uniform(-20, 20)
    if rng.random() < 0.5:
        g = cv2.GaussianBlur(g, (0, 0), rng.uniform(0.3, 1.2))
    g = g + np.random.default_rng(rng.randint(0, 1 << 30)).normal(0, rng.uniform(0, 6), g.shape)
    ok, enc = cv2.imencode(".jpg", np.clip(g, 0, 255).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, rng.randint(50, 92)])
    return cv2.imdecode(enc, cv2.IMREAD_COLOR)


def sets():
    """MIDV's cards and passports and SmartDoc's pages with their own corners: [(file, doc corners, doctype)]."""
    out = []
    for folder, kind_of in (("midv", lambda e: e.get("kind")), ("smartdoc", lambda e: "other")):
        p = WORK / folder / "examples.json"
        if not p.exists():
            continue
        for e in json.loads(p.read_text(encoding="utf-8")):
            if e.get("doc") and kind_of(e) in SHARE:
                out.append((str(WORK / folder / "img" / pathlib.Path(e["file"]).name), e["doc"], kind_of(e)))
    return out


def _batch(job):
    seed, start, n, folder, latin, hebrew, pages, real = job
    F = sd.Fonts(latin, hebrew)
    by_kind = {}
    for path, k in pages:
        by_kind.setdefault("other" if k in ("insert", "licence") else k, []).append(path)   # a loose sheet or a licence: "other"
    out = []
    for i in range(start, start + n):
        rng = random.Random(seed * 1_000_003 + i)
        kind = rng.choices(list(SHARE), list(SHARE.values()))[0]
        pick = rng.random()
        if kind in by_kind and pick < 0.45:      # a real page of the owner's, made another person's
            img = cv2.cvtColor(np.asarray(sd.template(rng, F, *(lambda p: (p, sd.kind_of_page(p, kind)))(rng.choice(by_kind[kind])), False)[0].convert("RGB")), cv2.COLOR_RGB2BGR)
            source = "template"
        elif real and pick < 0.7 and any(k == kind for _, _, k in real):
            f, doc, _ = rng.choice([r for r in real if r[2] == kind])
            pic = cv2.imread(f)
            if pic is None:
                continue
            img, source = cut(pic, doc), "midv" if "midv" in f else "smartdoc"
        else:
            img = cv2.cvtColor(np.asarray(drawn(rng, F, kind)), cv2.COLOR_RGB2BGR)
            source = "drawn"
        if kind == "sefach":
            img = sefach_like(rng, F, img, by_kind)
        s = LONG / max(img.shape[:2])
        img = changed(rng, cv2.resize(img, (max(8, round(img.shape[1] * s)), max(8, round(img.shape[0] * s))), interpolation=cv2.INTER_AREA))
        f = pathlib.Path(folder) / "img" / f"{i}.jpg"
        cv2.imwrite(str(f), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
        out.append({"id": f"page-{seed}-{i}", "file": str(f), "doctype": kind, "exam": False, "synth": True, "source": source})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=6000)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--jobs", type=int, default=gentle())
    ap.add_argument("--templates", default=str(sd.TEMPLATES), help="the owner's real pages (pull_templates.py)")
    a = ap.parse_args()
    (OUT / "img").mkdir(parents=True, exist_ok=True)
    pages = sd.templates_in(a.templates)
    # the owner's real pages kept apart for the exam (synth.held_out) are never made into a training page:
    # exam_doctypes.py reads them, cut from synth_docs.py --templates --exam's photos
    kept = [pg for pg in pages if synth.held_out(pg[0])]
    pages = [pg for pg in pages if not synth.held_out(pg[0])]
    if kept:
        print(f"{len(kept)} real pages kept apart for the exam, {len(pages)} used here")
    real = sets()
    latin, hebrew = sd.latin_fonts(), sd.hebrew_fonts()
    work = [(a.seed, s, min(200, a.count - s), str(OUT), latin, hebrew, pages, real) for s in range(0, a.count, 200)]
    if a.jobs > 1:
        from multiprocessing import Pool
        with Pool(a.jobs) as pool:
            done = pool.map(_batch, work)
    else:
        done = [_batch(w) for w in work]
    ex = [e for b in done for e in b]
    (OUT / "pages.json").write_text(json.dumps(ex), encoding="utf-8")
    from collections import Counter
    print(f"{len(ex)} pages in {OUT}: " + ", ".join(f"{k} {n}" for k, n in sorted(Counter(e['doctype'] for e in ex).items()))
          + " — from " + ", ".join(f"{k} {n}" for k, n in sorted(Counter(e['source'] for e in ex).items())))


if __name__ == "__main__":
    main()
