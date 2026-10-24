"""Step 2 of /scan-train: the light and the accurate document edges models (DocAligner, as the
lab uses them now — scripts/scan-lab/models-version) are fine-tuned on the examples:
the ONNX model is turned into PyTorch (onnx2torch; checked to give the same answer),
taught to put each corner's heatmap peak where the user put the corner, and exported
back to ONNX (checked again). Batch norms stay as they are (few examples). The GPU is
used when there is one (CUDA). Each epoch's progress is saved (checkpoint.py): --resume goes on with a
run that stopped, --more trains further from the last run's weights. With --synth N, N made-up photos (synth_docs.py), with --midv N, N MIDV
photos (midv.py), and with --smartdoc N, N SmartDoc frames (smartdoc.py) are added to the users' examples (never to the exam;
nor MIDV's and SmartDoc's exam documents, midv.open_exam). Before training, gen.sources.assert_clean refuses a set
holding a held-out template's photo, an exam background, an exam split key or an open set's exam document
(docs/scan-training.md → "Kept apart"); a made-up set drawn through gen build must have passed its QA (gen.qa.require_qa:
python -m gen qa --run DIR). The checkpoint records the data fingerprint (checkpoint.py); --more builds the network from
the graph the saved weights belong to (their info.base — v4's weights are of v3's graph) and records where it went on
from (info.from: that base, its epochs and the version publish.py stamped on it). Each photo's 256 input is made as the
phone makes it (gen/phone.py frame_to_S: half as the camera frame's live input, half as the capture's, the kernel drawn
from the phone profile's mix; --resize area: INTER_AREA as before), and the fingerprint records the profile.

The data come as one list (gen/mix.py; docs/scan-training.md → "Real data and its weight"): --from-mix DIR reads a mix
made by python -m gen mix --model edges (its train.jsonl, select.jsonl and mix.json; refused when made under another
heldout.json), and the old flags (--synth N, --midv N, --smartdoc N with pull.py's examples.json) build the same list
here. Each real example is repeated --real-repeat K times (capped so the real ones are at most 30 % of an epoch), each
example's loss is weighed by its weight (a self label — the model's own corners no one moved — 0.3), the counts per
source and the real share are printed, and the epoch kept is the one with the lowest loss on the select set (the real
examples of split "select"; never the exam) when it has any. --seed (default: a fresh one, printed and saved in the
checkpoint; --resume takes the stopped run's) seeds the shuffling, the augmentation and the old flags' sample. A warning
is printed when examples.json (or the mix's real index) is older than the newest scan attempt in attempts/new/.
Writes ~/.scan-train/new/<model>.onnx."""
import argparse
import pathlib
import random

import cv2
import numpy as np
import onnx
import onnx2torch
import onnxruntime as ort
import torch

import checkpoint
from gen import mix as gmix
from gen import phone
from gen.manifest import run_fingerprint
from gen.qa import require_qa
from gen.real import newest_attempt_day, stale_warning
from gen.sources import assert_clean
from midv import open_exam
from common import MODELS, WORK, model_path, read_json, version_of
from home import drop_report, gentle
from onnxbatch import free_batch

S, H, SIGMA = 256, 128, 2.4  # the spread of the models' own corner spots (measured)
EPOCHS = {"edges-lite.onnx": 24, "edges.onnx": 12}
LR = {"edges-lite.onnx": 3e-5, "edges.onnx": 1e-5}  # gentle: few examples, a model already good
FLIP = [1, 0, 3, 2]  # a mirrored page: top-left ↔ top-right, bottom-right ↔ bottom-left


def heatmaps(corners):
    """4 Gaussian heatmaps (H×H) peaking where the corners are (as docfind.corners reads them);
    corners None — a page the user deleted, "nothing here" (S8) — gives 4 empty maps."""
    ys, xs = np.mgrid[0:H, 0:H].astype(np.float32)
    out = np.zeros((4, H, H), np.float32)
    if corners is None:
        return out
    for k, (x, y) in enumerate(corners):
        cx, cy = x * H - 0.5, y * H - 0.5
        out[k] = np.exp(-((xs - cx) ** 2 + (ys - cy) ** 2) / (2 * SIGMA ** 2))
    return out


PHONE_LIVE = 0.5   # the share of examples made as the camera frame's live input (the rest as the capture's)


