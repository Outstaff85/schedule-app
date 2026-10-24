"""Document types, step 2 (docs/scan-plan.md → S7; /scan-train): the phone's document type model
(doctype-lite.onnx — the only one by default; owner, 2026-10-24) is trained on the page copies — an ImageNet EfficientNet-Lite (timm)
with two heads: the document type (6) and the clockwise turn the page needs (4). The turn is
learned for free: a page whose turn is known is shown turned by a random quarter turn, with the turn back as its
answer — a made-up page lies upright, a page from the phone's own cut (gen/phone_run.py, --synth-run <cuts run>) needs
its turn_k; a real page copy's turn is known only when the face finder or the owner set it (turnBy face / owner, or
turned by hand: turnFixed). Every other copy (the model's or Haiku's turn) is shown turned too but has no turn answer —
it teaches the type only: each sample carries a turn_known mask, and the turn loss (turn_loss: cross-entropy per sample)
is averaged over the known samples only. The ImageNet normalization is inside the model, so
it takes the page as RGB 0..1 like the document edges models. Exported to ONNX (input "img"
[1,3,256,256]; outputs "doctype", "turn" — probabilities) and checked to answer like the
trained model. With --synth N, N made-up upright pages (synth_pages.py) are added to the site's page
copies — or train alone while the site has collected none yet; the exam stays the site's pages. A set holding a
held-out real page, an exam split key or an open set's exam document is refused before training (gather), and so is a
made-up set drawn through gen build whose QA sheet did not pass (gen.qa.require_qa: python -m gen qa --run DIR).
Each epoch's progress is saved (checkpoint.py: --resume goes on with a run that stopped, --more trains
further from the last run's weights); the checkpoint records the data fingerprint (the class table, heldout.json, the
page ids trained on, the made-up set's run fingerprint), so --resume and --more refuse what they must.
Each page is drawn onto its 256 square as the phone draws it (gen/phone.py doctype_input, the kernel drawn from the
phone profile's capture mix; --resize area: INTER_AREA as before), and the fingerprint records the profile.
Writes ~/.scan-train/new/doctype-lite.onnx (and deletes report_doctypes.json: exam_doctypes.py runs again).
A larger model for a server (common.DOCTYPE_SERVER, doctype.onnx) is trained only with --only server; no
code runs it and publish.py never publishes it.

The data come as one list (gen/mix.py; docs/scan-training.md → "Real data and its weight"): --from-mix DIR reads a mix
made by python -m gen mix --model doctype (refused when made under another heldout.json); the old flags (doctypes.json
and --synth N) build the same list here. Each real page is repeated --real-repeat K times (capped at 30 % of an epoch),
a page whose type no one saw (labelBy self) is left out for now, each page's loss is weighed by its weight, the epoch
kept is the one with the lowest loss on the select set (the real pages of split "select", or with fewer than 20 of them the mix's made-up select
set — gen mix --select-run; never the exam; which set picked it is printed) when it has any, and --seed (default: a fresh one, printed and saved in the checkpoint; --resume takes the stopped run's) seeds the
run.

  python train_doctypes.py                                    # the phone's model, the default size
  python train_doctypes.py --phone tf_efficientnet_lite1     # the next size up for the phone
  python train_doctypes.py --only server                      # only the server's (Lite2), on request
  python train_doctypes.py --synth 6000                        # + the made-up pages (synth_pages.py)
  python train_doctypes.py --from-mix ~/.scan-train/models/doctype   # a mix (python -m gen mix --model doctype)
"""
import argparse
import pathlib
import random
from collections import Counter

import cv2
import numpy as np
import onnxruntime as ort
import timm
import torch
from torch import nn

import checkpoint
from common import DOCTYPE_MODELS, DOCTYPE_SERVER, DOCTYPE_SIZES, DOCTYPES, WORK, read_json, write_json
from gen import mix as gmix
from gen import phone
from gen import manifest
from gen.common import trains
from gen.manifest import run_fingerprint
from gen.qa import require_qa
from gen.real import newest_attempt_day, stale_warning
from gen.sources import assert_clean
from home import drop_report, gentle

S = 256
EPOCHS = {"doctype-lite.onnx": 20, "doctype.onnx": 16}
TURN_IGNORE = -100   # the turn answer of a copy not known to lie upright: no loss (CrossEntropyLoss ignore_index)


