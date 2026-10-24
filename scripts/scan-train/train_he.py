"""The Hebrew field reader (docs/hf-plan.md → H8c; docs/scan-training.md → "The Hebrew field reader"): the
passport zone reader's small CRNN (train_mrz.MrzNet, CTC) learns to read one field of an Israeli ID card,
its back or a ספח from
- the made-up fields cut from the owner's marked real pages made other people's (synth_fields.py:
  ~/.scan-train/synth/he-fields/train/) — the cards' own look, every value made up;
- the made-up Hebrew lines (synth_lines.py he: ~/.scan-train/synth/he/), if drawn — more names, streets,
  cities and dates in the PC's fonts, made worse like a phone's crop.
- with --phone-run <run>, the fields cut where the phone reads them on the lab's own cut of a scene's card
  (python -m gen build --model doctype,mrz,he,face: <run>/he/, gen/outputs/he.py) — the offset of a real cut included.
It is checked on the held-out real pages only (synth_fields.py --check: …/he-fields/check/, drawn from the pages
heldout.json keeps and the check vocabulary — names, cities and streets training never draws) — every field read
right, by kind, and the ID numbers whose check digit agrees. The check pages are split in two that share no page
(check_split, by the page each field was cut from): "select" picks the best epoch, "exam" is the gate — the score that
decides publish is never the one the epoch was picked on; report_he.json has both. Before training, the training sets' sources.json are
checked (gen.sources.assert_clean): a set holding a held-out page or drawn with the check vocabulary is refused; and
the check set's (clean_check): one not drawn as the check, with another heldout.json or from other pages is refused; a
training set drawn through gen build must have passed its QA (gen.qa.require_qa); a fields set cut before the names'
boxes were widened as the phone reads them (sources.json nameOpen) is refused too (assert_cut_as_read). Labels are taught in the visual order
(hemodel.visual). Exported to ONNX (input "img" [1,1,32,512], output "logits" [1,128,len(CHARS)+1]) and
checked. Each epoch's progress is saved (checkpoint.py: --resume, --more); the checkpoint records the data fingerprint
(the labels.tsv sha1s, the sizes, the batch and the steps per epoch: data_info), so --resume refuses other data. Writes
~/.scan-train/new/he.onnx, he-layouts.json (the card layouts the phone reads, hemodel.layouts) and
report_he.json; publish.py puts both files into the version when the check says YES (--force-he else). The real ID cards the site collects (H8a, each
with its fields' boxes and the values the user kept) are its exam once there are enough.

  python synth_fields.py --count 3000 && python synth_fields.py --count 300 --check
  python synth_lines.py he --count 50000          # optional
  python train_he.py                              # ~10-20 min on the 4070
"""
import argparse
import json
import pathlib
import random
from collections import Counter

import cv2
import torch

import hemodel
from home import HE_FILES, WORK, drop_report, gentle, model_hashes
from mrzmodel import decode, line_input
from synth import valid_israeli_id
import checkpoint
from gen.common import file_sha1
from gen import manifest
from gen.manifest import data_fingerprint
from gen.qa import require_qa
from gen.sources import assert_check_set, assert_clean, read_meta
from train_mrz import Lines, MrzNet, collate, export, fit

READ_AT = 0.9   # the share of check fields a model must read right


def load(folder, visual=True):
    """[(picture, label in the visual order, kind, info)] of a folder's labels.tsv (file, text as written[, kind,
    the page's sha1 prefix, page type, role, …]): info {"pageType", "role", "page"} — the page a field was cut from
    is its file name's part before the first "-" (synth_fields.py: <page>-<field>.png) or, for the phone's own cuts
    (gen/outputs/he.py), its 10th column."""
    rows = []
    tsv = folder / "labels.tsv"
    if not tsv.exists():
        return rows
    for line in tsv.read_text(encoding="utf-8").splitlines():
        parts = line.split("\t")
        if len(parts) < 2 or not hemodel.readable(parts[1]):
            continue
        kind = parts[2] if len(parts) > 2 else "line"
        info = {"pageType": parts[4] if len(parts) > 4 else None, "role": parts[5] if len(parts) > 5 else kind,
                "page": parts[9] if len(parts) > 9 else parts[0].split("-", 1)[0]}
        rows.append((folder / parts[0], hemodel.visual(parts[1]) if visual else parts[1], kind, info))
    return rows