def model_input(img, resize, rng):
    """One example's 256 input (BGR in, RGB out): resize "phone" — as the phone makes it (gen/phone.py frame_to_S):
    the live frame's createImageBitmap or the capture's smallRGBA, PHONE_LIVE of each, the kernel drawn from the phone
    profile's mix for that op —, or "area" (cv2.INTER_AREA, as before)."""
    if resize == "area":
        small = cv2.resize(img, (S, S), interpolation=cv2.INTER_AREA)
    else:
        small = phone.frame_to_S(img, "live" if rng.random() < PHONE_LIVE else "capture", rng=rng)
    return cv2.cvtColor(small, cv2.COLOR_BGR2RGB)


def load(examples, resize="phone"):
    """→ (inputs, corners, weights, repeats). Each example's input is made once, here (a whole photo per example would
    not fit in memory): by model_input, its draws from a stream of their own (the same every run, apart from the
    training's). An example of weight 0 or with no right answer (a retaken page: only the exam's) is left out."""
    X, Y, W, R = [], [], [], []
    rng = random.Random("train.py:resize")
    for e in examples:
        w = float(e.get("weight", 1.0))
        if e.get("hard") or w <= 0:
            continue
        img = cv2.imread(e["file"])
        if img is None:
            continue
        X.append(model_input(img, resize, rng))
        Y.append(e["fixed"])
        W.append(w)
        R.append(max(1, int(e.get("repeat", 1))))
    return X, Y, W, R


def batch(X, Y, idx, augment):
    xs, ys = [], []
    for i in idx:
        img, c = X[i].astype(np.float32), [list(p) for p in Y[i]] if Y[i] is not None else None
        if augment:
            img = np.clip(img * random.uniform(0.75, 1.25) + random.uniform(-25, 25), 0, 255)
            if random.random() < 0.5:
                img = img[:, ::-1]
                c = [[1 - c[j][0], c[j][1]] for j in FLIP] if c is not None else None
        xs.append(np.ascontiguousarray(img.transpose(2, 0, 1)) / 255.0)
        ys.append(heatmaps(c))
    return torch.tensor(np.stack(xs), dtype=torch.float32), torch.tensor(np.stack(ys))


def graph_of(name, base, args):
    """The version whose graph the network is built from, and the info's "from": with --more / --resume the saved
    weights' own base (an explicit --base that differs is refused: those weights do not load into another graph)."""
    if not (args.more or args.resume):
        return base, None
    prev = checkpoint.load(name)
    if prev is None:
        return base, None   # checkpoint.begin says there is nothing to go on from
    saved = (prev.get("info") or {}).get("base") or base
    if saved != base:
        if getattr(args, "base", ""):
            raise SystemExit(f"--base {base}, but the saved weights of {name} are of base {saved}'s graph — give --base {saved} or leave --base out")
        print(f"  {name}: the saved weights are of base {saved}'s graph — the network is built from it")
    if args.resume:
        return saved, (prev.get("info") or {}).get("from")
    published = (prev.get("published") or {}).get("version")
    lab = version_of("scan-lab")
    if not published:
        print(f"  note: the saved run of {name} was never published (it may be a run the owner turned down)")
    elif published != lab:
        print(f"  note: the saved run of {name} was published as {published}; the lab is on {lab}")
    return saved, {"base": saved, "epochs": prev.get("epoch"), "published": published}


def train_one(name, base, X, Y, epochs, dev, args, data=None, W=None, R=None, select=None, seed=None):
    """One model trained on (X, Y): each example's index R[i] times an epoch, its loss weighed by W[i]; select (Xs, Ys):
    the epoch with the lowest loss on it is the one exported (the last one without)."""
    base, came = graph_of(name, base, args)
    src = model_path(base, name)
    proto = onnx.load(str(src))
    free_batch(proto)  # trained in batches of 16: a version exported with its batch baked in as 1 (v3) is set free
    inp, outname = proto.graph.input[0].name, proto.graph.output[0].name
    net = onnx2torch.convert(proto)
    probe = np.random.rand(1, 3, S, S).astype(np.float32)
    ref = ort.InferenceSession(str(src)).run(None, {inp: probe})[0]
    with torch.no_grad():  # checked on the CPU: the GPU's TF32 convolutions differ by ~3e-3, not the copy
        got = net.eval()(torch.from_numpy(probe)).numpy()
    assert np.abs(got - ref).max() < 1e-3, "the PyTorch copy does not answer like the model"
    net = net.to(dev)
    info = {"model": name, "base": base, "data": data, "seed": seed}
    if came:
        info["from"] = came
    ck = checkpoint.begin(name, args, info)
    epochs = checkpoint.epochs_of(ck, args, epochs)
    opt = torch.optim.Adam(net.parameters(), LR[name])
    first, best = checkpoint.restore(ck, args, net, opt)
    order = [i for i in range(len(X)) for _ in range(R[i] if R else 1)]
    for ep in range(first, epochs):
        try:
            one_epoch(name, net, opt, X, Y, order, dev, ep, epochs, W)
        except KeyboardInterrupt:
            checkpoint.stopped(name, ep)
        if select and select[0]:
            score = select_loss(net, select[0], select[1], dev)
            print(f"  {name} epoch {ep + 1}: select loss {score:.4f} ({len(select[0])} real pages of split select)")
            if best is None or score < best["score"]:
                best = {"net": {k: v.detach().cpu().clone() for k, v in net.state_dict().items()}, "score": score, "epoch": ep + 1}
        checkpoint.save(name, info, net, opt, None, ep + 1, epochs, best)
    if best:
        net.load_state_dict(best["net"])
        print(f"  {name}: the select set picked epoch {best['epoch']} (loss {best['score']:.4f})")
    export(name, net, probe, inp, outname)


