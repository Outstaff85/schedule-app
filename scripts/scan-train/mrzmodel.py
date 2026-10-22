"""The passport zone reader (docs/hf-plan.md → H8b): a small CRNN that reads one MRZ line, and how
a passport page's two MRZ lines are found — shared by train_mrz.py and exam_mrz.py; the phone
does the same (src/scan-process/mrz-reader.ts: the same line finding, the same input, the same
decoding — a change here is mirrored there).

The model's contract (mrz.onnx): input "img" [1, 1, 32, 512] — the line in grey 0..1, its height
scaled to 32, left-aligned, the rest of the width filled with white; output "logits" [1, 128, 38]
— per column the scores of the blank (0) and of CHARS (1..37), read greedily (best per column,
repeats and blanks dropped)."""
import numpy as np

CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<"
H, W = 32, 512


def line_input(gray):
    """A line's picture (uint8 grey, any size) → the model's input [1, 32, 512] float32 0..1."""
    import cv2
    h, w = gray.shape[:2]
    nw = max(1, min(W, round(w * H / max(1, h))))
    small = cv2.resize(gray, (nw, H), interpolation=cv2.INTER_AREA)
    out = np.full((H, W), 255, np.uint8)
    out[:, :nw] = small
    return (out.astype(np.float32) / 255.0)[None]


def decode(logits, chars=CHARS):
    """Greedy CTC: [T, len(chars) + 1] → the text (the Hebrew field reader passes its own chars, hemodel.py)."""
    best = np.asarray(logits).argmax(-1)
    out, prev = [], 0
    for k in best:
        if k != prev and k != 0:
            out.append(chars[k - 1])
        prev = k
    return "".join(out)


FILLED = 0.35


def dark_marks(gray, r=15, c=15):
    """255 where a pixel is darker than the mean of its (2r+1)² neighbourhood (the part inside the
    picture) by c, else 0 — the lab's mrzFind computes it the same way."""
    g = gray.astype(np.float64)
    h, w = g.shape
    s = np.zeros((h + 1, w + 1))
    s[1:, 1:] = g.cumsum(0).cumsum(1)
    ys, xs = np.arange(h), np.arange(w)
    y0, y1 = np.clip(ys - r, 0, h), np.clip(ys + r + 1, 0, h)
    x0, x1 = np.clip(xs - r, 0, w), np.clip(xs + r + 1, 0, w)
    total = s[y1][:, x1] - s[y0][:, x1] - s[y1][:, x0] + s[y0][:, x0]
    mean = total / ((y1 - y0)[:, None] * (x1 - x0)[None, :])
    return np.where(g <= mean - c, 255, 0).astype(np.uint8)


def find_lines(gray):
    """A passport page, upright (uint8 grey) → the two MRZ lines' pictures [line 1, line 2], or [] when
    none is found. The zone is the page's lowest two text lines that run across most of its width: in
    the lower 45 % of the page, the dark marks of each pixel row (an adaptive threshold) are counted,
    rows whose dark marks (dark_marks, then joined along the row) fill at least 35 % of the width are text (a zone line's letters, joined, fill most of it; scattered specks do not), and the last two bands of such rows are
    the lines, each cut with a little margin; a last band less than half as tall as the one above it is the page's
    edge, not a line (both zone lines are the same height), and is left out."""
    import cv2
    h, w = gray.shape[:2]
    top = int(h * 0.55)
    part = gray[top:]
    bw = dark_marks(part)
    bw = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (max(3, w // 60), 1)))
    text = (bw > 0).sum(1) >= FILLED * w
    bands, y = [], 0
    while y < len(text):
        if text[y]:
            s = y
            while y < len(text) and text[y]:
                y += 1
            if y - s >= max(4, h // 150):
                bands.append((s, y))
        y += 1
    while len(bands) > 2 and 2 * (bands[-1][1] - bands[-1][0]) < bands[-2][1] - bands[-2][0]:
        bands.pop()                              # a thin band below the zone (the page's dark edge), not its line 2
    if len(bands) < 2:
        return []
    (a0, a1), (b0, b1) = bands[-2], bands[-1]
    out = []
    for s, e in ((a0, a1), (b0, b1)):
        m = max(2, (e - s) // 4)
        y0, y1 = max(0, top + s - m), min(h, top + e + m)
        row = bw[max(0, s - m):min(bw.shape[0], e + m)]
        xs = np.flatnonzero(row.any(0))
        x0, x1 = (max(0, xs[0] - m), min(w, xs[-1] + m)) if xs.size else (0, w)
        out.append(gray[y0:y1, x0:x1])
    return out


def check(s):
    """ICAO 9303 check digit (synth.mrz_check)."""
    t = 0
    for i, c in enumerate(s):
        v = int(c) if c.isdigit() else (ord(c) - 55 if "A" <= c <= "Z" else 0)
        t += v * (7, 3, 1)[i % 3]
    return t % 10


def fields(line2, this_year=None):
    """The values of MRZ line 2 whose check digit is right, as the worker window keeps them
    (docId, docDob and docExpiry DD/MM/YYYY, docSex) — src/scan-process/mrz.ts parseMrz without its mending."""
    import datetime
    l2 = (line2 + "<" * 44)[:44]
    yy = (this_year or datetime.date.today().year) % 100
    out = {}
    if l2[9].isdigit() and check(l2[0:9]) == int(l2[9]) and l2[0:9].strip("<"):
        out["docId"] = l2[0:9].rstrip("<")
    for key, s, e, century in (("docDob", 13, 19, lambda y: 19 if y > yy else 20), ("docExpiry", 21, 27, lambda y: 20)):
        part, c = l2[s:e], l2[e]
        if part.isdigit() and c.isdigit() and check(part) == int(c) and 1 <= int(part[2:4]) <= 12 and 1 <= int(part[4:6]) <= 31:
            out[key] = f"{part[4:6]}/{part[2:4]}/{century(int(part[:2]))}{part[:2]}"
    if l2[20] in "MF":
        out["docSex"] = l2[20]
    return out
