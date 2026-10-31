"""gen build — today's generators through the manifest (docs/scan-training.md → "Made-up sets: build, verify, QA").

  python -m gen build --model edges   --count 20000 --seed 1 --jobs 6 --out ~/.scan-train/synth/docs   # synth_docs.py
  python -m gen build --model doctype --count 6000  --seed 1 --jobs 6 --out ~/.scan-train/synth/pages  # synth_pages.py
  python -m gen build --model he      --count 3000  --seed 1 --jobs 6 --out ~/.scan-train/synth/he-fields/train  # synth_fields.py

`python -m gen build --model edges` draws scenes (gen/scene.py, written by gen/outputs/edges.py: one camera for the
table and the documents); synth_docs.py keeps today's flat-crop photos for comparison (its run.json names its generator).
`python -m gen build --model doctype,mrz,he,face` (cut_models) cuts the scenes' pages by the lab's own edges model
(gen/phone_run.py, its writers gen/outputs/doctype.py, mrz.py, he.py, face.py): one run, a folder per writer.

Each of today's generators draws exactly as it always did (one stream per example, gen.rng.legacy: an example depends only on
the seed and its index) and writes what it always wrote (examples.json, pages.json, labels.tsv), and the set's
folder also gets manifest.jsonl and run.json (gen/manifest.py). The old CLIs (synth_docs.py, synth_pages.py,
synth_fields.py) are thin wrappers over this with their own defaults (20000 / 6000 / 3000).

A generator module gives: MODEL, CHUNK, gen_args(ap) (its CLI), gen_params(args) (everything needed to draw any
example again, JSON), gen_prepare(folder, params), gen_jobs(params, indices, folder) and its _batch(job) → items
{"index", "id", "entry", "files", "meta"}, gen_write(folder, params, items). regenerate() draws chosen indices again
into another folder (gen verify)."""
import argparse
import importlib
import pathlib

from . import manifest

GENERATORS = {"edges": "synth_docs", "doctype": "synth_pages", "he": "synth_fields"}   # today's (the old CLIs)
SCENES = {"edges": "gen.outputs.edges", "cuts": "gen.phone_run"}   # python -m gen build: the scenes, the phone's own cuts
CUT_MODELS = ("doctype", "mrz", "he", "face")


def cut_models(spec, force=False):
    """The writers a --model names for the phone's own cuts (gen/phone_run.py), or None for one of today's generators:
    a list of doctype, mrz, he, face — any list of two or more, mrz or face alone, or doctype / he alone with --cuts."""
    names = [m for m in str(spec).split(",") if m]
    if names == ["cuts"]:
        return list(CUT_MODELS)
    if not names or any(m not in CUT_MODELS for m in names):
        if len(names) > 1 or any(m not in GENERATORS for m in names):
            raise SystemExit(f"--model {spec}: edges, doctype or he alone, or a list of {', '.join(CUT_MODELS)}")
        return None
    if len(names) > 1 or force or set(names) & {"mrz", "face"}:
        return list(dict.fromkeys(names))
    return None


def module(model, generator=None):
    """A generator module: the one a run's params name ("generator"), else today's for the model."""
    if generator:
        return importlib.import_module(generator)
    if model not in GENERATORS:
        raise SystemExit(f"no generator for {model!r} (one of {', '.join(GENERATORS)})")
    return importlib.import_module(GENERATORS[model])


def parser(model, prog=None, generator=None):
    ap = argparse.ArgumentParser(prog=prog)
    module(model, generator).gen_args(ap)
    return ap


def cli(model, argv=None, prog=None, generator=None):
    """A generator's CLI (its options and defaults) → build()."""
    from home import gentle
    a = parser(model, prog, generator).parse_args(argv)
    jobs = gentle()   # below-normal priority, the first core left free (the default number of processes)
    mod = module(model, generator)
    return build(model, mod.gen_params(a), a.jobs or jobs)


def draw(mod, params, indices, folder, jobs):
    """The items of the indices, sorted by index — the same whatever the number of processes."""
    work = mod.gen_jobs(params, list(indices), str(folder))
    if jobs > 1 and len(work) > 1:
        from home import RESERVE, memory_jobs
        fits = memory_jobs(jobs, getattr(mod, "PROCESS_GB", 0.5))   # the generator's own measure of one process
        if fits < jobs:
            print(f"memory: {fits} processes instead of {jobs} (each ~{getattr(mod, 'PROCESS_GB', 0.5)} GB, "
                  f"{RESERVE:.0%} of the free memory left to the system)", flush=True)
        jobs = fits
    if jobs > 1 and len(work) > 1:
        from multiprocessing import Pool
        with Pool(min(jobs, len(work))) as pool:
            done = pool.map(mod._batch, work)
    else:
        done = [mod._batch(w) for w in work]
    return sorted((it for b in done for it in b), key=lambda it: it["index"])


