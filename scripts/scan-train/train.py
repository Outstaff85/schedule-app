"""Step 2 of /scan-train: the light and the accurate document edges models (DocAligner, as the
lab uses them now — scripts/scan-lab/models-version) are fine-tuned on the examples:
the ONNX model is turned into PyTorch (onnx2torch; checked to give the same answer),
taught to put each corner's heatmap peak where the user put the corner, and exported
back to ONNX (checked again). Batch norms stay as they are (few examples). The GPU is
used when there is one (CUDA). Writes ~/.scan-train/new/<model>.onnx."""
import argparse
import random

import cv2
import numpy as np
import onnx
import onnx2torch
import onnxruntime as ort
import torch

from common import MODELS, WORK, model_path, read_json, version_of

S, H, SIGMA = 256, 128, 2.4  # the spread of the models' own corner spots (measured)
EPOCHS = {"edges-lite.onnx": 24, "edges.onnx": 12}
LR = {"edges-lite.onnx": 3e-5, "edges.onnx": 1e-5}  # gentle: few examples, a model already good
FLIP = [1, 0, 3, 2]  # a mirrored page: top-left ↔ top-right, bottom-right ↔ bottom-left


def heatmaps(corners):
    """4 Gaussian heatmaps (H×H) peaking where the corners are (as docfind.corners reads them)."""
    ys, xs = np.mgrid[0:H, 0:H].astype(np.float32)
    out = np.zeros((4, H, H), np.float32)
    for k, (x, y) in enumerate(corners):
        cx, cy = x * H - 0.5, y * H - 0.5
        out[k] = np.exp(-((xs - cx) ** 2 + (ys - cy) ** 2) / (2 * SIGMA ** 2))
    return out


def load(examples):
    X, Y = [], []
    for e in examples:
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
        img, c = X[i].astype(np.float32), [list(p) for p in Y[i]]
        if augment:
            img = np.clip(img * random.uniform(0.75, 1.25) + random.uniform(-25, 25), 0, 255)
            if random.random() < 0.5:
                img = img[:, ::-1]
                c = [[1 - c[j][0], c[j][1]] for j in FLIP]
        xs.append(np.ascontiguousarray(img.transpose(2, 0, 1)) / 255.0)
        ys.append(heatmaps(c))
    return torch.tensor(np.stack(xs), dtype=torch.float32), torch.tensor(np.stack(ys))


def train_one(name, base, X, Y, epochs, dev):
    src = model_path(base, name)
    proto = onnx.load(str(src))
    inp, outname = proto.graph.input[0].name, proto.graph.output[0].name
    net = onnx2torch.convert(proto).to(dev)
    probe = np.random.rand(1, 3, S, S).astype(np.float32)
    ref = ort.InferenceSession(str(src)).run(None, {inp: probe})[0]
    with torch.no_grad():
        got = net.eval()(torch.from_numpy(probe).to(dev)).cpu().numpy()
    assert np.abs(got - ref).max() < 1e-3, "the PyTorch copy does not answer like the model"
    opt = torch.optim.Adam(net.parameters(), LR[name])
    order = list(range(len(X)))
    for ep in range(epochs):
        random.shuffle(order)
        net.eval()  # batch norms keep their statistics; the weights still learn
        total = 0.0
        for k in range(0, len(order), 16):
            xb, yb = batch(X, Y, order[k:k + 16], True)
            out = net(xb.to(dev))
            yb = yb.to(dev)
            # the spots count, not the empty background: plain MSE would rather lower every peak
            loss = (((out - yb) ** 2) * (1 + 20 * yb)).mean() * 1000
            opt.zero_grad(); loss.backward(); opt.step()
            total += float(loss.detach()) * len(xb)
        print(f"  {name} epoch {ep + 1}/{epochs}: loss {total / len(order):.4f}")
    dst = WORK / "new" / name
    dst.parent.mkdir(parents=True, exist_ok=True)
    net = net.cpu().eval()
    with torch.no_grad():
        want = net(torch.from_numpy(probe)).numpy()
    torch.onnx.export(net, torch.from_numpy(probe), str(dst), input_names=[inp], output_names=[outname], opset_version=17, dynamo=False)
    back = ort.InferenceSession(str(dst)).run(None, {inp: probe})[0]
    assert np.abs(back - want).max() < 1e-3, "the exported model does not answer like the trained one"
    print(f"  {name} → {dst}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="*", default=list(MODELS))
    ap.add_argument("--epochs", type=int, default=0, help="0: the default per model")
    a = ap.parse_args()
    random.seed(7); torch.manual_seed(7)
    ex = [e for e in read_json(WORK / "examples.json") if not e["exam"]]
    if not ex:
        raise SystemExit("no examples to train on — run pull.py first")
    X, Y = load(ex)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    base = version_of("scan-lab")
    print(f"{len(X)} examples, base models {base}, on {dev}")
    for name in a.models:
        train_one(name, base, X, Y, a.epochs or EPOCHS[name], dev)


if __name__ == "__main__":
    main()
