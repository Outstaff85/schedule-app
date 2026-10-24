"""Every source the scanner's training draws from, with its side of the split (docs/scan-training.md → "Kept
apart"): the owner's and the site's real pages (templates/), the drawn kinds, the PDFs (Form 101, contracts),
the background photos, the occluders, the fonts, the Hebrew vocabulary, the open sets (MIDV, SmartDoc), and the
real examples pull.py and pull_doctypes.py wrote (records, attempts, page copies) and gen real's index
(real/index.jsonl: kind "real", its rows' own split). pool(split) is the only way to them.

  python -m gen sources            # the counts by kind and side
  python -m gen sources --check    # and fail when an exam or golden key is on the training side, a held-out
                                   # page is in training, a site page has no side, or heldout.json changed
                                   # after the exam sets were made (or an exam set on disk was never recorded)

assert_clean(entries) is what every train*.py calls on its inputs before it trains: it refuses an example of a
held-out template, an exam background, an exam split key or an open set's exam document. Pure: no torch, no
Google package. Prints sha1 prefixes only — never a file name, a name or a number off a document."""
import json
import pathlib
from collections import Counter
from dataclasses import dataclass, field

from . import common as gc

PICTURES = (".jpg", ".jpeg", ".png", ".webp")
FONTS = (".ttf", ".otf")


@dataclass(frozen=True)
class Source:
    id: str
    kind: str          # template-own, template-site, drawn, pdf, background, occluder, font, word, midv, smartdoc, record, attempt, page-copy, real
    split_key: object  # str or None
    split: str         # train, select, exam, golden; "none" (left out of both), "unknown" (a site page with no side)
    sha1: object       # str or None
    path: object       # str or None (local only; never printed)
    attrs: dict = field(default_factory=dict, hash=False, compare=False)


def _work(work):
    if work is not None:
        return pathlib.Path(work)
    import home
    return pathlib.Path(home.WORK)


