"""gen verify — a made-up set is what its manifest says (docs/scan-training.md → "Made-up sets: build, verify, QA").

  python -m gen verify --run ~/.scan-train/synth/pages --sample 50     # or --run pages (under ~/.scan-train/synth/)

1. Kept apart: every manifest row is checked — a training row must not lay a held-out template, sit on an exam
   background, carry an exam split key or be cut from an open set's exam document (MIDV, SmartDoc); an exam row lays
   only held-out pages (gen.manifest.held_refs). Any such row fails the run.
2. On disk and drawn again: every output file must have the manifest's sha256, and a sample of the examples (the same
   ones every time) is drawn again into a folder of its own inside the run (deleted after) and each output's sha256
   and the labels are compared with the manifest's.
3. The libraries: a warning when the versions the pixels depend on differ from run.json's (requirements-synth.txt
   pins them) — a mismatch is then expected.
Writes <run>/verify.json; exit 1 when anything failed. Prints sha1 prefixes only."""
import json
import pathlib
import random
import shutil
import tempfile

from . import manifest


def find_run(ident, work=None):
    """A run's folder: a path holding run.json, else a folder under ~/.scan-train/synth/ or ~/.scan-train/runs/."""
    import home
    work = pathlib.Path(work or home.WORK)
    for p in (pathlib.Path(ident), work / "synth" / ident, work / "runs" / ident):
        if (p / manifest.RUN).exists():
            return p
    raise SystemExit(f"no made-up set {ident!r} with a run.json (drawn before gen build? draw it again)")


def sample_indices(rows, n):
    """The same n indices of a run every time (n ≥ the rows: all of them)."""
    idx = sorted(r["index"] for r in rows)
    return idx if n >= len(idx) else sorted(random.Random(0).sample(idx, n))


def library_warnings(run):
    now, then = manifest.libraries(), run.get("libraries") or {}
    return [f"{k} {then.get(k)} when drawn, {now.get(k)} now" for k in sorted(set(now) | set(then)) if now.get(k) != then.get(k)]


def compare(want, got):
    """[(id, why)] of the regenerated rows that differ from the manifest's."""
    by = {r["index"]: r for r in got}
    out = []
    for r in want:
        g = by.get(r["index"])
        if g is None:
            out.append((r["id"], "not drawn again"))
            continue
        if [o[1] for o in g["outputs"]] != [o[1] for o in r["outputs"]] or [o[0] for o in g["outputs"]] != [o[0] for o in r["outputs"]]:
            out.append((r["id"], "pixels differ (sha256)"))
        elif manifest.canonical(g.get("labels")) != manifest.canonical(r.get("labels")):
            out.append((r["id"], "labels differ"))
        elif g.get("templates") != r.get("templates") or g.get("backgroundId") != r.get("backgroundId"):
            out.append((r["id"], "the pages or background laid differ"))
    return out


def verify(folder, sample=50, jobs=1, work=None, quiet=False):
    """→ the result dict (also written to <run>/verify.json)."""
    from . import build
    folder = pathlib.Path(folder)
    run = manifest.read_run(folder)
    rows = manifest.read_manifest(folder)
    if not run or not rows:
        raise SystemExit(f"{folder}: no run.json / manifest.jsonl (drawn before gen build? draw it again)")
    say = (lambda *a: None) if quiet else print
    result = {"run": run.get("id"), "fingerprint": run.get("fingerprint"), "rows": len(rows), "sample": 0, "matched": 0,
              "mismatched": [], "heldRefs": [], "libraryWarnings": library_warnings(run), "passed": False}
    for w in result["libraryWarnings"]:
        say(f"WARNING: library version differs — {w}; the pictures may not match byte for byte")
    if manifest.sha256_text("".join(manifest.canonical(r) + "\n" for r in sorted(rows, key=lambda r: r["index"]))) != run.get("manifestSha256"):
        result["mismatched"].append(("manifest", "manifest.jsonl is not the one run.json names"))
    for r in rows:   # the set on disk is the one the manifest names
        for f, h in r.get("outputs") or []:
            p = folder / f
            if not p.exists() or manifest.sha256_file(p) != h:
                result["mismatched"].append((r["id"], "the file on disk is not the manifest's"))
                break
    refs = manifest.held_refs(rows, work=work)
    result["heldRefs"] = refs
    if refs:
        kinds = sorted({why for _, why in refs})
        say(f"NOT CLEAN: {len(refs)} rows reference what the exam keeps ({', '.join(kinds)})")
    idx = set(sample_indices(rows, sample))
    want = [r for r in rows if r["index"] in idx]
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="verify-", dir=folder))
    try:
        got = build.regenerate(run, idx, tmp, jobs, work)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    bad = compare(want, got)
    result.update({"sample": len(want), "matched": len(want) - len(bad)})
    result["mismatched"] += bad
    result["passed"] = not result["mismatched"] and not refs
    (folder / "verify.json").write_text(json.dumps(result, indent=1), encoding="utf-8")
    other = [m for m in result["mismatched"] if m not in bad]   # the manifest itself, the files on disk
    say(f"verify {folder.name}: {result['matched']} of {result['sample']} examples drawn again byte for byte"
        + (f"; {len(bad)} differ: " + ", ".join(f"{i} ({why})" for i, why in bad[:5]) if bad else "")
        + (f"; not as the manifest says: " + ", ".join(f"{i} ({why})" for i, why in other[:5]) if other else "")
        + f"; rows referencing what the exam keeps: {len(refs)} — " + ("PASSED" if result["passed"] else "FAILED"))
    return result
