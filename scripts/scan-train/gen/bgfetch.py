"""python -m gen bg fetch — more background photos for the categories the bank is short of (docs/scan-training.md →
"The automatic cycle" → "The generator tunes itself").

  python -m gen bg fetch [--limit 40]

- What is short: each category of the bank (gen/backgrounds.py CATEGORY_WORDS — QUERIES here, the words searched)
  against TARGET usable photos (checked ok, licence confirmed, on either bank: the downloads and the owner's shots);
  the most short first.
- Where from: Openverse's public API (api.openverse.org, no key) — only CC0 and public domain (license=cc0,pdm), never
  marked mature, at least gen/backgrounds.py's MIN_SIDE (1600 px) on the long side; a photo longer than MAX_SIDE is
  stored shrunk to it (JPEG). At most `--limit` photos a run (PER_RUN), a pause of PAUSE seconds before every request,
  a User-Agent naming the project. Each query's next page is remembered, so the next run goes on where this one stopped.
- Where to: <home>/gen/bg-fetch/<category>/ while downloading (with its sources.json), then catalogued into
  <home>/backgrounds by gb.add with its category, licence, url, title and query — the same entry in
  <home>/backgrounds/sources.json, so a fresh PC's `bg pull` of the pushed bank catalogues them the same way — and the
  bank made ready (gb.prepare: catalog, check — the lab's edges models reject anything document-like —, split).
  <home>/gen/bg-fetch.json keeps every photo fetched and whether it was pushed: `bg push` marks them; `bg pull`
  merges the fetched ones' sources entries back first (reapply) so a pulled sources.json never drops them.
- It never pushes to the bucket — the owner looks at the bank and runs `python -m gen bg push`; the note says how many
  photos wait for that. A category no free source fills any more (every query run out) is a need for the owner: their
  own shots (gen/needs.py → the report's needsOwner).
- No network: exit 0 with a note, nothing changed."""
import datetime
import hashlib
import io
import json
import pathlib
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request

from . import backgrounds as gb
from . import capture as gcap
from . import needs as gneeds

API = "https://api.openverse.org/v1/images/"
USER_AGENT = "OutStaff-scan-train/1.0 (background photos for a document scanner's training; CC0 and public domain only)"
LICENCES = ("cc0", "pdm")
TARGET = 25          # usable photos wanted per category
PER_RUN = 40         # photos fetched a run at most
PAUSE = 2.0          # seconds before each request (the API's and each photo's)
PAGE_SIZE = 20
MAX_PAGE = 12        # a query's last page (anonymous Openverse serves the first ~240 results)
MAX_BYTES = 30 << 20
MAX_SIDE = 3200      # a photo stored at most this long (JPEG 92)
STATE = "bg-fetch.json"
# category → its search words (each maps back to its category by gb.auto_category: the tests hold it)
QUERIES = {
    "car": ("car seat upholstery", "car dashboard"),
    "desk": ("office desk top", "desk surface"),
    "bed-sofa": ("sofa cushion fabric", "bedding texture"),
    "tablecloth": ("tablecloth pattern", "checked tablecloth"),
    "rug": ("rug texture", "carpet texture"),
    "glass": ("glass table top", "frosted glass texture"),
    "light": ("white table surface", "pale wood surface"),
    "dark": ("black table surface", "dark leather texture"),
    "stone": ("granite countertop", "marble texture", "concrete floor texture"),
    "tile": ("tile floor", "ceramic tile texture"),
    "wood": ("wood table top", "oak wood texture", "parquet floor"),
    "fabric": ("linen fabric texture", "denim texture", "wool blanket texture"),
}


class Offline(Exception):
    """The API cannot be reached: the run stops with a note, nothing harmful done."""


def http_get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:   # noqa: S310 — https only, our own constant and Openverse's
        data = r.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("too large")
    return data


def _work(work):
    import home
    return pathlib.Path(work or home.WORK)


def load_state(work=None):
    got = gcap.read(gcap.gen_dir(work) / STATE) or {}
    return {"version": 1, "photos": list(got.get("photos") or []), "pages": dict(got.get("pages") or {}),
            "exhausted": list(got.get("exhausted") or [])}


def save_state(work, st):
    gcap.write(gcap.gen_dir(work) / STATE, st)


def waiting(work=None):
    """Fetched photos still on this PC and not pushed to the bucket yet."""
    w = _work(work)
    return sum(1 for p in load_state(work)["photos"] if not p.get("pushed") and (w / "backgrounds" / p["file"]).exists())