class DoctypeNet(nn.Module):
    def __init__(self, arch, pretrained=True):
        super().__init__()
        self.body = timm.create_model(arch, pretrained=pretrained, num_classes=0)
        cfg = self.body.pretrained_cfg
        self.register_buffer("mean", torch.tensor(cfg.get("mean", (0.485, 0.456, 0.406))).view(1, 3, 1, 1))
        self.register_buffer("std", torch.tensor(cfg.get("std", (0.229, 0.224, 0.225))).view(1, 3, 1, 1))
        n = self.body.num_features
        self.doctype = nn.Linear(n, len(DOCTYPES))
        self.turn = nn.Linear(n, 4)

    def logits(self, x):
        f = self.body((x - self.mean) / self.std)
        return self.doctype(f), self.turn(f)

    def forward(self, x):  # what the ONNX file answers: probabilities
        k, t = self.logits(x)
        return torch.softmax(k, 1), torch.softmax(t, 1)


def square(img, resize, rng):
    """A page (BGR) on its 256 square (RGB): resize "phone" — drawn as the phone draws it (gen/phone.py
    doctype_input: the aspect not kept, the kernel drawn from the phone profile's capture mix; the site's 256 copies
    and the phone's own cuts' squares — drawn from the full cut by gen/outputs/doctype.py — stay as they are) —, or
    "area" (cv2.INTER_AREA, as before)."""
    if resize == "area":
        small = cv2.resize(img, (S, S), interpolation=cv2.INTER_AREA)
    else:
        small = phone.resample(img, (S, S), phone.kernel_for("capture", rng))
    return cv2.cvtColor(small, cv2.COLOR_BGR2RGB)


KNOWN_BY = ("face", "owner")   # who sets a real copy's turn for sure (not the model's guess, not Haiku's)


def turn_known(e):
    """Is a page's turn known (its turn answer taught)? A made-up page (synth_pages: drawn upright) or a phone-cut
    crop (gen/phone_run.py: turn_k from the geometry, unless None) — yes; a real page copy (doctypes.json) only when
    the face finder or the owner set its turn (turnBy face / owner) or the owner turned it by hand (turnFixed)."""
    if "turn_k" in e:
        return e["turn_k"] is not None
    if e.get("synthPage"):
        return True
    return e.get("turnBy") in KNOWN_BY or e.get("turnFixed") is not None


def load(examples, resize="phone", with_weights=False):
    """→ (pictures, types, known, turns) — and, with_weights, (…, weights, repeats): known False for a page whose turn is
    not known (no turn answer); turns: the clockwise quarter turns each stored page still needs (a phone-cut crop's
    turn_k; 0 for the rest); a page of weight 0 is left out. Each picture's square is made once, here (square), its
    kernel draws from a stream of their own."""
    X, Y, U, T, W, R = [], [], [], [], [], []
    rng = random.Random("train_doctypes.py:resize")
    for e in examples:
        w = float(e.get("weight", 1.0))
        if w <= 0:
            continue
        img = cv2.imread(e["file"])
        if img is None:
            continue
        X.append(square(img, resize, rng))
        Y.append(DOCTYPES.index(e["doctype"]))
        U.append(turn_known(e))
        T.append(int(e.get("turn_k") or 0))
        W.append(w)
        R.append(max(1, int(e.get("repeat", 1))))
    return (X, Y, U, T, W, R) if with_weights else (X, Y, U, T)


def turned(img, k):
    """img turned k clockwise quarter-turns."""
    return np.ascontiguousarray(np.rot90(img, -k)) if k else img


def turn_answer(k, known, needs=0):
    """The turn answer of a page shown turned k more clockwise quarter turns: the turn that sets it upright (it needed
    `needs` as stored), or TURN_IGNORE when its turn is not known."""
    return (needs - k) % 4 if known else TURN_IGNORE


def turn_loss(logits, target, known, weight=None):
    """The turn head's loss: cross-entropy per sample (reduction 'none'), averaged over the samples whose turn is known
    (known: a bool tensor; weight: each sample's weight, a weighted mean) — 0 when none is (a batch of type-only copies
    adds no turn loss, never a NaN)."""
    ce = nn.functional.cross_entropy(logits, target.clamp(min=0), reduction="none")
    k = known.to(ce.dtype) * (weight.to(ce.dtype) if weight is not None else 1.0)
    n = k.sum()
    return (ce * k).sum() / n if bool(n > 0) else ce.sum() * 0.0


