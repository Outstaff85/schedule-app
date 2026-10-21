"""The open sets made on the owner's PC — MIDV (midv.py: midv/, midv-mrz/) and SmartDoc (smartdoc.py:
smartdoc/) — kept in the PRIVATE bucket DATA under datasets/<set>/ instead of only on the PC
(docs/scan-training.md → 4, "MIDV"): `push` uploads the made sets (never a download's raw/ folder),
`pull` brings them back before a training on any PC. MIDV's terms allow no public copy: only the private
bucket. The owner's own HF token on the PC (hf auth login).

  python datasets_hf.py push                  # every set made here → hf://buckets/OutStaff/scanner-data/datasets/
  python datasets_hf.py pull                  # → the work folder (~/.scan-train or SCAN_TRAIN_HOME)
  python datasets_hf.py pull midv-mrz         # one set
"""
import argparse

from home import DATA, WORK

SETS = ("midv", "midv-mrz", "smartdoc")


def remote(name):
    return f"hf://buckets/{DATA}/datasets/{name}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=("push", "pull"))
    ap.add_argument("sets", nargs="*", help=f"which sets ({', '.join(SETS)}; default all)")
    a = ap.parse_args()
    unknown = [x for x in a.sets if x not in SETS]
    if unknown:
        raise SystemExit(f"unknown sets {unknown}: {', '.join(SETS)}")
    from huggingface_hub import HfApi
    api = HfApi()
    for name in a.sets or SETS:
        local = WORK / name
        if a.action == "push":
            if not local.is_dir():
                print(f"{name}: not made on this PC — skipped")
                continue
            api.sync_bucket(str(local), remote(name), exclude=["raw/*"], quiet=True)
            print(f"{name}: {local} → {remote(name)}")
        else:
            local.mkdir(parents=True, exist_ok=True)
            api.sync_bucket(remote(name), str(local), quiet=True)
            print(f"{name}: {remote(name)} → {local}")


if __name__ == "__main__":
    main()
