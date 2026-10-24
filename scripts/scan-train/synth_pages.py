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
Every label comes from the one class table (gen.common.LABELS). Kept apart (docs/scan-training.md → "Kept
apart"): no held-out real page and no open set's exam document is drawn; each entry names the real pages in it
(templateSha1, templates) and the open-set document it was cut from (open), so train_doctypes.py can check.

  python synth_pages.py --count 6000          # → ~/.scan-train/synth/pages/ (img/, pages.json)
  python train_doctypes.py --synth 6000       # the made-up pages beside the site's (or alone, at first)

A thin wrapper over `python -m gen build --model doctype` (gen/build.py): the folder also gets manifest.jsonl and
run.json (docs/scan-training.md → "Made-up sets: build, verify, QA").
"""
import json
import pathlib

import cv2
import numpy as np
from PIL import ImageDraw

import synth
import synth_docs as sd
from gen import rng as grng
from gen.common import file_sha1, label
from gen.manifest import sha256_file
from home import WORK
from midv import open_exam

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


SHEETS_HE = ("payslip", "bank", "medical", "notice")   # he_sheet's kinds: Hebrew A4 that is not a contract


def he_sheet(rng, F, held=False):
    """A Hebrew A4 page that is not a contract (training audit: "Hebrew A4" must not mean "contract" to the type model):
    a payslip (a table of amounts), a bank letter (a letterhead, an account line, a short letter), a medical form (boxes
    with labels to fill) or a notice — every value made up. → synth_docs.Drawn (RGBA, rect, the values' boxes)."""
    w, h = 1050, 1485
    im = sd.paper(rng, w, h)
    d = ImageDraw.Draw(im)
    kind = rng.choice(SHEETS_HE)
    boxes = []

    def text(xy, s, size, fill=(25, 25, 35), rtl=True, role=None):
        f = F.get("hebrew", size, rng)
        sd.put(d, xy, s, f, fill, rtl)
        if role:
            boxes.append((role, s, sd.text_box(d, xy, s, f, rtl)))

    head = {"payslip": ("תלוש שכר", "תלוש משכורת לחודש"), "bank": ("בנק", "הודעה ללקוח"),
            "medical": ("טופס רפואי", "שאלון הצהרת בריאות"), "notice": ("הודעה לתושב", "עירייה - הודעה")}[kind]
    band = sd.pastel(rng, (60, 170))
    if rng.random() < 0.6:   # a letterhead's band
        d.rectangle((0, 0, w, rng.randint(70, 120)), fill=band)
    text((w - 60, 40), rng.choice(head), rng.randint(34, 44), (20, 20, 40))
    text((w - 60, 110), sd.he_value(rng, "given", held) + " " + sd.he_value(rng, "surname", held), 24, role="name")
    text((w - 60, 145), sd.he_value(rng, "street", held) + " " + str(rng.randint(1, 120)) + ", " + sd.he_value(rng, "city", held),
         20, role="address")
    y = 210
    if kind == "payslip":
        rows = rng.randint(8, 16)
        labels = ("שכר יסוד", "שעות נוספות", "נסיעות", "הבראה", "מס הכנסה", "ביטוח לאומי", "מס בריאות", "פנסיה",
                  "קרן השתלמות", "ניכויים", "ברוטו", "נטו לתשלום")
        for r in range(rows + 1):
            yy = y + r * 40
            d.line((60, yy, w - 60, yy), fill=(90, 90, 100), width=1)
            if r:
                text((w - 80, yy - 32), rng.choice(labels), 20)
                text((90, yy - 32), f"{rng.randint(10, 9999)}.{rng.randint(0, 99):02d}", 20, rtl=False, role="amount")
        for x in (60, w // 2, w - 60):
            d.line((x, y, x, y + rows * 40), fill=(90, 90, 100), width=1)
        y += rows * 40 + 40
    elif kind == "medical":
        labels = ("שם המטופל", "מספר זהות", "תאריך לידה", "קופת חולים", "רופא מטפל", "אבחנה", "תרופות", "רגישויות")
        for lab in rng.sample(labels, rng.randint(5, len(labels))):
            text((w - 70, y), lab, 20, (70, 70, 80))
            d.rectangle((70, y + 30, w - 70, y + 70), outline=(110, 110, 120), width=2)
            if rng.random() < 0.6:
                text((w - 90, y + 38), sd.he_value(rng, rng.choice(("given", "city", "street")), held), 22, role="value")
            y += 95
            if y > h - 300:
                break
    words = HE_WORDS[18:] + ("לקוח", "יקר", "חשבון", "יתרה", "תשלום", "בברכה", "הודעה", "בקשה", "מסמך", "טופס", "תאריך")
    while y < h - 220:   # the letter's lines: no numbered clauses (a contract's look)
        line = " ".join(rng.choice(words) for _ in range(rng.randint(5, 11)))
        text((w - 70, y), line, rng.randint(18, 22), role="text")
        y += rng.randint(30, 40)
        if rng.random() < 0.15:
            y += 30
    if rng.random() < 0.6:   # a stamp
        cx, cy, r = rng.randint(150, 400), rng.randint(h - 260, h - 140), rng.randint(50, 90)
        d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=rng.choice(((60, 70, 150), (150, 40, 50))), width=4)
    sd.put(d, (60, h - 60), "SPECIMEN", F.get("latin", 26, rng), (150, 80, 80))
    return sd.Drawn(im.convert("RGBA"), (0, 0, w, h), boxes)


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


def card(rng, F, by_kind, used=None):
    """An ID card to lay on a ספח: one of the owner's made another person's, else a drawn one (BGR, upright);
    used: the real pages' sha1s, added to."""
    if by_kind.get("id_front") and rng.random() < 0.5:
        p = rng.choice(by_kind["id_front"])
        if used is not None:
            used.append(file_sha1(p))
        im = sd.template(rng, F, p, sd.kind_of_page(p, "id_front"), False)[0]
    else:
        im = drawn(rng, F, "id_front")
    return cv2.cvtColor(np.asarray(im.convert("RGB")), cv2.COLOR_RGB2BGR)


def sefach_like(rng, F, img, by_kind, used=None):
    """A ספח as the phone sees it (owner, 2026-10-24: the type model took a ספח for an ID card — 88 % right): its
    ID card lying on it (a third of them), only the holder's part of the sheet, a fold's shadow, faded print."""
    h, w = img.shape[:2]
    if rng.random() < 0.3:   # only a part of the sheet (the holder's part, a sheet cut by the photo)
        cw, ch = int(w * rng.uniform(0.55, 0.9)), int(h * rng.uniform(0.55, 0.9))
        x, y = rng.randint(0, w - cw), rng.randint(0, h - ch)
        img = img[y:y + ch, x:x + cw].copy()
        h, w = img.shape[:2]
    if rng.random() < 0.35:  # the ID card lying on it, a little turned, its shadow under it
        c = card(rng, F, by_kind, used)
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


def open_ref(e):
    """What an entry keeps of the open-set example it was cut from (enough for midv.open_exam)."""
    return {k: e[k] for k in ("id", "source", "midv", "smartdoc", "doc_no") if k in e}


def sets():
    """MIDV's cards and passports and SmartDoc's pages with their own corners, but their exam documents
    (midv.open_exam): [(file, doc corners, doctype, open_ref)] — the doctype from the class table (gen.common.LABELS)."""
    out = []
    for folder, kind_of in (("midv", lambda e: e.get("kind")), ("smartdoc", lambda e: label("smartdoc", e.get("kind") or ""))):
        p = WORK / folder / "examples.json"
        if not p.exists():
            continue
        for e in json.loads(p.read_text(encoding="utf-8")):
            if e.get("doc") and kind_of(e) in SHARE and not open_exam(e):
                out.append((str(WORK / folder / "img" / pathlib.Path(e["file"]).name), e["doc"], kind_of(e), open_ref(e)))
    return out


OPEN_SETS = ("midv", "smartdoc")


def open_sets():
    """The open sets' examples.json the pages are cut from, by their sha256 (None: not made here) — a run is drawn
    again (gen verify) only from the same ones."""
    return {f: (sha256_file(WORK / f / "examples.json") if (WORK / f / "examples.json").exists() else None) for f in OPEN_SETS}


# ---------- gen build (gen/build.py): the set through the manifest ----------
MODEL, CHUNK = "doctype", 200


def _batch(job):
    seed, indices, folder, latin, hebrew, pages, real = job
    F = sd.Fonts(latin, hebrew)
    by_kind = {}
    for path, k in pages:
        by_kind.setdefault(label("template", k), []).append(path)   # a loose sheet or a licence: "other" (the class table)
    out = []
    for i in indices:
        rng = grng.legacy(seed, i)   # random.Random(seed * 1_000_003 + i), as always
        kind = rng.choices(list(SHARE), list(SHARE.values()))[0]
        pick = rng.random()
        used, ref = [], None
        if kind in by_kind and pick < 0.45:      # a real page of the owner's, made another person's
            p = rng.choice(by_kind[kind])
            used.append(file_sha1(p))
            img = cv2.cvtColor(np.asarray(sd.template(rng, F, p, sd.kind_of_page(p, kind), False)[0].convert("RGB")), cv2.COLOR_RGB2BGR)
            source = "template"
        elif real and pick < 0.7 and any(r[2] == kind for r in real):
            f, doc, _, ref = rng.choice([r for r in real if r[2] == kind])
            pic = cv2.imread(f)
            if pic is None:
                F.used()
                continue
            img, source = cut(pic, doc), "midv" if "midv" in f else "smartdoc"
        else:
            img = cv2.cvtColor(np.asarray(drawn(rng, F, kind)), cv2.COLOR_RGB2BGR)
            source = "drawn"
        if kind == "sefach":
            img = sefach_like(rng, F, img, by_kind, used)
        s = LONG / max(img.shape[:2])
        img = changed(rng, cv2.resize(img, (max(8, round(img.shape[1] * s)), max(8, round(img.shape[0] * s))), interpolation=cv2.INTER_AREA))
        f = pathlib.Path(folder) / "img" / f"{i}.jpg"
        cv2.imwrite(str(f), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
        entry = {"id": f"page-{seed}-{i}", "file": str(f), "doctype": kind, "exam": False, "synth": True, "source": source,
                 **({"templateSha1": used[0], "templates": sorted(set(used))} if used else {}), **({"open": ref} if ref else {})}
        out.append({"index": i, "id": entry["id"], "entry": entry, "files": [f"img/{i}.jpg"], "meta": {
            "templates": used, "fonts": F.used(), "vocabulary": "train", "class": kind, "source": source,
            "scene": {"kind": kind, "size": [int(img.shape[1]), int(img.shape[0])]},
            "labels": {"doctype": kind, "turn": 0}, **({"open": ref} if ref else {})}})
    return out


def gen_args(ap):
    """synth_pages.py's options (and python -m gen build --model doctype)."""
    ap.add_argument("--count", type=int, default=6000)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", default=str(OUT), help="default ~/.scan-train/synth/pages")
    ap.add_argument("--jobs", type=int, default=None, help="processes (default: all cores but two, gently)")
    ap.add_argument("--templates", default=str(sd.TEMPLATES), help="the owner's real pages (pull_templates.py)")


def gen_params(a):
    pages = sd.templates_in(a.templates)
    # the owner's real pages kept apart for the exam (synth.held_out) are never made into a training page:
    # exam_doctypes.py reads them, cut from synth_docs.py --templates --exam's photos
    kept = [pg for pg in pages if synth.held_out(pg[0])]
    pages = [pg for pg in pages if not synth.held_out(pg[0])]
    if kept:
        print(f"{len(kept)} real pages kept apart for the exam, {len(pages)} used here")
    return {"model": MODEL, "split": "train", "count": a.count, "seed": a.seed, "out": str(a.out),
            "pages": [{"path": p, "sha1": file_sha1(p), "kind": k} for p, k in pages],
            "latin": list(sd.latin_fonts()), "hebrew": list(sd.hebrew_fonts()), "openSets": open_sets()}


def gen_prepare(folder, params):
    (pathlib.Path(folder) / "img").mkdir(parents=True, exist_ok=True)


def gen_jobs(params, indices, folder):
    if open_sets() != params.get("openSets", open_sets()):
        raise SystemExit("the MIDV / SmartDoc sets on this PC are not the ones the run cut its pages from (their examples.json changed)")
    real = sets()
    pages = [(e["path"], e["kind"]) for e in params["pages"]]
    return [(params["seed"], chunk, folder, params["latin"], params["hebrew"], pages, real)
            for chunk in (indices[k:k + CHUNK] for k in range(0, len(indices), CHUNK))]


def gen_write(folder, params, items):
    ex = [it["entry"] for it in items]
    (pathlib.Path(folder) / "pages.json").write_text(json.dumps(ex), encoding="utf-8")
    from collections import Counter
    print(f"{len(ex)} pages in {folder}: " + ", ".join(f"{k} {n}" for k, n in sorted(Counter(e['doctype'] for e in ex).items()))
          + " — from " + ", ".join(f"{k} {n}" for k, n in sorted(Counter(e['source'] for e in ex).items())))


def main(argv=None):
    """The old CLI: python -m gen build --model doctype with today's defaults."""
    from gen.build import cli
    cli(MODEL, argv, prog="synth_pages.py")


if __name__ == "__main__":
    main()
