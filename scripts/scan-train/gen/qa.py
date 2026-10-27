"""gen qa — the sheet to look at before a made-up set is trained on (docs/scan-training.md → "Made-up sets: build,
verify, QA").

  python -m gen qa --run ~/.scan-train/synth/pages          # → <run>/qa/index.html and <run>/qa/purity.json

The sheet (local only — the pictures come from the owner's real pages; it is never uploaded):
- contact sheets per stratum (the source × the class): the pictures with their corners drawn (the first corner red,
  the document's own top-left blue: its turn), the class and the turn written on them, a field's text only as a sha1
  prefix — no file name, no name or number off a document anywhere on the sheet;
- the table source × class: every cell has its count and its sheet, or n=0;
- histograms by class, by source and by background category;
- the line "intersection with held-out = N" (gen.manifest.held_refs over every row) and the verify result (gen
  verify on a sample, run here when the set has none for its fingerprint);
- for scenes (gen/scene.py: rows with a recipe) the per-recipe strata too: the tables recipe × class and recipe ×
  background category (every cell a count or n=0), a histogram by recipe, and a contact sheet per recipe showing every
  picture of a scene — the frame, each "next" one (found pages painted over) and each "inside" cut — with its answer;
- for the phone's own cuts (gen/phone_run.py, model "cuts"): the shot's counts (matched, missed, false), the IoU of
  the phone's cuts as a histogram, the cut_by share of the pages kept (phone, bad, editor) against the editor cap,
  the document type crops by class (short classes marked), the zone finder's and the Hebrew fields' counts with
  layout_overflow.json, the face exam's, and a contact sheet of the crops per class (turn_k, cut_by, IoU written on).
- the realism panel: how far the made-up pictures are from real ones — the two-sample Kolmogorov–Smirnov distance of
  each picture statistic (sharpness, noise, brightness, and for photos the document's fill and tilt) against the real
  scan attempts (gen real's index; a set of crops is compared with the real page copies and document pages and with
  the attempts cut at their corners) and against MIDV, plus the AUC of a real-vs-made-up classifier on those statistics
  (a logistic regression in numpy, scored on held-back folds: 0.5 — it cannot tell them apart). Written to run.json
  ("realism") and shown on the sheet; it never decides purity.
purity.json records it: passed when the intersection is 0 and verify passed. Every train*.py calls require_qa on a
made-up set drawn through gen build: no qa/purity.json, one not passed, or one of another drawing (fingerprint) or
another heldout.json, or a manifest that references what the exam keeps today (held_refs run again at training
time) → it refuses to train."""
import datetime
import html
import json
import pathlib
import re

from . import common as gc
from . import manifest

THUMB, PER_SHEET, COLS = 180, 12, 6


def _slug(s):
    return re.sub(r"[^a-z0-9_]+", "-", str(s).lower()).strip("-") or "x"


def stratum(r):
    return (str(r.get("source")), str(r.get("class")))


def _thumb(folder, r, out=0, labels=None, title=None):
    """One example's picture for the sheet (BGR), its labels drawn on it (out: which of its outputs; labels: that
    picture's own — a scene's next / inside pictures)."""
    import cv2
    import numpy as np
    outs = (r.get("outputs") or [])[out:]
    labels = labels if labels is not None else (r.get("labels") or {})
    if r.get("model") == "he":
        crops = []
        for (f, _), fl in zip(outs[:4], labels.get("fields") or []):
            g = cv2.imread(str(folder / f))
            if g is None:
                continue
            g = cv2.resize(g, (THUMB, max(12, min(40, round(g.shape[0] * THUMB / max(1, g.shape[1]))))))
            band = np.full((14, THUMB, 3), 255, np.uint8)
            cv2.putText(band, f"{fl.get('kind')} #{fl.get('text')}", (2, 11), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (0, 0, 0), 1)
            crops += [g, band]
        img = np.vstack(crops) if crops else np.full((40, THUMB, 3), 200, np.uint8)
    else:
        img = cv2.imread(str(folder / outs[0][0])) if outs else None
        if img is None:
            img = np.full((THUMB, THUMB, 3), 200, np.uint8)
        h, w = img.shape[:2]
        k = THUMB / max(h, w)
        img = cv2.resize(img, (max(1, round(w * k)), max(1, round(h * k))))
        h, w = img.shape[:2]
        fixed, doc = labels.get("fixed"), labels.get("doc")
        if fixed:
            P = np.array([[x * w, y * h] for x, y in fixed], np.int32)
            cv2.polylines(img, [P], True, (60, 220, 60), 2)
            cv2.circle(img, tuple(int(c) for c in P[0]), 5, (0, 0, 255), -1)      # the first corner: red
        if doc:
            cv2.circle(img, (int(doc[0][0] * w), int(doc[0][1] * h)), 3, (255, 120, 0), -1)   # the document's own top-left: blue
        turn = labels.get("turn", labels.get("upright"))
        cv2.rectangle(img, (0, 0), (w, 14), (255, 255, 255), -1)
        cv2.putText(img, title or f"{r.get('class')} turn {turn}", (2, 11), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (0, 0, 0), 1)
    pad = np.full((img.shape[0] + 4, THUMB + 4, 3), 255, np.uint8)
    pad[2:2 + img.shape[0], 2:2 + min(THUMB, img.shape[1])] = img[:, :THUMB]
    return pad