def check_split(rows):
    """The check fields in two parts that share no page (crc32 of the page): (select — picks the epoch, exam — the
    gate). Split by page, not by field: the fields of one page share its look."""
    import zlib
    sel = [r for r in rows if zlib.crc32(str(r[3]["page"]).encode("utf-8")) % 2 == 0]
    exam = [r for r in rows if zlib.crc32(str(r[3]["page"]).encode("utf-8")) % 2 == 1]
    return sel, exam


def clean_inputs(fields, lines, work=None):
    """Refuse to train on a held-out page or the check vocabulary (gen.sources.assert_clean): each training set must
    carry its sources.json (synth_fields.py, synth_lines.py) naming the training split and vocabulary and no held-out
    page."""
    work = pathlib.Path(work or WORK)
    meta = []
    if fields:
        meta.append(("synth/he-fields/train", read_meta(work / "synth" / "he-fields" / "train")))
    if lines:
        meta.append(("synth/he", read_meta(work / "synth" / "he")))
    assert_clean((), "the Hebrew field reader's training sets", meta=meta, work=work)


def clean_check(work=None):
    """Refuse a check set that is not the held-out one (gen.sources.assert_check_set)."""
    assert_check_set(pathlib.Path(work or WORK) / "synth" / "he-fields" / "check", "synth/he-fields/check")


def assert_cut_as_read(work=None, fields=True):
    """Refuse a fields set (synth_fields.py) cut before the names' boxes were widened as the phone reads them: its
    sources.json must carry nameOpen = hemodel.NAME_OPEN — a set cut by the marked box alone trains and checks the
    names on a narrower strip than the phone gives the reader (draw it again)."""
    work = pathlib.Path(work or WORK)
    for f in (["he-fields/train"] if fields else []) + ["he-fields/check"]:
        if (read_meta(work / "synth" / f) or {}).get("nameOpen") != hemodel.NAME_OPEN:
            raise SystemExit(f"synth/{f} was cut before the names' boxes were widened as the phone reads them "
                             f"(hemodel.NAME_OPEN) — draw it again: synth_fields.py --count 3000 / --count 300 --check")


def data_info(work, items, checks, batch, steps, phone_run=None):
    """The checkpoint's info: the reader and the data fingerprint of its sets (each labels.tsv's sha1), the sizes, the
    batch and the steps per epoch (a resumed schedule is made for them)."""
    work = pathlib.Path(work)
    labels = {k: file_sha1(work / "synth" / f / "labels.tsv") for k, f in (("train", "he-fields/train"), ("check", "he-fields/check"), ("lines", "he"))}
    if phone_run:
        labels["phoneRun"] = file_sha1(pathlib.Path(phone_run) / "he" / "labels.tsv")
    return {"model": "he", "data": data_fingerprint((), labels=labels, sizes={"items": len(items), "checks": len(checks)},
                                                       batch=batch, steps=steps)}


def check(net, rows, dev):
    """Every check field read: the share right, by kind, and the ID numbers read whose check digit agrees."""
    net.eval()
    right, by, ids = 0, Counter(), Counter()
    with torch.no_grad():
        for p, label, kind, _ in rows:
            g = cv2.imread(str(p), cv2.IMREAD_GRAYSCALE)
            got = decode(net(torch.from_numpy(line_input(g)[None]).to(dev)).cpu().numpy()[0], hemodel.CHARS)
            ok = got == label
            right += ok
            by[(kind, ok)] += 1
            if kind == "idNo":
                ids["read"] += 1
                ids["checkDigitAgrees"] += valid_israeli_id(hemodel.logical(got).replace(" ", ""))
    kinds = sorted({k for k, _ in by})
    return {"fieldsRight": round(right / max(1, len(rows)), 4), "fields": len(rows),
            "byKind": {k: round(by[(k, True)] / max(1, by[(k, True)] + by[(k, False)]), 3) for k in kinds},
            "idNumbersWithARightCheckDigit": round(ids["checkDigitAgrees"] / max(1, ids["read"]), 3)}