def mark_pushed(work=None):
    """After `bg push`: every fetched photo is in the bucket."""
    st = load_state(work)
    if any(not p.get("pushed") for p in st["photos"]):
        for p in st["photos"]:
            p["pushed"] = True
        save_state(work, st)


def usable_by_category(work=None):
    out = {}
    for name in ("backgrounds", "backgrounds-own"):
        for e in gb.load(work, name)["files"].values():
            if gb.usable(e) or (e.get("status") == "new" and gb.confirmed(e)):   # new: not checked yet, counted as coming
                c = e.get("category") or "uncategorised"
                out[c] = out.get(c, 0) + 1
    return out


def shortfall(work=None, target=TARGET):
    have = usable_by_category(work)
    short = {c: target - have.get(c, 0) for c in QUERIES if have.get(c, 0) < target}
    return dict(sorted(short.items(), key=lambda kv: (-kv[1], kv[0])))


def _sources_merge(folder, entries):
    """Entries ({file, …}) merged into folder/sources.json (a list, or the dict form kept as it is)."""
    p = pathlib.Path(folder) / "sources.json"
    try:
        got = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        got = []
    if isinstance(got, dict):
        for e in entries:
            got[e["file"]] = {k: v for k, v in e.items() if k != "file"}
    else:
        got = [x for x in got if not (isinstance(x, dict) and x.get("file") in {e["file"] for e in entries})] + list(entries)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(got, indent=1, ensure_ascii=False), encoding="utf-8")


def _entry(p):
    return {"file": p["file"], "query": p.get("query"), "license": p.get("licence"), "source": p.get("url"),
            "title": p.get("title"), "category": p.get("category"), "openverse": p.get("id")}


def reapply(work=None):
    """The fetched photos' entries merged back into <home>/backgrounds/sources.json (a `bg pull` may have brought the
    bucket's older one) → how many."""
    w = _work(work)
    here = [p for p in load_state(work)["photos"] if (w / "backgrounds" / p["file"]).exists()]
    if here:
        _sources_merge(w / "backgrounds", [_entry(p) for p in here])
    return len(here)


def _staging(work):
    return gcap.gen_dir(work) / "bg-fetch"


def _store(data):
    """The downloaded bytes → (JPEG bytes, (w, h)) at most MAX_SIDE long, or None when not a picture or too small."""
    from PIL import Image
    try:
        with Image.open(io.BytesIO(data)) as im:
            im = im.convert("RGB")
            w, h = im.size
            if max(w, h) < gb.MIN_SIDE:
                return None
            if max(w, h) > MAX_SIDE:
                k = MAX_SIDE / max(w, h)
                im = im.resize((round(w * k), round(h * k)), Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=92)
            return buf.getvalue(), im.size
    except Exception:
        return None


def flush(work=None, now=None):
    """The staging folders (this run's, or one a stop left) → catalogued into the bank → photos added."""
    w = _work(work)
    root = _staging(work)
    if not root.is_dir():
        return 0
    st = load_state(work)
    added = 0
    for d in sorted(x for x in root.iterdir() if x.is_dir()):
        src = gb.read_sources(d)
        if not src:
            shutil.rmtree(d, ignore_errors=True)
            continue
        gb.add(d, d.name, work=w)   # its category given: a title's words never move it
        cat = gb.load(w, "backgrounds")["files"]
        by_sha = {e.get("sha1"): f for f, e in cat.items()}
        entries = []
        for name, info in src.items():
            f = d / name
            if not f.exists():
                continue
            sha = hashlib.sha1(f.read_bytes()).hexdigest()
            final = by_sha.get(sha)
            if not final:
                continue
            rec = {"file": final, "sha1": sha, "category": d.name, "licence": info.get("license"), "url": info.get("source"),
                   "title": info.get("title"), "query": info.get("query"), "id": info.get("openverse"),
                   "at": (now or datetime.datetime.now(datetime.timezone.utc)).isoformat(timespec="seconds"), "pushed": False}
            st["photos"] = [p for p in st["photos"] if p.get("sha1") != sha] + [rec]
            entries.append(_entry(rec))
            added += 1
        if entries:
            _sources_merge(w / "backgrounds", entries)
        save_state(work, st)
        shutil.rmtree(d, ignore_errors=True)
    if not any(root.iterdir()):
        root.rmdir()
    return added


