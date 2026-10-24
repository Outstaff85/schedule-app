"""The open sets made on the owner's PC — MIDV (midv.py: midv/, midv-mrz/), SmartDoc (smartdoc.py:
smartdoc/), the background photos for the made-up document photos (backgrounds/: CC0 / public-domain photos
of tables, cloths, floors from Openverse, their sources in sources.json and the bank's catalog.json — gen/backgrounds.py),
the owner's own shots of empty surfaces (backgrounds-own/) and the cut-outs laid over documents (occluders/) — kept in
the PRIVATE bucket DATA under datasets/<set>/ instead of only on the PC
(docs/scan-training.md → 4, "MIDV", "The background bank"): `push` uploads the made sets (never a download's raw/ folder),
`pull` brings them back before a training on any PC. MIDV's terms allow no public copy: only the private
bucket. The owner's own HF token on the PC (hf auth login).

  python datasets_hf.py push                  # every set made here → hf://buckets/OutStaff/scanner-data/datasets/
  python datasets_hf.py pull                  # → the work folder (~/.scan-train or SCAN_TRAIN_HOME)
  python datasets_hf.py pull midv-mrz         # one set
"""
import argparse

from home import DATA, WORK

SETS = ("midv", "midv-mrz", "smartdoc", "backgrounds", "backgrounds-own", "occluders")


def remote(name):
    return f"hf://buckets/{DATA}/datasets/{name}"


def _check(names):
    unknown = [x for x in names if x not in SETS]
    if unknown:
        raise SystemExit(f"unknown sets {unknown}: {', '.join(SETS)}")
    return list(names) or list(SETS)


def push(names=(), api=None):
    """The sets made here → the private bucket (a set not made on this PC is skipped)."""
    if api is None:
        from huggingface_hub import HfApi
        api = HfApi()
    for name in _check(names):
        local = WORK / name
        if not local.is_dir():
            print(f"{name}: not made on this PC — skipped")
            continue
        api.sync_bucket(str(local), remote(name), exclude=["raw/*"], quiet=True)
        print(f"{name}: {local} → {remote(name)}")


def pull(names=(), api=None):
    """The sets in the private bucket → the work folder."""
    if api is None:
        from huggingface_hub import HfApi
        api = HfApi()
    for name in _check(names):
        local = WORK / name
        local.mkdir(parents=True, exist_ok=True)
        try:
            api.sync_bucket(remote(name), str(local), quiet=True)
        except Exception as e:   # a set not pushed yet (backgrounds-own, occluders before the owner's first shots)
            print(f"{name}: not in the bucket ({type(e).__name__}) — skipped")
            continue
        print(f"{name}: {remote(name)} → {local}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=("push", "pull"))
    ap.add_argument("sets", nargs="*", help=f"which sets ({', '.join(SETS)}; default all)")
    a = ap.parse_args()
    (push if a.action == "push" else pull)(a.sets)


if __name__ == "__main__":
    main()
