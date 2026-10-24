"""python -m gen <command> (run from scripts/scan-train; docs/scan-training.md → "Kept apart").

  python -m gen sources            # every source by kind and side
  python -m gen sources --check    # and fail (exit 1) when the exam is not kept apart
"""
import argparse
import sys

import home  # noqa: F401 — prints in UTF-8 whatever the console's code page


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m gen")
    sub = ap.add_subparsers(dest="command", required=True)
    s = sub.add_parser("sources", help="the sources registry: counts by kind and side")
    s.add_argument("--check", action="store_true", help="fail when an exam or golden key is on the training side, a held-out "
                   "page is in training, a site page has no side, or heldout.json changed after the exam sets were made")
    s.add_argument("--work", help="the work folder (default SCAN_TRAIN_HOME, else ~/.scan-train)")
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
