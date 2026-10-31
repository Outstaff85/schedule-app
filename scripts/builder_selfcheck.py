#!/usr/bin/env python3
"""The builder's bytes where it really runs (docs/backend.md → The golden hashes): asks a `fill_form_101` — production
after a deploy, or the Tests workflow's Cloud Functions image — for its self-check ({"ping": true, "selftest": true}: no
login, no secret, no worker's data) and compares the hashes with tests/auth/builder_golden.json.

  python scripts/builder_selfcheck.py <url> [--tries N] [--wait SECONDS]

Exit 0 when every hash matches, 1 otherwise, naming what differs. Standard library only: it runs before any venv."""

import argparse
import json
import pathlib
import sys
import time
import urllib.request

GOLDEN = pathlib.Path(__file__).resolve().parents[1] / "tests" / "auth" / "builder_golden.json"


def differences(answer, golden):
    """What differs between a self-check's answer and the golden file → [text]; [] when they agree."""
    if not isinstance(answer, dict) or not isinstance(answer.get("builders"), dict) or not answer["builders"]:
        return ["no self-check in the answer (an older deploy?)"]
    if answer.get("builder") not in answer["builders"]:
        return [f"the answer has no hashes for its builder {answer.get('builder')}"]
    out = []
    for version, have in answer["builders"].items():
        want = (golden.get("builders") or {}).get(version)
        if not want:
            out.append(f"no golden hashes for builder {version}")
            continue
        out += [f"{version} {k}: {have.get(k)} is not the golden {want.get(k)}" for k in sorted(set(want) | set(have)) if have.get(k) != want.get(k)]
    return out


def ask(url):
    req = urllib.request.Request(url, data=json.dumps({"ping": True, "selftest": True}).encode(), headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--tries", type=int, default=1, help="a deploy's new revision or a starting container may not answer at once")
    ap.add_argument("--wait", type=float, default=20)
    args = ap.parse_args()
    golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
    problems = ["no answer"]
    for i in range(args.tries):
        if i:
            time.sleep(args.wait)
        try:
            answer = ask(args.url)
        except Exception as e:
            problems = [f"no answer: {e}"]
            print(f"try {i + 1}: {problems[0]}", flush=True)
            continue
        problems = differences(answer, golden)
        print(f"try {i + 1}: {json.dumps({k: v for k, v in answer.items() if k != 'builders'})}, {len(problems)} differences", flush=True)
        if not problems:
            print("The builder's bytes are the golden ones.")
            return 0
    print("\n".join(problems))
    return 1


if __name__ == "__main__":
    sys.exit(main())
