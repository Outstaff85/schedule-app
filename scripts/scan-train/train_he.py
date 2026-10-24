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
heldout.json keeps and the check vocabulary — names, cities and streets training never draws). The check pages are split
in two that share no page (check_split, by the page each field was cut from): "select" picks the best epoch, "exam" is
the gate — the score that decides publish is never the one the epoch was picked on; report_he.json has both.
The gate is what the phone reads ("phone": phone_figures): on the ID card fronts of the exam part (and, with --phone-exam
<run>, the fields cut where the phone reads them on the lab's own cut of the held-out cards: a cut exam run, python -m gen
build --model doctype,mrz,he,face --exam), each of the 5 roles the phone reads (hemodel.ROLES: surname, given, idNo,
dob, expiry) read right on at least PHONE_AT (0.9) of its fields, and the ID numbers read with a right check digit on at
least ID_OK_AT (0.95) — every value unseen (the check vocabulary). Every field read right and by kind ("fieldsRight",
"byKind") stay in the report for information only, with the page types not examined named ("notExamined": an ID
card's back or a licence when the check set has none of their fields). gate() names each rule that failed. Before training, the training sets' sources.json are
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

PHONE_AT = 0.9    # each role the phone reads: the share of its fields read right
ID_OK_AT = 0.95   # the ID numbers read whose check digit agrees
PAGE_TYPES = ("id_front", "id_back", "sefach", "licence")   # the page types a Hebrew field is read on


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


def reads(net, rows, dev):
    """The reader's text on each row's picture (in the visual order, as the labels)."""
    import torch
    net.eval()
    out = []
    with torch.no_grad():
        for p, _, _, _ in rows:
            g = cv2.imread(str(p), cv2.IMREAD_GRAYSCALE)
            out.append(decode(net(torch.from_numpy(line_input(g)[None]).to(dev)).cpu().numpy()[0], hemodel.CHARS))
    return out


def id_ok(got):
    """An ID number read (visual order) whose check digit agrees."""
    return bool(valid_israeli_id(hemodel.logical(got).replace(" ", "")))


def figures(rows, got):
    """Every check field read: the share right, by kind, the ID numbers read whose check digit agrees, and the page types
    not examined (no field of them in the set) — for information."""
    right, by, ids = 0, Counter(), Counter()
    for (p, label, kind, info), g in zip(rows, got):
        ok = g == label
        right += ok
        by[(kind, ok)] += 1
        if kind == "idNo":
            ids["read"] += 1
            ids["checkDigitAgrees"] += id_ok(g)
    kinds = sorted({k for k, _ in by})
    seen = {r[3].get("pageType") for r in rows}
    return {"fieldsRight": round(right / max(1, len(rows)), 4), "fields": len(rows),
            "byKind": {k: round(by[(k, True)] / max(1, by[(k, True)] + by[(k, False)]), 3) for k in kinds},
            "idNumbersWithARightCheckDigit": round(ids["checkDigitAgrees"] / max(1, ids["read"]), 3),
            "notExamined": [t for t in PAGE_TYPES if t not in seen]}


def phone_figures(rows, got):
    """What the phone reads, on the ID card fronts: each of hemodel.ROLES read right (None when the set has none of it),
    the ID numbers read with a right check digit (idOk), and the cards with all 5 roles right (allFive, by the page)."""
    per = {r: [0, 0] for r in hemodel.ROLES}
    ids = [0, 0]
    cards = {}
    for (p, label, kind, info), g in zip(rows, got):
        role = info.get("role") or kind
        if info.get("pageType") != "id_front" or role not in per:
            continue
        ok = g == label
        per[role][0] += ok
        per[role][1] += 1
        if role == "idNo":
            ids[0] += id_ok(g)
            ids[1] += 1
        c = cards.setdefault(info.get("page"), {})
        c[role] = c.get(role, True) and ok
    full = [c for c in cards.values() if all(r in c for r in hemodel.ROLES)]
    pct = lambda a, b: round(a / b, 3) if b else None
    return {"fields": sum(v[1] for v in per.values()), "cards": len(cards),
            "byRole": {r: pct(v[0], v[1]) for r, v in per.items()}, "roleFields": {r: v[1] for r, v in per.items()},
            "idOk": pct(*ids), "allFive": pct(sum(all(c.values()) for c in full), len(full)), "fullCards": len(full)}


def gate(report):
    """(publish, [the rules that failed]): every role the phone reads at least PHONE_AT and idOk at least ID_OK_AT, on
    the phone block."""
    ph = report.get("phone") or {}
    fails = []
    for r in hemodel.ROLES:
        v = (ph.get("byRole") or {}).get(r)
        if v is None:
            fails.append(f"{r}: not examined (no ID card front field of it in the exam part)")
        elif v < PHONE_AT:
            fails.append(f"{r}: {v:.1%} read right < {PHONE_AT:.0%}")
    if ph.get("idOk") is None:
        fails.append("ID numbers: not examined")
    elif ph["idOk"] < ID_OK_AT:
        fails.append(f"ID numbers with a right check digit {ph['idOk']:.1%} < {ID_OK_AT:.0%}")
    return not fails, fails


def phone_exam_rows(run):
    """The held-out cards' fields cut where the phone reads them (a cut exam run's he/labels.tsv): rows as load()."""
    run = pathlib.Path(run)
    if (manifest.read_run(run) or {}).get("split") != "exam":
        raise SystemExit(f"{run}: not an exam run (python -m gen build --model doctype,mrz,he,face --exam)")
    return load(run / "he")


def check(net, rows, dev, phone_rows=()):
    """The exam: the figures on every check field (for information) and the phone block on the ID card fronts (the
    gate) — over the exam part's rows and the phone's own cuts of the held-out cards (phone_rows)."""
    got = reads(net, rows, dev)
    out = figures(rows, got)
    pg = reads(net, list(phone_rows), dev) if phone_rows else []
    out["phone"] = phone_figures(list(rows) + list(phone_rows), got + pg)
    if phone_rows:
        out["phoneCut"] = phone_figures(list(phone_rows), pg)
    return out


def main():
    gentle(spare_core=False)   # below-normal priority: the PC stays usable (the GPU as it is)
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=16)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--phone-run", help="also the fields of a run of the phone's own cuts (python -m gen build --model "
                    "doctype,mrz,he,face: <run>/he/) — the training side's pages only; its QA must have passed")
    ap.add_argument("--phone-exam", help="a cut exam run (python -m gen build --model doctype,mrz,he,face --exam): the held-out "
                    "cards' fields cut where the phone reads them, added to the gate's phone block")
    checkpoint.add_args(ap)
    a = ap.parse_args()
    import torch
    from train_mrz import Lines, MrzNet, collate, export, fit
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
    phone_rows = phone_exam_rows(a.phone_exam) if a.phone_exam else []
    report = check(net.to(dev), exam, dev, phone_rows)   # the gate: the exam part, never the part the epoch was picked on
    report["select"] = check(net, select, dev)
    report["checkSplit"] = {"selectFields": len(select), "examFields": len(exam),
                            "selectPages": len({r[3]["page"] for r in select}), "examPages": len({r[3]["page"] for r in exam})}
    report["onnxDiff"] = export(net, WORK / "new" / "he.onnx")
    marks = json.loads((pathlib.Path(__file__).resolve().parent / "template_fields.json").read_text(encoding="utf-8"))
    (WORK / "new" / "he-layouts.json").write_text(json.dumps(hemodel.layouts(marks)), encoding="utf-8")   # where the phone reads
    report["trainFields"], report["trainLines"], report["phoneRunFields"] = len(fields), len(lines), len(cut)
    report["phoneExamRun"] = str(a.phone_exam) if a.phone_exam else None
    report["publish"], report["failed"] = gate(report)
    report["model_sha256"] = model_hashes(HE_FILES, WORK / "new")   # the exact files checked (publish.py checks them)
    (WORK / "report_he.json").write_text(json.dumps(report, indent=1, ensure_ascii=False))
    print_report(report)


def print_report(report):
    pc = lambda v: "—" if v is None else f"{v:.1%}"
    ph = report["phone"]
    print(f"he.onnx: the phone's reading on {ph['cards']} held-out ID card fronts ({ph['fields']} fields, unseen values): "
          + ", ".join(f"{r} {pc(v)}" for r, v in ph["byRole"].items()) + f"; ID numbers with a right check digit {pc(ph['idOk'])}; "
          f"all five right on {pc(ph['allFive'])} of {ph['fullCards']} cards")
    if report.get("phoneCut"):
        print(f"  of which the phone's own cuts of the held-out cards: {report['phoneCut']['fields']} fields")
    print(f"  for information: {report['fieldsRight']:.1%} of every check field read right (select: {report['select']['fieldsRight']:.1%}); "
          f"by kind {report['byKind']}" + (f"; not examined: {', '.join(report['notExamined'])}" if report.get("notExamined") else ""))
    if report["publish"]:
        print("YES — good enough to try (in the lab, then in shadow)")
    else:
        print("NO — do not publish:")
        for f in report["failed"]:
            print(f"  - {f}")


if __name__ == "__main__":
    main()
