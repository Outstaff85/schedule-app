"""Document types, step 2 (docs/scan-plan.md → S7; /scan-train): the phone's document type model
(doctype-lite.onnx — the only one by default; owner, 2026-10-24) is trained on the page copies — an ImageNet EfficientNet-Lite (timm)
with two heads: the document type (6) and the clockwise turn the page needs (4). The turn is
learned for free: a copy stored upright is shown turned by a random quarter
turn, with the turn back as its answer; a copy whose turn only the model guessed ("upright": False in doctypes.json,
pull_doctypes.py) is shown turned too but has no turn answer (TURN_IGNORE) — it teaches the type only. The ImageNet normalization is inside the model, so
it takes the page as RGB 0..1 like the document edges models. Exported to ONNX (input "img"
[1,3,256,256]; outputs "doctype", "turn" — probabilities) and checked to answer like the
trained model. With --synth N, N made-up upright pages (synth_pages.py) are added to the site's page
copies — or train alone while the site has collected none yet; the exam stays the site's pages. A set holding a
held-out real page, an exam split key or an open set's exam document is refused before training (gather).
Each epoch's progress is saved (checkpoint.py: --resume goes on with a run that stopped, --more trains
further from the last run's weights).
Writes ~/.scan-train/new/doctype-lite.onnx (and deletes report_doctypes.json: exam_doctypes.py runs again).
A larger model for a server (common.DOCTYPE_SERVER, doctype.onnx) is trained only with --only server; no
code runs it and publish.py never publishes it.

  python train_doctypes.py                                    # the phone's model, the default size
  python train_doctypes.py --phone tf_efficientnet_lite1     # the next size up for the phone
  python train_doctypes.py --only server                      # only the server's (Lite2), on request
  python train_doctypes.py --synth 6000                        # + the made-up pages (synth_pages.py)
"""
import argparse
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


def load(examples):
    """→ (pictures, types, upright): upright False for a copy whose turn is not known (no turn answer)."""
    X, Y, U = [], [], []
    for e in examples:
        img = cv2.imread(e["file"])
        if img is None:
            continue
        X.append(cv2.cvtColor(cv2.resize(img, (S, S), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB))
        Y.append(DOCTYPES.index(e["doctype"]))
        U.append(e.get("upright") is not False)   # the made-up pages are drawn upright
    return X, Y, U


def turned(img, k):
    """img turned k clockwise quarter-turns."""
    return np.ascontiguousarray(np.rot90(img, -k)) if k else img


def turn_answer(k, upright):
    """The turn answer of a copy shown turned k clockwise quarter turns: the turn that sets it back upright, or
    TURN_IGNORE when the copy is not known to lie upright."""
    return (4 - k) % 4 if upright else TURN_IGNORE


def batch(X, Y, idx, augment, U=None):
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
        ts.append(turn_answer(k, U is None or U[i]))  # the clockwise turn that sets it back upright
    return torch.tensor(np.stack(xs), dtype=torch.float32), torch.tensor(ks), torch.tensor(ts)


def train_one(name, arch, X, Y, epochs, dev, pretrained=True, args=None, U=None):
    info = {"model": name, "arch": arch}
    ck = checkpoint.begin(name, args, info)
    epochs = checkpoint.epochs_of(ck, args, epochs)
    net = DoctypeNet(arch, pretrained and ck is None).to(dev)   # saved weights need no ImageNet download
    counts = Counter(Y)
    weights = torch.tensor([1 / np.sqrt(max(1, counts.get(i, 0))) for i in range(len(DOCTYPES))], dtype=torch.float32)
    ce_kind, ce_turn = nn.CrossEntropyLoss(weight=(weights / weights.mean()).to(dev)), nn.CrossEntropyLoss(ignore_index=TURN_IGNORE)
    opt = torch.optim.AdamW(net.parameters(), 3e-4, weight_decay=1e-4)
    steps = epochs * ((len(X) + 31) // 32)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, 3e-4, total_steps=max(1, steps), pct_start=0.15)
    first, _ = checkpoint.restore(ck, args, net, opt, sched)
    order = list(range(len(X)))
    for ep in range(first, epochs):
        try:
            random.shuffle(order)
            net.train()
            total = 0.0
            for k in range(0, len(order), 32):
                xb, kb, tb = batch(X, Y, order[k:k + 32], True, U)
                lk, lt = net.logits(xb.to(dev))
                loss = ce_kind(lk, kb.to(dev))
                if bool((tb != TURN_IGNORE).any()):  # a batch with no turn answer at all adds no turn loss (it would be NaN)
                    loss = loss + ce_turn(lt, tb.to(dev))
                opt.zero_grad(); loss.backward(); opt.step(); sched.step()
                total += float(loss.detach()) * len(xb)
        except KeyboardInterrupt:
            checkpoint.stopped(name, ep)
        print(f"  {name} ({arch}) epoch {ep + 1}/{epochs}: loss {total / len(order):.4f}")
        checkpoint.save(name, info, net, opt, sched, ep + 1, epochs)
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
    document (docs/scan-training.md → "Kept apart")."""
    ex = [e for e in read_json(WORK / "doctypes.json") if not e["exam"]] if (WORK / "doctypes.json").exists() else []
    if a.synth:
        made = WORK / "synth" / "pages" / "pages.json"
        if not made.exists():
            raise SystemExit("no made-up pages — run synth_pages.py first")
        pages = [{**e, "file": str(made.parent / "img" / e["file"].replace("\\", "/").rsplit("/", 1)[-1])} for e in read_json(made)]
        assert_clean(pages, "the made-up pages (synth_pages.py)", work=WORK)   # the whole set, not only the sample drawn
        ex += random.sample(pages, min(a.synth, len(pages)))
    if not ex:
        raise SystemExit("no page copies to train on — run pull_doctypes.py (or synth_pages.py and --synth) first")
    assert_clean(ex, "the document type model's training pages", work=WORK)
    return ex


def main():
    gentle(spare_core=False)   # below-normal priority: the PC stays usable (the GPU as it is)
    ap = argparse.ArgumentParser()
    ap.add_argument("--phone", default=DOCTYPE_MODELS["doctype-lite.onnx"], choices=DOCTYPE_SIZES, help="the phone's model size")
    ap.add_argument("--server", default=DOCTYPE_SERVER["doctype.onnx"], choices=DOCTYPE_SIZES, help="the server's model size (with --only server)")
    ap.add_argument("--only", choices=("phone", "server"), default="phone", help="phone (the default): the phone's model; server: only the server's, on request")
    ap.add_argument("--epochs", type=int, default=0, help="0: the default per model")
    ap.add_argument("--scratch", action="store_true", help="random weights, no download — only to test the steps, never for a model to publish")
    ap.add_argument("--synth", type=int, default=0, help="made-up pages (synth_pages.py) added, at random")
    checkpoint.add_args(ap)
    a = ap.parse_args()
    random.seed(7); torch.manual_seed(7)
    X, Y, U = load(gather(a))
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"{len(X)} page copies ({len(U) - sum(U)} with no sure turn: the type only), on {dev}")
    jobs = {"doctype-lite.onnx": a.phone} if a.only == "phone" else {"doctype.onnx": a.server}
    for name, arch in jobs.items():
        train_one(name, arch, X, Y, a.epochs or EPOCHS[name], dev, not a.scratch, a, U)
    prev = read_json(WORK / "new" / "doctypes-arch.json") if (WORK / "new" / "doctypes-arch.json").exists() else {}
    write_json(WORK / "new" / "doctypes-arch.json", {**prev, **jobs})


if __name__ == "__main__":
    main()