def main():
    gentle(spare_core=False)   # below-normal priority: the PC stays usable (the GPU as it is)
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=16)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--phone-run", help="also the fields of a run of the phone's own cuts (python -m gen build --model "
                    "doctype,mrz,he,face: <run>/he/) — the training side's pages only; its QA must have passed")
    checkpoint.add_args(ap)
    a = ap.parse_args()
    fields = load(WORK / "synth" / "he-fields" / "train")
    lines = load(WORK / "synth" / "he")
    checks = load(WORK / "synth" / "he-fields" / "check")
    cut = []
    if a.phone_run:
        run = pathlib.Path(a.phone_run)
        require_qa(run, "the phone's own cuts (gen build --model …he)", work=WORK)   # its QA passed: nothing the exam keeps
        if (manifest.read_run(run) or {}).get("split") != "train":
            raise SystemExit(f"{run}: not a training run — the phone's cuts of the exam's pages are never trained on")
        cut = load(run / "he")
    if len(fields) + len(lines) + len(cut) < 1000 or not checks:
        raise SystemExit("too few made-up fields — run synth_fields.py --count 3000 and synth_fields.py --count 300 --check first")
    clean_inputs(fields, lines)
    clean_check()
    assert_cut_as_read(WORK, bool(fields))
    if fields:
        require_qa(WORK / "synth" / "he-fields" / "train", "synth/he-fields/train (synth_fields.py)", work=WORK)   # drawn through gen build: its QA passed
    select, exam = check_split(checks)
    if not select or not exam:
        raise SystemExit(f"the check set has too few pages to split into select and exam ({len(select)} / {len(exam)} fields): "
                         "draw more (synth_fields.py --count 300 --check)")
    items = [(p, t) for p, t, _, _ in fields + lines + cut]
    random.Random(0).shuffle(items)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"{len(fields)} fields from the real pages made up + {len(lines)} made-up lines + {len(cut)} fields of the phone's own "
          f"cuts to train on, {len(checks)} check fields ({len(select)} to pick the epoch, {len(exam)} for the gate), on the {dev}")
    net = MrzNet(hemodel.OUT).to(dev)
    real = frozenset(p for p, _, _, _ in fields + cut)   # already a phone's crop: made worse only half the time
    tl = torch.utils.data.DataLoader(Lines(items, True, real=real, chars=hemodel.CHARS), a.batch, shuffle=True,
                                     num_workers=a.workers, collate_fn=collate, drop_last=True)
    vl = torch.utils.data.DataLoader(Lines([(p, t) for p, t, _, _ in select][:2000], False, real=frozenset(p for p, _, _, _ in select),
                                           chars=hemodel.CHARS), 128, num_workers=a.workers, collate_fn=collate)
    net = fit("he", data_info(WORK, items, checks, a.batch, len(tl), a.phone_run), net, tl, vl, dev, a.epochs, a, hemodel.CHARS,
              "select fields right")
    drop_report("report_he.json")   # the reader's check below writes it again, for these files
    report = check(net.to(dev), exam, dev)   # the gate: the exam part, never the part the epoch was picked on
    report["select"] = check(net, select, dev)
    report["checkSplit"] = {"selectFields": len(select), "examFields": len(exam),
                            "selectPages": len({r[3]["page"] for r in select}), "examPages": len({r[3]["page"] for r in exam})}
    report["onnxDiff"] = export(net, WORK / "new" / "he.onnx")
    marks = json.loads((pathlib.Path(__file__).resolve().parent / "template_fields.json").read_text(encoding="utf-8"))
    (WORK / "new" / "he-layouts.json").write_text(json.dumps(hemodel.layouts(marks)), encoding="utf-8")   # where the phone reads
    report["trainFields"], report["trainLines"], report["phoneRunFields"] = len(fields), len(lines), len(cut)
    report["publish"] = report["fieldsRight"] >= READ_AT
    report["model_sha256"] = model_hashes(HE_FILES, WORK / "new")   # the exact files checked (publish.py checks them)
    (WORK / "report_he.json").write_text(json.dumps(report, indent=1, ensure_ascii=False))
    print(f"he.onnx written: {report['fieldsRight']:.1%} of the exam's check fields read right (select: "
          f"{report['select']['fieldsRight']:.1%}); by kind {report['byKind']}; "
          f"ID numbers with a right check digit {report['idNumbersWithARightCheckDigit']:.1%}")
    print("YES — good enough to try (in the lab, then in shadow)" if report["publish"] else f"NO — under {READ_AT:.0%}: more pages (--count) or epochs")


if __name__ == "__main__":
    main()
