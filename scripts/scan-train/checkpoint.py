"""A training's progress kept on the PC (docs/scan-training.md → 4, "Stopped and picked up again"): after every
epoch each model's state — its weights, the optimizer's and the schedule's, the epoch, the best weights so
far — is written to ~/.scan-train/checkpoints/<model>.pt (written aside, then put in place: a crash or a
cut-off power while writing leaves the last one whole). clean.py and publish.py keep the folder.

  --resume   a run that stopped (Ctrl+C, a crash, the PC turned off) goes on where it stopped: the same
             weights, optimizer, schedule and epochs; one that had finished is only exported again
  --more     a new run (fresh schedule, the epochs given) from the last run's weights — its best ones when
             it kept them: to train a model further, on more or new examples

What a run loses at most is the epoch it was in."""
import os
import random

import torch

from home import WORK

DIR = WORK / "checkpoints"


def path(name):
    return DIR / f"{name}.pt"


def add_args(ap):
    ap.add_argument("--resume", action="store_true", help="go on with the run that stopped, where it stopped")
    ap.add_argument("--more", action="store_true", help="a new run from the last run's (best) weights")


def save(name, info, net, opt, sched, epoch, epochs, best=None):
    """The state after `epoch` epochs of `epochs` (best: the best weights so far and their score, if kept)."""
    DIR.mkdir(parents=True, exist_ok=True)
    state = {"info": info, "net": {k: v.detach().cpu() for k, v in net.state_dict().items()},
             "opt": opt.state_dict() if opt else None, "sched": sched.state_dict() if sched else None,
             "epoch": epoch, "epochs": epochs, "best": best,
             "rng": random.getstate(), "torch_rng": torch.get_rng_state()}
    tmp = path(name).with_suffix(".tmp")
    torch.save(state, tmp)
    os.replace(tmp, path(name))


def load(name):
    p = path(name)
    return torch.load(p, map_location="cpu", weights_only=False) if p.exists() else None


def begin(name, args, info):
    """The saved state to start from: with --resume the run that stopped (its info must be this run's —
    the same model, base and size), with --more the last run of the same model and size; else None."""
    if not (getattr(args, "resume", False) or getattr(args, "more", False)):
        return None
    ck = load(name)
    if ck is None:
        raise SystemExit(f"no saved progress of {name} ({path(name)}) — start without --resume / --more")
    same = ck["info"] == info if args.resume else all(ck["info"].get(k) == v for k, v in info.items() if k != "base")
    if not same:
        raise SystemExit(f"the saved progress of {name} is of {ck['info']}, not {info} — start without --resume / --more")
    return ck


def restore(ck, args, net, opt=None, sched=None):
    """Puts the saved state in place: → (the first epoch to run, the best so far). --more: only the weights
    (the best ones when kept), a fresh optimizer and schedule, from epoch 0."""
    if ck is None:
        return 0, None
    if args.more:
        net.load_state_dict((ck.get("best") or {}).get("net") or ck["net"])
        print(f"  from the last run's {'best ' if ck.get('best') else ''}weights ({ck['epoch']} epochs)")
        return 0, None
    net.load_state_dict(ck["net"])
    if opt is not None and ck.get("opt"):
        opt.load_state_dict(ck["opt"])
    if sched is not None and ck.get("sched"):
        sched.load_state_dict(ck["sched"])
    random.setstate(ck["rng"])
    torch.set_rng_state(ck["torch_rng"])
    print(f"  going on after epoch {ck['epoch']} of {ck['epochs']}")
    return ck["epoch"], ck.get("best")


def epochs_of(ck, args, wanted):
    """How many epochs the run has: a resumed run keeps its own (its schedule was made for them)."""
    return ck["epochs"] if ck is not None and args.resume else wanted


def stopped(name, epoch):
    raise SystemExit(f"stopped — {name}'s progress after epoch {epoch} is saved ({path(name)}); "
                     f"go on with the same command and --resume")
