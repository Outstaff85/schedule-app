"""The passport zone reader, step 3 (docs/hf-plan.md → H8b; /scan-train): the new mrz.onnx is examined beside the reader
already in the lab (the lab's version's mrz.onnx, when it has one), both on the very same pages:

- the real passports the site collected (the full documents, H8a: documents/…/record.json with its pages), read the way
  the phone will run it (mrzmodel.py: the two lowest lines of the primary page, each read, line 2's values taken where
  their check digit is right) and compared with what the user saved — every field the user kept a value for counts, a
  field the reader did not give counts wrong (as the site's shadow counts, functions/feedback.py mrz_counts), and a
  passport is all right when at least one field was compared and every one was right — and with what the AI had filled
  in (scanned), by the same rule. A bucket that cannot be listed stops the exam (SystemExit), never "no passports"; a
  page that cannot be downloaded or read is counted (passportsSkipped);
- MIDV-2020's exam passports (midv_mrz.py: real photos and scans of mock passports, never trained on): the zone found,
  line 2 read right, every check-digit field right — a page counts only when its true line 2 has a field with a check
  digit (docId, docDob or docExpiry). A missing midv-mrz/exam stops the exam unless --no-midv (then "midvSkipped": true);
- the phone's own path (--phone-run, default the newest gen/runs/cuts-*-exam with mrz/pages.json — built with
  `python -m gen build --model doctype,mrz,he,face --exam --editor-cap 1 --bad-share 1`): each passport of the exam's
  scenes went photo → the lab's edges → cut → the face's turn → the zone found (gen/outputs/mrz.py), then each reader
  reads it — the stage that failed is reported (edges: the lab missed the page or cut it badly; turn: not upright; find:
  the zone's two lines not found on their true lines; read: the fields read differ from the true ones), the earlier
  stages the same for both readers.
On the made-up lines the check figures come from train_mrz.py (report_mrz_train.json).

"publish" when the made-up lines are read well enough (SYNTH_AT), MIDV's exam passports have every check-digit field right
often enough (MIDV_AT; unless --no-midv), the real passports are right at least as often as the AI (with none: not
examined — "realExamined": false, publish.py warns), and the new reader is not worse than the lab's on any of MIDV, the
real passports and the phone's path. While scripts/scan/models-version is base-v1 (no mrz.onnx) the site runs no shadow:
the only real check beside this exam is the owner trying the reader in the lab. The real passports decide more than the
made-up lines (owner, 2026-10-22): many made-up check lines are made so small and blurred that a person cannot read
them either. Writes exam_rows.jsonl (one row per page and reader) and ~/.scan-train/report_mrz.json (with the sha256 of
the mrz.onnx examined, "model_sha256"; publish.py refuses a report written for another file).

  python exam_mrz.py [--no-midv] [--phone-run DIR]
"""
import argparse
import json
import pathlib
import tempfile

import cv2

from common import DATA, MRZ_MODEL, WORK, model_hashes, write_json
from gen import exam_sets as es
from mrzmodel import check, decode, fields, find_lines, line_input

SYNTH_AT = 0.93       # the share of made-up lines read right that a model must reach
MIDV_AT = 0.95        # the share of MIDV's exam passports with every check-digit field right
COMPARED = ("docId", "docDob", "docExpiry", "docSex")
CHECKED = ("docId", "docDob", "docExpiry")   # the fields with a check digit of their own
STAGES = ("edges", "turn", "find", "read")


