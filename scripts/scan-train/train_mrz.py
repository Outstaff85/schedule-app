"""The passport zone reader, step 2 (docs/hf-plan.md → H8b; /scan-train): a small CRNN (convolutions,
a two-way LSTM, CTC) learns to read one MRZ line from the made-up lines synth_lines.py drew
(~/.scan-train/synth/mrz/) — made a little worse on the way, as a phone's photo of a passport is:
blurred, small, noisy, squeezed into JPEG, tilted, with a bit of the next line in the crop. No real
passport is needed to train (exam_mrz.py examines it on the real ones the site collected). Exported
to ONNX (mrzmodel.py: input "img" [1,1,32,512], output "logits" [1,128,38]) and checked to answer like
the trained model. With --midv, the real zone lines cut from MIDV-2020's passport photos and scans
(midv_mrz.py: ~/.scan-train/midv-mrz/train/) are added, each shown --midv-repeat times an epoch.
Writes ~/.scan-train/new/mrz.onnx and report_mrz_train.json. (`fit` below is the Hebrew field reader's
training, train_he.py: its progress goes through checkpoint.py.)

The weights are kept between trainings in ~/.scan-train/mrz-ckpt/ (made-up and public lines only, no
worker's data: clean.py and publish.py leave it): best.pt — the best weights so far, which the next
training starts from (with a lower learning rate); last.pt — the running training after every epoch,
which --resume continues after a stop. The check lines are picked by their text (one in 50), so a
check line is never trained on in any training, whatever the number of lines drawn.

  python synth_lines.py mrz --count 100000      # first
  python train_mrz.py                           # ~10-20 min on the 4070; from best.pt when it is there
  python train_mrz.py --midv                    # + MIDV-2020's real lines (after midv_mrz.py)
  python train_mrz.py --resume                  # the stopped training goes on from its last epoch
  python train_mrz.py --fresh                   # from random weights (best.pt replaced only when beaten)
"""
import argparse
import io
import json
import pathlib
import random
import zlib

import cv2
import numpy as np
import torch
from torch import nn

import checkpoint
from home import WORK, drop_report, gentle
from mrzmodel import CHARS, H, W, decode, line_input

CKPT = WORK / "mrz-ckpt"



class MrzNet(nn.Module):
    def __init__(self, n_out=len(CHARS) + 1):   # the Hebrew field reader (train_he.py) has its own characters
        super().__init__()

        def block(i, o, pool):
            return [nn.Conv2d(i, o, 3, padding=1, bias=False), nn.BatchNorm2d(o), nn.ReLU(inplace=True)] + ([nn.MaxPool2d(pool)] if pool else [])
        self.conv = nn.Sequential(*block(1, 32, (2, 2)), *block(32, 64, (2, 2)), *block(64, 96, None), *block(96, 96, (2, 1)),
                                  *block(96, 128, None), *block(128, 128, (2, 1)), nn.Conv2d(128, 128, (2, 1)), nn.ReLU(inplace=True))
        self.rnn = nn.LSTM(128, 96, bidirectional=True, batch_first=True)
        self.out = nn.Linear(192, n_out)

    def forward(self, img):                     # [B,1,32,512] → [B,128,38]
        f = self.conv(img).squeeze(2).permute(0, 2, 1)   # [B,128,128]: 128 columns
        f, _ = self.rnn(f)
        return self.out(f)


def load(folder):
    rows = [l.split("\t", 1) for l in (folder / "labels.tsv").read_text(encoding="utf-8").splitlines() if "\t" in l]
    return [(folder / f, t) for f, t in rows]