def corner_loss(out, yb, wb=None):
    """The heatmaps' error, the spots counted, not the empty background (plain MSE would rather lower
    every peak) — against the right corners started from whichever corner fits best (each example its
    own): near 45° the photo's "top-left" is either of two corners, and a fixed order taught the model
    to put its first corner between them (MIDV's turned scans, owner 2026-10-22). wb: each example's weight (a self
    label 0.3): the weighted mean."""
    per = [(((out - y) ** 2) * (1 + 20 * y)).mean((1, 2, 3)) for y in (torch.roll(yb, k, 1) for k in range(4))]
    best = torch.stack(per, 1).min(1).values
    if wb is None:
        return best.mean() * 1000
    return (best * wb).sum() / wb.sum().clamp_min(1e-8) * 1000


def select_loss(net, Xs, Ys, dev):
    """The mean corner loss on the select set (no augmentation, no learning)."""
    total = 0.0
    with torch.no_grad():
        for k in range(0, len(Xs), 16):
            xb, yb = batch(Xs, Ys, range(k, min(k + 16, len(Xs))), False)
            total += float(corner_loss(net(xb.to(dev)), yb.to(dev))) * len(xb)
    return total / max(1, len(Xs))


def one_epoch(name, net, opt, X, Y, order, dev, ep, epochs, W=None):
    random.shuffle(order)
    net.eval()  # batch norms keep their statistics; the weights still learn
    total = 0.0
    for k in range(0, len(order), 16):
        idx = order[k:k + 16]
        xb, yb = batch(X, Y, idx, True)
        out = net(xb.to(dev))
        yb = yb.to(dev)
        wb = torch.tensor([W[i] for i in idx], dtype=torch.float32, device=dev) if W else None
        loss = corner_loss(out, yb, wb)
        opt.zero_grad(); loss.backward(); opt.step()
        total += float(loss.detach()) * len(xb)
    print(f"  {name} epoch {ep + 1}/{epochs}: loss {total / len(order):.4f}")


def export(name, net, probe, inp, outname):
    dst = WORK / "new" / name
    dst.parent.mkdir(parents=True, exist_ok=True)
    drop_report("report.json", "report.html")   # the exam of the model before: exam.py runs again on this one
    net = net.cpu().eval()
    with torch.no_grad():
        want = net(torch.from_numpy(probe)).numpy()
    torch.onnx.export(net, torch.from_numpy(probe), str(dst), input_names=[inp], output_names=[outname], opset_version=17, dynamo=False,
                      dynamic_axes={inp: {0: "batch"}, outname: {0: "batch"}})
    proto = onnx.load(str(dst))
    if free_batch(proto):  # a batch of 1 the export still folded into a shape: the next run trains it in batches too
        onnx.save(proto, str(dst))
    back = ort.InferenceSession(str(dst)).run(None, {inp: probe})[0]
    assert np.abs(back - want).max() < 1e-3, "the exported model does not answer like the trained one"
    two = np.concatenate([probe, probe[:, :, ::-1].copy()])
    with torch.no_grad():
        want2 = net(torch.from_numpy(two)).numpy()
    back2 = ort.InferenceSession(str(dst)).run(None, {inp: two})[0]
    assert np.abs(back2 - want2).max() < 1e-3, "the exported model does not answer a batch of two"
    print(f"  {name} → {dst}")