def kind_loss(logits, target, class_weight, weight=None):
    """The type head's loss: cross-entropy with the class weights, each sample also weighed by its own weight (the
    weighted mean, as nn.CrossEntropyLoss(weight=…) averages: over the weights of the samples' classes)."""
    ce = nn.functional.cross_entropy(logits, target, weight=class_weight, reduction="none")
    w = class_weight[target] * (weight if weight is not None else 1.0)
    return ce.mul(weight if weight is not None else 1.0).sum() / w.sum().clamp_min(1e-8)


def batch(X, Y, idx, augment, U=None, T=None):
    xs, ks, ts = [], [], []
    for i in idx:
        img = X[i].astype(np.float32)
        if augment:
            img = np.clip(img * random.uniform(0.75, 1.25) + random.uniform(-25, 25), 0, 255)
            if random.random() < 0.5:  # a little off-centre, as a page cut by hand can be
                s = random.uniform(0.88, 1.0); w = int(S * s); x0, y0 = random.randint(0, S - w), random.randint(0, S - w)
                img = cv2.resize(img[y0:y0 + w, x0:x0 + w], (S, S), interpolation=cv2.INTER_LINEAR)
        k = random.randrange(4)
        xs.append(turned(img, k).transpose(2, 0, 1) / 255.0)
        ks.append(Y[i])
        ts.append(turn_answer(k, U is None or U[i], T[i] if T is not None else 0))  # the clockwise turn that sets it upright
    return torch.tensor(np.stack(xs), dtype=torch.float32), torch.tensor(ks), torch.tensor(ts)


def select_loss(net, sel, cw, dev):
    """The mean loss on the select set (pages shown upright as stored: turn 0; no augmentation, no learning)."""
    Xs, Ys, Us, Ts = sel
    net.eval()
    total = 0.0
    with torch.no_grad():
        for k in range(0, len(Xs), 32):
            idx = list(range(k, min(k + 32, len(Xs))))
            xb = torch.tensor(np.stack([Xs[i].astype(np.float32).transpose(2, 0, 1) / 255.0 for i in idx]), dtype=torch.float32)
            kb = torch.tensor([Ys[i] for i in idx], device=dev)
            tb = torch.tensor([turn_answer(0, Us[i], Ts[i]) for i in idx], device=dev)
            lk, lt = net.logits(xb.to(dev))
            total += float(kind_loss(lk, kb, cw) + turn_loss(lt, tb, tb != TURN_IGNORE)) * len(idx)
    return total / max(1, len(Xs))