def rows_of(model, params, items, folder):
    folder = pathlib.Path(folder)
    return [manifest.row(model, params["split"], params["seed"], it["index"], it["id"], it["meta"],
                         [(f, manifest.sha256_file(folder / f)) for f in it["files"]]) for it in items]


def build(model, params, jobs):
    """Draw the set into params["out"]: the generator's own files, manifest.jsonl and run.json. → (folder, rows, run)."""
    mod = module(model, params.get("generator"))
    folder = pathlib.Path(params["out"])
    folder.mkdir(parents=True, exist_ok=True)
    for stale in (folder / "verify.json", folder / "qa" / "purity.json"):   # of a set drawn here before
        stale.unlink(missing_ok=True)
    mod.gen_prepare(folder, params)
    every = mod.indices(params) if hasattr(mod, "indices") else range(params["count"])   # a generator may draw more (real scenes)
    items = draw(mod, params, every, folder, jobs)
    mod.gen_write(folder, params, items)
    rows = rows_of(model, params, items, folder)
    sha = manifest.write_manifest(folder, rows)
    info = manifest.write_run(folder, model, params["split"], params, rows, sha)
    print(f"manifest.jsonl: {len(rows)} examples, fingerprint {sha[:12]} — next: python -m gen qa --run {folder}")
    return folder, rows, info


# ---------- drawing chosen examples again (gen verify) ----------
def _found(entry, roots):
    """A recorded input file on this PC: at its path when its sha1 is still the same, else under one of roots by
    its last two path parts (kind folder / name) with the same sha1; None when not here."""
    from . import common as gc
    p = pathlib.Path(entry["path"])
    if gc.file_sha1(p) == entry.get("sha1"):
        return str(p)
    for root in roots:
        q = pathlib.Path(root).joinpath(*p.parts[-2:])
        if gc.file_sha1(q) == entry.get("sha1"):
            return str(q)
        q = pathlib.Path(root) / p.name
        if gc.file_sha1(q) == entry.get("sha1"):
            return str(q)
    return None


WHAT = {"pages": "page", "photos": "background", "pdfs": "PDF", "occluders": "cut-out", "real": "attempt photo", "open": "open-set photo"}


def resolve(params, work=None):
    """The run's parameters with every input file found on this PC (SystemExit naming the missing one by a sha1
    prefix: the example cannot be drawn again without it)."""
    import home
    work = pathlib.Path(work or home.WORK)
    out = dict(params)
    assets = pathlib.Path(__file__).resolve().parents[3] / "functions" / "assets" / "form101"
    for key, roots in (("pages", [work / "templates"]), ("photos", [work / "backgrounds", work / "backgrounds-own"]),
                       ("pdfs", [work / "contracts", assets]), ("occluders", [work / "occluders"]), ("real", [work / "img"]),
                       ("open", [work / "midv", work / "smartdoc"])):
        fixed = []
        for e in params.get(key) or []:
            got = _found(e, roots)
            if got is None:
                raise SystemExit(f"a {WHAT[key]} the run used ({(e.get('sha1') or '?')[:8]}) is not on "
                                 "this PC with the same content — the run cannot be drawn again")
            fixed.append({**e, "path": got})
        out[key] = fixed
    for key in ("latin", "hebrew", "fonts"):
        missing = [f for f in params.get(key) or [] if not pathlib.Path(f).exists()]
        if missing:
            raise SystemExit(f"fonts the run used are not on this PC: {', '.join(pathlib.Path(f).name for f in missing)}")
    return out


def regenerate(run, indices, folder, jobs=1, work=None):
    """Draw the chosen indices of a run (its run.json) again into folder → their manifest rows."""
    model, params = run["model"], resolve(run["params"], work)
    params = {**params, "out": str(folder), "show": False}
    mod = module(model, params.get("generator"))
    mod.gen_prepare(pathlib.Path(folder), params)
    items = draw(mod, params, sorted(indices), folder, jobs)
    return rows_of(model, params, items, folder)
