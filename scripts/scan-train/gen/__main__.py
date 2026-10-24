"""python -m gen <command> (run from scripts/scan-train; docs/scan-training.md → "Kept apart", "Made-up sets: build,
verify, QA").

  python -m gen sources            # every source by kind and side
  python -m gen sources --check    # and fail (exit 1) when the exam is not kept apart
  python -m gen build --model edges --count N --seed S --jobs J --out DIR   # scenes: one camera for table and documents
  python -m gen build --model doctype|he --count N --seed S --jobs J --out DIR   # today's generators + their manifest
  python -m gen build --model doctype,mrz,he,face --count N --seed S --out DIR   # the phone's own cuts (gen/phone_run.py)
  python -m gen build --model edges|doctype,mrz,he,face --split select   # a made-up select set: its own seeds, the training side
  python -m gen bg add DIR --category auto|<name> [--owner] | bg check | bg split | bg pull | bg push   # the background bank
  python -m gen occluders add DIR --category cup --size-mm 80   # cut-outs laid over documents
  python -m gen verify --run DIR --sample 50    # draw a sample again byte for byte; fail on what the exam keeps
  python -m gen qa --run DIR [--real DIR] [--midv DIR]   # the QA sheet (DIR/qa/index.html), purity.json, the realism panel
  python -m gen real [--out DIR]                # every real labelled picture in one index (DIR/index.jsonl; read-only)
  python -m gen mix --model edges|doctype --synth-run DIR [--real-repeat 30] [--out DIR]   # one training list per model
      [--hard [mine/hard/pool.jsonl]] [--hard-repeat 3] [--select-run DIR]   # gen mine's hard examples; a made-up select set
  python -m gen profile --frames DIR            # the resampling probe's fixed frames (PNG) and frames.json
  python -m gen profile --from probe.json --frames DIR [--out FILE]   # fit the kernels to a browser's outputs
  python -m gen exam-phone --model edges --count 40 --out DIR   # E4: the lab's edges models, INTER_AREA vs the phone path
  python -m gen exam-sets [--work DIR]          # the exam sets pinned in exam_sets.json and the rows in exam_rows.jsonl
  python -m gen mine [--run PATH ...] [--real DIR] [--prev FILE] [--out DIR]   # exam mistakes → focus.json, hard/pool.jsonl, note.txt
  python -m gen build --model edges --focus DIR/focus.json ...   # the next made-up set drawn by gen mine's weights
  python -m gen status [--work DIR]             # each model's counters on this PC and the command to run next (read-only)
"""
import argparse
import sys