def train_one(name, arch, X, Y, epochs, dev, pretrained=True, args=None, U=None, data=None, T=None, W=None, R=None,
              select=None, seed=None, select_what=None):
    """One model trained on the pages: each page's index R[i] times an epoch, its loss weighed by W[i]; select (the
    select set's (X, Y, U, T)): the epoch with the lowest loss on it is the one exported (the last one without)."""
    info = {"model": name, "arch": arch, "data": data, "seed": seed}
    ck = checkpoint.begin(name, args, info)
    epochs = checkpoint.epochs_of(ck, args, epochs)
    net = DoctypeNet(arch, pretrained and ck is None).to(dev)   # saved weights need no ImageNet download
    counts = Counter(Y)
    weights = torch.tensor([1 / np.sqrt(max(1, counts.get(i, 0))) for i in range(len(DOCTYPES))], dtype=torch.float32)
    cw = (weights / weights.mean()).to(dev)
    opt = torch.optim.AdamW(net.parameters(), 3e-4, weight_decay=1e-4)
    order = [i for i in range(len(X)) for _ in range(R[i] if R else 1)]
    steps = epochs * ((len(order) + 31) // 32)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, 3e-4, total_steps=max(1, steps), pct_start=0.15)
    checkpoint.check_steps(ck, args, max(1, steps))
    first, best = checkpoint.restore(ck, args, net, opt, sched)
    for ep in range(first, epochs):
        try:
            random.shuffle(order)
            net.train()
            total = 0.0
            for k in range(0, len(order), 32):
                idx = order[k:k + 32]
                xb, kb, tb = batch(X, Y, idx, True, U, T)
                wb = torch.tensor([W[i] for i in idx], dtype=torch.float32, device=dev) if W else None
                lk, lt = net.logits(xb.to(dev))
                tb = tb.to(dev)
                loss = kind_loss(lk, kb.to(dev), cw, wb) + turn_loss(lt, tb, tb != TURN_IGNORE, wb)   # the turn over the known samples only
                opt.zero_grad(); loss.backward(); opt.step(); sched.step()
                total += float(loss.detach()) * len(xb)
        except KeyboardInterrupt:
            checkpoint.stopped(name, ep)
        print(f"  {name} ({arch}) epoch {ep + 1}/{epochs}: loss {total / len(order):.4f}")
        if select and select[0]:
            score = select_loss(net, select, cw, dev)
            print(f"  {name} epoch {ep + 1}: select loss {score:.4f} ({select_what or f'{len(select[0])} real pages of split select'})")
            if best is None or score < best["score"]:
                best = {"net": {k: v.detach().cpu().clone() for k, v in net.state_dict().items()}, "score": score, "epoch": ep + 1}
        checkpoint.save(name, info, net, opt, sched, ep + 1, epochs, best)
    if best:
        net.load_state_dict(best["net"])
        print(f"  {name}: the select set ({select_what or 'real pages of split select'}) picked epoch {best['epoch']} (loss {best['score']:.4f})")
    dst = WORK / "new" / name
    dst.parent.mkdir(parents=True, exist_ok=True)
    if name in DOCTYPE_MODELS:
        drop_report("report_doctypes.json")   # the exam of the model before: exam_doctypes.py runs again on this one
    net = net.cpu().eval()
    probe = torch.rand(1, 3, S, S)
    with torch.no_grad():
        want = [o.numpy() for o in net(probe)]
    torch.onnx.export(net, probe, str(dst), input_names=["img"], output_names=["doctype", "turn"], opset_version=17, dynamo=False)
    got = ort.InferenceSession(str(dst)).run(None, {"img": probe.numpy()})
    assert all(np.abs(g - w).max() < 1e-3 for g, w in zip(got, want)), "the exported model does not answer like the trained one"
    print(f"  {name} → {dst}")


def gather(a):
    """The entries to train on: the site's page copies but the exam's, and a.synth made-up pages (synth_pages.py) —
    refused (gen.sources.assert_clean) when any holds a held-out real page, an exam split key or an open set's exam
    document (docs/scan-training.md → "Kept apart"); a run of the phone's own cuts only when it is a training run
    (run.json split "train", every entry split "train": a cuts run drawn with --exam is the exam's)."""
    ex = [e for e in read_json(WORK / "doctypes.json") if trains(e)] if (WORK / "doctypes.json").exists() else []   # not the exam's, none left out of both
    if a.synth:
        run = pathlib.Path(getattr(a, "synth_run", None) or WORK / "synth" / "pages")
        cut = (run / "doctype" / "pages.json").exists()   # the phone's own cuts (gen/phone_run.py): <run>/doctype/
        made = run / "doctype" / "pages.json" if cut else run / "pages.json"
        if not made.exists():
            raise SystemExit("no made-up pages — run synth_pages.py (or python -m gen build --model doctype,mrz,he,face) first")
        require_qa(run, "the made-up pages", work=WORK)   # drawn through gen build: its QA sheet passed
        if cut and (manifest.read_run(run) or {}).get("split") != "train":
            raise SystemExit(f"{run}: not a training run — the phone's cuts of the exam's pages are never trained on")
        pages = [{**e, "file": str(made.parent / "img" / e["file"].replace("\\", "/").rsplit("/", 1)[-1]), "synthPage": True}
                 for e in read_json(made)]
        if cut and any(e.get("exam") or e.get("split", "train") != "train" for e in pages):
            raise SystemExit(f"{run}: holds pages of the exam's side — the phone's cuts of the exam are never trained on")
        assert_clean(pages, "the made-up pages (synth_pages.py)", work=WORK)   # the whole set, not only the sample drawn
        ex += random.sample(pages, min(a.synth, len(pages)))
    if not ex:
        raise SystemExit("no page copies to train on — run pull_doctypes.py (or synth_pages.py and --synth) first")
    assert_clean(ex, "the document type model's training pages", work=WORK)
    return ex


def as_mix(ex, real_repeat):
    """The old flags' entries (gather) as one list (gen.mix.build): the real page copies (doctypes.json — a page whose
    type no one saw, labelBy self, left out for now) repeated, the made-up pages once each → (rows, meta)."""
    real = [e for e in gmix.real_from_examples([e for e in ex if not e.get("synthPage")]) if e.get("labelBy") != "self"]
    synth = [{**e, "source": "synth", "weight": float(e.get("weight", 1.0))} for e in ex if e.get("synthPage")]
    return gmix.build("doctype", real, (), synth, (), real_repeat)


def main():
    gentle(spare_core=False)   # below-normal priority: the PC stays usable (the GPU as it is)
    ap = argparse.ArgumentParser()
    ap.add_argument("--phone", default=DOCTYPE_MODELS["doctype-lite.onnx"], choices=DOCTYPE_SIZES, help="the phone's model size")
    ap.add_argument("--server", default=DOCTYPE_SERVER["doctype.onnx"], choices=DOCTYPE_SIZES, help="the server's model size (with --only server)")
    ap.add_argument("--only", choices=("phone", "server"), default="phone", help="phone (the default): the phone's model; server: only the server's, on request")
    ap.add_argument("--epochs", type=int, default=0, help="0: the default per model")
    ap.add_argument("--scratch", action="store_true", help="random weights, no download — only to test the steps, never for a model to publish")
    ap.add_argument("--synth", type=int, default=0, help="made-up pages (synth_pages.py) added, at random")
    ap.add_argument("--synth-run", default=str(WORK / "synth" / "pages"), help="the made-up set --synth draws from (default "
                    "~/.scan-train/synth/pages; a run of the phone's own cuts — python -m gen build --model doctype,… — too)")
    ap.add_argument("--resize", choices=("phone", "area"), default="phone",
                    help="how a page is shrunk to 256: as the phone draws it (gen/phone.py, the default) or INTER_AREA")
    ap.add_argument("--from-mix", help="a mix's folder (python -m gen mix --model doctype --out DIR): its train.jsonl and select.jsonl")
    ap.add_argument("--real-repeat", type=int, default=gmix.DEFAULT_REPEAT,
                    help="each real page repeated K times, capped so the real ones are at most 30%% of an epoch (the old flags)")
    ap.add_argument("--seed", type=int, default=None, help="the run's seed (default: a fresh one, printed and saved; --resume: the stopped run's)")
    checkpoint.add_args(ap)
    a = ap.parse_args()
    jobs = {"doctype-lite.onnx": a.phone} if a.only == "phone" else {"doctype.onnx": a.server}
    seed = checkpoint.seed_of(list(jobs), a)
    random.seed(seed); torch.manual_seed(seed)
    print(f"seed {seed} (python train_doctypes.py ... --seed {seed} repeats this run)")
    if a.from_mix:
        ex, select, meta = gmix.load(a.from_mix, "doctype", work=WORK)
        if meta.get("synthRun"):
            require_qa(meta["synthRun"], "the mix's made-up pages", work=WORK)   # drawn through gen build: its QA passed
        pulled = pathlib.Path(meta.get("realDir") or WORK / "real") / "index.jsonl"
    else:
        ex, meta = as_mix(gather(a), a.real_repeat)
        meta.update({"synth": run_fingerprint(a.synth_run) if a.synth else None, "seed": None, "realIndex": None})
        select, pulled = [], WORK / "doctypes.json"
    stale = stale_warning(pulled, newest_attempt_day())
    if stale:
        print(stale)
    if not ex:
        raise SystemExit("no pages to train on — run pull_doctypes.py (or python -m gen real and gen mix) first")
    print("  " + gmix.summary_line(meta))
    assert_clean(ex + select, "the document type model's training pages", work=WORK)
    data = gmix.fingerprint(ex, meta, resize=phone.profile_id() if a.resize == "phone" else "area")
    X, Y, U, T, W, R = load(ex, a.resize, with_weights=True)
    sel = load(select, a.resize) if select else None
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"{len(X)} pages ({sum(R)} an epoch; {len(U) - sum(U)} with no known turn: the type only), on {dev}")
    for name, arch in jobs.items():
        train_one(name, arch, X, Y, a.epochs or EPOCHS[name], dev, not a.scratch, a, U, data, T, W, R, sel, seed,
                  gmix.select_words(meta, len(select)))
    prev = read_json(WORK / "new" / "doctypes-arch.json") if (WORK / "new" / "doctypes-arch.json").exists() else {}
    write_json(WORK / "new" / "doctypes-arch.json", {**prev, **jobs})


if __name__ == "__main__":
    main()