def passports(api=None):
    """The collected full documents of passports: ([(record, primary page path in the bucket)], records unreadable).
    A listing error stops the exam: SystemExit, never an empty list."""
    if api is None:
        from huggingface_hub import HfApi
        api = HfApi()
    try:
        files = [f.path for f in api.list_bucket_tree(DATA, prefix="documents/", recursive=True) if f.path.endswith("/record.json")]
    except Exception as e:
        raise SystemExit(f"cannot list the bucket's documents ({type(e).__name__}) — the exam needs the real passports: "
                         f"check the HF token (hf auth login) and the network")
    out, bad = [], 0
    if not files:
        return out, bad
    with tempfile.TemporaryDirectory() as tmp:
        api.download_bucket_files(DATA, [(f, f"{tmp}/{i}.json") for i, f in enumerate(files)])
        for i, f in enumerate(files):
            try:
                r = json.loads(open(f"{tmp}/{i}.json", encoding="utf-8").read())
            except Exception:
                bad += 1
                continue
            prim = next((p for p in r.get("pages") or [] if p.get("primary")), None)
            if prim and (r.get("saved", {}).get("docType") == "passport" or (r.get("read") or {}).get("mrzLine2")):
                out.append((r, prim["path"]))
    return out, bad


def compare(got, saved):
    """(fields compared, fields right): every field the user kept a value for (the ID number of an Israeli —
    docType israeli_id — is not a passport number); a field the reader did not give counts wrong."""
    keys = [k for k in COMPARED if saved.get(k) and not (k == "docId" and saved.get("docType") != "passport")]
    norm = lambda v: str(v).replace(" ", "").upper()
    return len(keys), sum(k in got and norm(got[k]) == norm(saved[k]) for k in keys)


def all_right(c, ok):
    """A passport is all right when at least one field was compared and every one was right (the shadow's rule)."""
    return c > 0 and ok == c


def read_zone(sess, gray):
    """(zone found, line texts) of a passport page read by one reader."""
    lines = find_lines(gray)
    if not lines:
        return False, []
    return True, [decode(sess.run(None, {"img": line_input(l)[None]})[0][0]) for l in lines]


def sex_unchecked(line2):
    """Line 2 has a sex (M / F) but its composite check digit is wrong: the sex is not taken (mrzmodel.fields)."""
    l2 = (line2 + "<" * 44)[:44]
    return l2[20] in "MF" and not (l2[43].isdigit() and check(l2[0:10] + l2[13:20] + l2[21:43]) == int(l2[43]))


def real_scores(sess, pages):
    """One reader on the real passports' pages [(record, grey page)]: the counts and the misses (ids only)."""
    n = found = right = fields_n = fields_right = sex_apart = 0
    misses, rows = [], []
    for r, gray in pages:
        n += 1
        ok_zone, texts = read_zone(sess, gray)
        got = fields(texts[1]) if ok_zone else {}
        found += ok_zone
        sex_apart += bool(ok_zone and sex_unchecked(texts[1]))
        c, ok = compare(got, r.get("saved") or {})
        fields_n, fields_right = fields_n + c, fields_right + ok
        right += all_right(c, ok)
        if not all_right(c, ok):
            misses.append(r.get("id"))
        rows.append((r.get("id"), None if not c else all_right(c, ok)))
    return {"passports": n, "zoneFound": found, "passportsAllRight": right, "fieldsRight": fields_right,
            "fieldsCompared": fields_n, "sexWithoutComposite": sex_apart, "missed": misses[:50]}, rows


def ai_scores(pages):
    """The AI's answers (scanned) on the same passports, by the same rule."""
    right = fields_right = fields_n = 0
    for r, _ in pages:
        c, ok = compare(r.get("scanned") or {}, r.get("saved") or {})
        fields_n, fields_right = fields_n + c, fields_right + ok
        right += all_right(c, ok)
    return {"aiPassportsAllRight": right, "aiFieldsRight": fields_right, "aiFieldsCompared": fields_n}


def fetch_pages(docs, api=None):
    """The primary pages of the passports, downloaded and read in grey: ([(record, grey)], skipped)."""
    if not docs:
        return [], 0
    if api is None:
        from huggingface_hub import HfApi
        api = HfApi()
    pages, skipped = [], 0
    with tempfile.TemporaryDirectory() as tmp:
        for i, (r, path) in enumerate(docs):
            dest = f"{tmp}/{i}.jpg"
            try:
                api.download_bucket_files(DATA, [(path, dest)])
            except Exception:
                skipped += 1
                continue
            gray = cv2.imread(dest, cv2.IMREAD_GRAYSCALE)
            if gray is None:
                skipped += 1
                continue
            pages.append((r, gray))
    return pages, skipped


