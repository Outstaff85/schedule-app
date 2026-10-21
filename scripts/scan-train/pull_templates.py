"""The real pages for synth_docs.py --templates (docs/scan-training.md → 4, "Made-up document photos"):
the cut pages of the full documents the site collected (H8a: documents/…/record.json with its pages,
each with the kind the user left) are copied from the private bucket to
~/.scan-train/templates/<kind>/ — ID cards, their backs, passports, ספחים — up to --per pages of each
kind, the newest first. They are workers' documents: they stay on this PC, synth_docs.py washes out
their face and text, and clean.py / publish.py delete them with the other copies. The owner's own
photos of Israeli documents, cut straight, can be put into the same folders by hand.

  python pull_templates.py --per 100
"""
import argparse
import json
import tempfile

from common import DATA, WORK

KINDS = ("id_front", "id_back", "passport", "sefach")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per", type=int, default=100, help="pages of each kind at most")
    a = ap.parse_args()
    from huggingface_hub import HfApi
    api = HfApi()
    try:
        records = sorted((f.path for f in api.list_bucket_tree(DATA, prefix="documents/", recursive=True)
                          if f.path.endswith("/record.json")), key=lambda f: f.split("/")[2], reverse=True)   # documents/<tenant>/<YYYY-MM>/…: the newest months first
    except Exception as e:
        raise SystemExit(f"the private bucket {DATA} cannot be read ({e}) — hf auth login as OutStaff")
    want = {k: [] for k in KINDS}
    with tempfile.TemporaryDirectory() as tmp:
        api.download_bucket_files(DATA, [(f, f"{tmp}/{i}.json") for i, f in enumerate(records)])
        for i, f in enumerate(records):
            try:
                r = json.loads(open(f"{tmp}/{i}.json", encoding="utf-8").read())
            except Exception:
                continue
            for n, pg in enumerate(r.get("pages") or []):
                k = pg.get("doctype")
                if k in want and len(want[k]) < a.per and pg.get("path"):
                    want[k].append((pg["path"], WORK / "templates" / k / f"{r.get('id') or i}-{n}.jpg"))
    pairs = [(src, dest) for v in want.values() for src, dest in v if not dest.exists()]
    for _, dest in pairs:
        dest.parent.mkdir(parents=True, exist_ok=True)
    if pairs:
        api.download_bucket_files(DATA, [(src, str(dest)) for src, dest in pairs])
    print(f"templates in {WORK / 'templates'}: " + ", ".join(f"{k} {len(v)}" for k, v in want.items()))


if __name__ == "__main__":
    main()