def gather(a, seed):
    """The training list → (rows, select rows, mix meta, the real file it was pulled into): --from-mix's (gen/mix.py), or
    the old flags' — pull.py's examples.json (the training side, each with its weight) and a.synth / a.midv /
    a.smartdoc made-up and open examples drawn at random (by seed) — built into the same list (gen.mix.build)."""
    if a.from_mix:
        rows, select, meta = gmix.load(a.from_mix, "edges", work=WORK)
        if meta.get("synthRun"):
            require_qa(meta["synthRun"], "the mix's made-up photos", work=WORK)   # drawn through gen build: its QA passed
        return rows, select, meta, pathlib.Path(meta.get("realDir") or WORK / "real") / "index.jsonl"
    rng = random.Random(f"train.py:{seed}")
    real = gmix.real_from_examples(read_json(WORK / "examples.json")) if (WORK / "examples.json").exists() else []
    synth_run = pathlib.Path(a.synth_run)
    more = []
    for n, folder, how, src in ((a.synth, synth_run, "synth_docs.py", "synth"), (a.midv, WORK / "midv", "midv.py", "midv"),
                                 (a.smartdoc, WORK / "smartdoc", "smartdoc.py", "smartdoc")):
        if not n:
            continue
        f = folder / "examples.json"
        if not f.exists():
            raise SystemExit(f"no {folder.name} examples — run {how} first")
        got = [{**e, "file": str(folder / "img" / pathlib.Path(e["file"]).name), "source": src}   # wherever the set was made (another PC, datasets_hf.py)
               for e in read_json(f) if not open_exam(e)]  # the exam's documents are never trained on
        more += rng.sample(got, min(n, len(got)))
    if a.synth:
        require_qa(synth_run, "the made-up photos (synth_docs.py)", work=WORK)   # drawn through gen build: its QA passed
    rows, meta = gmix.build("edges", real, (), more, (), a.real_repeat)
    meta.update({"synth": run_fingerprint(synth_run) if a.synth else None, "seed": None, "realIndex": None})
    return rows, [], meta, WORK / "examples.json"


def main():
    gentle(spare_core=False)   # below-normal priority: the PC stays usable (the GPU as it is)
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="*", default=list(MODELS))
    ap.add_argument("--epochs", type=int, default=0, help="0: the default per model")
    ap.add_argument("--from-mix", help="a mix's folder (python -m gen mix --model edges --out DIR): its train.jsonl and select.jsonl")
    ap.add_argument("--synth", type=int, default=0, help="made-up photos (synth_docs.py) added, at random")
    ap.add_argument("--midv", type=int, default=0, help="MIDV photos (midv.py) added, at random")
    ap.add_argument("--smartdoc", type=int, default=0, help="SmartDoc frames (smartdoc.py) added, at random")
    ap.add_argument("--real-repeat", type=int, default=gmix.DEFAULT_REPEAT,
                    help="each real example repeated K times, capped so the real ones are at most 30%% of an epoch (the old flags)")
    ap.add_argument("--seed", type=int, default=None, help="the run's seed (default: a fresh one, printed and saved; --resume: the stopped run's)")
    ap.add_argument("--base", default="", help="the version whose models are trained further (default: the lab's, scripts/scan-lab/models-version; "
                    "with --more / --resume the saved weights' own)")
    ap.add_argument("--synth-run", default=str(WORK / "synth" / "docs"), help="the made-up set --synth draws from (default ~/.scan-train/synth/docs)")
    ap.add_argument("--resize", choices=("phone", "area"), default="phone",
                    help="how a photo is shrunk to the 256 input: as the phone does (gen/phone.py, live or capture; the default) or INTER_AREA")
    checkpoint.add_args(ap)
    a = ap.parse_args()
    seed = checkpoint.seed_of(a.models, a)
    random.seed(seed); torch.manual_seed(seed)
    print(f"seed {seed} (python train.py ... --seed {seed} repeats this run)")
    rows, select, meta, pulled = gather(a, seed)
    stale = stale_warning(pulled, newest_attempt_day())
    if stale:
        print(stale)
    if not rows:
        raise SystemExit("no examples to train on — run pull.py (or python -m gen real and gen mix) first")
    print("  " + gmix.summary_line(meta))
    assert_clean(rows + select, "the document edges' training examples", work=WORK)   # no held-out page, exam key or exam document
    data = gmix.fingerprint(rows, meta, resize=phone.profile_id() if a.resize == "phone" else "area")
    X, Y, W, R = load(rows, a.resize)
    sel = load(select, a.resize)[:2] if select else None
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    base = a.base or version_of("scan-lab")
    print(f"{len(X)} examples ({sum(R)} an epoch), base models {base}, on {dev}")
    for name in a.models:
        train_one(name, base, X, Y, a.epochs or EPOCHS[name], dev, a, data, W, R, sel, seed)


if __name__ == "__main__":
    main()