import home  # noqa: F401 — prints in UTF-8 whatever the console's code page


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["build"] and not {"-h", "--help"} & set(argv[1:2]):
        # the model's own options (synth_docs.py, synth_pages.py, synth_fields.py) once --model is known
        pre = argparse.ArgumentParser(prog="python -m gen build", add_help=False)
        pre.add_argument("--model", required=True, help="edges | doctype | he (today's) | a list of doctype,mrz,he,face "
                         "(the phone's own cuts, gen/phone_run.py; a single doctype or he with --cuts)")
        known, rest = pre.parse_known_args(argv[1:])
        from .build import SCENES, cli, cut_models
        cuts = cut_models(known.model, "--cuts" in rest)
        if cuts:
            cli("cuts", rest + ["--models", ",".join(cuts)], prog=f"python -m gen build --model {known.model}", generator=SCENES["cuts"])
        else:
            cli(known.model, rest, prog=f"python -m gen build --model {known.model}", generator=SCENES.get(known.model))
        return 0
    ap = argparse.ArgumentParser(prog="python -m gen")
    sub = ap.add_subparsers(dest="command", required=True)
    s = sub.add_parser("sources", help="the sources registry: counts by kind and side")
    s.add_argument("--check", action="store_true", help="fail when an exam or golden key is on the training side, a held-out "
                   "page is in training, a site page has no side, or heldout.json changed after the exam sets were made")
    s.add_argument("--work", help="the work folder (default SCAN_TRAIN_HOME, else ~/.scan-train)")
    sub.add_parser("build", help="a made-up set through the manifest: --model edges (scenes) | doctype | he (today's) | "
                   "doctype,mrz,he,face (the phone's own cuts) and the generator's options (scenes: --focus focus.json)")
    b = sub.add_parser("bg", help="the background bank (gen/backgrounds.py): add, check, split, pull, push")
    b.add_argument("action", choices=("add", "check", "split", "pull", "push"))
    b.add_argument("dir", nargs="?", help="add: the folder of photos (copied into <home>/backgrounds unless there)")
    b.add_argument("--category", default="auto", help="add: the photos' category, or auto (from a download's sources.json)")
    b.add_argument("--series", help="add: one surface shot again (its photos stay on one side)")
    b.add_argument("--licence", help="add: cc0, pdm, owner… (default: the sources.json one; --owner: owner)")
    b.add_argument("--url")
    b.add_argument("--owner", action="store_true", help="add: the owner's own shots (into <home>/backgrounds-own)")
    b.add_argument("--min-side", type=int, default=None, help="check: the long side at least (default 1600)")
    b.add_argument("--version", help="check: the edges models' version (default the lab's)")
    b.add_argument("--share", type=float, default=None, help="split: the exam's share of the surfaces (default 0.2)")
    o = sub.add_parser("occluders", help="cut-outs laid over documents (PNG with alpha)")
    o.add_argument("action", choices=("add",))
    o.add_argument("dir")
    o.add_argument("--category", required=True)
    o.add_argument("--size-mm", type=float, required=True, help="the cut-out's long side on the table, mm")
    o.add_argument("--licence", default="owner")
    v = sub.add_parser("verify", help="draw a sample of a made-up set again byte for byte; fail on what the exam keeps")
    v.add_argument("--run", required=True, help="the set's folder (with run.json), or its name under ~/.scan-train/synth/")
    v.add_argument("--sample", type=int, default=50)
    v.add_argument("--jobs", type=int, default=1)
    q = sub.add_parser("qa", help="the QA sheet of a made-up set (<run>/qa/index.html) and purity.json")
    q.add_argument("--run", required=True)
    q.add_argument("--sample", type=int, default=20, help="the examples verify draws again when the set has no verify.json")
    q.add_argument("--jobs", type=int, default=1)
    q.add_argument("--real", help="the realism panel's real pictures: gen real's folder (default <home>/real)")
    q.add_argument("--midv", help="and MIDV's folder (default <home>/midv)")
    r = sub.add_parser("real", help="every real labelled picture (attempts, records, page copies, documents) in one index, "
                       "labelled only from what a person did — read-only")
    r.add_argument("--out", help="the index's folder (default <home>/real)")
    m = sub.add_parser("mix", help="one training list per model: made-up, open and real data, the real data repeated")
    m.add_argument("--model", required=True, choices=("edges", "doctype"))
    m.add_argument("--real", help="gen real's folder (default <home>/real)")
    m.add_argument("--synth-run", help="a made-up set drawn through gen build (its QA passed)")
    m.add_argument("--synth", type=int, default=0, help="made-up examples taken (0: all)")
    m.add_argument("--midv", type=int, default=0, help="MIDV training photos taken (edges)")
    m.add_argument("--smartdoc", type=int, default=0, help="SmartDoc training frames taken (edges)")
    m.add_argument("--real-repeat", type=int, default=30, help="each real row repeated K times, capped at 30%% of an epoch")
    m.add_argument("--seed", type=int, help="the made-up sample's seed (default: fresh, saved in mix.json)")
    m.add_argument("--out", help="the mix's folder (default <home>/models/<model>)")
    m.add_argument("--hard", nargs="?", const="", default=None, help="gen mine's hard pool (default <home>/mine/hard/pool.jsonl): "
                   "its rows of this model repeated more — checked again against today's exam first")
    m.add_argument("--hard-repeat", type=int, default=3, help="a hard row: this many times its kind's repeat (default 3)")
    m.add_argument("--select-run", help="a made-up select set (python -m gen build --split select; its QA passed): picks the "
                   "epoch when the real select rows are fewer than 20")
    p = sub.add_parser("profile", help="the phone's resampling: write the probe's frames, or fit gen/phone_profile.json "
                       "to a probe's outputs (gen/phone.py)")
    p.add_argument("--frames", help="the probe's frames folder: written there without --from, read from there with it")
    p.add_argument("--count", type=int, default=20, help="frames written (without --from)")
    p.add_argument("--from", dest="probe", help="probe.json: a browser's outputs of every path on the frames")
    p.add_argument("--out", help="where the fitted profile is written (default: print only)")
    e = sub.add_parser("exam-phone", help="E4: today's lab models through INTER_AREA and through the phone's path "
                       "(live → cap → the lab's findNext / findInside), without retraining")
    e.add_argument("--model", required=True, choices=("edges",))
    e.add_argument("--count", type=int, default=40, help="photos of each exam set (the same ones every run)")
    e.add_argument("--version", help="the model version (default: the lab's, scripts/scan-lab/models-version)")
    e.add_argument("--out", help="the folder exam_phone.json goes to (default: the work folder)")
    x = sub.add_parser("exam-sets", help="the exam sets pinned (exam_sets.json: each manifest's sha256 and the heldout.json "
                       "it was pinned under) and the exam rows written (exam_rows.jsonl)")
    x.add_argument("--work", help="the work folder (default SCAN_TRAIN_HOME, else ~/.scan-train)")
    mn = sub.add_parser("mine", help="the exams' mistakes → sampling multipliers (focus.json) for the next gen build --focus, "
                        "a pool of hard real examples from the training side (hard/pool.jsonl) and a note to the owner")
    mn.add_argument("--run", nargs="*", help="exam_rows.jsonl files, folders holding one, and gen runs (manifest.jsonl) — "
                    "default: the work folder's exam_rows.jsonl and every run under <home>/gen/runs")
    mn.add_argument("--real", help="gen real's folder (default <home>/real)")
    mn.add_argument("--prev", help="the last run's focus.json, halved toward 1 (default: the out folder's focus.json)")
    mn.add_argument("--out", help="the folder (default <home>/mine)")
    st = sub.add_parser("status", help="each model's counters on this PC and the command to run next (read-only)")
    st.add_argument("--work", help="the work folder (default SCAN_TRAIN_HOME, else ~/.scan-train)")
    a = ap.parse_args(argv)
    if a.command == "mine":
        from .mine import mine
        mine(a.run, a.real, a.prev, a.out)
        return 0
    if a.command == "status":
        from .status import status
        print("\n".join(status(a.work)))
        return 0
    if a.command == "exam-sets":
        from . import common as gc
        from .exam_sets import report as exam_sets_report
        print("\n".join(exam_sets_report(a.work)))
        stale = gc.stale_exam_sets(a.work)
        if stale:
            print("made under another heldout.json (draw them again): " + ", ".join(stale))
            return 1
        return 0
    if a.command == "sources":
        from .sources import report
        lines, bad = report(a.work)
        print("\n".join(lines))
        if a.check:
            if bad:
                print("NOT CLEAN:\n  " + "\n  ".join(bad))
                return 1
            print("clean: nothing the exam keeps is on the training side")
    elif a.command == "verify":
        from .verify import find_run, verify
        return 0 if verify(find_run(a.run), a.sample, a.jobs)["passed"] else 1
    elif a.command == "qa":
        from .qa import qa
        from .verify import find_run
        return 0 if qa(find_run(a.run), a.sample, a.jobs, real=a.real, midv=a.midv)["passed"] else 1
    elif a.command == "real":
        from .real import main as real_main
        real_main(a.out)
    elif a.command == "mix":
        from .mix import main as mix_main
        import pathlib
        import home as _home
        hard = (a.hard or str(pathlib.Path(_home.WORK) / "mine" / "hard" / "pool.jsonl")) if a.hard is not None else None
        mix_main(a.model, a.real, a.synth_run, a.synth, a.midv, a.smartdoc, a.real_repeat, a.seed, a.out,
                 hard=hard, hard_repeat=a.hard_repeat, select_run=a.select_run)
    elif a.command == "profile":
        return profile(a)
    elif a.command == "bg":
        return bg(a)
    elif a.command == "occluders":
        from .backgrounds import occluders_add
        added, skipped = occluders_add(a.dir, a.category, a.size_mm, licence=a.licence)
        print(f"occluders: {added} added, {skipped} skipped (no alpha channel: cut them out first)")
    elif a.command == "exam-phone":
        from .exam_phone import main as exam_phone
        exam_phone(a.model, a.count, a.version, a.out)
    return 0


