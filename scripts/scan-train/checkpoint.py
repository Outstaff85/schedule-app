"""A training's progress kept on the PC (docs/scan-training.md → 4, "Stopped and picked up again"): after every
epoch each model's state — its weights, the optimizer's and the schedule's, the epoch, the best weights so
far — is written to ~/.scan-train/checkpoints/<model>.pt (written aside, then put in place: a crash or a
cut-off power while writing leaves the last one whole). clean.py and publish.py keep the folder.

  --resume       a run that stopped (Ctrl+C, a crash, the PC turned off) goes on where it stopped: the same
                 weights, optimizer, schedule and epochs — only with the very same data (its info, the data
                 fingerprint included, must be this run's); one that had finished is only exported again
  --more         a new run (fresh schedule, the epochs given) from the last run's weights — its best ones when
                 it kept them: to train a model further, on more or new examples. Refused when the class table
                 (DOCTYPES) or heldout.json changed since (the old weights learned other labels or saw what is now
                 the exam), when any example it trained on is on the exam side today (a record's split moved from
                 train to exam: its split key changed, or pull.py kept more exam keys — gen.manifest.exam_ids against
                 the checkpoint's trainIds), or when the checkpoint records no data fingerprint or no training ids;
                 a loud warning when only the training examples changed
  --more-anyway  --more even then (the owner's explicit call)

The data fingerprint (gen.manifest.data_fingerprint, info["data"]) is what a training records of its data: the class
table's and heldout.json's sha256, the training examples (each one's short id too), a made-up set's run fingerprint,
the sizes. publish.py
stamps the checkpoint of each model it publishes with the version ("published"), so --more says what it goes on from.
What a run loses at most is the epoch it was in. torch is imported only where the weights are read or written."""
import os
import random

from gen.manifest import MOVED, NO_IDS, compare_data, exam_ids
from home import WORK

DIR = WORK / "checkpoints"


def path(name):
    return DIR / f"{name}.pt"


def add_args(ap):
    ap.add_argument("--resume", action="store_true", help="go on with the run that stopped, where it stopped (the same data only)")
    ap.add_argument("--more", action="store_true", help="a new run from the last run's (best) weights")
    ap.add_argument("--more-anyway", action="store_true", help="--more even when the class table or heldout.json changed since "
                    "(the old weights learned other labels or saw today's exam) — the owner's explicit call")


def _write(state, dest):
    import torch
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp")
    torch.save(state, tmp)
    os.replace(tmp, dest)


def save(name, info, net, opt, sched, epoch, epochs, best=None):
    """The state after `epoch` epochs of `epochs` (best: the best weights so far and their score, if kept)."""
    import torch
    state = {"info": info, "net": {k: v.detach().cpu() for k, v in net.state_dict().items()},
             "opt": opt.state_dict() if opt else None, "sched": sched.state_dict() if sched else None,
             "epoch": epoch, "epochs": epochs, "best": best,
             "rng": random.getstate(), "torch_rng": torch.get_rng_state()}
    _write(state, path(name))


def load(name):
    p = path(name)
    if not p.exists():
        return None
    import torch
    return torch.load(p, map_location="cpu", weights_only=False)


def stamp(file, published):
    """publish.py: the checkpoint the published model came from records its version ({"version", "at"})."""
    import torch
    ck = torch.load(file, map_location="cpu", weights_only=False)
    ck["published"] = published
    _write(ck, file)


def _differ(old, new):
    return sorted(k for k in set(old) | set(new) if old.get(k) != new.get(k))


