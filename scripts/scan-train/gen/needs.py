"""What the generator's own steps tell the automatic cycle's report (docs/scan-training.md → "The automatic cycle" →
"The generator tunes itself"): `gen bg fetch`, `gen tune` and `gen ablate` each leave their lines here, and the cycle
(loop.py) reads them with collect() into the report's notes and needsOwner.

  <home>/gen/notes/<step>.json   {"at", "step", "notes": [str]} — what the step did last (replaced each run)
  <home>/gen/needs.json          {"version": 1, "items": {id: {"text", "from", "since", "seen"}}} — what the
                                 generator cannot make by itself: a new effect, a new document type, photos of a kind
                                 no free source gives. An item stays until the step that raised it finds it solved
                                 (resolve) — the owner reads it under needsOwner in every report until then.

Plain words only, never a worker's name, number or picture, never a file name of a real page."""
import datetime

from . import capture as gcap

NEEDS = "needs.json"


def _now(now=None):
    return (now or datetime.datetime.now(datetime.timezone.utc)).isoformat(timespec="seconds")


def load(work=None):
    got = gcap.read(gcap.gen_dir(work) / NEEDS) or {}
    items = got.get("items") if isinstance(got.get("items"), dict) else {}
    return {"version": 1, "items": items}


def need(work, ident, text, source, now=None):
    """Add (or refresh) what the owner must give: ident stable per need (e.g. "effect:sharpness")."""
    d = load(work)
    old = d["items"].get(ident) or {}
    d["items"][ident] = {"text": text, "from": source, "since": old.get("since") or _now(now), "seen": _now(now)}
    gcap.write(gcap.gen_dir(work) / NEEDS, d)


def resolve(work, ident):
    """A need its step finds solved: removed (no write when it was not there)."""
    d = load(work)
    if d["items"].pop(ident, None) is not None:
        gcap.write(gcap.gen_dir(work) / NEEDS, d)


def note(work, step, lines, now=None):
    """The step's lines for this cycle's report (printed too, each as "note: …")."""
    lines = [str(x) for x in lines if x]
    for x in lines:
        print(f"note: {x}", flush=True)
    gcap.write(gcap.gen_dir(work) / "notes" / f"{step}.json", {"at": _now(now), "step": step, "notes": lines})


def collect(work=None, steps=("bg-fetch", "tune", "ablate"), since=None):
    """→ {"notes": [str], "needsOwner": [str]} for the cycle's report: each step's last lines (only those written at
    or after `since`, an ISO time, when given) and every open need."""
    notes = []
    for s in steps:
        got = gcap.read(gcap.gen_dir(work) / "notes" / f"{s}.json")
        if got and (since is None or str(got.get("at") or "") >= str(since)):
            notes += [f"{s}: {x}" for x in got.get("notes") or []]
    needs = [v["text"] for _, v in sorted(load(work)["items"].items())]
    return {"notes": notes, "needsOwner": needs}