def midv_folder():
    return WORK / "midv-mrz" / "exam"


def midv_exam(sess):
    """MIDV-2020's exam passports: ({"midvPages", "midvZoneFound", "midvLine2Right", "midvFieldsAllRight"}, rows), or
    ({}, []) without the folder. A page counts only when its true line 2 has a field with a check digit."""
    folder = midv_folder()
    if not (folder / "exam.json").exists():
        return {}, []
    pages = json.loads((folder / "exam.json").read_text(encoding="utf-8"))
    n = found = line2 = right = 0
    rows = []
    for e in pages:
        want = fields(e["lines"][1])
        if not any(k in want for k in CHECKED):
            continue
        gray = cv2.imread(str(folder / e["page"]), cv2.IMREAD_GRAYSCALE)
        if gray is None:
            continue
        n += 1
        ok_zone, texts = read_zone(sess, gray)
        found += ok_zone
        ok = bool(ok_zone and fields(texts[1]) == want)
        line2 += bool(ok_zone and texts[1] == e["lines"][1])
        right += ok
        rows.append((e["page"], ok))
    return {"midvPages": n, "midvZoneFound": found, "midvLine2Right": line2, "midvFieldsAllRight": right}, rows


def phone_pages(run):
    """The phone-path exam's passport pages of a cut exam run: [{"page", "lines", "stage" (the stage that failed before
    the read: edges / turn / find, else None), "crops" (the two lines' files)}] — pages with no true zone left out."""
    run = pathlib.Path(run)
    f = run / "mrz" / "pages.json"
    if not f.exists():
        return []
    crops = {}
    tsv = run / "mrz" / "labels.tsv"
    if tsv.exists():
        for line in tsv.read_text(encoding="utf-8").splitlines():
            parts = line.split("\t")
            if len(parts) >= 4:
                crops.setdefault(parts[2], []).append(run / "mrz" / "img" / parts[0])
    out = []
    for p in json.loads(f.read_text(encoding="utf-8")):
        if not p.get("lines"):
            continue
        stage = ("edges" if p.get("cut_by") == "editor" else "turn" if p.get("turn_k") not in (0, None)
                 else "find" if not p.get("ok") else None)
        out.append({"page": p["page"], "lines": p["lines"], "stage": stage, "crops": sorted(crops.get(p["page"], []), key=str)})
    return out


def phone_scores(sess, pages):
    """One reader on the phone path's pages: {"pages", "ok", "failed": {stage: n}} and its rows."""
    failed = {s: 0 for s in STAGES}
    ok_n, rows = 0, []
    for p in pages:
        stage = p["stage"]
        if stage is None:
            texts = []
            for c in p["crops"][:2]:
                g = cv2.imread(str(c), cv2.IMREAD_GRAYSCALE)
                texts.append(decode(sess.run(None, {"img": line_input(g)[None]})[0][0]) if g is not None else "")
            want = fields(p["lines"][1])
            stage = None if len(texts) == 2 and want and fields(texts[1]) == want else "read"
        if stage:
            failed[stage] += 1
        else:
            ok_n += 1
        rows.append((p["page"], stage is None))
    return {"pages": len(pages), "ok": ok_n, "failed": failed}, rows


