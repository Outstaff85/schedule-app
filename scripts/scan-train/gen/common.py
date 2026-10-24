"""What keeps the exam apart from training, in one place (docs/scan-training.md → "Kept apart"), and the one
class table of the document type model. Pure: no torch, no Google or Hugging Face package (the tests in CI
import it).

- split_key(rec): which real data belong together — a hash of the worker's id, else the scan session's,
  else the retake group's, else the document group's. Never a record's or a page's id: one worker's pages,
  one scan's page copies and its full document, the retakes of one shot all land on one side.
- split_of(key): train / select / exam by fixed remainders of the key's hash. golden is never a hash's
  answer: it is given (attempts/golden/, or a flag).
- side(rec, ..., exam_keys): every pull's one decision — the keys of the attempts kept as the exam before are the
  exam whatever their hash (pull.kept_exam_keys), and a record the rule before (its id) put on the training side,
  kept before KEY_RULE_FROM, never enters the exam (in neither set: a published version learned it).
- heldout.json (committed, beside this package): the owner's real pages kept for the exam by their content
  sha1 and document group, the exam backgrounds and fonts, the vocabulary salt, and the open sets' exam
  documents. A renamed file moves nothing.
- DOCTYPES and LABELS: the page kinds and every source's label for them (owner, 2026-10-24: licences
  stay "other")."""
import datetime
import hashlib
import json
import pathlib
import re
import zlib

HERE = pathlib.Path(__file__).resolve().parents[1]      # scripts/scan-train
HELDOUT = HERE / "heldout.json"

# ---------- the page kinds (the document type model's 6 answers, in its output order) ----------
DOCTYPES = ("id_front", "id_back", "sefach", "passport", "contract", "other")
# a real page's template folder (pull_templates.py, synth_docs.TEMPLATE_KINDS)
TEMPLATE_KINDS = ("id_front", "id_back", "passport", "sefach", "insert", "licence")
# the documents synth_docs.py / synth_pages.py draw from nothing
DRAWN_KINDS = ("id_front", "id_back", "passport", "sefach", "insert", "contract")
# Every source's own kind → the page kind it teaches. The wording of Haiku's prompt for contract / other is
# not changed here (the training audit: deferred); SmartDoc's printed pages stay "other" as before.
LABELS = {
    "template": {"id_front": "id_front", "id_back": "id_back", "passport": "passport", "sefach": "sefach",
                 "insert": "other", "licence": "other"},
    "drawn": {"id_front": "id_front", "id_back": "id_back", "passport": "passport", "sefach": "sefach",
              "insert": "other", "contract": "contract"},
    "smartdoc": {"datasheet": "other", "letter": "other", "magazine": "other", "paper": "other", "patent": "other",
                 "tax": "other"},
    "midv": {"id": "id_front", "passportcard": "id_front", "passport": "passport", "drvlic": "other"},
}


def midv_kind(path):
    """A MIDV document's own kind by its folder name (alb_id, 05_aze_passport, 48_usa_passportcard, 21_esp_drvlic…)."""
    s = str(path).lower()
    if "drvlic" in s or "driving" in s:
        return "drvlic"
    if "passportcard" in s:
        return "passportcard"
    return "passport" if "passport" in s else "id"


def label(source, kind):
    """The page kind (DOCTYPES) a source's own kind teaches: label("midv", "alb_id/00.jpg") → "id_front";
    label("template", "licence") → "other"; an unknown kind → "other"."""
    if source == "midv":
        kind = midv_kind(kind)
    return LABELS.get(source, {}).get(kind, "other")


# ---------- the split ----------
SPLIT_EVERY = 7                 # the key's hash % 7: 0 the exam, 1 the select set, the rest training
EXAM_REM, SELECT_REM = (0,), (1,)
SPLITS = ("train", "select", "exam", "golden")
TRAIN_SIDE, EXAM_SIDE = ("train", "select"), ("exam", "golden")


def _hex(s):
    return hashlib.sha1(s.encode("utf-8")).hexdigest()


def _str(v):
    return str(v) if isinstance(v, (str, int)) and not isinstance(v, bool) and str(v) else None