def fetch(work=None, limit=PER_RUN, http=None, sleep=None, prepare=None, now=None):
    """One run → its summary {"fetched": {category: n}, "waiting", "offline", "short"}."""
    http, sleep = http or http_get, sleep or time.sleep
    w = _work(work)
    flush(work, now)   # what a stopped run left
    short = shortfall(work)
    st = load_state(work)
    known = {str(p.get("id")) for p in st["photos"]} | {p.get("sha1") for p in st["photos"]}
    for name in ("backgrounds", "backgrounds-own"):
        known |= {e.get("sha1") for e in gb.load(w, name)["files"].values()}
    fetched, offline, notes = {}, False, []
    left = int(limit)

    def get(url):
        sleep(PAUSE)
        return http(url)
    try:
        for cat, need in short.items():
            if left <= 0:
                break
            want = min(need, left)
            d = _staging(work) / cat
            for q in QUERIES[cat]:
                if want <= 0 or left <= 0:
                    break
                if q in st["exhausted"]:
                    continue
                page = int(st["pages"].get(q, 1))
                while want > 0 and left > 0:
                    if page > MAX_PAGE:
                        st["exhausted"].append(q)
                        break
                    url = API + "?" + urllib.parse.urlencode({"q": q, "license": ",".join(LICENCES), "page_size": PAGE_SIZE,
                                                              "page": page, "mature": "false", "size": "large"})
                    try:
                        data = json.loads(get(url).decode("utf-8"))
                    except (urllib.error.URLError, OSError, TimeoutError) as e:
                        raise Offline(str(type(e).__name__)) from e
                    except ValueError:
                        data = {}
                    results = data.get("results") or []
                    page += 1
                    st["pages"][q] = page
                    if not results:
                        st["exhausted"].append(q)
                        break
                    for r in results:
                        if want <= 0 or left <= 0:
                            st["pages"][q] = page - 1   # the page's rest not looked at: this page again next run
                            break
                        rid, lic = str(r.get("id") or ""), str(r.get("license") or "").lower()
                        if not rid or rid in known or lic not in LICENCES or r.get("mature"):
                            continue
                        dims = [v for v in (r.get("width"), r.get("height")) if isinstance(v, int)]
                        if dims and max(dims) < gb.MIN_SIDE:
                            continue
                        src = str(r.get("url") or "")
                        if not src.startswith("https://"):
                            continue
                        known.add(rid)
                        try:
                            img = _store(get(src))
                        except (urllib.error.URLError, OSError, TimeoutError, ValueError):
                            continue   # one photo that would not come: the next
                        if img is None:
                            continue
                        sha = hashlib.sha1(img[0]).hexdigest()
                        if sha in known:
                            continue
                        known.add(sha)
                        d.mkdir(parents=True, exist_ok=True)
                        name = f"ov-{hashlib.sha1(rid.encode('utf-8')).hexdigest()[:12]}.jpg"
                        (d / name).write_bytes(img[0])
                        _sources_merge(d, [{"file": name, "query": q, "license": lic, "source": r.get("foreign_landing_url") or src,
                                            "title": str(r.get("title") or q)[:120], "category": cat, "openverse": rid}])
                        fetched[cat] = fetched.get(cat, 0) + 1
                        want -= 1
                        left -= 1
                    save_state(work, st)
            save_state(work, st)
    except Offline as e:
        offline = True
        notes.append(f"no network ({e}): nothing more fetched this run")
    save_state(work, st)
    added = flush(work, now)
    if added or any(any(gb.pending(w, n).values()) for n in ("backgrounds", "backgrounds-own")):
        (prepare or gb.prepare)(w)
    st = load_state(work)
    for cat, need in shortfall(work).items():
        if all(q in st["exhausted"] for q in QUERIES[cat]):
            gneeds.need(work, f"photos:{cat}", f"background photos of {cat}: {need} more wanted and no free source gives any "
                        f"more — the owner's own shots (python -m gen bg add DIR --owner --category {cat})", "bg-fetch", now)
        else:
            gneeds.resolve(work, f"photos:{cat}")
    for cat in QUERIES:
        if cat not in shortfall(work):
            gneeds.resolve(work, f"photos:{cat}")
    n_wait = waiting(work)
    if fetched:
        notes.insert(0, f"{sum(fetched.values())} background photos fetched (" + ", ".join(f"{c} {n}" for c, n in fetched.items())
                     + ")")
    elif not short:
        notes.insert(0, f"every category has its {TARGET} photos: nothing fetched")
    elif not offline:
        notes.insert(0, "no new free photo found for the short categories: " + ", ".join(short))
    if n_wait:
        notes.append(f"{n_wait} fetched photos wait to be pushed to the bucket (the owner's step: python -m gen bg push)")
    gneeds.note(work, "bg-fetch", notes, now)
    return {"fetched": fetched, "waiting": n_wait, "offline": offline, "short": shortfall(work)}