def bg(a):
    import json
    from . import backgrounds as gb
    name = "backgrounds-own" if a.owner else "backgrounds"
    if a.action == "add":
        if not a.dir:
            print("give the folder: python -m gen bg add DIR --category auto")
            return 2
        added, updated = gb.add(a.dir, a.category, series=a.series, licence=a.licence, url=a.url, owner=a.owner, name=name)
        print(f"{name}: {added} photos added, {updated} updated — next: python -m gen bg check")
        return 0
    if a.action in ("pull", "push"):
        (gb.pull if a.action == "pull" else gb.push)()
        return 0
    out = {}
    for n in ("backgrounds", "backgrounds-own"):
        if not gb.load(name=n)["files"]:
            continue
        if a.action == "check":
            det = gb.edges_detector(version=a.version)
            out[n] = gb.check(detector=det, min_side=a.min_side or gb.MIN_SIDE, name=n)
            out[n]["edgesVersion"] = det.version
        else:
            out[n] = gb.split(share=gb.EXAM_SHARE if a.share is None else a.share, name=n)
    if not out:
        print("no catalogued photo: python -m gen bg add DIR --category auto")
        return 2
    for n, rep in out.items():
        print(f"{n}: {rep['photos']} photos — used by category {json.dumps(rep['used'])}; surfaces {json.dumps(rep['surfaces'])}")
        print(f"  rejected {json.dumps(rep['rejected'])}; no confirmed licence {rep['unlicensed']}; "
              f"hard negatives (text, no document) {rep['hardNegatives']}")
        print(f"  split {json.dumps(rep['splits'])}; not split yet {rep.get('unsplit', 0)}; exam locked {rep.get('locked', 0)}; "
              f"trained twins of exam photos (now in neither) {rep.get('twinsOfExam', 0)}"
              + (f"; edges models {rep['edgesVersion']}" if rep.get("edgesVersion") else ""))
    return 0


def profile(a):
    import json
    import pathlib
    from . import phone
    if not a.probe:
        if not a.frames:
            print("give --frames DIR (the frames are written there) or --from probe.json")
            return 2
        names = phone.write_probe_frames(a.frames, a.count)
        print(f"{len(names)} probe frames in {a.frames}")
        return 0
    probe = json.loads(pathlib.Path(a.probe).read_text(encoding="utf-8"))
    fit = phone.fit_profile(probe, a.frames or probe.get("framesDir") or pathlib.Path(a.probe).parent / "frames")
    for op, r in fit["ops"].items():
        print(f"  {op}: {r['kernel']} (PSNR mean {r['mean']} dB, worst frame {r['min']} dB)")
    if fit["zoneBoxes"]:
        print(f"  the zone's boxes differ from mrz_find on {len(fit['zoneBoxes'])} frame(s)")
    if a.out:
        pathlib.Path(a.out).write_text(json.dumps(fit, indent=1), encoding="utf-8")
        print(f"profile: {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