def scene_thumbs(folder, r):
    """Every picture of a scene (the frame, its next and inside pictures), each with its own answer and role."""
    entries = (r.get("labels") or {}).get("entries") or []
    out = []
    for k, e in enumerate(entries):
        lab = {"fixed": e.get("fixed")}
        out.append(_thumb(folder, r, k, lab, f"{r.get('recipe')} {e.get('role')}"[:30]))
    return out or [_thumb(folder, r)]


def contact_sheet(folder, rows, dest, every=False):
    """Up to PER_SHEET examples of a stratum in one picture (every: all the pictures of each scene)."""
    import cv2
    import numpy as np
    thumbs = ([t for r in rows for t in scene_thumbs(folder, r)] if every else [_thumb(folder, r) for r in rows])[:PER_SHEET]
    lines = []
    for k in range(0, len(thumbs), COLS):
        part = thumbs[k:k + COLS]
        hh = max(t.shape[0] for t in part)
        part = [np.vstack([t, np.full((hh - t.shape[0], t.shape[1], 3), 255, np.uint8)]) for t in part]
        part += [np.full((hh, THUMB + 4, 3), 255, np.uint8)] * (COLS - len(part))
        lines.append(np.hstack(part))
    cv2.imwrite(str(dest), np.vstack(lines), [cv2.IMWRITE_JPEG_QUALITY, 85])


def _bars(title, counts):
    total = max(1, sum(counts.values()))
    rows = "".join(f'<tr><td>{html.escape(k)}</td><td class="n">{n}</td><td><div class="bar" style="width:{100 * n / total:.1f}%"></div></td></tr>'
                   for k, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])))
    return f"<h3>{html.escape(title)}</h3><table class=\"hist\">{rows}</table>"


def _count(rows, key):
    c = {}
    for r in rows:
        v = str(key(r))
        c[v] = c.get(v, 0) + 1
    return c


def classes_of(model, rows):
    base = list(gc.DOCTYPES) + (["none"] if model == "edges" else [])
    return base + sorted({str(r.get("class")) for r in rows} - set(base))


SOURCES = {"edges": ("drawn", "template", "washed", "pdf", "none"), "doctype": ("drawn", "template", "midv", "smartdoc"),
           "he": ("template",), "cuts": ("drawn", "template", "washed", "pdf", "attempt", "none")}
RECIPES = ("single", "pair", "card_on_sheet", "painted", "none", "partial")   # gen/scene.py's


def _table(rows, key_row, key_col, rows_order, cols_order, link=None):
    t = _count(rows, lambda r: (str(key_row(r)), str(key_col(r))))
    head = "".join(f"<th>{html.escape(c)}</th>" for c in cols_order)
    body = ""
    for a in rows_order:
        cells = ""
        for c in cols_order:
            n = t.get(str((a, c)), 0)
            cells += (f'<td class="n">{n}</td>' if n else '<td class="zero">n=0</td>')
        name = f'<a href="#{link(a)}">{html.escape(a)}</a>' if link else html.escape(a)
        body += f"<tr><th>{name}</th>{cells}</tr>"
    return f"<table><tr><th></th>{head}</tr>{body}</table>"


