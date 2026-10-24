"""Made-up fields of Israeli ID cards, their backs and ספחים for the Hebrew field reader (docs/scan-training.md
→ "The Hebrew field reader"): each of the owner's marked real pages (template_fields.json) is made another
person's (template_vary.py), made like a phone's cut page (smaller, blurred, noisy, unevenly lit, squeezed
into JPEG, the box a little off), and each field is cut out with its text — the kind of picture the reader
will get from the scanner's cut page and the field's box. Nothing of a real holder is in them (every value
made up), and nothing is uploaded: the same seed draws the same fields again.

  python synth_fields.py --count 3000                 # pages → ~/.scan-train/synth/he-fields/train/
  python synth_fields.py --count 300 --check          # the held-out pages (another seed) → …/check/, to measure on

Kept apart (docs/scan-training.md → "Kept apart"): the check set is drawn only from the real pages kept for the
exam (synth.held_out: heldout.json) and with the check vocabulary (synth.field_value held=True); training gets the
other pages and the training vocabulary — the reader is measured on cards and words it never saw.

Writes <n>.png (grey), labels.tsv (file, text as written, kind, the page's sha1 prefix) and sources.json (the
split, the vocabulary, the pages' sha1s — train_he.py refuses a training set holding a held-out page)."""
import argparse
import json
import pathlib
import random

import cv2
import numpy as np

from gen.common import file_sha1, heldout_sha256, record_exam_set
from home import WORK, gentle
from synth_docs import TEMPLATES, templates_in
from synth_lines import hebrew_fonts

OUT = WORK / "synth" / "he-fields"


def phone(rng, page):
    """A flat page made like a phone's cut page: smaller, blurred, noisy, unevenly lit, JPEG (grey)."""
    g = cv2.cvtColor(np.asarray(page), cv2.COLOR_RGB2GRAY).astype(np.float32)
    h, w = g.shape
    s = rng.uniform(0.45, 1.0)
    if s < 0.97:
        small = cv2.resize(g, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
        g = cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)
    if rng.random() < 0.6:
        g = cv2.GaussianBlur(g, (0, 0), rng.uniform(0.4, 1.6))
    g = g * np.linspace(rng.uniform(0.75, 1.05), rng.uniform(0.75, 1.05), w)[None] + rng.uniform(-20, 20)
    g = g + np.random.default_rng(rng.randint(0, 1 << 30)).normal(0, rng.uniform(0, 9), g.shape)
    g = np.clip(g, 0, 255).astype(np.uint8)
    ok, enc = cv2.imencode(".jpg", g, [cv2.IMWRITE_JPEG_QUALITY, rng.randint(35, 92)])
    return cv2.imdecode(enc, cv2.IMREAD_GRAYSCALE)


def crop(rng, g, box):
    """A field's box cut out a little off and with a margin, as a box the AI or a finder gives would be."""
    x, y, w, h = box
    H, W = g.shape
    dx, dy = rng.uniform(-0.02, 0.02) * w, rng.uniform(-0.15, 0.15) * h
    mx, my = rng.uniform(0.0, 0.03) * w, rng.uniform(0.1, 0.4) * h   # a field beside on the same line stays out
    x0, y0 = int(max(0, x + dx - mx)), int(max(0, y + dy - my))
    x1, y1 = int(min(W, x + w + dx + mx)), int(min(H, y + h + dy + my))
    return g[y0:y1, x0:x1]


def _batch(job):
    import template_vary
    seed, start, n, folder, pages, fonts, held = job
    labels = []
    for i in range(start, start + n):
        rng = random.Random(seed * 1_000_003 + i)
        path, _ = rng.choice(pages)
        page, fields = template_vary.vary(rng, fonts, path, template_vary.spec_for(path), held=held)
        tag = (file_sha1(path) or "")[:10]
        g = phone(rng, page)
        for k, (kind, text, box) in enumerate(fields):
            part = crop(rng, g, box)
            if part.size == 0:
                continue
            name = f"{i}-{k}.png"
            cv2.imwrite(str(pathlib.Path(folder) / name), part)
            labels.append(f"{name}\t{text}\t{kind}\t{tag}")
    return labels


def split_pages(pages, check):
    """The marked pages a run draws: the held-out ones for the check, the others for training — a clear stop when
    either list is empty (no check without a held-out page, no training on held-out pages alone)."""
    import synth
    held = [pg for pg in pages if synth.exam_page(pg[0])]
    rest = [pg for pg in pages if not synth.held_out(pg[0])]   # a site page with no known side: in neither
    if not held:
        raise SystemExit("no marked real page is held out for the check (heldout.json) — the check would measure "
                         "pages the reader trains on; mark a held-out page in template_fields.json")
    if not rest:
        raise SystemExit("every marked real page is held out — nothing left to train on; mark more pages in template_fields.json")
    return held if check else rest


def draw(count, out, seed, jobs, pages, fonts, held=False):
    out = pathlib.Path(out)
    out.mkdir(parents=True, exist_ok=True)
    work = [(seed, s, min(50, count - s), str(out), pages, fonts, held) for s in range(0, count, 50)]
    if jobs > 1:
        from multiprocessing import Pool
        with Pool(jobs) as pool:
            done = pool.map(_batch, work)
    else:
        done = [_batch(w) for w in work]
    labels = [l for b in done for l in b]
    (out / "labels.tsv").write_text("\n".join(labels) + "\n", encoding="utf-8")
    used = sorted({file_sha1(p) for p, _ in pages} - {None})
    (out / "sources.json").write_text(json.dumps({"split": "check" if held else "train", "vocabulary": "check" if held else "train",
                                                  "templates": used, "heldout_sha256": heldout_sha256()}, indent=1), encoding="utf-8")
    return len(labels)


def main():
    import template_vary
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=3000, help="pages (each gives all its fields)")
    ap.add_argument("--check", action="store_true", help="the check set: the held-out pages and words, another seed")
    ap.add_argument("--out", help="the folder (default ~/.scan-train/synth/he-fields/train or …/check)")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--templates", default=str(TEMPLATES), help="the real pages (pull_templates.py)")
    ap.add_argument("--jobs", type=int, default=gentle())
    ap.add_argument("--fonts", nargs="*", help="Hebrew fonts (default: the PC's)")
    a = ap.parse_args()
    pages = [(p, k) for p, k in templates_in(a.templates) if (template_vary.spec_for(p) or {}).get("fields")]
    if not pages:
        raise SystemExit(f"no marked real page in {a.templates} — run pull_templates.py (template_fields.json names the marked ones)")
    pages = split_pages(pages, a.check)
    fonts = a.fonts or hebrew_fonts()
    seed = a.seed or (2 if a.check else 1)
    out = pathlib.Path(a.out) if a.out else OUT / ("check" if a.check else "train")
    n = draw(a.count, out, seed, a.jobs, pages, fonts, held=a.check)
    if a.check:
        record_exam_set("he-fields/check", out / "labels.tsv")
    print(f"{n} fields from {a.count} made-up pages ({len(pages)} real {'held-out' if a.check else 'training'} pages: "
          + ", ".join(sorted((file_sha1(p) or "?")[:8] for p, _ in pages)) + f") in {out}")


if __name__ == "__main__":
    main()
