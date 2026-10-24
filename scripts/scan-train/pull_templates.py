"""The real pages for synth_docs.py --templates (docs/scan-training.md → 4, "Made-up document photos"):
the cut pages of the full documents the site collected (H8a: documents/…/record.json with its pages,
each with the kind the user left) are copied from the private bucket to
~/.scan-train/templates/<kind>/ — ID cards, their backs, passports, ספחים — up to --per pages of each
kind, the newest first. They are workers' documents: they stay on this PC, synth_docs.py washes out
their face and text, and clean.py / publish.py delete them with the other copies; a page pulled before whose document
is no longer in the bucket (deleted on request, delete_data.py) is deleted here too. The owner's own
photos of Israeli documents, cut straight, are uploaded to the same private bucket under
templates/<kind>/ (hf buckets sync <folder> hf://buckets/OutStaff/scanner-data/templates) and copied
too, every one of them, as own-<name>.

  python pull_templates.py --per 100
"""
import argparse
import json
import pathlib
import re
import tempfile

from common import DATA, WORK

KINDS = ("id_front", "id_back", "passport", "sefach")
OWN_KINDS = KINDS + ("insert",)
PICTURES = (".jpg", ".jpeg", ".png", ".webp")
# a page this script pulled: <the document's id (a Firestore id, 20 letters and digits)>-<n>.jpg
PULLED = re.compile(r"([A-Za-z0-9]{20})-\d+\.jpg")


def stale(folder, ids):
    """The pages pulled before under folder/<kind>/ whose document is no longer in the bucket (ids: the documents
    there) — the owner's own pages (own-*) and pages put there by hand stay."""
    out = []
    for p in pathlib.Path(folder).glob("*/*.jpg"):
        m = PULLED.fullmatch(p.name)
        if m and m.group(1) not in ids:
            out.append(p)
    return sorted(out)


def own_pages(paths):
    """The owner's uploaded pages among the bucket's paths: [(path, kind, file name)] — templates/<kind>/<name>,
    a known kind and a picture only."""
    out = []
    for f in paths:
        parts = f.split("/")
        if len(parts) == 3 and parts[0] == "templates" and parts[1] in OWN_KINDS and parts[2].lower().endswith(PICTURES):
            out.append((f, parts[1], parts[2]))
    return out


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
    gone = stale(WORK / "templates", {f.split("/")[3] for f in records if len(f.split("/")) == 5})
    for p in gone:
        p.unlink(missing_ok=True)
    want = {k: [] for k in KINDS}
    with tempfile.TemporaryDirectory() as tmp:
        if records:
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
    try:
        own = own_pages([f.path for f in api.list_bucket_tree(DATA, prefix="templates/", recursive=True)])
    except Exception:
        own = []
    mine = [(src, WORK / "templates" / k / f"own-{name}") for src, k, name in own]
    pairs = [(src, dest) for v in want.values() for src, dest in v if not dest.exists()] + [(s, d) for s, d in mine if not d.exists()]
    for _, dest in pairs:
        dest.parent.mkdir(parents=True, exist_ok=True)
    if pairs:
        api.download_bucket_files(DATA, [(src, str(dest)) for src, dest in pairs])
    print(f"templates in {WORK / 'templates'}: " + ", ".join(f"{k} {len(v)}" for k, v in want.items())
          + f"; the owner's own pages: {len(mine)}; deleted (their document no longer in the bucket): {len(gone)}")


if __name__ == "__main__":
    main()
