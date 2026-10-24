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
split, the vocabulary, the pages' sha1s — train_he.py refuses a training set holding a held-out page). A thin wrapper
over `python -m gen build --model he` (gen/build.py): the folder also gets manifest.jsonl and run.json, one row per page
(docs/scan-training.md → "Made-up sets: build, verify, QA")."""
import hashlib
import json
import pathlib

import cv2
import numpy as np

from gen import rng as grng
from gen.common import file_sha1, heldout_sha256, record_own_exam_set
from gen.manifest import FontLog
from home import WORK
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


# ---------- gen build (gen/build.py): the set through the manifest ----------
MODEL, CHUNK = "he", 50


def _batch(job):
    import template_vary
    seed, indices, folder, pages, fonts, held = job
    fonts = FontLog(fonts)
    out = []
    for i in indices:
        rng = grng.legacy(seed, i)   # random.Random(seed * 1_000_003 + i), as always
        path, kind_page = rng.choice(pages)
        page, fields = template_vary.vary(rng, fonts, path, template_vary.spec_for(path), held=held)
        sha = file_sha1(path) or ""
        tag = sha[:10]
        g = phone(rng, page)
        labels, files, kept = [], [], []
        for k, (kind, text, box) in enumerate(fields):
            part = crop(rng, g, box)
            if part.size == 0:
                continue
            name = f"{i}-{k}.png"
            cv2.imwrite(str(pathlib.Path(folder) / name), part)
            labels.append(f"{name}\t{text}\t{kind}\t{tag}")
            files.append(name)
            kept.append({"file": name, "kind": kind, "text": hashlib.sha1(text.encode("utf-8")).hexdigest()[:10]})   # the text as a hash only
        out.append({"index": i, "id": f"he-{seed}-{i}", "entry": labels, "files": files, "meta": {
            "templates": [sha], "fonts": fonts.take(), "vocabulary": "check" if held else "train", "class": kind_page,
            "source": "template", "scene": {"fields": len(fields), "kept": len(kept)}, "labels": {"fields": kept}}})
    return out


def gen_args(ap):
    """synth_fields.py's options (and python -m gen build --model he)."""
    ap.add_argument("--count", type=int, default=3000, help="pages (each gives all its fields)")
    ap.add_argument("--check", action="store_true", help="the check set: the held-out pages and words, another seed")
    ap.add_argument("--out", help="the folder (default ~/.scan-train/synth/he-fields/train or …/check)")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--templates", default=str(TEMPLATES), help="the real pages (pull_templates.py)")
    ap.add_argument("--jobs", type=int, default=None, help="processes (default: all cores but two, gently)")
    ap.add_argument("--fonts", nargs="*", help="Hebrew fonts (default: the PC's)")


def gen_params(a):
    import template_vary
    pages = [(p, k) for p, k in templates_in(a.templates) if (template_vary.spec_for(p) or {}).get("fields")]
    if not pages:
        raise SystemExit(f"no marked real page in {a.templates} — run pull_templates.py (template_fields.json names the marked ones)")
    pages = split_pages(pages, a.check)
    out = pathlib.Path(a.out) if a.out else OUT / ("check" if a.check else "train")
    return {"model": MODEL, "split": "exam" if a.check else "train", "count": a.count, "seed": a.seed or (2 if a.check else 1),
            "out": str(out), "held": bool(a.check), "pages": [{"path": p, "sha1": file_sha1(p), "kind": k} for p, k in pages],
            "fonts": list(a.fonts or hebrew_fonts())}


def gen_prepare(folder, params):
    pathlib.Path(folder).mkdir(parents=True, exist_ok=True)


def gen_jobs(params, indices, folder):
    pages = [(e["path"], e["kind"]) for e in params["pages"]]
    return [(params["seed"], chunk, folder, pages, params["fonts"], params["held"])
            for chunk in (indices[k:k + CHUNK] for k in range(0, len(indices), CHUNK))]


def gen_write(folder, params, items):
    out = pathlib.Path(folder)
    labels = [l for it in items for l in it["entry"]]
    (out / "labels.tsv").write_text("\n".join(labels) + "\n", encoding="utf-8")
    held = params["held"]
    used = sorted({e["sha1"] for e in params["pages"]} - {None})
    (out / "sources.json").write_text(json.dumps({"split": "check" if held else "train", "vocabulary": "check" if held else "train",
                                                  "templates": used, "heldout_sha256": heldout_sha256()}, indent=1), encoding="utf-8")
    if held:
        record_own_exam_set("he-fields/check", out / "labels.tsv")   # the work folder's own check set only
    print(f"{len(labels)} fields from {params['count']} made-up pages ({len(used)} real {'held-out' if held else 'training'} pages: "
          + ", ".join(sorted(s[:8] for s in used)) + f") in {out}")


def main(argv=None):
    """The old CLI: python -m gen build --model he with today's defaults."""
    from gen.build import cli
    cli(MODEL, argv, prog="synth_fields.py")


if __name__ == "__main__":
    main()
