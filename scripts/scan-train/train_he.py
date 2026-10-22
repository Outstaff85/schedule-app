"""The Hebrew field reader (docs/hf-plan.md → H8c; docs/scan-training.md → "The Hebrew field reader"): the
passport zone reader's small CRNN (train_mrz.MrzNet, CTC) learns to read one field of an Israeli ID card,
its back or a ספח from
- the made-up fields cut from the owner's marked real pages made other people's (synth_fields.py:
  ~/.scan-train/synth/he-fields/train/) — the cards' own look, every value made up;
- the made-up Hebrew lines (synth_lines.py he: ~/.scan-train/synth/he/), if drawn — more names, streets,
  cities and dates in the PC's fonts, made worse like a phone's crop.
It is checked on the other made-up pages (synth_fields.py --check: …/he-fields/check/) — every field read
right, by kind, and the ID numbers whose check digit agrees. Labels are taught in the visual order
(hemodel.visual). Exported to ONNX (input "img" [1,1,32,512], output "logits" [1,128,len(CHARS)+1]) and
checked. Each epoch's progress is saved (checkpoint.py: --resume, --more). Writes
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
from home import WORK, gentle
from mrzmodel import decode, line_input
from synth import valid_israeli_id
import checkpoint
from train_mrz import Lines, MrzNet, collate, export, fit

READ_AT = 0.9   # the share of check fields a model must read right


def load(folder, visual=True):
    """[(picture, label in the visual order, kind)] of a folder's labels.tsv (file, text as written[, kind])."""
    rows = []
    tsv = folder / "labels.tsv"
    if not tsv.exists():
        return rows
    for line in tsv.read_text(encoding="utf-8").splitlines():
        parts = line.split("\t")
        if len(parts) < 2 or not hemodel.readable(parts[1]):
            continue
        rows.append((folder / parts[0], hemodel.visual(parts[1]) if visual else parts[1], parts[2] if len(parts) > 2 else "line"))
    return rows


def check(net, rows, dev):
    """Every check field read: the share right, by kind, and the ID numbers read whose check digit agrees."""
    net.eval()
    right, by, ids = 0, Counter(), Counter()
    with torch.no_grad():
        for p, label, kind in rows:
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
    checkpoint.add_args(ap)
    a = ap.parse_args()
    fields = load(WORK / "synth" / "he-fields" / "train")
    lines = load(WORK / "synth" / "he")
    checks = load(WORK / "synth" / "he-fields" / "check")
    if len(fields) + len(lines) < 1000 or not checks:
        raise SystemExit("too few made-up fields — run synth_fields.py --count 3000 and synth_fields.py --count 300 --check first")
    items = [(p, t) for p, t, _ in fields + lines]
    random.Random(0).shuffle(items)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"{len(fields)} fields from the real pages made up + {len(lines)} made-up lines to train on, "
          f"{len(checks)} check fields, on the {dev}")
    net = MrzNet(hemodel.OUT).to(dev)
    real = frozenset(p for p, _, _ in fields)   # already a phone's crop: made worse only half the time
    tl = torch.utils.data.DataLoader(Lines(items, True, real=real, chars=hemodel.CHARS), a.batch, shuffle=True,
                                     num_workers=a.workers, collate_fn=collate, drop_last=True)
    vl = torch.utils.data.DataLoader(Lines([(p, t) for p, t, _ in checks][:2000], False, real=frozenset(p for p, _, _ in checks), chars=hemodel.CHARS), 128,
                                     num_workers=a.workers, collate_fn=collate)
    net = fit("he", {"model": "he"}, net, tl, vl, dev, a.epochs, a, hemodel.CHARS, "check fields right")
    report = check(net.to(dev), checks, dev)
    report["onnxDiff"] = export(net, WORK / "new" / "he.onnx")
    marks = json.loads((pathlib.Path(__file__).resolve().parent / "template_fields.json").read_text(encoding="utf-8"))
    (WORK / "new" / "he-layouts.json").write_text(json.dumps(hemodel.layouts(marks)), encoding="utf-8")   # where the phone reads
    report["trainFields"], report["trainLines"] = len(fields), len(lines)
    report["publish"] = report["fieldsRight"] >= READ_AT
    (WORK / "report_he.json").write_text(json.dumps(report, indent=1, ensure_ascii=False))
    print(f"he.onnx written: {report['fieldsRight']:.1%} of the check fields read right; by kind {report['byKind']}; "
          f"ID numbers with a right check digit {report['idNumbersWithARightCheckDigit']:.1%}")
    print("YES — good enough to try (in the lab, then in shadow)" if report["publish"] else f"NO — under {READ_AT:.0%}: more pages (--count) or epochs")


if __name__ == "__main__":
    main()