def begin(name, args, info):
    """The saved state to start from: with --resume the run that stopped (its info must be this run's — the same
    model, base, size and data fingerprint), with --more the last run of the same model and size (the base, the data
    and where it came from may differ — the data by the rules above); else None."""
    if not (getattr(args, "resume", False) or getattr(args, "more", False)):
        return None
    ck = load(name)
    if ck is None:
        raise SystemExit(f"no saved progress of {name} ({path(name)}) — start without --resume / --more")
    old = ck.get("info") or {}
    if getattr(args, "resume", False):
        if old != info:
            keys = _differ(old, info)
            why = ("the data changed since it stopped (" + ", ".join(compare_data(old.get("data"), info.get("data") or {})[1]) + ")"
                   if keys == ["data"] else "it is of " + ", ".join(f"{k} {old.get(k)!r}" for k in keys if k != "data")
                   + (" and other data" if "data" in keys else ""))
            raise SystemExit(f"the saved progress of {name} cannot be resumed: {why} — start without --resume (or --more)")
        return ck
    plain = {k: v for k, v in info.items() if k not in ("base", "data", "from")}
    if not all(old.get(k) == v for k, v in plain.items()):
        raise SystemExit(f"the saved progress of {name} is of {{{', '.join(f'{k}: {old.get(k)!r}' for k in plain)}}}, not "
                         f"{plain} — start without --resume / --more")
    verdict, diff = compare_data(old.get("data"), info.get("data") or {}, exam=exam_ids(WORK))
    if verdict == "labels":
        if diff == ["no data fingerprint"]:
            what = "it records no data fingerprint (made before Training 4): what it learned cannot be checked"
        elif any(MOVED in d or d == NO_IDS for d in diff):
            what = ("examples it trained on are on the exam side today, or it records no training ids (" + ", ".join(diff)
                    + "): the users' exam would measure pages the weights have seen")
        else:
            what = "the class table (DOCTYPES) or heldout.json changed since (" + ", ".join(diff) + ")"
        if not getattr(args, "more_anyway", False):
            raise SystemExit(f"--more refused for {name}: {what} — train fresh (without --more), or --more-anyway on the owner's explicit call")
        print(f"!!! WARNING: --more-anyway for {name}: {what}. The old weights carry it forward; the exam may not show it. !!!")
    elif verdict == "data":
        print(f"!!! WARNING: --more for {name} on other data than the saved run's ({', '.join(diff)} changed) — going on from its weights "
              "(more examples is what --more is for; a change of the split or labels needs a fresh run) !!!")
    return ck


def restore(ck, args, net, opt=None, sched=None):
    """Puts the saved state in place: → (the first epoch to run, the best so far). --more: only the weights
    (the best ones when kept), a fresh optimizer and schedule, from epoch 0. Weights of another graph (another base
    version's) stop the run with what to do."""
    if ck is None:
        return 0, None
    weights = ((ck.get("best") or {}).get("net") or ck["net"]) if args.more else ck["net"]
    try:
        net.load_state_dict(weights)
    except RuntimeError as e:
        base = (ck.get("info") or {}).get("base")
        raise SystemExit(f"the saved weights do not fit this network ({str(e).splitlines()[0][:160]}): they are of "
                         + (f"base {base}'s graph — train with --base {base} --more, or without --more" if base
                            else "another network — train without --resume / --more"))
    if args.more:
        print(f"  from the last run's {'best ' if ck.get('best') else ''}weights ({ck['epoch']} epochs)")
        return 0, None
    import torch
    if opt is not None and ck.get("opt"):
        opt.load_state_dict(ck["opt"])
    if sched is not None and ck.get("sched"):
        sched.load_state_dict(ck["sched"])
    random.setstate(ck["rng"])
    torch.set_rng_state(ck["torch_rng"])
    print(f"  going on after epoch {ck['epoch']} of {ck['epochs']}")
    return ck["epoch"], ck.get("best")


def check_steps(ck, args, total_steps):
    """A resumed one-cycle schedule must have been made for this run's steps (epochs × batches per epoch): a different
    count would run past its end ("Tried to step N times") or end early."""
    if ck is None or not getattr(args, "resume", False):
        return
    saved = (ck.get("sched") or {}).get("total_steps")
    if saved is not None and saved != total_steps:
        raise SystemExit(f"the saved schedule was made for {saved} steps, this run has {total_steps} (the set or the batch changed) "
                         "— start without --resume")


def epochs_of(ck, args, wanted):
    """How many epochs the run has: a resumed run keeps its own (its schedule was made for them)."""
    return ck["epochs"] if ck is not None and args.resume else wanted


def stopped(name, epoch):
    raise SystemExit(f"stopped — {name}'s progress after epoch {epoch} is saved ({path(name)}); "
                     f"go on with the same command and --resume")