def split_key(rec, links=None):
    """The key real data are split by: "w:" + a hash of the worker's id, else "s:" the scan session's, else "g:"
    the retake group's, else "d:" the document group's — None when the record has none of them. links: {session
    id: worker id} (session_links), so a page copy sent before the worker was saved goes with its document."""
    rec = rec or {}
    w, s = _str(rec.get("workerId")), _str(rec.get("sessionId"))
    if not w and s and links:
        w = _str(links.get(s))
    if w:
        return "w:" + _hex("worker:" + w)[:20]
    if s:
        return "s:" + _hex("session:" + s)[:20]
    g = _str(rec.get("group") or rec.get("retakeGroup"))
    if g:
        return "g:" + _hex("group:" + g)[:20]
    d = _str(rec.get("docGroup"))
    if d:
        return "d:" + _hex("doc:" + d)[:20]
    return None


def split_of(key):
    """train / select / exam of a split key, by fixed remainders of its hash (never golden)."""
    r = int(_hex("split:" + key)[:12], 16) % SPLIT_EVERY
    return "exam" if r in EXAM_REM else "select" if r in SELECT_REM else "train"


def legacy_split(record_id):
    """A record kept before the workers' and sessions' ids were (no key at all): the rule before, about one in
    seven by its id, so the exam figures of the runs before stay comparable. Only for such records."""
    return "exam" if int(_hex(record_id), 16) % SPLIT_EVERY == 0 else "train"


def session_links(recs):
    """{session id: worker id} from the records and documents that carry both."""
    out = {}
    for r in recs:
        if isinstance(r, dict) and _str(r.get("sessionId")) and _str(r.get("workerId")):
            out[str(r["sessionId"])] = str(r["workerId"])
    return out


# The key rule's first day (Training 3): a record or page copy kept before it was split by its own id (legacy_split),
# and the published versions the trainings fine-tune from (the lab's v5) learned the ones that rule put on the
# training side. Such a record never enters the exam: when its key says exam it is in neither set ("none"). A
# version trained with the old per-id rule after this day would move it forward.
KEY_RULE_FROM = "2026-11-01"


def _day(v):
    """A record's createdAt as "YYYY-MM-DD" (a Firestore datetime, or the bucket's str of one); None when it has none."""
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.isoformat()[:10]
    if isinstance(v, str) and re.match(r"\d{4}-\d{2}-\d{2}", v):
        return v[:10]
    return None


def learned_before(rec, rid):
    """Was this record (or page copy) on the training side of the rule before the key, kept before KEY_RULE_FROM (or
    with no date: counted as before) — so a published version may have learned it?"""
    if not rid:
        return False
    day = _day((rec or {}).get("createdAt"))
    return (day is None or day < KEY_RULE_FROM) and legacy_split(rid) == "train"


def side(rec, links=None, rid=None, golden=False, exam_keys=frozenset()):
    """→ (key, split, legacy): golden when given; else the exam when the key is one of exam_keys (the keys of the
    attempts kept as the exam before: pull.kept_exam_keys), else the split of the record's key; a record with no key
    at all is split by its id the old way (legacy True; rid None: training). A record whose key says exam but that the
    rule before put on the training side (learned_before) is "none" — in neither set."""
    key = split_key(rec, links)
    if golden:
        return key, "golden", False
    if key:
        split = "exam" if key in exam_keys else split_of(key)
        if split == "exam" and learned_before(rec, rid):
            split = "none"
        return key, split, False
    return None, legacy_split(rid) if rid else "train", True


def trains(e):
    """Does a pulled example (examples.json, doctypes.json) go to training? Not the exam's, not one left out of both."""
    return not e.get("exam") and not e.get("hard") and e.get("split") != "none"


# ---------- heldout.json ----------
_cache = {}


def _cached(path, read):
    p = pathlib.Path(path)
    try:
        st = p.stat()
    except OSError:
        return None
    k = (str(p.resolve()), st.st_size, st.st_mtime_ns, read.__name__)
    if k not in _cache:
        _cache[k] = read(p)
    return _cache[k]


def _read_json(p):
    return json.loads(p.read_text(encoding="utf-8"))


def _sha1_file(p):
    h = hashlib.sha1()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def file_sha1(path):
    """A file's content sha1 (hex); None when it is not there."""
    return _cached(path, _sha1_file)