def recipe_part(model, rows, recipe_sheets):
    """The per-recipe strata of a scenes' set ("" for a set with no recipes)."""
    if not any(r.get("recipe") for r in rows):
        return ""
    recipes = list(RECIPES) + sorted({str(r.get("recipe")) for r in rows} - set(RECIPES))
    classes = classes_of(model, rows)
    cats = sorted({str(r.get("bgCategory")) for r in rows})
    blocks = "".join(f'<section id="recipe-{_slug(rc)}"><h3>{html.escape(rc)} — {n} scenes</h3>'
                     f'<img src="{html.escape(f)}" alt="{html.escape(rc)}"></section>' for rc, (f, n) in sorted(recipe_sheets.items()))
    return (f"<h2>Recipes</h2><p>Each recipe's scenes (partial: weight 0 until the owner confirms its label).</p>"
            f"<h3>Recipe × class</h3>{_table(rows, lambda r: r.get('recipe'), lambda r: r.get('class'), recipes, classes, lambda a: 'recipe-' + _slug(a))}"
            f"<h3>Recipe × background category</h3>{_table(rows, lambda r: r.get('recipe'), lambda r: r.get('bgCategory'), recipes, cats)}"
            f"{_bars('by recipe', _count(rows, lambda r: r.get('recipe')))}"
            f"<h3>Every picture of a scene, per recipe</h3><p>The frame, the next pictures (found pages painted over) and the inside "
            f"cuts, each with its own answer.</p>{blocks}")


def crop_sheet(folder, entries, dest):
    """Up to PER_SHEET document type crops in one picture, each with its turn_k, cut_by and IoU written on it."""
    import cv2
    import numpy as np
    thumbs = []
    for e in entries[:PER_SHEET]:
        img = cv2.imread(str(folder / e["file"]))
        if img is None:
            continue
        h, w = img.shape[:2]
        k = THUMB / max(h, w)
        img = cv2.resize(img, (max(1, round(w * k)), max(1, round(h * k))))
        cv2.rectangle(img, (0, 0), (img.shape[1], 14), (255, 255, 255), -1)
        cv2.putText(img, f"t{e.get('turn_k')} {e.get('cut_by')} {float(e.get('iou') or 0):.2f}", (2, 11), cv2.FONT_HERSHEY_SIMPLEX,
                    0.35, (0, 0, 0), 1)
        pad = np.full((THUMB + 4, THUMB + 4, 3), 255, np.uint8)
        pad[2:2 + img.shape[0], 2:2 + img.shape[1]] = img
        thumbs.append(pad)
    if not thumbs:
        return False
    blank = np.full((THUMB + 4, THUMB + 4, 3), 255, np.uint8)
    rows = [np.hstack(thumbs[k:k + COLS] + [blank] * (COLS - len(thumbs[k:k + COLS]))) for k in range(0, len(thumbs), COLS)]
    cv2.imwrite(str(dest), np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 85])
    return True