def not_worse(new, old):
    """[what the new reader does worse than the lab's], on what both were measured on."""
    out = []
    for key, what in (("midvFieldsAllRight", "MIDV exam passports with every check-digit field right"),
                      ("passportsAllRight", "real passports all right"), ("phoneOk", "phone-path passports read right")):
        a, b = new.get(key), old.get(key)
        if a is not None and b is not None and a < b:
            out.append(f"{what}: {b} with the lab's reader → {a}")
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-midv", action="store_true", help="judge without MIDV's exam passports (recorded: midvSkipped)")
    ap.add_argument("--phone-run", help="the cut exam run (default: the newest gen/runs/cuts-*-exam with mrz/pages.json)")
    a = ap.parse_args(argv)
    import onnxruntime as ort
    from common import model_path, sha256_of, version_of
    model = WORK / "new" / MRZ_MODEL
    if not model.exists():
        raise SystemExit("no ~/.scan-train/new/mrz.onnx — run train_mrz.py first")
    if not (WORK / "report_mrz_train.json").exists():
        raise SystemExit("no report_mrz_train.json — run train_mrz.py first (the made-up lines' figures)")
    if not (midv_folder() / "exam.json").exists() and not a.no_midv:
        raise SystemExit(f"no MIDV exam passports in {midv_folder()} — run datasets_hf.py pull midv-mrz (or midv.py, then "
                         "midv_mrz.py), or pass --no-midv to judge without them")
    train = json.loads((WORK / "report_mrz_train.json").read_text())
    sess = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])
    lab = version_of("scan-lab")
    try:
        old_path = model_path(lab, MRZ_MODEL)
    except SystemExit:
        old_path = None   # the lab has no reader: nothing to beat
    old = ort.InferenceSession(str(old_path), providers=["CPUExecutionProvider"]) if old_path else None
    n_sha, o_sha = sha256_of(model), (sha256_of(old_path) if old_path else None)
    docs, unreadable = passports()
    pages, skipped = fetch_pages(docs)
    rows = []
    real, real_rows = real_scores(sess, pages)
    rows += [es.row("mrz", MRZ_MODEL, "new", n_sha, "real", i, None, None, ok) for i, ok in real_rows]
    ai = ai_scores(pages)
    midv, midv_rows = ({}, []) if a.no_midv else midv_exam(sess)
    rows += [es.row("mrz", MRZ_MODEL, "new", n_sha, "midv", i, None, None, ok) for i, ok in midv_rows]
    run = pathlib.Path(a.phone_run) if a.phone_run else es.latest_run("cuts-", WORK)
    ph_pages = phone_pages(run) if run else []
    if ph_pages:
        es.require_fresh({"phone": run}, WORK)
        es.refresh({"mrz/phone": (ph_pages, None)}, WORK)
    phone, ph_rows = phone_scores(sess, ph_pages) if ph_pages else (None, [])
    rows += [es.row("mrz", MRZ_MODEL, "new", n_sha, "phone", i, None, None, ok) for i, ok in ph_rows]
    before = None
    if old is not None:
        o_real, o_rows = real_scores(old, pages)
        o_midv, o_mrows = ({}, []) if a.no_midv else midv_exam(old)
        o_phone, o_prows = phone_scores(old, ph_pages) if ph_pages else (None, [])
        rows += [es.row("mrz", MRZ_MODEL, "lab", o_sha, s, i, None, None, ok)
                 for s, rr in (("real", o_rows), ("midv", o_mrows), ("phone", o_prows)) for i, ok in rr]
        before = {"midvFieldsAllRight": o_midv.get("midvFieldsAllRight"), "midvLine2Right": o_midv.get("midvLine2Right"),
                  "passportsAllRight": o_real["passportsAllRight"] if o_real["passports"] else None,
                  "fieldsRight": o_real["fieldsRight"], "phoneOk": o_phone["ok"] if o_phone else None, "phone": o_phone}
    now = {"midvFieldsAllRight": midv.get("midvFieldsAllRight"), "passportsAllRight": real["passportsAllRight"] if real["passports"] else None,
           "phoneOk": phone["ok"] if phone else None}
    synth_ok = train["linesRight"] >= SYNTH_AT
    real_ok = real["passports"] == 0 or real["passportsAllRight"] >= ai["aiPassportsAllRight"]
    midv_ok = a.no_midv or (bool(midv.get("midvPages")) and midv["midvFieldsAllRight"] >= MIDV_AT * midv["midvPages"])
    worse = not_worse(now, before) if before else []
    fails = ([f"unchanged model — nothing to publish (new/{MRZ_MODEL} is the very file of the lab's {lab})"] if n_sha == o_sha else []) +         ([] if synth_ok else [f"made-up lines read right {train['linesRight']:.1%} < {SYNTH_AT:.0%}"]) + \
        ([] if real_ok else [f"real passports all right {real['passportsAllRight']} < the AI's {ai['aiPassportsAllRight']}"]) + \
        ([] if midv_ok else ["MIDV exam passports: " + (f"every check-digit field right on {midv['midvFieldsAllRight']} of {midv['midvPages']} "
                                                         f"(needed {MIDV_AT:.0%})" if midv.get("midvPages") else "none examined")]) + \
        [f"worse than the lab's reader ({lab}): {w}" for w in worse]
    report = {"madeUpLinesRight": train["linesRight"], "madeUpCharsWrong": train["charsWrong"], **real, **ai, **midv,
              "passportsSkipped": skipped, "recordsUnreadable": unreadable, "realExamined": real["passports"] > 0,
              "midvExamined": bool(midv.get("midvPages")), "midvSkipped": bool(a.no_midv),
              "phone": phone, "phoneRun": str(run) if ph_pages else None, "base": lab if old else None, "before": before,
              "publish": not fails, "failed": fails, "model_sha256": model_hashes([MRZ_MODEL], WORK / "new")}
    es.write_rows("mrz", rows, WORK)
    write_json(WORK / "report_mrz.json", report)
    print(f"Made-up lines: {train['linesRight']:.1%} read right ({train['charsWrong']:.2%} of the characters wrong; needed {SYNTH_AT:.0%})")
    if real["passports"]:
        print(f"Real passports: {real['passports']}; the zone found on {real['zoneFound']}; every field right on {real['passportsAllRight']} "
              f"({real['fieldsRight']}/{real['fieldsCompared']} fields, a field not read counts wrong) — the AI: {ai['aiPassportsAllRight']} "
              f"({ai['aiFieldsRight']}/{ai['aiFieldsCompared']} fields)"
              + (f"; the lab's reader: {before['passportsAllRight']}" if before and before["passportsAllRight"] is not None else ""))
        if real["sexWithoutComposite"]:
            print(f"  sex not taken on {real['sexWithoutComposite']} (the composite check digit wrong)")
    else:
        print("Real passports: none examined — no real passport examined this reader (realExamined false); while the site is on "
              "base-v1 (no mrz.onnx) it runs no shadow: try the reader in the lab")
    if skipped or unreadable:
        print(f"  pages not downloaded or not readable: {skipped}; records not readable: {unreadable}")
    if midv.get("midvPages"):
        m = midv["midvPages"]
        print(f"MIDV-2020 exam passports (real photos and scans): {m}; the zone found on {midv['midvZoneFound']}; "
              f"line 2 read right on {midv['midvLine2Right']} ({midv['midvLine2Right'] / m:.0%}); "
              f"every check-digit field right on {midv['midvFieldsAllRight']} ({midv['midvFieldsAllRight'] / m:.0%}; needed {MIDV_AT:.0%})"
              + (f"; the lab's reader: {before['midvFieldsAllRight']}" if before and before["midvFieldsAllRight"] is not None else ""))
    elif a.no_midv:
        print("MIDV-2020 exam passports: not examined (--no-midv; midvSkipped)")
    if phone:
        f = phone["failed"]
        print(f"Phone path (photo → edges → cut → turn → find → read; {run.name}): {phone['ok']} of {phone['pages']} passports read right; "
              f"failed at edges {f['edges']}, turn {f['turn']}, find {f['find']}, read {f['read']}"
              + (f" — the lab's reader: {before['phoneOk']} right, read failed {before['phone']['failed']['read']}" if before and before.get("phone") else ""))
    else:
        print("Phone path: not examined (no cut exam run with mrz/pages.json: python -m gen build --model doctype,mrz,he,face --exam "
              "--editor-cap 1 --bad-share 1)")
    print(f"Against the lab's reader ({lab}): " + ("not worse" if before and not worse else "WORSE" if worse else "the lab has none — nothing to beat"))
    if report["publish"]:
        print("YES — worth publishing to the lab")
    else:
        print("NO — do not publish:")
        for x in fails:
            print(f"  - {x}")
    return report


if __name__ == "__main__":
    main()