def heldout(path=None):
    """heldout.json as a dict."""
    got = _cached(path or HELDOUT, _read_json)
    if got is None:
        raise SystemExit(f"{path or HELDOUT} is missing — it is committed with the scripts")
    return got


HELD_KEYS = ("templates", "examBackgrounds", "examFonts", "vocabulary", "open")   # what heldout.json keeps from training


def heldout_sha256(path=None):
    """The identity of what heldout.json keeps (its HELD_KEYS, canonical JSON) — not its notes or its "versions" list,
    so marking a published version moves nothing: the exam sets, the made-up sets' QA and the checkpoints' data
    fingerprints change only when what is held out changes."""
    h = heldout(path)
    return hashlib.sha256(json.dumps({k: h.get(k) for k in HELD_KEYS}, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":")).encode("utf-8")).hexdigest()


def dirty_versions(model, path=None):
    """The published versions whose `model` may have seen what the exam keeps (heldout.json "versions": heldout_clean
    false) — a versions entry with no "models" covers every model."""
    v = heldout(path).get("versions") or {}
    return frozenset(name for name, e in v.items() if isinstance(e, dict) and e.get("heldout_clean") is False
                     and (not e.get("models") or model in e["models"]))


def _dump_heldout(h):
    """heldout.json in its own layout: one key per line, a list's items and the versions one per line (compact)."""
    def one(x):
        return json.dumps(x, ensure_ascii=False)
    parts = []
    for k, v in h.items():
        if isinstance(v, list) and v:
            body = "[\n" + ",\n".join("  " + one(x) for x in v) + "\n ]"
        elif k == "versions" and isinstance(v, dict) and v:
            body = "{\n" + ",\n".join(f"  {one(n)}: {one(e)}" for n, e in v.items()) + "\n }"
        else:
            body = one(v)
        parts.append(f" {one(k)}: {body}")
    return "{\n" + ",\n".join(parts) + "\n}\n"


def mark_version(version, models, why, path=None):
    """publish.py: a new version whose models may have seen what the exam keeps (one carried over from a version
    marked so, or trained from one) is added to heldout.json "versions" (heldout_clean false, those models, why) —
    so a version descended from v3/v4/v5 is never reported clean. heldout_sha256 ignores "versions": nothing goes
    stale. The file is committed with the scripts (the skill commits it with models-version)."""
    p = pathlib.Path(path or HELDOUT)
    h = json.loads(p.read_text(encoding="utf-8"))
    v = h.setdefault("versions", {})
    v[version] = {"heldout_clean": False, "models": sorted(models), "why": why}
    p.write_text(_dump_heldout(h), encoding="utf-8", newline="\n")


def contaminated(chain, model, path=None):
    """The versions of a model's base chain (the lab's version, the one it was trained from…) that are not held-out
    clean: the exam's templates set is "contaminated" for it (exam.py; never a gate alone)."""
    dirty = dirty_versions(model, path)
    return sorted({c for c in chain if c} & dirty)


def held_sha1s(path=None):
    """The content sha1s of the owner's real pages kept for the exam."""
    return frozenset(t["sha1"] for t in heldout(path).get("templates") or [])


def held_groups(path=None):
    return frozenset(t["group"] for t in heldout(path).get("templates") or [] if t.get("group"))


def own_group(sha1):
    """The document group of an owner's page heldout.json does not name: the page alone."""
    return "own:" + sha1[:12]


def page_ids(name):
    """The short ids synth_docs.page_id gives a real page by its file name (one per template kind it can be laid
    as): how the photos made before templateSha1 name their page."""
    return {_hex(f"{k}/{name}")[:10] for k in TEMPLATE_KINDS}


# A site page pulled_templates.py copied: <the document's id (20 letters and digits)>-<n>.jpg
PULLED = re.compile(r"([A-Za-z0-9]{20})-\d+\.jpg")


def template_index(folder):
    """templates/index.json (pull_templates.py): {"<kind>/<file>": {"key", "split"}} of the site pages."""
    got = _cached(pathlib.Path(folder) / "index.json", _read_json)
    return got if isinstance(got, dict) else {}