def cuts_part(folder, out):
    """The phone's own cuts' section ("" for any other set): cuts.json's counts and the crops by class."""
    try:
        summary = json.loads((folder / "cuts.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    c = summary.get("cuts") or {}
    ok = c.get("editorShare", 0) <= c.get("editorCap", 1) + 1e-9
    runs = summary.get("modelRuns")
    part = (f"<h2>The phone's own cuts</h2><p>The lab's edges models {html.escape(str(c.get('labVersion')))} (edges sha "
            f"{html.escape(str(c.get('edgesSha'))[:12])}); model runs in this drawing: {runs}"
            f"{' (every scene from the cache)' if not runs else ''}.</p>"
            f"<p>{c.get('scenes')} scenes, {c.get('shots')} shots taken; {c.get('documents')} true documents: matched "
            f"{c.get('matched')}, missed {c.get('missed')}; found where no document is (false) {c.get('false')}; "
            f"mean corner error of the phone's cuts {c.get('cornerErrMean')}.</p>"
            f"<ul><li class='{'ok' if ok else 'bad'}'>cut_by share of the pages kept: editor {c.get('editorShare', 0):.1%} "
            f"(cap {c.get('editorCap', 0):.0%}), bad cuts {c.get('badShare', 0):.1%} (cap {c.get('badCap', 0):.0%}); "
            f"{summary.get('dropped', 0)} pages dropped to keep them so</li></ul>"
            f"{_bars('IoU of the phone cuts (before the caps)', c.get('iouHist') or {})}"
            f"{_bars('pages kept, by cut', c.get('keptByCut') or {})}{_bars('pages by cut (before the caps)', c.get('byCut') or {})}"
            f"{_bars('found by (the lab step)', c.get('byHow') or {})}")
    d = summary.get("doctype")
    if d:
        body = "".join(f"<tr><th>{html.escape(k)}</th><td class='n'>{v['crops']}</td><td class='n'>{v['templates']}</td>"
                       f"<td class='n'>{v['editor']}</td><td class='n'>{v['bad']}</td><td class='n'>{v['turnKnown']}</td>"
                       f"<td class='{'bad' if k in d['short'] else 'ok'}'>{'short' if k in d['short'] else 'ok'}</td></tr>"
                       for k, v in d["byClass"].items())
        part += (f"<h3>Document type crops by class</h3><p>Each class wants at least {d['minCrops']} crops from "
                 f"{d['minTemplates']} distinct pages.</p><table><tr><th></th><th>crops</th><th>pages</th><th>editor</th>"
                 f"<th>bad cut</th><th>turn known</th><th></th></tr>{body}</table>")
        try:
            entries = json.loads((folder / "doctype" / "pages.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            entries = []
        for cls in sorted({e["doctype"] for e in entries}):
            name = f"sheet-crops-{_slug(cls)}.jpg"
            if crop_sheet(folder, [e for e in entries if e["doctype"] == cls], out / name):
                part += f"<section><h3>{html.escape(cls)} crops</h3><img src='{name}' alt='{html.escape(cls)}'></section>"
    z = summary.get("mrz")
    if z:
        part += (f"<h3>Passport zone</h3><p>{z['passports']} passports ({z['td3']} TD3): both lines found right on {z['ok']}; "
                 f"failed {html.escape(json.dumps(z['failed']))}; {z['lines']} line crops ({z['linesFoundRight']} find_ok).</p>")
    h = summary.get("he")
    if h:
        o = h.get("overflow") or {}
        part += (f"<h3>Hebrew fields</h3><p>{h['crops']} crops on {h['pages']} card fronts, skipped "
                 f"{html.escape(json.dumps(h['skipped']))}; by role {html.escape(json.dumps(h['byRole']))}. "
                 f"layout_overflow.json: 99th percentile past the box x {o.get('x')}, y {o.get('y')} — "
                 f"{'within' if o.get('covered') else 'NOT within'} heLine's margins.</p>")
    f = summary.get("face")
    if f:
        part += (f"<h3>Face exam crops</h3><p>{f['crops']} pages with a photo: the face finder right on {f['right']}, "
                 f"no face on {f['noFace']}.</p>")
    return part


# ---------- the realism panel ----------
REALISM_N = 200                   # pictures per group at most (a fixed sample)
STATS = ("sharpness", "noise", "brightness", "fill", "tilt")
LONG_SIDE = 512                   # the statistics are measured on the picture shrunk to this long side


def _quad_area(q):
    return abs(sum(q[i][0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * q[i][1] for i in range(4))) / 2


def _tilt(q, w, h):
    """The mean distance of the quad's four corner angles from 90° (degrees), in the picture's pixels: 0 for a page
    seen straight on, larger the more the camera leans."""
    import math
    P = [(x * w, y * h) for x, y in q]
    out = []
    for i in range(4):
        a, b, c = P[i - 1], P[i], P[(i + 1) % 4]
        u, v = (a[0] - b[0], a[1] - b[1]), (c[0] - b[0], c[1] - b[1])
        n = math.hypot(*u) * math.hypot(*v)
        if n <= 0:
            return None
        out.append(abs(math.degrees(math.acos(max(-1.0, min(1.0, (u[0] * v[0] + u[1] * v[1]) / n)))) - 90))
    return sum(out) / 4


def image_stats(img, quad=None):
    """One picture's statistics (BGR or grey): sharpness — log10(1 + the Laplacian's variance); noise — the median
    absolute high-pass residual (× 1.4826); brightness — the mean grey 0..1; fill — the document's share of the picture
    (its quad's area, 0..1) and tilt (_tilt), only with a quad."""
    import cv2
    import numpy as np
    g = img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    h, w = g.shape[:2]
    k = LONG_SIDE / max(h, w)
    if k < 1:
        g = cv2.resize(g, (max(1, round(w * k)), max(1, round(h * k))), interpolation=cv2.INTER_AREA)
    f = g.astype(np.float32)
    lap = cv2.Laplacian(f, cv2.CV_32F)
    res = f - cv2.GaussianBlur(f, (3, 3), 0)
    out = {"sharpness": float(np.log10(1 + lap.var())), "noise": float(1.4826 * np.median(np.abs(res))),
           "brightness": float(f.mean() / 255), "fill": None, "tilt": None}
    if quad:
        out["fill"] = float(_quad_area(quad))
        out["tilt"] = _tilt(quad, img.shape[1], img.shape[0])
    return out


def ks(a, b):
    """The two-sample Kolmogorov–Smirnov distance (the largest gap of the two empirical distributions); None when either
    is empty."""
    import numpy as np
    a = np.sort(np.asarray([x for x in a if x is not None], np.float64))
    b = np.sort(np.asarray([x for x in b if x is not None], np.float64))
    if not len(a) or not len(b):
        return None
    v = np.concatenate([a, b])
    return float(np.max(np.abs(np.searchsorted(a, v, "right") / len(a) - np.searchsorted(b, v, "right") / len(b))))


def auc(scores, labels):
    """The area under the ROC curve (the Mann–Whitney statistic, ties averaged); None without both classes."""
    import numpy as np
    s, y = np.asarray(scores, np.float64), np.asarray(labels, bool)
    npos, nneg = int(y.sum()), int((~y).sum())
    if not npos or not nneg:
        return None
    order = np.argsort(s, kind="mergesort")
    ranks = np.empty(len(s), np.float64)
    sv = s[order]
    i = 0
    while i < len(s):
        j = i
        while j + 1 < len(s) and sv[j + 1] == sv[i]:
            j += 1
        ranks[order[i:j + 1]] = (i + j) / 2 + 1
        i = j + 1
    return float((ranks[y].sum() - npos * (npos + 1) / 2) / (npos * nneg))


def logistic_auc(real, made, folds=2, seed=0, steps=600, lr=0.2, l2=1e-3):
    """The AUC of a real-vs-made-up classifier: a logistic regression (numpy gradient descent, the features standardised)
    on the rows (lists of numbers), each row scored by a model fitted on the other folds. None with fewer than 5 of
    either."""
    import numpy as np
    if len(real) < 5 or len(made) < 5:
        return None
    X = np.asarray(list(real) + list(made), np.float64)
    y = np.asarray([1] * len(real) + [0] * len(made), np.float64)
    rng = np.random.default_rng(seed)
    fold = np.empty(len(y), int)
    for c in (0, 1):
        idx = np.flatnonzero(y == c)
        rng.shuffle(idx)
        fold[idx] = np.arange(len(idx)) % folds
    scores = np.zeros(len(y))
    for k in range(folds):
        tr, te = fold != k, fold == k
        mu, sd = X[tr].mean(0), X[tr].std(0) + 1e-9
        A = (X[tr] - mu) / sd
        w, b = np.zeros(X.shape[1]), 0.0
        for _ in range(steps):
            p = 1 / (1 + np.exp(-(A @ w + b)))
            g = p - y[tr]
            w -= lr * (A.T @ g / len(g) + l2 * w)
            b -= lr * g.mean()
        scores[te] = ((X[te] - mu) / sd) @ w + b
    return auc(scores, y.astype(bool))


def _sample_items(items, n=REALISM_N, seed="realism"):
    import random
    items = list(items)
    return items if len(items) <= n else random.Random(seed).sample(items, n)


def made_items(folder, run, rows):
    """The made-up pictures to measure → (kind, [(file, quad or None, cut quad or None)]): "frames" for photos (an edges
    set: each scene's frame with its answer's corners), "pages" for crops (a cuts set's document type crops, a pages
    set's pages); (None, []) for a set of field crops."""
    model = run.get("model")
    if model == "edges":
        return "frames", [(str(folder / r["outputs"][0][0]), (r.get("labels") or {}).get("fixed"), None) for r in rows if r.get("outputs")]
    if model == "cuts":
        try:
            entries = json.loads((folder / "doctype" / "pages.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            entries = []
        return "pages", [(str(folder / e["file"]), None, None) for e in entries]
    if model == "doctype":
        return "pages", [(str(folder / r["outputs"][0][0]), None, None) for r in rows if r.get("outputs")]
    return None, []


def real_items(real_dir, kind):
    """The real pictures of gen real's index for a kind: frames — the attempts' photos (their first page, not a cut) with
    their right corners; pages — the page copies and document pages, and the attempts' photos cut at their corners."""
    from . import real as greal
    rows = greal.read_index(real_dir) if real_dir else []
    out = []
    for r in rows:
        e = (r.get("targets") or {}).get("edges") or {}
        if r.get("source") == "attempt" and r.get("page") == 0 and not r.get("inside"):
            q = e.get("fixed") if not e.get("none") else None
            if kind == "frames":
                out.append((r["file"], q, None))
            elif q:
                out.append((r["file"], None, q))
        elif kind == "pages" and "doctype" in (r.get("targets") or {}):
            out.append((r["file"], None, None))
    return out


def midv_items(midv_dir, kind):
    """MIDV's photos with their corners (frames), or cut at them (pages)."""
    p = pathlib.Path(midv_dir) / "examples.json" if midv_dir else None
    if not p or not p.exists():
        return []
    out = []
    for e in json.loads(p.read_text(encoding="utf-8")):
        f = str(pathlib.Path(midv_dir) / "img" / str(e["file"]).replace("\\", "/").rsplit("/", 1)[-1])
        q = e.get("fixed")
        out.append((f, q, None) if kind == "frames" else (f, None, q) if q else None)
    return [x for x in out if x]


def measure(items):
    """The statistics of each picture (a cut quad: the picture cut flat there first, gen/phone.py warp_rgba)."""
    import cv2
    from . import phone
    out = []
    for f, quad, cut in items:
        img = cv2.imread(str(f))
        if img is None:
            continue
        if cut:
            img = phone.warp_rgba(img, cut)[..., :3]
            if img.shape[0] < 8 or img.shape[1] < 8:
                continue
        out.append(image_stats(img, quad))
    return out


def compare(made, ref):
    """{ks: {stat: distance or None}, auc, n} of the made-up statistics against a reference group's."""
    if not ref:
        return {"ks": {k: None for k in STATS}, "auc": None, "n": 0}
    d = {k: ks([m[k] for m in made], [r[k] for r in ref]) for k in STATS}
    # the classifier's features: the statistics most pictures of both have (a photo with no document has no fill or
    # tilt), on the pictures that have them all
    share = lambda xs, k: sum(x[k] is not None for x in xs) / max(1, len(xs))
    feats = [k for k in STATS if share(made, k) >= 0.8 and share(ref, k) >= 0.8]
    whole = lambda xs: [[x[k] for k in feats] for x in xs if all(x[k] is not None for k in feats)]
    a = logistic_auc(whole(ref), whole(made)) if feats else None
    # the medians tell the side a KS distance lies on (gen tune moves the camera's settings toward the real ones)
    med = {who: {k: median([x[k] for x in xs]) for k in STATS} for who, xs in (("made", made), ("ref", ref))}
    return {"ks": d, "auc": None if a is None else round(a, 4), "n": len(ref), "features": feats, "median": med}


def median(xs):
    """The median of the values that are there (None skipped), rounded; None when none is."""
    v = sorted(float(x) for x in xs if x is not None)
    if not v:
        return None
    m = len(v) // 2
    return round(v[m] if len(v) % 2 else (v[m - 1] + v[m]) / 2, 5)


def realism(folder, run, rows, real_dir=None, midv_dir=None):
    """The realism panel of a set → its dict (also written into run.json "realism"); None for a set of field crops."""
    kind, made = made_items(folder, run, rows)
    if kind is None:
        return None
    m = measure(_sample_items(made))
    groups = {"real": real_items(real_dir, kind), "midv": midv_items(midv_dir, kind)}
    got = {"kind": kind, "made": len(m), "against": {}, "at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
           "realDir": str(real_dir) if real_dir else None}
    for name, items in groups.items():
        c = compare(m, measure(_sample_items(items, seed=f"realism:{name}")))
        got["against"][name] = {**c, "ks": {k: None if v is None else round(v, 4) for k, v in c["ks"].items()}}
    p = folder / manifest.RUN
    info = manifest.read_run(folder) or {}
    info["realism"] = got
    p.write_text(json.dumps(info, indent=1, ensure_ascii=False, default=str), encoding="utf-8")
    return got


def realism_part(rz):
    """The realism panel's section of the sheet."""
    if not rz:
        return ""
    head = "".join(f"<th>{html.escape(n)} (n={g['n']})</th>" for n, g in rz["against"].items())
    body = ""
    for k in STATS:
        cells = "".join('<td class="zero">n/a</td>' if g["ks"].get(k) is None else f'<td class="n">{g["ks"][k]:.3f}</td>'
                        for g in rz["against"].values())
        body += f"<tr><th>KS {html.escape(k)}</th>{cells}</tr>"
    cells = "".join('<td class="zero">n/a</td>' if g.get("auc") is None else f'<td class="n">{g["auc"]:.3f}</td>' for g in rz["against"].values())
    body += f"<tr><th>AUC real vs made-up</th>{cells}</tr>"
    note = ("" if any(g["n"] for g in rz["against"].values()) else
            "<p class='bad'>No real pictures to compare with: python -m gen real (and MIDV: midv.py), then gen qa again.</p>")
    return (f"<h2>Realism</h2><p>{rz['made']} made-up {html.escape(rz['kind'])} measured against real ones: the KS distance of each "
            f"statistic (0 — the same distribution, 1 — apart) and the AUC of a classifier telling real from made-up on them "
            f"(0.5 — it cannot tell; it should fall toward 0.5 run after run).</p>{note}<table><tr><th></th>{head}</tr>{body}</table>")


def page(run, rows, sheets, refs, ver, recipe_sheets=None, extra=""):
    model = run.get("model")
    classes = classes_of(model, rows)
    sources = list(SOURCES.get(model, ())) + sorted({str(r.get("source")) for r in rows} - set(SOURCES.get(model, ())))
    table = _count(rows, stratum)
    head = "".join(f"<th>{html.escape(c)}</th>" for c in classes)
    body = ""
    for s in sources:
        cells = ""
        for c in classes:
            n = table.get(str((s, c)), 0)
            cells += f'<td class="n"><a href="#{_slug(s)}-{_slug(c)}">{n}</a></td>' if n else '<td class="zero">n=0</td>'
        body += f"<tr><th>{html.escape(s)}</th>{cells}</tr>"
    blocks = "".join(f'<section id="{_slug(s)}-{_slug(c)}"><h3>{html.escape(s)} · {html.escape(c)} — {n} examples</h3>'
                     f'<img src="{html.escape(f)}" alt="{html.escape(s)} {html.escape(c)}"></section>'
                     for (s, c), (f, n) in sorted(sheets.items()))
    verdict = "PASSED" if ver.get("passed") else "FAILED"
    lines = [f"intersection with held-out = {len(refs)}",
             f"verify: {ver.get('matched', 0)} of {ver.get('sample', 0)} examples drawn again byte for byte — {verdict}"]
    lines += [f"warning: {w}" for w in ver.get("libraryWarnings") or []]
    counts = run.get("counts") or {}
    return f"""<!doctype html><meta charset="utf-8"><title>Made-up set QA</title>
<style>body{{font:14px system-ui;margin:20px;max-width:1200px}}table{{border-collapse:collapse;margin:8px 0}}td,th{{border:1px solid #ccc;padding:3px 7px}}
.n{{text-align:right}}.zero{{color:#999;text-align:center}}.hist td{{border:none}}.bar{{background:#4a7bd0;height:10px}}.hist td:last-child{{width:420px}}
.ok{{color:#1a7f37}}.bad{{color:#c62828}}img{{max-width:100%;border:1px solid #ddd}}</style>
<h1>Made-up set QA — {html.escape(str(model))} ({html.escape(str(run.get('split')))})</h1>
<p>{counts.get('examples', len(rows))} examples, {counts.get('outputs', 0)} files; seed {html.escape(str((run.get('params') or {}).get('seed')))};
fingerprint {html.escape(str(run.get('fingerprint'))[:12])}; heldout.json {html.escape(str(run.get('heldoutSha256'))[:12])}.</p>
<ul>{''.join(f'<li class="{"ok" if (i == 0 and not refs) or (i == 1 and ver.get("passed")) else "bad" if i < 2 else ""}">{html.escape(t)}</li>' for i, t in enumerate(lines))}</ul>
<h2>Source × class</h2><table><tr><th></th>{head}</tr>{body}</table>
<h2>Histograms</h2>{_bars("by class", _count(rows, lambda r: r.get("class")))}{_bars("by source", _count(rows, lambda r: r.get("source")))}
{_bars("by background category", _count(rows, lambda r: r.get("bgCategory")))}
{recipe_part(model, rows, recipe_sheets or {})}
{extra}
<h2>Contact sheets</h2><p>First corner red, the document's own top-left blue; a field's text only as a sha1 prefix.</p>{blocks}"""


def qa(folder, sample=20, jobs=1, work=None, real=None, midv=None):
    """Write <run>/qa/index.html, its pictures and purity.json → the purity dict. real: gen real's folder (default
    <home>/real), midv: MIDV's (default <home>/midv) — the realism panel's references."""
    import home
    from . import verify as gv
    folder = pathlib.Path(folder)
    base = pathlib.Path(work or home.WORK)
    real = pathlib.Path(real) if real else base / "real"
    midv = pathlib.Path(midv) if midv else base / "midv"
    run, rows = manifest.read_run(folder), manifest.read_manifest(folder)
    if not run or not rows:
        raise SystemExit(f"{folder}: no run.json / manifest.jsonl (drawn before gen build? draw it again)")
    try:
        ver = json.loads((folder / "verify.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        ver = None
    if not ver or ver.get("fingerprint") != run.get("fingerprint"):
        ver = gv.verify(folder, sample, jobs, work)
    refs = manifest.held_refs(rows, work=work)
    out = folder / "qa"
    out.mkdir(exist_ok=True)
    for old in out.glob("sheet-*.jpg"):
        old.unlink()
    groups = {}
    for r in rows:
        groups.setdefault(stratum(r), []).append(r)
    sheets = {}
    for (s, c), rs in groups.items():
        name = f"sheet-{_slug(s)}-{_slug(c)}.jpg"
        contact_sheet(folder, rs, out / name)
        sheets[(s, c)] = (name, len(rs))
    recipe_sheets = {}
    by_recipe = {}
    for r in rows:
        if r.get("recipe"):
            by_recipe.setdefault(str(r["recipe"]), []).append(r)
    for rc, rs in by_recipe.items():
        name = f"sheet-recipe-{_slug(rc)}.jpg"
        contact_sheet(folder, rs, out / name, every=True)
        recipe_sheets[rc] = (name, len(rs))
    rz = realism(folder, run, rows, real, midv)
    (out / "index.html").write_text(page(run, rows, sheets, refs, ver, recipe_sheets, cuts_part(folder, out) + realism_part(rz)),
                                    encoding="utf-8")
    purity = {"passed": bool(not refs and ver.get("passed")), "heldoutIntersection": len(refs),
              "verify": {k: ver.get(k) for k in ("sample", "matched", "passed")}, "fingerprint": run.get("fingerprint"),
              "heldoutSha256": gc.heldout_sha256(), "at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
    (out / "purity.json").write_text(json.dumps(purity, indent=1), encoding="utf-8")
    print(f"QA sheet: {out / 'index.html'} — intersection with held-out = {len(refs)}; verify "
          + ("passed" if ver.get("passed") else "FAILED") + ("" if purity["passed"] else " — NOT PASSED: no training on this set"))
    if rz:
        for name, g in rz["against"].items():
            ksd = ", ".join(f"{k} {v:.3f}" for k, v in g["ks"].items() if v is not None) or "n/a"
            print(f"  realism vs {name} (n={g['n']}): KS {ksd}; AUC {g['auc'] if g['auc'] is not None else 'n/a'}")
    return purity


def require_qa(folder, what, work=None):
    """A training's check on a made-up set: one drawn through gen build (run.json) must have a passed qa/purity.json
    of this very drawing and today's heldout.json, and its manifest must still reference nothing the exam keeps today
    (gen.manifest.held_refs run again now: a site page's side comes from templates/index.json, which can move to the
    exam after the sheet was drawn — SystemExit naming why); a set drawn before gen build only warns."""
    folder = pathlib.Path(folder)
    run = manifest.read_run(folder)
    if run is None:
        print(f"warning: {what} was drawn before gen build (no run.json, no manifest, no QA sheet) — draw it again")
        return None
    try:
        p = json.loads((folder / "qa" / "purity.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        p = None
    why = None
    if p is None:
        why = "it has no QA sheet (qa/purity.json)"
    elif not p.get("passed"):
        why = f"its QA did not pass (intersection with held-out = {p.get('heldoutIntersection')}, verify {'passed' if (p.get('verify') or {}).get('passed') else 'failed'})"
    elif p.get("fingerprint") != run.get("fingerprint"):
        why = "its QA sheet is of another drawing (the set was drawn again since)"
    elif p.get("heldoutSha256") != gc.heldout_sha256():
        why = "heldout.json changed since its QA"
    else:
        refs = manifest.held_refs(manifest.read_manifest(folder), work=work)
        if refs:
            by = {}
            for _, w in refs:
                by[w] = by.get(w, 0) + 1
            why = ("it now references what the exam keeps (a page moved to the exam side since its QA): "
                   + ", ".join(f"{w} {n}" for w, n in sorted(by.items())) + " — draw it again")
    if why:
        raise SystemExit(f"{what}: {why} — run python -m gen qa --run {folder} and look at the sheet before training")
    return p
