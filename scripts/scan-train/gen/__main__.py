"""python -m gen <command> (run from scripts/scan-train; docs/scan-training.md → "Kept apart", "Made-up sets: build,
verify, QA").

  python -m gen sources            # every source by kind and side
  python -m gen sources --check    # and fail (exit 1) when the exam is not kept apart
  python -m gen build --model edges|doctype|he --count N --seed S --jobs J --out DIR   # a made-up set + its manifest
  python -m gen verify --run DIR --sample 50    # draw a sample again byte for byte; fail on what the exam keeps
  python -m gen qa --run DIR                    # the QA sheet (DIR/qa/index.html) and purity.json
  python -m gen profile --frames DIR            # the resampling probe's fixed frames (PNG) and frames.json
  python -m gen profile --from probe.json --frames DIR [--out FILE]   # fit the kernels to a browser's outputs
  python -m gen exam-phone --model edges --count 40 --out DIR   # E4: the lab's edges models, INTER_AREA vs the phone path
"""
import argparse
import sys

import home  # noqa: F401 — prints in UTF-8 whatever the console's code page


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["build"] and not {"-h", "--help"} & set(argv[1:2]):
        # the model's own options (synth_docs.py, synth_pages.py, synth_fields.py) once --model is known
        pre = argparse.ArgumentParser(prog="python -m gen build", add_help=False)
        pre.add_argument("--model", required=True, choices=("edges", "doctype", "he"))
        known, rest = pre.parse_known_args(argv[1:])
        from .build import cli
        cli(known.model, rest, prog=f"python -m gen build --model {known.model}")
        return 0
    ap = argparse.ArgumentParser(prog="python -m gen")
    sub = ap.add_subparsers(dest="command", required=True)
    s = sub.add_parser("sources", help="the sources registry: counts by kind and side")
    s.add_argument("--check", action="store_true", help="fail when an exam or golden key is on the training side, a held-out "
                   "page is in training, a site page has no side, or heldout.json changed after the exam sets were made")
    s.add_argument("--work", help="the work folder (default SCAN_TRAIN_HOME, else ~/.scan-train)")
    sub.add_parser("build", help="a made-up set through the manifest: --model edges|doctype|he and the generator's options")
    v = sub.add_parser("verify", help="draw a sample of a made-up set again byte for byte; fail on what the exam keeps")
    v.add_argument("--run", required=True, help="the set's folder (with run.json), or its name under ~/.scan-train/synth/")
    v.add_argument("--sample", type=int, default=50)
    v.add_argument("--jobs", type=int, default=1)
    q = sub.add_parser("qa", help="the QA sheet of a made-up set (<run>/qa/index.html) and purity.json")
    q.add_argument("--run", required=True)
    q.add_argument("--sample", type=int, default=20, help="the examples verify draws again when the set has no verify.json")
    q.add_argument("--jobs", type=int, default=1)
    p = sub.add_parser("profile", help="the phone's resampling: write the probe's frames, or fit gen/phone_profile.json "
                       "to a probe's outputs (gen/phone.py)")
    p.add_argument("--frames", help="the probe's frames folder: written there without --from, read from there with it")
    p.add_argument("--count", type=int, default=20, help="frames written (without --from)")
    p.add_argument("--from", dest="probe", help="probe.json: a browser's outputs of every path on the frames")
    p.add_argument("--out", help="where the fitted profile is written (default: print only)")
    e = sub.add_parser("exam-phone", help="E4: today's lab models through INTER_AREA and through the phone's path "
                       "(live → cap → find_next / find_inside), without retraining")
    e.add_argument("--model", required=True, choices=("edges",))
    e.add_argument("--count", type=int, default=40, help="photos of each exam set (the same ones every run)")
    e.add_argument("--version", help="the model version (default: the lab's, scripts/scan-lab/models-version)")
    e.add_argument("--out", help="the folder exam_phone.json goes to (default: the work folder)")
    a = ap.parse_args(argv)
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
        return 0 if qa(find_run(a.run), a.sample, a.jobs)["passed"] else 1
    elif a.command == "profile":
        return profile(a)
    elif a.command == "exam-phone":
        from .exam_phone import main as exam_phone
        exam_phone(a.model, a.count, a.version, a.out)
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