def worse(gray, rng, other=None):
    """A clean made-up line made like a phone's crop of a passport's zone."""
    g = gray.astype(np.float32)
    h, w = g.shape
    if other is not None and rng.random() < 0.35:   # a strip of the other line above or below
        o = cv2.resize(other, (w, max(1, int(h * rng.uniform(0.15, 0.4))))).astype(np.float32)
        g = np.vstack([o, g]) if rng.random() < 0.5 else np.vstack([g, o])
        h = g.shape[0]
    pad = [rng.randint(0, h // 3) for _ in range(2)] + [rng.randint(0, h) for _ in range(2)]
    g = cv2.copyMakeBorder(g, pad[0], pad[1], pad[2], pad[3], cv2.BORDER_REPLICATE)
    if rng.random() < 0.6:                       # tilt
        a = rng.uniform(-2.5, 2.5)
        m = cv2.getRotationMatrix2D((g.shape[1] / 2, g.shape[0] / 2), a, 1.0)
        g = cv2.warpAffine(g, m, (g.shape[1], g.shape[0]), borderMode=cv2.BORDER_REPLICATE)
    lo, hi = rng.uniform(0, 90), rng.uniform(170, 255)   # contrast, paper tint
    g = lo + (g / 255.0) * (hi - lo)
    if rng.random() < 0.5:                       # uneven light across the line
        g = g * np.linspace(rng.uniform(0.7, 1.0), rng.uniform(0.7, 1.0), g.shape[1])[None]
    if rng.random() < 0.3:                       # faint background pattern (guilloche-like waves)
        yy, xx = np.mgrid[0:g.shape[0], 0:g.shape[1]]
        g = g - rng.uniform(5, 30) * (0.5 + 0.5 * np.sin(xx / rng.uniform(3, 12) + np.sin(yy / rng.uniform(4, 10)) * 3))
    s = rng.uniform(0.3, 1.0)                    # small in the photo
    if s < 0.95:
        sm = cv2.resize(g, (max(8, int(g.shape[1] * s)), max(4, int(g.shape[0] * s))), interpolation=cv2.INTER_AREA)
        g = cv2.resize(sm, (g.shape[1], g.shape[0]), interpolation=cv2.INTER_LINEAR)
    if rng.random() < 0.6:
        k = rng.choice((3, 3, 5))
        g = cv2.GaussianBlur(g, (k, k), rng.uniform(0.3, 1.4))
    g = g + np.random.default_rng(rng.randint(0, 1 << 30)).normal(0, rng.uniform(0, 12), g.shape)
    g = np.clip(g, 0, 255).astype(np.uint8)
    if rng.random() < 0.7:
        ok, enc = cv2.imencode(".jpg", g, [cv2.IMWRITE_JPEG_QUALITY, rng.randint(25, 90)])
        g = cv2.imdecode(enc, cv2.IMREAD_GRAYSCALE)
    return g


class Lines(torch.utils.data.Dataset):
    def __init__(self, items, train, seed=0, real=frozenset(), chars=CHARS):
        self.items, self.train, self.seed, self.real, self.chars = items, train, seed, real, chars

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        rng = random.Random((self.seed, i, torch.initial_seed()).__hash__() if self.train else i)
        p, t = self.items[i]
        g = cv2.imread(str(p), cv2.IMREAD_GRAYSCALE)
        if p in self.real:                       # a real photo's line: already a phone's — sometimes a little worse
            if self.train and rng.random() < 0.5:   # when learning, never when checked
                g = worse(g, rng)
        elif self.train:
            other = cv2.imread(str(self.items[rng.randrange(len(self.items))][0]), cv2.IMREAD_GRAYSCALE)
            g = worse(g, rng, other)
        else:
            g = worse(g, rng)                    # the check lines are made worse too, the same way each time
        x = torch.from_numpy(line_input(g))
        y = torch.tensor([self.chars.index(c) + 1 for c in t], dtype=torch.long)
        return x, y


def collate(batch):
    xs, ys = zip(*batch)
    return torch.stack(xs), torch.cat(ys), torch.tensor([len(y) for y in ys]), list(ys)


def evaluate(net, loader, dev, alphabet=CHARS):
    net.eval()
    right = total = chars = wrong = 0
    with torch.no_grad():
        for x, _, _, ys in loader:
            out = net(x.to(dev)).cpu().numpy()
            for o, y in zip(out, ys):
                t = "".join(alphabet[k - 1] for k in y.tolist())
                r = decode(o, alphabet)
                right += r == t
                total += 1
                chars += len(t)
                wrong += edit_distance(r, t)
    return right / max(1, total), wrong / max(1, chars)


def edit_distance(a, b):
    d = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        prev, d[0] = d[0], i
        for j, cb in enumerate(b, 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (ca != cb))
    return d[-1]


def fit(name, info, net, tl, vl, dev, epochs, args, alphabet=CHARS, what="lines right"):
    """CTC training of a line reader (the zone reader, the Hebrew field reader), each epoch's progress saved
    (checkpoint.py: --resume, --more; info carries the data fingerprint, and a resumed schedule must have been made for
    this run's steps); → the net with its best weights on the check lines."""
    ck = checkpoint.begin(name, args, info)
    epochs = checkpoint.epochs_of(ck, args, epochs)
    opt = torch.optim.AdamW(net.parameters(), 1e-3, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, 2e-3, total_steps=epochs * len(tl))
    checkpoint.check_steps(ck, args, epochs * len(tl))   # a resumed schedule made for another number of steps: stop now
    first, best = checkpoint.restore(ck, args, net, opt, sched)
    best = best or {"score": -1.0, "net": None}
    ctc = nn.CTCLoss(blank=0, zero_infinity=True)
    for ep in range(first, epochs):
        try:
            net.train()
            total = 0.0
            for x, y, ly, _ in tl:
                lp = net(x.to(dev)).log_softmax(-1).permute(1, 0, 2)   # [T,B,C]
                loss = ctc(lp, y.to(dev), torch.full((x.shape[0],), lp.shape[0], dtype=torch.long), ly.to(dev))
                opt.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(net.parameters(), 5)
                opt.step()
                sched.step()
                total += loss.item()
            acc, cer = evaluate(net, vl, dev, alphabet)
        except KeyboardInterrupt:
            checkpoint.stopped(name, ep)
        print(f"epoch {ep + 1}/{epochs}: loss {total / len(tl):.3f}, {what} {acc:.1%}, characters wrong {cer:.2%}")
        if acc > best["score"]:
            best = {"score": acc, "net": {k: v.detach().cpu().clone() for k, v in net.state_dict().items()}}
        checkpoint.save(name, info, net, opt, sched, ep + 1, epochs, best)
    if best["net"] is not None:
        net.load_state_dict(best["net"])
    return net


def export(net, path):
    net = net.cpu().eval()
    x = torch.rand(1, 1, H, W)
    buf = io.BytesIO()
    torch.onnx.export(net, x, buf, input_names=["img"], output_names=["logits"], opset_version=17, dynamo=False)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(buf.getvalue())
    import onnxruntime as ort
    got = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"]).run(None, {"img": x.numpy()})[0]
    want = net(x).detach().numpy()
    diff = float(np.abs(got - want).max())
    if diff > 1e-3:
        raise SystemExit(f"the ONNX model answers differently ({diff})")
    return diff


def is_check(text):
    """One line in 50 is a check line, by its text: the same in every training."""
    return zlib.crc32(text.encode()) % 50 == 0


def main():
    gentle(spare_core=False)   # below-normal priority: the PC stays usable (the GPU as it is)
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(WORK / "synth" / "mrz"))
    ap.add_argument("--epochs", type=int, default=12)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--midv", action="store_true", help="add MIDV-2020's real zone lines (midv_mrz.py)")
    ap.add_argument("--midv-repeat", type=int, default=8, help="how many times an epoch each real line is shown")
    ap.add_argument("--lr", type=float, help="the highest learning rate (default 2e-3 from random weights, 5e-4 from best.pt)")
    ap.add_argument("--fresh", action="store_true", help="start from random weights, not from best.pt")
    ap.add_argument("--resume", action="store_true", help="go on with the stopped training in last.pt")
    a = ap.parse_args()
    last = None
    if a.resume:
        if not (CKPT / "last.pt").exists():
            raise SystemExit(f"no {CKPT / 'last.pt'}: no stopped training to go on with")
        last = torch.load(CKPT / "last.pt", weights_only=False)
        a = argparse.Namespace(**last["args"])
        print(f"going on with the stopped training from epoch {last['epoch'] + 2}/{a.epochs}")
    items = load(pathlib.Path(a.data))
    if len(items) < 1000:
        raise SystemExit(f"only {len(items)} lines in {a.data}: run synth_lines.py mrz first")
    val = [it for it in items if is_check(it[1])]
    train = [it for it in items if not is_check(it[1])]
    real = []
    if a.midv:
        folder = WORK / "midv-mrz" / "train"
        if not (folder / "labels.tsv").exists():
            raise SystemExit(f"no {folder / 'labels.tsv'} — run midv_mrz.py first")
        real = load(folder)
        train = train + real * a.midv_repeat
        print(f"+ {len(real)} real zone lines from MIDV-2020, each {a.midv_repeat} times an epoch")
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"{len(train)} lines to train on, {len(val)} to check, on the {dev}")
    net = MrzNet().to(dev)
    print(f"{sum(p.numel() for p in net.parameters()) / 1e6:.2f} M weights")
    tl = torch.utils.data.DataLoader(Lines(train, True, real=frozenset(p for p, _ in real)), a.batch, shuffle=True, num_workers=a.workers, collate_fn=collate, drop_last=True)
    vl = torch.utils.data.DataLoader(Lines(val, False), 128, num_workers=a.workers, collate_fn=collate)
    saved = torch.load(CKPT / "best.pt", weights_only=False) if (CKPT / "best.pt").exists() else None
    before = None                                # best.pt on today's check lines: a training must beat it
    if saved:
        net.load_state_dict(saved["weights"])
        acc, cer = evaluate(net, vl, dev)
        before = (acc, -cer)                     # lines right first, then fewer characters wrong
        print(f"best.pt (kept {saved['at']}): {acc:.1%} of today's check lines right ({cer:.2%} of the characters wrong)")
    if last is None:
        if a.fresh or not saved:
            net = MrzNet().to(dev)
            print("from random weights")
        else:
            print("starting from best.pt")
        if a.lr is None:
            a.lr = 2e-3 if a.fresh or not saved else 5e-4
    opt = torch.optim.AdamW(net.parameters(), a.lr / 2, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, a.lr, total_steps=a.epochs * len(tl))
    ctc = nn.CTCLoss(blank=0, zero_infinity=True)
    best, first = ((-1.0, 0.0), None), 0
    if last is not None:
        saved_steps = (last.get("sched") or {}).get("total_steps")
        if saved_steps is not None and saved_steps != a.epochs * len(tl):   # the lines were drawn again since: the schedule would run out
            raise SystemExit(f"last.pt's schedule was made for {saved_steps} steps, this run has {a.epochs * len(tl)} (the lines changed) — start without --resume")
        net.load_state_dict(last["weights"])
        opt.load_state_dict(last["opt"])
        sched.load_state_dict(last["sched"])
        best, first = (last["bestAcc"], last["bestWeights"]), last["epoch"] + 1
    CKPT.mkdir(parents=True, exist_ok=True)
    for ep in range(first, a.epochs):
        net.train()
        total = 0.0
        for x, y, ly, _ in tl:
            lp = net(x.to(dev)).log_softmax(-1).permute(1, 0, 2)   # [T,B,C]
            loss = ctc(lp, y.to(dev), torch.full((x.shape[0],), lp.shape[0], dtype=torch.long), ly.to(dev))
            opt.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(net.parameters(), 5)
            opt.step()
            sched.step()
            total += loss.item()
        acc, cer = evaluate(net, vl, dev)
        print(f"epoch {ep + 1}/{a.epochs}: loss {total / len(tl):.3f}, lines right {acc:.1%}, characters wrong {cer:.2%}")
        if (acc, -cer) > best[0]:
            best = ((acc, -cer), {k: v.detach().cpu().clone() for k, v in net.state_dict().items()})
        torch.save({"args": vars(a), "epoch": ep, "weights": net.state_dict(), "opt": opt.state_dict(),
                    "sched": sched.state_dict(), "bestAcc": best[0], "bestWeights": best[1]}, CKPT / "last.pt")
    if before is not None and before >= best[0]:
        print(f"this training did not beat best.pt ({best[0][0]:.1%} against {before[0]:.1%} of the lines right): best.pt is kept and written out")
        best = (before, saved["weights"])
    else:
        import datetime
        torch.save({"weights": best[1], "acc": best[0][0], "at": datetime.date.today().isoformat()}, CKPT / "best.pt")
        print(f"best.pt kept: {best[0][0]:.1%} of the lines right")
    (CKPT / "last.pt").unlink(missing_ok=True)
    net.load_state_dict(best[1])
    acc, cer = evaluate(net.to(dev), vl, dev)
    drop_report("report_mrz.json")   # the exam of the model before: exam_mrz.py runs again on this one
    diff = export(net, WORK / "new" / "mrz.onnx")
    report = {"linesRight": acc, "charsWrong": cer, "trainLines": len(train), "checkLines": len(val), "midvLines": len(real), "onnxDiff": diff}
    (WORK / "report_mrz_train.json").write_text(json.dumps(report, indent=1))
    print(f"mrz.onnx written: on made-up lines {acc:.1%} of the lines right ({cer:.2%} of the characters wrong)")


if __name__ == "__main__":
    main()