def page_side(path):
    """A real page's side: "exam" — by its content (heldout.json), or a site page whose document is on the exam side
    (templates/index.json); "unknown" — a site page (PULLED) index.json gives no training side (pulled before it, its
    record unreadable, or index.json missing); "train" — the rest. None when the file is not there."""
    p = pathlib.Path(path)
    sha = file_sha1(p)
    if sha is None:
        return None
    if sha in held_sha1s():
        return "exam"
    if PULLED.fullmatch(p.name):
        info = template_index(p.parent.parent).get(f"{p.parent.name}/{p.name}") or {}
        s = info.get("split")
        return s if s in TRAIN_SIDE else "exam" if s in EXAM_SIDE else "unknown"
    return "train"


def held_out_page(path):
    """Is this real page never laid on a training photo? The exam's pages, and — failing closed — a site page with no
    known training side (page_side "unknown")."""
    return page_side(path) in ("exam", "unknown")


def exam_page(path):
    """Is this real page laid on the exam photos (synth_docs.py --exam, synth_fields.py --check)? The exam's only — a
    site page with no known side is in neither."""
    return page_side(path) == "exam"


def crc32_held_out(path):
    """The rule before heldout.json (about one page in six by its kind folder and file name). Kept only to show
    that heldout.json holds the same pages; a renamed file would move under it."""
    p = pathlib.Path(path)
    return zlib.crc32(f"exam:0{p.parent.name}/{p.name}".encode("utf-8")) % 6 == 0


def vocab_held(word):
    """Is this word in the check vocabulary (never in training)? crc32(salt + word) % every == 0."""
    v = heldout().get("vocabulary") or {}
    return zlib.crc32((v.get("salt", "") + word).encode("utf-8")) % int(v.get("every", 5)) == 0


# ---------- the exam sets made from heldout.json ----------
def exam_sets_path(work=None):
    import home
    return pathlib.Path(work or home.WORK) / "exam_sets.json"


def record_exam_set(name, file, work=None):
    """An exam set was made (synth_docs.py --exam, synth_fields.py --check): its file's sha256 and the
    heldout.json it was made with, in exam_sets.json — `gen sources --check` fails once heldout.json changes."""
    p = exam_sets_path(work)
    try:
        got = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        got = {}
    sets = got.get("sets") if isinstance(got.get("sets"), dict) else {}
    sets[name] = {"heldout_sha256": heldout_sha256(), "sha256": _sha256_file(file) if pathlib.Path(file).exists() else None,
                  "at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"sets": sets}, indent=1), encoding="utf-8")


# the exam sets on disk (their folder under the work folder, the file that marks one made) by their exam_sets.json name
EXAM_SET_FOLDERS = {"he-fields/check": ("synth/he-fields/check", "labels.tsv"), "synth/docs-exam": ("synth/docs-exam", "examples.json")}


def record_own_exam_set(name, file, work=None):
    """record_exam_set only for the work folder's own exam set (EXAM_SET_FOLDERS: synth/docs-exam/examples.json,
    synth/he-fields/check/labels.tsv): a set drawn elsewhere (--out under _smoke, a test's tmp folder) leaves
    exam_sets.json alone — it is not the set exam.py and train_he.py read. → whether it was recorded."""
    import home
    base = pathlib.Path(work or home.WORK)
    folder, mark = EXAM_SET_FOLDERS[name]
    try:
        own = pathlib.Path(file).resolve() == (base / folder / mark).resolve()
    except OSError:
        own = False
    if not own:
        print(f"  {name}: drawn outside {base / folder} — exam_sets.json not touched (only the work folder's own exam set is recorded)")
        return False
    record_exam_set(name, file, work=work)
    return True


def stale_exam_sets(work=None):
    """The exam sets made with another heldout.json, or on disk with no exam_sets.json entry (made before it was
    recorded): [name]."""
    import home
    base = pathlib.Path(work or home.WORK)
    try:
        got = json.loads(exam_sets_path(work).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        got = {}
    sets = got.get("sets") if isinstance(got, dict) and isinstance(got.get("sets"), dict) else {}
    now = heldout_sha256()
    out = {n for n, s in sets.items() if not isinstance(s, dict) or s.get("heldout_sha256") != now}
    out |= {n for n, (folder, mark) in EXAM_SET_FOLDERS.items() if n not in sets and (base / folder / mark).exists()}
    return sorted(out)
