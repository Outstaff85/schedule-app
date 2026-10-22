"""Step 2 of /scan-train: the light and the accurate document edges models (DocAligner, as the
lab uses them now — scripts/scan-lab/models-version) are fine-tuned on the examples:
the ONNX model is turned into PyTorch (onnx2torch; checked to give the same answer),
taught to put each corner's heatmap peak where the user put the corner, and exported
back to ONNX (checked again). Batch norms stay as they are (few examples). The GPU is
used when there is one (CUDA). Each epoch's progress is saved (checkpoint.py): --resume goes on with a
run that stopped, --more trains further from the last run's weights. With --synth N, N made-up photos (synth_docs.py), with --midv N, N MIDV
photos (midv.py), and with --smartdoc N, N SmartDoc frames (smartdoc.py) are added to the users' examples (never to the exam;
nor MIDV's and SmartDoc's exam documents, midv.open_exam). Writes ~/.scan-train/new/<model>.onnx."""
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
from midv import open_exam
from common import MODELS, WORK, model_path, read_json, version_of
from home import gentle
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


def load(examples):
    X, Y = [], []
    for e in examples:
        if e.get("hard"):
            continue  # a retaken page with no right answer: only the exam's
        img = cv2.imread(e["file"])
        if img is None:
            continue
        img = cv2.cvtColor(cv2.resize(img, (S, S), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
        X.append(img)
        Y.append(e["fixed"])
    return X, Y


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


def train_one(name, base, X, Y, epochs, dev, args):
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
    info = {"model": name, "base": base}
    ck = checkpoint.begin(name, args, info)
    epochs = checkpoint.epochs_of(ck, args, epochs)
    opt = torch.optim.Adam(net.parameters(), LR[name])
    first, _ = checkpoint.restore(ck, args, net, opt)
    order = list(range(len(X)))
    for ep in range(first, epochs):
        try:
            one_epoch(name, net, opt, X, Y, order, dev, ep, epochs)
        except KeyboardInterrupt:
            checkpoint.stopped(name, ep)
        checkpoint.save(name, info, net, opt, None, ep + 1, epochs)
    export(name, net, probe, inp, outname)


def corner_loss(out, yb):
    """The heatmaps' error, the spots counted, not the empty background (plain MSE would rather lower
    every peak) — against the right corners started from whichever corner fits best (each example its
    own): near 45° the photo's "top-left" is either of two corners, and a fixed order taught the model
    to put its first corner between them (MIDV's turned scans, owner 2026-10-22)."""
    per = [(((out - y) ** 2) * (1 + 20 * y)).mean((1, 2, 3)) for y in (torch.roll(yb, k, 1) for k in range(4))]
    return torch.stack(per, 1).min(1).values.mean() * 1000


def one_epoch(name, net, opt, X, Y, order, dev, ep, epochs):
    random.shuffle(order)
    net.eval()  # batch norms keep their statistics; the weights still learn
    total = 0.0
    for k in range(0, len(order), 16):
        xb, yb = batch(X, Y, order[k:k + 16], True)
        out = net(xb.to(dev))
        yb = yb.to(dev)
        loss = corner_loss(out, yb)
        opt.zero_grad(); loss.backward(); opt.step()
        total += float(loss.detach()) * len(xb)
    print(f"  {name} epoch {ep + 1}/{epochs}: loss {total / len(order):.4f}")


def export(name, net, probe, inp, outname):
    dst = WORK / "new" / name
    dst.parent.mkdir(parents=True, exist_ok=True)
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


def main():
    gentle(spare_core=False)   # below-normal priority: the PC stays usable (the GPU as it is)
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="*", default=list(MODELS))
    ap.add_argument("--epochs", type=int, default=0, help="0: the default per model")
    ap.add_argument("--synth", type=int, default=0, help="made-up photos (synth_docs.py) added, at random")
    ap.add_argument("--midv", type=int, default=0, help="MIDV photos (midv.py) added, at random")
    ap.add_argument("--smartdoc", type=int, default=0, help="SmartDoc frames (smartdoc.py) added, at random")
    checkpoint.add_args(ap)
    a = ap.parse_args()
    random.seed(7); torch.manual_seed(7)
    ex = [e for e in read_json(WORK / "examples.json") if not e["exam"]] if (WORK / "examples.json").exists() else []
    for n, folder, how in ((a.synth, "synth/docs", "synth_docs.py"), (a.midv, "midv", "midv.py"),
                            (a.smartdoc, "smartdoc", "smartdoc.py")):
        if not n:
            continue
        more = WORK / folder / "examples.json"
        if not more.exists():
            raise SystemExit(f"no {folder} examples — run {how} first")
        more = [{**e, "file": str(WORK / folder / "img" / pathlib.Path(e["file"]).name)} for e in read_json(more)  # wherever the set was made (another PC, datasets_hf.py)
                if not open_exam(e)]  # the exam's documents are never trained on
        ex += random.sample(more, min(n, len(more)))
    if not ex:
        raise SystemExit("no examples to train on — run pull.py first")
    X, Y = load(ex)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    base = version_of("scan-lab")
    print(f"{len(X)} examples, base models {base}, on {dev}")
    for name in a.models:
        train_one(name, base, X, Y, a.epochs or EPOCHS[name], dev, a)


if __name__ == "__main__":
    main()
