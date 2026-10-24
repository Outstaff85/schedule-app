"""python -m gen <command> (run from scripts/scan-train; docs/scan-training.md → "Kept apart", "Made-up sets: build,
verify, QA").

  python -m gen sources            # every source by kind and side
  python -m gen sources --check    # and fail (exit 1) when the exam is not kept apart
  python -m gen build --model edges|doctype|he --count N --seed S --jobs J --out DIR   # a made-up set + its manifest
  python -m gen verify --run DIR --sample 50    # draw a sample again byte for byte; fail on what the exam keeps
  python -m gen qa --run DIR                    # the QA sheet (DIR/qa/index.html) and purity.json
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