def _read(p, default):
    try:
        return json.loads(pathlib.Path(p).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _templates(work):
    folder = work / "templates"
    if not folder.is_dir():
        return []
    held, groups, index = gc.held_sha1s(), {t["sha1"]: t.get("group") for t in gc.heldout().get("templates") or []}, gc.template_index(folder)
    held_groups = gc.held_groups()
    out = []
    for p in sorted(folder.rglob("*")):
        if p.suffix.lower() not in PICTURES or not p.is_file():
            continue
        sha = gc.file_sha1(p)
        kind = p.parent.name if p.parent.name in gc.TEMPLATE_KINDS else "insert"
        site = gc.PULLED.fullmatch(p.name) is not None
        attrs = {"doctype": gc.label("template", kind), "folder": kind, "pageIds": sorted(gc.page_ids(p.name)),
                 "crc32Held": gc.crc32_held_out(p)}
        if site:
            info = index.get(f"{p.parent.name}/{p.name}") or {}
            key, split = info.get("key"), info.get("split")
            if split not in gc.TRAIN_SIDE + gc.EXAM_SIDE:
                split = "unknown"   # no side known: in neither set (gen.common.page_side)
        else:
            group = groups.get(sha) or gc.own_group(sha)
            key, split = gc.split_key({"docGroup": group}), "train"
            if group in held_groups:
                split = "exam"
        if sha in held:
            split = "exam"
        out.append(Source("tpl:" + sha[:12], "template-site" if site else "template-own", key, split, sha, str(p), attrs))
    return out


def _drawn():
    return [Source("drawn:" + k, "drawn", None, "train", None, None, {"doctype": gc.label("drawn", k)}) for k in gc.DRAWN_KINDS]


def _pdfs(work):
    out = []
    for folder in (gc.HERE.parents[1] / "functions" / "assets", work / "contracts"):
        if folder.is_dir():
            for p in sorted(folder.glob("*.pdf")):
                sha = gc.file_sha1(p)
                out.append(Source("pdf:" + sha[:12], "pdf", None, "train", sha, str(p), {}))
    return out


def _backgrounds(work):
    """The background photos (backgrounds/, backgrounds-own/), each on the side gen/backgrounds.py's side() reads: exam
    when locked (the catalog's examLocked, heldout.json's examBackgrounds) or split so, train when usable and split so,
    none otherwise (its check failed, no confirmed licence, past the exam's cap, a trained twin of an exam photo, not
    split yet). A folder with a catalog: a photo it does not list is none; with no catalog, train (heldout.json's
    exam ones exam)."""
    from . import backgrounds as gb
    out = []
    for name in ("backgrounds", "backgrounds-own"):
        folder = work / name
        if not folder.is_dir():
            continue
        cat = _read(folder / "catalog.json", None)
        has = isinstance(cat, dict) and isinstance(cat.get("files"), dict)
        files = cat["files"] if has else {}
        locked = gb.locked_of(cat if has else {})
        for p in sorted(folder.rglob("*")):
            if p.suffix.lower() in PICTURES and p.is_file():
                sha = gc.file_sha1(p)
                e = files.get(p.name) if isinstance(files.get(p.name), dict) else None
                if gb.is_locked({"sha1": sha}, p.name, locked):
                    split = "exam"
                elif e is not None:
                    split = gb.side({**e, "sha1": sha}, p.name, locked)
                else:
                    split = "none" if has else "train"
                out.append(Source("bg:" + sha[:12], "background", None, split, sha, str(p),
                                  {"category": (e or {}).get("category"), "series": (e or {}).get("series")}))
    return out


def _occluders(work):
    """The cut-outs (occluders/) on gen/backgrounds.py's occluder_side (by the crc of their sha1)."""
    from . import backgrounds as gb
    cat = _read(work / "occluders" / "catalog.json", None)
    files = cat.get("files") if isinstance(cat, dict) and isinstance(cat.get("files"), dict) else {}
    return [Source("occ:" + str(e.get("sha1"))[:12], "occluder", None, gb.occluder_side(e.get("sha1")), e.get("sha1"),
                   str(work / "occluders" / f), {"category": e.get("category")})
            for f, e in sorted(files.items()) if isinstance(e, dict) and e.get("sha1")]


def _fonts():
    exam = set(gc.heldout().get("examFonts") or [])
    paths = sorted((gc.HERE / "fonts").glob("*")) if (gc.HERE / "fonts").is_dir() else []
    try:
        from synth_lines import hebrew_fonts
        paths += [pathlib.Path(f) for f in hebrew_fonts()]
    except Exception:
        pass
    seen, out = set(), []
    for p in paths:
        if p.suffix.lower() in FONTS and p.name.lower() not in seen:
            seen.add(p.name.lower())
            out.append(Source("font:" + p.name.lower(), "font", None, "exam" if p.name.lower() in {e.lower() for e in exam} else "train",
                              None, str(p), {}))
    return out


def _words():
    import synth
    out = []
    for name in synth.TRAIN:
        for w in synth.vocab(name, False):
            out.append(Source("word:" + gc._hex(w)[:12], "word", None, "train", None, None, {"list": name}))
        for w in synth.vocab(name, True):
            out.append(Source("word:" + gc._hex(w)[:12], "word", None, "exam", None, None, {"list": name}))
    return out


def open_key(e):
    """An open set's example → its document's key (every photo, scan and frame of one document shares it)."""
    import re
    if e.get("midv"):
        import midv
        n = midv.doc_no(e) or "?"
        m = re.search(r"-([a-z]{3}_[a-z]+)-\d{2}(?:-\d+)?$", e.get("id", ""))
        return f"midv:{e.get('source', '').split('/')[0]}:{m.group(1) if m else '?'}:{n}"
    if e.get("smartdoc"):
        m = re.search(r"-([a-z]+\d{3})-", e.get("id", ""))
        return "smartdoc:" + (m.group(1) if m else "?")
    return None


def _open(work):
    import midv
    out = []
    for folder, kind in (("midv", "midv"), ("smartdoc", "smartdoc")):
        for e in _read(work / folder / "examples.json", []):
            out.append(Source(f"{kind}:{e.get('id')}", kind, open_key(e), "exam" if midv.open_exam(e) else "train", None, None,
                              {"doctype": gc.label(kind, e.get("kind") or "")}))
    return out


def _real_split(e):
    if e.get("golden"):
        return "golden"
    if e.get("exam"):
        return "exam"
    s = e.get("split")
    if e.get("hard") or s == "none":
        return "none"   # a retaken page with no fix on the training side, or a record the rule before trained: in neither (pull.py)
    return s if s in gc.TRAIN_SIDE else "train"


def _real(work):
    out = []
    for e in _read(work / "examples.json", []):
        kind = "attempt" if e.get("attempt") else "record"
        out.append(Source(f"{kind}:{e.get('id')}", kind, e.get("key"), _real_split(e), None, None, {"legacy": bool(e.get("legacy"))}))
    for e in _read(work / "doctypes.json", []):
        out.append(Source(f"page-copy:{e.get('id')}", "page-copy", e.get("key"), _real_split(e), None, None,
                          {"legacy": bool(e.get("legacy")), "doctype": e.get("doctype")}))
    # gen real's index: each row with its own split ("none": a key the exam keeps — a self label, a used attempt, a
    # record the rule before trained, a document page whose type giver is not known — so Held keeps its key too)
    try:
        lines = (work / "real" / "index.jsonl").read_text(encoding="utf-8").splitlines()
    except OSError:
        lines = []
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if isinstance(e, dict) and e.get("id") is not None:
            split = e.get("split") if e.get("split") in gc.SPLITS + ("none",) else "unknown"
            out.append(Source(f"real:{e['id']}", "real", e.get("key"), split, None, None,
                              {"legacy": bool(e.get("legacy")), "hard": bool(e.get("hard")), "source": e.get("source")}))
    return out


def _all(work=None):
    work = _work(work)
    return (_templates(work) + _drawn() + _pdfs(work) + _backgrounds(work) + _occluders(work) + _fonts() + _words() + _open(work)
            + _real(work))


def pool(split, kind=None, work=None):
    """The sources on one side (train, select, exam, golden; or a tuple of them), of one kind or every kind."""
    sides = (split,) if isinstance(split, str) else tuple(split)
    return [s for s in _all(work) if s.split in sides and (kind is None or s.kind == kind)]


# ---------- what must never reach training ----------
class Held:
    """What the exam keeps: the held-out templates' sha1s and page ids (and, failing closed, the site pages with no
    known side), the exam backgrounds, the exam occluders, the exam split keys."""

    def __init__(self, work=None):
        every = _all(work)
        exam = [s for s in every if s.split in gc.EXAM_SIDE]
        tpl = [s for s in exam if s.kind.startswith("template")] + [s for s in every if s.kind == "template-site" and s.split == "unknown"]
        self.sha1s = set(gc.held_sha1s()) | {s.sha1 for s in tpl}
        self.page_ids = {i for s in tpl for i in s.attrs.get("pageIds", [])}
        bgs = set(gc.heldout().get("examBackgrounds") or [])
        self.backgrounds = bgs | {s.sha1 for s in exam if s.kind == "background"} | {s.sha1[:12] for s in exam if s.kind == "background"}
        self.occluders = {s.sha1 for s in exam if s.kind == "occluder"} | {s.sha1[:12] for s in exam if s.kind == "occluder"}
        self.keys = {s.split_key for s in exam if s.split_key} | {
            s.split_key for s in every if s.kind == "real" and s.split == "none" and s.split_key}


NO_META = object()   # problems(): no Hebrew set to check (None: a set with no sources.json)


def problems(entries=(), meta=NO_META, held=None, work=None):
    """What in a training set's entries (examples.json / pages.json rows) or its sources.json (meta: the Hebrew
    sets; None when the set has none) belongs to the exam: [(what, count)] — [] when clean."""
    import midv
    held = held or Held(work)
    c = Counter()
    for e in entries:
        t = e.get("templateSha1")
        if any(x in held.sha1s for x in [t] + list(e.get("templates") or []) if x):
            c["pages of a held-out template"] += 1
        elif not t and e.get("template") in held.page_ids:
            c["pages of a held-out template (by its page id)"] += 1
        elif not t and e.get("source") == "template":
            c["real-page entries with no template id (made before heldout.json: draw the set again)"] += 1
        bg = e.get("bg")
        if bg and (bg in held.backgrounds or bg[:12] in held.backgrounds):
            c["photos on an exam background"] += 1
        if any(o in getattr(held, "occluders", ()) for o in e.get("occ") or []):
            c["photos with an exam occluder"] += 1
        if not e.get("exam") and e.get("key") and e["key"] in held.keys:
            c["examples whose split key is the exam's"] += 1
        if not e.get("exam") and e.get("split") == "none":
            c["examples left out of both sides"] += 1
        if (e.get("midv") or e.get("smartdoc")) and midv.open_exam(e):
            c["open-set exam documents"] += 1
        o = e.get("open")
        if isinstance(o, dict) and midv.open_exam(o):
            c["pages cut from an open-set exam document"] += 1
    if meta is not NO_META:
        if not isinstance(meta, dict):
            c["a set with no sources.json (made before heldout.json: draw it again)"] += 1
        else:
            bad = [t for t in meta.get("templates") or [] if t in held.sha1s]
            if bad:
                c["held-out templates in the set"] += len(bad)
            if meta.get("vocabulary") != "train" or meta.get("split") not in (None, "train"):
                c["a set drawn with the check vocabulary or as the check"] += 1
    return sorted(c.items())


def assert_clean(entries=(), what="the training set", meta=(), work=None):
    """Refuse to train on anything the exam keeps (SystemExit naming what and how many). meta: a list of
    (set name, sources.json dict or None) of the Hebrew sets."""
    held = Held(work)
    found = list(problems(entries, NO_META, held))
    for name, m in meta or ():
        found += [(f"{name}: {k}", n) for k, n in problems((), m, held)]
    if found:
        raise SystemExit(f"{what} holds what the exam keeps — not training: " + "; ".join(f"{k}: {n}" for k, n in found)
                         + " (docs/scan-training.md → Kept apart)")


def read_meta(folder):
    """A made-up set's sources.json (synth_fields.py, synth_lines.py), None when it has none."""
    got = _read(pathlib.Path(folder) / "sources.json", None)
    return got if isinstance(got, dict) else None


def assert_check_set(folder, what):
    """Refuse a check set (synth_fields.py --check) that is not the held-out one: its sources.json must name the check
    split and vocabulary, today's heldout.json (its sha256) and only pages heldout.json keeps — a set drawn before had
    no sources.json, came from the training pages with the full vocabulary, and the reader would be measured on what
    it trains on (SystemExit naming why)."""
    m = read_meta(folder)
    why = []
    if m is None:
        why.append("it has no sources.json (drawn before heldout.json)")
    else:
        if m.get("split") != "check" or m.get("vocabulary") != "check":
            why.append("it was not drawn as the check (split and vocabulary)")
        if m.get("heldout_sha256") != gc.heldout_sha256():
            why.append("it was drawn with another heldout.json")
        held = gc.held_sha1s()
        if not m.get("templates") or any(t not in held for t in m.get("templates") or []):
            why.append("it holds pages heldout.json does not keep for the exam")
    if why:
        raise SystemExit(f"{what} is not the held-out check set: " + "; ".join(why)
                         + " — run synth_fields.py --count 300 --check again (docs/scan-training.md → Kept apart)")


# ---------- gen sources [--check] ----------
def report(work=None):
    """(lines to print, problems) of the registry."""
    work = _work(work)
    every = _all(work)
    lines, bad = [], []
    table = Counter((s.kind, s.split) for s in every)
    kinds = sorted({k for k, _ in table})
    splits = [s for s in gc.SPLITS + ("none", "unknown") if any(table.get((k, s)) for k in kinds)]
    lines.append("sources by kind and side:")
    lines.append("  " + "kind".ljust(14) + "".join(s.rjust(9) for s in splits))
    for k in kinds:
        lines.append("  " + k.ljust(14) + "".join(str(table.get((k, s), 0)).rjust(9) for s in splits))
    # exam / golden keys on the training side
    exam_keys = {s.split_key for s in every if s.split in gc.EXAM_SIDE and s.split_key}
    train_keys = {s.split_key for s in every if s.split in gc.TRAIN_SIDE and s.split_key}
    crossed = exam_keys & train_keys
    lines.append(f"exam keys in train: {len(crossed)}")
    if crossed:
        bad.append(f"{len(crossed)} exam or golden keys are on the training side: " + ", ".join(sorted(k[:10] for k in crossed)[:10]))
    # the same content on both sides
    exam_sha = {s.sha1 for s in every if s.split in gc.EXAM_SIDE and s.sha1}
    both = {s.sha1 for s in every if s.split in gc.TRAIN_SIDE and s.sha1} & exam_sha
    lines.append(f"held-out content in train: {len(both)}")
    if both:
        bad.append(f"{len(both)} files are on both sides: " + ", ".join(sorted(x[:8] for x in both)))
    # the held-out pages against the crc32 rule
    tpl = [s for s in every if s.kind.startswith("template")]
    held_pages = [s for s in tpl if s.split in gc.EXAM_SIDE]
    held = {s.sha1 for s in held_pages}
    crc = {s.sha1 for s in tpl if s.attrs.get("crc32Held")}
    listed = gc.held_sha1s()
    if tpl:
        same = "same as the crc32 rule" if held == crc else f"the crc32 rule would hold {len(crc)} ({len(held & crc)} of them these)"
        lines.append(f"held-out pages: {len(held_pages)} ({same})")
        lines.append("  " + ", ".join(sorted(x[:8] for x in held)))
    else:
        lines.append("held-out pages: none here (no templates folder)")
    missing = listed - {s.sha1 for s in tpl}
    if missing and tpl:
        lines.append(f"heldout.json pages not in this templates folder: {len(missing)}")
    unknown = [s for s in tpl if s.split == "unknown"]
    if unknown:
        bad.append(f"{len(unknown)} site pages have no side (copied before templates/index.json): run pull_templates.py again")
    legacy = sum(1 for s in every if s.attrs.get("legacy"))
    if legacy:
        lines.append(f"real examples with no worker, session or group (split by their id as before): {legacy}")
    stale = gc.stale_exam_sets(work)
    lines.append(f"exam sets made with another heldout.json or not recorded: {len(stale)}" + (f" ({', '.join(stale)})" if stale else ""))
    if stale:
        bad.append("exam sets made with another heldout.json or before exam_sets.json recorded them: " + ", ".join(stale)
                   + " — run synth_docs.py --templates --exam and synth_fields.py --check again")
    return lines, bad
