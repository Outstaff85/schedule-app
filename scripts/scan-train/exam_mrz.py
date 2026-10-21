"""The passport zone reader, step 3 (docs/hf-plan.md → H8b; /scan-train): the new mrz.onnx is examined on
the real passports the site collected (the full documents, H8a: documents/…/record.json with its pages),
the way the phone will run it (mrzmodel.py: the two lowest lines of the primary page, each read, line 2's
values taken where their check digit is right) — and compared with what the user saved and with what the
AI had filled in (scanned). On the made-up lines its check figures come from train_mrz.py.
Writes ~/.scan-train/report_mrz.json: "publish" when the made-up lines are read well enough and, on the
real passports, it is right at least as often as the AI (or there are none yet: then the shadow on the
site examines it). With MIDV-2020's exam passports (midv_mrz.py: real photos and scans of mock passports,
never trained on), the same is done on them — the zone found, line 2 read right, every check-digit field
right — and reported beside (MIDV's figures inform the owner; the decision stays the made-up lines and
the real passports the site collected).

  python exam_mrz.py
"""
import json
import tempfile

import cv2
import numpy as np
import onnxruntime as ort

from common import DATA, WORK, write_json
from mrzmodel import decode, fields, find_lines, line_input

SYNTH_AT = 0.95       # the share of made-up lines read right that a model must reach
COMPARED = ("docId", "docDob", "docExpiry", "docSex")


def passports():
    """The collected full documents of passports: [(record, primary page path in the bucket)]."""
    from huggingface_hub import HfApi
    api = HfApi()
    try:
        files = [f.path for f in api.list_bucket_tree(DATA, prefix="documents/", recursive=True) if f.path.endswith("/record.json")]
    except Exception:
        return []
    out = []
    with tempfile.TemporaryDirectory() as tmp:
        api.download_bucket_files(DATA, [(f, f"{tmp}/{i}.json") for i, f in enumerate(files)])
        for i, f in enumerate(files):
            try:
                r = json.loads(open(f"{tmp}/{i}.json", encoding="utf-8").read())
            except Exception:
                continue
            prim = next((p for p in r.get("pages") or [] if p.get("primary")), None)
            if prim and (r.get("saved", {}).get("docType") == "passport" or (r.get("read") or {}).get("mrzLine2")):
                out.append((r, prim["path"]))
    return out


def compare(got, saved):
    """(fields compared, fields right): only the fields the reader gave and the user kept a value for;
    the ID number of an Israeli (docType israeli_id) is not a passport number."""
    keys = [k for k in COMPARED if k in got and saved.get(k) and not (k == "docId" and saved.get("docType") != "passport")]
    norm = lambda v: str(v).replace(" ", "").upper()
    return len(keys), sum(norm(got[k]) == norm(saved[k]) for k in keys)


def midv_exam(sess):
    """MIDV-2020's exam passports: {"midvPages", "midvZoneFound", "midvLine2Right", "midvFieldsAllRight"}, or {}."""
    folder = WORK / "midv-mrz" / "exam"
    if not (folder / "exam.json").exists():
        return {}
    pages = json.loads((folder / "exam.json").read_text(encoding="utf-8"))
    n = found = line2 = all_right = 0
    for e in pages:
        gray = cv2.imread(str(folder / e["page"]), cv2.IMREAD_GRAYSCALE)
        if gray is None:
            continue
        n += 1
        lines = find_lines(gray)
        if not lines:
            continue
        found += 1
        texts = [decode(sess.run(None, {"img": line_input(l)[None]})[0][0]) for l in lines]
        line2 += texts[1] == e["lines"][1]
        want = fields(e["lines"][1])
        all_right += bool(want) and fields(texts[1]) == want
    return {"midvPages": n, "midvZoneFound": found, "midvLine2Right": line2, "midvFieldsAllRight": all_right}


def main():
    model = WORK / "new" / "mrz.onnx"
    if not model.exists():
        raise SystemExit("no ~/.scan-train/new/mrz.onnx — run train_mrz.py first")
    train = json.loads((WORK / "report_mrz_train.json").read_text())
    sess = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])
    from huggingface_hub import HfApi
    api = HfApi()
    docs = passports()
    n = found = all_right = ai_right = 0
    fields_n = fields_right = ai_n = ai_fields_right = 0
    misses = []
    with tempfile.TemporaryDirectory() as tmp:
        for i, (r, path) in enumerate(docs):
            dest = f"{tmp}/{i}.jpg"
            try:
                api.download_bucket_files(DATA, [(path, dest)])
            except Exception:
                continue
            gray = cv2.imread(dest, cv2.IMREAD_GRAYSCALE)
            if gray is None:
                continue
            n += 1
            lines = find_lines(gray)
            got = {}
            if lines:
                found += 1
                texts = [decode(sess.run(None, {"img": line_input(l)[None]})[0][0]) for l in lines]
                got = fields(texts[1])
            saved = r.get("saved") or {}
            c, ok = compare(got, saved)
            fields_n, fields_right = fields_n + c, fields_right + ok
            all_right += c > 0 and c == ok
            ac, aok = compare(r.get("scanned") or {}, saved)
            ai_n, ai_fields_right = ai_n + ac, ai_fields_right + aok
            ai_right += ac > 0 and ac == aok
            if not (c and c == ok):
                misses.append(r.get("id"))
    synth_ok = train["linesRight"] >= SYNTH_AT
    real_ok = n == 0 or all_right >= ai_right
    report = {"madeUpLinesRight": train["linesRight"], "madeUpCharsWrong": train["charsWrong"],
              "passports": n, "zoneFound": found, "passportsAllRight": all_right, "fieldsRight": fields_right, "fieldsCompared": fields_n,
              "aiPassportsAllRight": ai_right, "aiFieldsRight": ai_fields_right, "aiFieldsCompared": ai_n,
              "missed": misses[:50], "publish": synth_ok and real_ok, **midv_exam(sess)}
    write_json(WORK / "report_mrz.json", report)
    print(f"Made-up lines: {train['linesRight']:.1%} read right ({train['charsWrong']:.2%} of the characters wrong; needed {SYNTH_AT:.0%})")
    if n:
        print(f"Real passports: {n}; the zone found on {found}; every field right on {all_right} ({fields_right}/{fields_n} fields) — "
              f"the AI: {ai_right} ({ai_fields_right}/{ai_n} fields)")
    else:
        print("Real passports: none collected yet — the shadow on the site will compare it with the AI")
    if report.get("midvPages"):
        m = report["midvPages"]
        print(f"MIDV-2020 exam passports (real photos and scans): {m}; the zone found on {report['midvZoneFound']}; "
              f"line 2 read right on {report['midvLine2Right']} ({report['midvLine2Right'] / m:.0%}); "
              f"every check-digit field right on {report['midvFieldsAllRight']} ({report['midvFieldsAllRight'] / m:.0%})")
    print("YES — worth publishing to the lab" if report["publish"] else "NO — do not publish")


if __name__ == "__main__":
    main()
