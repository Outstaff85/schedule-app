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


def decode(logits):
    """Greedy CTC: [T, 38] → the text."""
    best = np.asarray(logits).argmax(-1)
    out, prev = [], 0
    for k in best:
        if k != prev and k != 0:
            out.append(CHARS[k - 1])
        prev = k
    return "".join(out)


def find_lines(gray):
    """A passport page, upright (uint8 grey) → the two MRZ lines' pictures [line 1, line 2], or [] when
    none is found. The zone is the page's lowest two text lines that run across most of its width: in
    the lower 45 % of the page, the dark marks of each pixel row (an adaptive threshold) are counted,
    rows with marks over at least 55 % of the width are text, and the last two bands of such rows are
    the lines, each cut with a little margin."""
    import cv2
    h, w = gray.shape[:2]
    top = int(h * 0.55)
    part = gray[top:]
    bw = cv2.adaptiveThreshold(part, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 31, 15)
    bw = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (max(3, w // 60), 1)))
    cols = np.zeros(bw.shape[0], np.float32)
    for y in range(bw.shape[0]):
        xs = np.flatnonzero(bw[y])
        cols[y] = (xs[-1] - xs[0]) / w if xs.size > w * 0.08 else 0.0
    text = cols >= 0.55
    bands, y = [], 0
    while y < len(text):
        if text[y]:
            s = y
            while y < len(text) and text[y]:
                y += 1
            if y - s >= max(4, h // 150):
                bands.append((s, y))
        y += 1
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
