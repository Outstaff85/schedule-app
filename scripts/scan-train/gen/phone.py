"""The phone's input path in Python (docs/scan-training.md → "The phone mirror"): exact ports of what the scanner lab
does to a picture before a model sees it (src/scan/engine/, the one copy the site's scanner and the lab run), so training
and the exams see what the phone sees. A change on either side is mirrored on the other (CLAUDE.md → "Duplicated on
purpose"); tests/scan/phone_parity.test.mjs runs the lab's own code on the fixtures tests/auth/test_scan_train_phone.py
writes from this file, and tests/e2e/phone-parity.test.js runs the lab's resamplers in Chromium.

Exact ports (pure numpy, no randomness):
- corners(hm): the 4 corners picked together from the edges model's heatmaps (geometry.ts corners; docfind.py
  re-exports it);
- homography / warp_rgba: the cut (geometry.ts warpRGBA) — bilinear, no antialiasing, the sides by Math.round, no
  exact proportion, what falls outside the photo left 0 (alpha too);
- mrz_find: the passport zone's two line boxes (readers.ts mrzFind), and line_input (mrzRead's 32 × 512 input);
- he_line(page, box): the Hebrew field reader's input (readers.ts heLineBox: margins HE_MARGIN_X / HE_MARGIN_Y of the
  box — hemodel.MARGIN_X / MARGIN_Y, which synth_fields.crop cuts by too);
- face_turn(sess, page): the quarter turns that set a cut page upright by its face (upright.ts faceTurn / faceScore);
- doc_shape, lab_good_quad, in_quad / lab_quad_iou, lab_border_colour, unwarp, INSIDE_MIN / INSIDE_MAX: the rules by
  which the lab takes more documents on one photo (geometry.ts docShape, goodQuad, inQuad / quadIoU, findNext's paint
  colour, findInside) — docfind.find_next(lab=True) and docfind.find_inside run the lab's steps with them.

The resampling (the one thing a browser decides for itself): frame_to_S(img, op) — "live" (the camera frame by
createImageBitmap, resizeQuality 'low'), "capture" (drawImage onto the 256 canvas at the default smoothing: smallRGBA;
the document type square, the face finder's 320 letterbox and the stored attempt are drawn the same way) and "high"
(imageSmoothingQuality 'high': the zone and field lines). Each op's kernel comes from gen/phone_profile.json: a
measured profile (`python -m gen profile --from probe.json`) names one kernel per op; with none measured, a kernel mix is
drawn from and its name (profile_id) is written beside what it made. The kernels:
- "bilinear": one bilinear sample at each output pixel's centre, edges clamped (Skia's linear filter, no mipmaps:
  Chromium's 'low' — createImageBitmap and drawImage — measured by tests/e2e/phone-parity.test.js);
- "mipmap": Skia's linear mipmaps — a 2 × 2 box pyramid, the two levels around log2 of the shrink less 0.5 sampled
  bilinearly and blended (Chromium's 'medium');
- "high": "mipmap" when shrinking, the Mitchell cubic when enlarging (Chromium's imageSmoothingQuality 'high', measured
  by tests/e2e/phone-parity.test.js); "cubic": the Mitchell cubic alone;
- "area": every source pixel averaged by its share (cv2.INTER_AREA — what training used before, and a well
  antialiased browser);
- "nearest": the source pixel under each output pixel's centre.

Images are H × W × C uint8 in the phone's order (RGB, or RGBA); the resamplers keep whatever order they are given, and
the functions whose output order matters take bgr=True for an OpenCV picture. Torch-free and Google-free."""
import base64
import hashlib
import json
import math
import pathlib
import random
import zlib

import numpy as np

S, HM, FN = 256, 128, 320               # the edges model's input and heatmap sides; the face finder's input side
MRZ_H, MRZ_W = 32, 512                  # the zone / field reader's input
PICTURE_MAX, JPEG_QUALITY = 1600, 85    # newAttempt: the stored photo (toDataURL 'image/jpeg', 0.85)
PROFILE = pathlib.Path(__file__).with_name("phone_profile.json")
KERNELS = ("bilinear", "mipmap", "high", "cubic", "area", "nearest")
OPS = ("live", "capture", "high")


def js_round(v):
    """Math.round: halves up (Python's round goes to even)."""
    return int(math.floor(v + 0.5))


# ---------- the resamplers ----------

def _bilinear(src, rect, ow, oh):
    x0, y0, sw, sh = rect
    h, w = src.shape[:2]
    xs = x0 + (np.arange(ow) + 0.5) * (sw / ow) - 0.5
    ys = y0 + (np.arange(oh) + 0.5) * (sh / oh) - 0.5
    ix, iy = np.floor(xs), np.floor(ys)
    fx, fy = xs - ix, ys - iy
    ix0, ix1 = np.clip(ix, 0, w - 1).astype(np.intp), np.clip(ix + 1, 0, w - 1).astype(np.intp)
    iy0, iy1 = np.clip(iy, 0, h - 1).astype(np.intp), np.clip(iy + 1, 0, h - 1).astype(np.intp)
    s = src.astype(np.float64)
    fx = fx[None, :, None] if s.ndim == 3 else fx[None, :]
    fy = fy[:, None, None] if s.ndim == 3 else fy[:, None]
    top = s[iy0][:, ix0] * (1 - fx) + s[iy0][:, ix1] * fx
    bot = s[iy1][:, ix0] * (1 - fx) + s[iy1][:, ix1] * fx
    return top * (1 - fy) + bot * fy


def _nearest(src, rect, ow, oh):
    x0, y0, sw, sh = rect
    h, w = src.shape[:2]
    ix = np.clip(np.floor(x0 + (np.arange(ow) + 0.5) * (sw / ow)), 0, w - 1).astype(np.intp)
    iy = np.clip(np.floor(y0 + (np.arange(oh) + 0.5) * (sh / oh)), 0, h - 1).astype(np.intp)
    return src[iy][:, ix].astype(np.float64)


def _half(a, axis):
    """One mipmap step along an axis: pairs averaged; an odd side by the 1-2-1 filter (Skia's downsample_3)."""
    n = a.shape[axis]
    if n < 2:
        return a
    t = np.moveaxis(a, axis, 0)
    m = n // 2
    if n % 2 == 0:
        out = (t[0:2 * m:2] + t[1:2 * m:2]) / 2
    else:
        out = (t[0:2 * m:2] + 2 * t[1:2 * m + 1:2] + t[2:2 * m + 1:2]) / 4
    return np.moveaxis(out, 0, axis)


def _level(src, L, cache):
    """Mipmap level L of src (each level stored in 8 bits, as Skia keeps them)."""
    if L not in cache:
        a = _level(src, L - 1, cache) if L > 0 else src.astype(np.float64)
        if L > 0 and not (a.shape[0] < 2 and a.shape[1] < 2):
            a = np.floor(_half(_half(a, 0), 1) + 0.5)
        cache[L] = a
    return cache[L]


def _at_level(src, L, rect, ow, oh, cache):
    a = _level(src, L, cache)
    x0, y0, sw, sh = rect
    ky, kx = a.shape[0] / src.shape[0], a.shape[1] / src.shape[1]
    return _bilinear(a, (x0 * kx, y0 * ky, sw * kx, sh * ky), ow, oh)


def _mipmap(src, rect, ow, oh):
    """Skia's linear mipmaps (Chromium's 'medium', and 'high' when shrinking): the level of detail
    log2 of the geometric mean of the two shrink factors less 0.5 (Skia's "sharpen" bias), the two levels around it
    each sampled bilinearly and blended by its fraction; no shrink beyond the bias: plain bilinear."""
    _, _, sw, sh = rect
    shrink = math.sqrt((sw / ow) * (sh / oh))
    lod = max(0.0, math.log2(shrink) - 0.5) if shrink > 0 else 0.0
    if lod <= 0:
        return _bilinear(src, rect, ow, oh)
    cache = {}
    lo = int(math.floor(lod))
    t = lod - lo
    out = _at_level(src, lo, rect, ow, oh, cache)
    return out if t == 0 else out * (1 - t) + _at_level(src, lo + 1, rect, ow, oh, cache) * t


def _mitchell(t):
    """The Mitchell–Netravali cubic (B = C = 1/3), Skia's for 'high' when enlarging."""
    t = np.abs(t)
    B = C = 1 / 3
    t2, t3 = t * t, t * t * t
    near = ((12 - 9 * B - 6 * C) * t3 + (-18 + 12 * B + 6 * C) * t2 + (6 - 2 * B)) / 6
    far = ((-B - 6 * C) * t3 + (6 * B + 30 * C) * t2 + (-12 * B - 48 * C) * t + (8 * B + 24 * C)) / 6
    return np.where(t < 1, near, np.where(t < 2, far, 0.0))


def _cubic(src, rect, ow, oh):
    x0, y0, sw, sh = rect
    h, w = src.shape[:2]

    def taps(start, span, n, size):
        c = start + (np.arange(n) + 0.5) * (span / n) - 0.5
        base = np.floor(c)
        idx = base[:, None] + np.arange(-1, 3)[None, :]
        wts = _mitchell(c[:, None] - idx)
        return np.clip(idx, 0, size - 1).astype(np.intp), wts / wts.sum(1, keepdims=True)
    xi, xw = taps(x0, sw, ow, w)
    yi, yw = taps(y0, sh, oh, h)
    s = src.astype(np.float64)
    rows = np.einsum("yk,yk...->y...", yw, s[yi])                     # oh × w × C: each output row from 4 source rows
    return np.einsum("xk,yxk...->yx...", xw, rows[:, xi])


def _high(src, rect, ow, oh):
    """Chromium's 'high' (imageSmoothingQuality): the linear mipmaps when shrinking (on either side), the Mitchell
    cubic when not."""
    _, _, sw, sh = rect
    return _mipmap(src, rect, ow, oh) if sw > ow or sh > oh else _cubic(src, rect, ow, oh)


def _area(src, rect, ow, oh):
    import cv2
    x0, y0, sw, sh = rect
    h, w = src.shape[:2]
    X0, Y0 = max(0, int(math.floor(x0))), max(0, int(math.floor(y0)))
    X1, Y1 = min(w, max(X0 + 1, int(math.ceil(x0 + sw)))), min(h, max(Y0 + 1, int(math.ceil(y0 + sh))))
    return cv2.resize(np.ascontiguousarray(src[Y0:Y1, X0:X1]), (ow, oh), interpolation=cv2.INTER_AREA).astype(np.float64)


_KERNEL_FN = {"bilinear": _bilinear, "mipmap": _mipmap, "high": _high, "cubic": _cubic, "area": _area, "nearest": _nearest}


def resample(img, size, kernel="bilinear", rect=None):
    """img (H × W [× C] uint8) → size (w, h) uint8 by one kernel (KERNELS), from rect (x, y, w, h) in pixels — the
    source rectangle of drawImage(img, x, y, w, h, 0, 0, ow, oh); the whole picture by default."""
    ow, oh = int(size[0]), int(size[1])
    h, w = img.shape[:2]
    rect = (0.0, 0.0, float(w), float(h)) if rect is None else tuple(float(v) for v in rect)
    if (ow, oh) == (w, h) and rect == (0.0, 0.0, float(w), float(h)):
        return np.array(img, np.uint8)   # drawn at its own size: copied (a browser filters nothing there)
    out = _KERNEL_FN[kernel](img, rect, ow, oh)
    return np.clip(np.floor(out + 0.5), 0, 255).astype(np.uint8)


# ---------- the profile: which kernel each op uses ----------

_profiles = {}


def load_profile(path=None):
    p = pathlib.Path(path or PROFILE)
    key = str(p.resolve())
    if key not in _profiles:
        raw = p.read_bytes()
        prof = json.loads(raw.decode("utf-8"))
        prof["_sha256"] = hashlib.sha256(raw).hexdigest()
        _profiles[key] = prof
    return _profiles[key]


def profile_id(profile=None):
    """The profile's name and the short sha256 of its file: written beside every input made with it (a checkpoint's
    data fingerprint, exam_phone.json)."""
    prof = profile if isinstance(profile, dict) else load_profile(profile)
    return f"{prof.get('name', 'unnamed')}:{prof.get('_sha256', '')[:12]}"


def _mix(prof, op):
    spec = (prof.get("ops") or {}).get(op) or {}
    if spec.get("kernel"):
        return {spec["kernel"]: 1.0}
    mix = {k: float(v) for k, v in (spec.get("mix") or {}).items() if k in KERNELS and float(v) > 0}
    return mix or {"bilinear": 1.0}


def kernel_for(op, rng=None, profile=None):
    """The kernel an op uses: the measured one, else one drawn from the mix (with rng: a random.Random or a numpy
    Generator), else — with no rng (the exams: the same every run) — the mix's heaviest."""
    mix = _mix(profile if isinstance(profile, dict) else load_profile(profile), op)
    names = sorted(mix, key=lambda k: (-mix[k], KERNELS.index(k)))
    if rng is None or len(names) == 1:
        return names[0]
    total = sum(mix[k] for k in names)
    r = (rng.random() if hasattr(rng, "random") else random.random()) * total
    for k in names:
        r -= mix[k]
        if r < 0:
            return k
    return names[-1]


def mix_kernels(op, profile=None):
    """Every kernel the op may use under the profile, heaviest first."""
    mix = _mix(profile if isinstance(profile, dict) else load_profile(profile), op)
    return sorted(mix, key=lambda k: (-mix[k], KERNELS.index(k)))


def _kernel(op, kernel, rng, profile):
    return kernel or kernel_for(op, rng, profile)


# ---------- the inputs the phone makes ----------

def frame_to_S(img, op="capture", kernel=None, rng=None, profile=None):
    """The edges model's 256 × 256 input from a frame (any size, kept in its channel order): op "live"
    (createImageBitmap, resizeQuality 'low'), "capture" (smallRGBA: drawImage at the default smoothing) or "high"."""
    if op not in OPS:
        raise ValueError(f"op {op!r}: one of {OPS}")
    return resample(img, (S, S), _kernel(op, kernel, rng, profile))


def turned(img, k):
    """img turned k clockwise quarter turns (upright.ts turned: whole pixels, no resampling)."""
    return np.ascontiguousarray(np.rot90(img, -k)) if k % 4 else img


def face_input(img, k=0, bgr=False, kernel=None, rng=None, profile=None):
    """The face finder's input (upright.ts faceScore): the page turned k quarter turns, shrunk into a black 320 × 320
    square at its top-left (Math.round sides), as float32 [3, 320, 320] BGR 0..255."""
    src = turned(img[..., :3], k)
    h, w = src.shape[:2]
    s = FN / max(w, h)
    nw, nh = js_round(w * s), js_round(h * s)
    canvas = np.zeros((FN, FN, 3), np.uint8)
    canvas[:nh, :nw] = resample(src, (nw, nh), _kernel("capture", kernel, rng, profile))
    if not bgr:
        canvas = canvas[..., ::-1]
    return np.ascontiguousarray(canvas.transpose(2, 0, 1)).astype(np.float32)


def doctype_input(page, bgr=False, kernel=None, rng=None, profile=None):
    """The document type model's input (readers.ts doctypeAnswer): the page drawn onto a 256 × 256 square (the aspect
    not kept) at the default smoothing, as float32 [3, 256, 256] RGB 0..1."""
    sq = resample(page[..., :3], (S, S), _kernel("capture", kernel, rng, profile))
    if bgr:
        sq = sq[..., ::-1]
    return np.ascontiguousarray(sq.transpose(2, 0, 1)).astype(np.float32) / 255.0


def face_score_of(outs):
    """faceScore's reading of the face finder's outputs on its 320 input ({name: array}: cls_/obj_/kps_ 8, 16, 32): the
    surest face (the first of the highest, stride by stride), its score × sin of the eyes → mouth angle — 1 when the
    mouth is straight below the eyes; 0 when no face is surer than 0.5."""
    best = None
    for st in (8, 16, 32):
        cols = FN // st
        cls = np.clip(np.asarray(outs[f"cls_{st}"], np.float64).reshape(-1), 0, 1)
        obj = np.clip(np.asarray(outs[f"obj_{st}"], np.float64).reshape(-1), 0, 1)
        if not cls.size:
            continue
        sc = np.sqrt(cls * obj)
        i = int(np.argmax(sc))
        if best is None or sc[i] > best[0]:
            kps = np.asarray(outs[f"kps_{st}"], np.float64).reshape(-1, 10)[i]
            r, c = divmod(i, cols)
            best = (float(sc[i]), [((kps[2 * m] + c) * st, (kps[2 * m + 1] + r) * st) for m in range(5)])
    if best is None or best[0] < 0.5:
        return 0.0
    er, el, _, mr, ml = best[1]
    a = math.atan2((mr[1] + ml[1]) / 2 - (er[1] + el[1]) / 2, (mr[0] + ml[0]) / 2 - (er[0] + el[0]) / 2)
    return best[0] * max(0.0, math.sin(a))


def face_turn(sess, page, bgr=False, kernel=None):
    """upright.ts faceTurn: the clockwise quarter turns (0..3) that put a cut page upright by the face on it — the
    page turned k = 0..3, each on the face finder's 320 letterbox (face_input), the surest upright face wins; -1 when
    no face is found. sess: the face finder's ONNX session (face.onnx)."""
    name = sess.get_inputs()[0].name
    outs = [o.name for o in sess.get_outputs()]
    bk, bs = -1, 0.0
    for k in range(4):
        x = face_input(page, k, bgr=bgr, kernel=kernel)
        sc = face_score_of(dict(zip(outs, sess.run(None, {name: x[None]}))))
        if sc > bs:
            bk, bs = k, sc
    return bk


def _grey(rgba):
    return (0.299 * rgba[..., 0].astype(np.float64) + 0.587 * rgba[..., 1] + 0.114 * rgba[..., 2])


def _line(img, rect, kernel):
    x0, y0, w, h = rect
    nw = max(1, min(MRZ_W, js_round(w * MRZ_H / max(1, h))))
    out = np.full((MRZ_H, MRZ_W, 3), 255, np.uint8)
    out[:, :nw] = resample(img[..., :3], (nw, MRZ_H), kernel, rect=rect)
    return (_grey(out) / 255.0).astype(np.float32)[None]


def line_input(img, box, kernel=None, rng=None, profile=None):
    """mrzRead's input for one zone line: the box ({x, y, w, h} in pixels, from mrz_find) drawn at 'high' smoothing
    into a white 32 × 512 strip, its height to 32 (the width by the same scale, at most 512), as grey float32
    [1, 32, 512] 0..1 (0.299 R + 0.587 G + 0.114 B). bgr: no matter here only when the picture is grey."""
    b = box
    return _line(img, (int(b["x"]), int(b["y"]), int(b["w"]), int(b["h"])), _kernel("high", kernel, rng, profile))


def strip_input(gray, kernel=None, rng=None, profile=None):
    """A stored grey strip — a zone line's box (gen/outputs/mrz.py) or heLine's rectangle (gen/outputs/he.py), cut at
    the page's own resolution — as the reader's input the phone draws from it: line_input over the whole strip ('high'
    smoothing into the white 32 × 512), grey float32 [1, 32, 512] 0..1. The exams' phone-path reads go through it, never
    mrzmodel.line_input's INTER_AREA."""
    g = np.asarray(gray)
    if g.ndim == 3:
        g = g[..., 0]
    h, w = g.shape[:2]
    return line_input(np.repeat(g[..., None], 3, 2), {"x": 0, "y": 0, "w": w, "h": h}, kernel, rng, profile)


# heLine's margins around a field's layout box: a share of the box's width on each side and of its height above and
# below. One number on every side of the copy: hemodel.MARGIN_X / MARGIN_Y (synth_fields.crop cuts the training fields
# by them) and HE_MX / HE_MY in src/scan/engine/readers.ts heLineBox — tests/auth/test_scan_train_he.py holds them
# equal. Wide enough for the 99th percentile of a field running past its layout box on the phone's own cut
# (gen/outputs/he.py writes layout_overflow.json) and for a corner a little off.
HE_MARGIN_X, HE_MARGIN_Y = 0.22, 0.7


def he_rect(W, H, box):
    """heLine's source rectangle (x0, y0, w, h) in pixels of a W × H page for a field box ([x, y, w, h] as shares of
    the page): the box grown by HE_MARGIN_X of its width on each side and HE_MARGIN_Y of its height above and below,
    kept inside the page; None when it is under 4 px."""
    bx, by, bw, bh = (float(v) for v in box)
    x0, y0 = max(0.0, (bx - HE_MARGIN_X * bw) * W), max(0.0, (by - HE_MARGIN_Y * bh) * H)
    x1, y1 = min(float(W), (bx + bw * (1 + HE_MARGIN_X)) * W), min(float(H), (by + bh * (1 + HE_MARGIN_Y)) * H)
    w, h = x1 - x0, y1 - y0
    if w < 4 or h < 4:
        return None
    return x0, y0, w, h


def he_line(page, box, kernel=None, rng=None, profile=None):
    """heLine's input for one field: the box ([x, y, w, h] as shares of the page) grown by heLine's margins (he_rect),
    drawn as line_input does; None when the field is under 4 px."""
    H, W = page.shape[:2]
    rect = he_rect(W, H, box)
    if rect is None:
        return None
    return _line(page, rect, _kernel("high", kernel, rng, profile))


def store_attempt(img, bgr=True, kernel=None, rng=None, profile=None):
    """The photo an attempt keeps (attempts.ts newAttempt): at most PICTURE_MAX px on its long side (drawImage at the
    default smoothing; Math.round sides), as JPEG at quality 0.85 → (jpeg bytes, the shrunk picture)."""
    import cv2
    h, w = img.shape[:2]
    k = min(1.0, PICTURE_MAX / max(w, h))
    small = img[..., :3] if k >= 1 else resample(img[..., :3], (js_round(w * k), js_round(h * k)), _kernel("capture", kernel, rng, profile))
    ok, buf = cv2.imencode(".jpg", small if bgr else small[..., ::-1], [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
    return buf.tobytes(), small


# ---------- corners (geometry.ts corners) ----------

PEAKS, PEAK_R, BLOB_R, SIDES, PAR, FREE = 3, 6, 10, 1.6, 4, 5 * math.pi / 180


def _spots(m):
    """Up to PEAKS spots of one heatmap (>= 0.3 and at least half its highest): the weighted centre of the blob around
    each peak — the pixels >= 0.3 joined to it (4-neighbours) without leaving the BLOB_R window — in 0..1, and the
    peak's value. Then the PEAK_R square around the peak is taken out (geometry.ts spotsOf)."""
    hm = np.asarray(m, np.float64)
    n = hm.shape[0]
    top = float(hm.max())
    flat = hm.reshape(-1)
    gone = np.zeros(n * n, bool)
    out = []
    for _ in range(PEAKS):
        left = np.where(gone, -np.inf, flat)
        mi = int(np.argmax(left))
        mv = float(left[mi])
        if mv < 0.3 or mv < top * 0.5:
            break
        px, py = mi % n, mi // n
        seen = np.zeros(n * n, bool)
        seen[mi] = True
        q = [mi]
        sx = sy = sw = 0.0
        while q:
            i = q.pop()
            x, y = i % n, i // n
            v = float(flat[i])
            sx += x * v
            sy += y * v
            sw += v
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if nx < 0 or ny < 0 or nx >= n or ny >= n or abs(nx - px) > BLOB_R or abs(ny - py) > BLOB_R:
                    continue
                j = ny * n + nx
                if not seen[j] and flat[j] >= 0.3:
                    seen[j] = True
                    q.append(j)
        out.append(([(sx / sw + 0.5) / n, (sy / sw + 0.5) / n], mv))
        gy0, gy1 = max(0, py - PEAK_R), min(n - 1, py + PEAK_R)
        gx0, gx1 = max(0, px - PEAK_R), min(n - 1, px + PEAK_R)
        g = gone.reshape(n, n)
        g[gy0:gy1 + 1, gx0:gx1 + 1] = True
    return out, top


def _sign(z):
    return (z > 0) - (z < 0)


def _frame_score(c):
    q = [p for p, _ in c]
    sg = 0
    for i in range(4):
        a, b, d = q[i], q[(i + 1) % 4], q[(i + 2) % 4]
        z = (b[0] - a[0]) * (d[1] - b[1]) - (b[1] - a[1]) * (d[0] - b[0])
        if not z or (sg and _sign(z) != sg):
            return -1.0
        sg = _sign(z)

    def side(i):
        return math.hypot(q[(i + 1) % 4][0] - q[i][0], q[(i + 1) % 4][1] - q[i][1])

    def even(a, b):
        r = max(a, b) / max(1e-6, min(a, b))
        return (SIDES / r) ** 2 if r > SIDES else 1.0

    def ang(i):
        return math.atan2(q[(i + 1) % 4][1] - q[i][1], q[(i + 1) % 4][0] - q[i][0])

    def off(a, b):   # how far opposite sides are from parallel (they run opposite ways)
        d = math.fmod(abs(ang(a) - ang(b) - math.pi), 2 * math.pi)
        return min(d, 2 * math.pi - d)
    # a page in perspective keeps one pair of sides near parallel; a frame with both pairs off is counted down by
    # cos^PAR of the smaller one beyond FREE
    par = max(0.0, math.cos(max(0.0, min(off(0, 2), off(1, 3)) - FREE))) ** PAR
    return sum(v for _, v in c) * even(side(0), side(2)) * even(side(1), side(3)) * par


def corners(hm):
    """The 4 corners picked together from up to PEAKS spots of each heatmap (hm: [4, 128, 128]): with two documents
    on a picture every heatmap has a spot on each, and the highest spots alone can put one corner on one document and
    three on the other (an ID card below its ספח, 2026-10-22). The convex frame with the highest spots wins, a frame
    whose opposite sides differ more than SIDES× counted down, and one with both pairs of sides more than FREE from
    parallel (a frame mixed of two documents) by cos^PAR of the rest. One spot on each heatmap: that frame. →
    (pts 4 × 2 in 0..1, or None when a heatmap has no spot; conf). geometry.ts corners, exactly."""
    found = [_spots(hm[k]) for k in range(4)]
    conf0 = min(top for _, top in found)
    if any(not s for s, _ in found):
        return None, conf0
    best = [s[0] for s, _ in found]
    best_score = _frame_score(best)
    for s0 in found[0][0]:
        for s1 in found[1][0]:
            for s2 in found[2][0]:
                for s3 in found[3][0]:
                    c = [s0, s1, s2, s3]
                    sc = _frame_score(c)
                    if sc > best_score:
                        best, best_score = c, sc
    return np.array([p for p, _ in best], np.float64), min(v for _, v in best)


# ---------- the cut (geometry.ts homography, warpRGBA) ----------

def homography(frm, to):
    """The 8 numbers of the plane map taking the 4 points frm onto to (Gaussian elimination with partial pivoting,
    in the lab's order)."""
    A, b = [], []
    for i in range(4):
        x, y = frm[i]
        u, v = to[i]
        A.append([x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y]); b.append(u)
        A.append([0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y]); b.append(v)
    A = [[float(t) for t in r] for r in A]
    b = [float(t) for t in b]
    for c in range(8):
        m = c
        for r in range(c + 1, 8):
            if abs(A[r][c]) > abs(A[m][c]):
                m = r
        A[c], A[m] = A[m], A[c]
        b[c], b[m] = b[m], b[c]
        for r in range(8):
            if r != c:
                f = A[r][c] / A[c][c]
                for k in range(c, 8):
                    A[r][k] -= f * A[c][k]
                b[r] -= f * b[c]
    return [b[i] / A[i][i] for i in range(8)]


def apply_h(Hm, x, y):
    z = Hm[6] * x + Hm[7] * y + 1
    return (Hm[0] * x + Hm[1] * y + Hm[2]) / z, (Hm[3] * x + Hm[4] * y + Hm[5]) / z


def warp_size(w, h, pts):
    P = [(x * w, y * h) for x, y in pts]
    d = lambda a, b: math.hypot(a[0] - b[0], a[1] - b[1])
    return js_round(max(d(P[0], P[1]), d(P[3], P[2]))), js_round(max(d(P[0], P[3]), d(P[1], P[2]))), P


def warp_rgba(rgba, pts):
    """The quad pts (0..1, from the top-left clockwise) of an H × W × 4 picture cut flat (geometry.ts warpRGBA):
    width the longer of the top and bottom sides and height the longer of the left and right ones (Math.round),
    one bilinear sample per pixel with no antialiasing (a source pixel whose right or lower neighbour falls outside
    the picture gives nothing), each value rounded as a Uint8ClampedArray does (half to even); what falls outside
    stays 0, alpha too; the rest has alpha 255."""
    rgba = np.asarray(rgba)
    h, w = rgba.shape[:2]
    if rgba.shape[2] == 3:
        rgba = np.concatenate([rgba, np.full((h, w, 1), 255, np.uint8)], 2)
    W, Hh, P = warp_size(w, h, pts)
    Hm = homography([[0, 0], [W, 0], [W, Hh], [0, Hh]], P)
    out = np.zeros((Hh, W, 4), np.uint8)
    if W <= 0 or Hh <= 0:
        return out
    ys, xs = np.mgrid[0:Hh, 0:W].astype(np.float64)
    z = Hm[6] * xs + Hm[7] * ys + 1
    sx = (Hm[0] * xs + Hm[1] * ys + Hm[2]) / z
    sy = (Hm[3] * xs + Hm[4] * ys + Hm[5]) / z
    ix, iy = np.trunc(sx), np.trunc(sy)        # x | 0
    ok = (ix >= 0) & (iy >= 0) & (ix < w - 1) & (iy < h - 1) & np.isfinite(sx) & np.isfinite(sy)
    ixs, iys = ix[ok].astype(np.intp), iy[ok].astype(np.intp)
    fx, fy = sx[ok] - ix[ok], sy[ok] - iy[ok]
    src = rgba.astype(np.float64)
    for c in range(3):
        p00, p01 = src[iys, ixs, c], src[iys, ixs + 1, c]
        p10, p11 = src[iys + 1, ixs, c], src[iys + 1, ixs + 1, c]
        v = (p00 * (1 - fx) + p01 * fx) * (1 - fy) + (p10 * (1 - fx) + p11 * fx) * fy
        out[..., c][ok] = np.clip(np.rint(v), 0, 255).astype(np.uint8)
    out[..., 3][ok] = 255
    return out


def unwarp(q, pts):
    """Points (0..1) found on the flat cut of the quad q, back on the photo (shot.ts findInside)."""
    Hm = homography([[0, 0], [1, 0], [1, 1], [0, 1]], q)
    return [list(apply_h(Hm, u, v)) for u, v in pts]


# ---------- the passport zone (readers.ts mrzFind) ----------

def mrz_find(img):
    """The passport zone's two lines on an upright page (H × W × 3 or 4, RGB; a grey picture is taken as R = G = B):
    [{x, y, w, h}] in pixels, line 1 then line 2, or [] — the lab's mrzFind, exactly: the grey (float32) of the lower
    45 %, dark marks under the mean of their 31 × 31 neighbourhood by 15, closed along each row (w/60 wide), rows
    filled to 35 % are text, the last two bands of at least max(4, H/150) rows (a last band under half the one
    above it is the page's dark edge), each with a margin of a quarter of its height."""
    a = np.asarray(img)
    if a.ndim == 2:
        a = np.repeat(a[..., None], 3, 2)
    h, w = a.shape[:2]
    top = int(math.floor(h * 0.55))
    ph = h - top
    if w < 50 or ph < 20:
        return []
    gray = _grey(a[top:]).astype(np.float32).astype(np.float64)
    s = np.zeros((ph + 1, w + 1))
    s[1:, 1:] = np.cumsum(np.cumsum(gray, 1), 0)
    r = 15
    ys, xs = np.arange(ph), np.arange(w)
    y0, y1 = np.maximum(0, ys - r), np.minimum(ph, ys + r + 1)
    x0, x1 = np.maximum(0, xs - r), np.minimum(w, xs + r + 1)
    total = s[y1][:, x1] - s[y0][:, x1] - s[y1][:, x0] + s[y0][:, x0]
    mean = total / ((y1 - y0)[:, None] * (x1 - x0)[None, :])
    bw = (gray <= mean - 15).astype(np.uint8)
    k = max(3, w // 60)
    half = k // 2
    lo = np.maximum(0, xs - half)
    hi = np.minimum(w - 1, xs - half + k - 1)

    def run(rows, op):
        c = np.zeros((rows.shape[0], w + 1), np.int64)
        c[:, 1:] = np.cumsum(rows, 1)
        cnt = c[:, hi + 1] - c[:, lo]
        return (cnt > 0).astype(np.uint8) if op == "max" else (cnt == (hi - lo + 1)).astype(np.uint8)
    bw = run(run(bw, "max"), "min")
    filled = bw.sum(1) >= 0.35 * w
    bands, min_h, y = [], max(4, h // 150), 0
    while y < ph:
        if not filled[y]:
            y += 1
            continue
        st = y
        while y < ph and filled[y]:
            y += 1
        if y - st >= min_h:
            bands.append((st, y))
        y += 1
    while len(bands) > 2 and 2 * (bands[-1][1] - bands[-1][0]) < bands[-2][1] - bands[-2][0]:
        bands.pop()
    if len(bands) < 2:
        return []
    out = []
    for st, e in bands[-2:]:
        m = max(2, (e - st) // 4)
        ys0, ye = max(0, st - m), min(ph, e + m)
        cols = np.flatnonzero(bw[ys0:ye].any(0))
        cx0, cx1 = (int(cols[0]), int(cols[-1])) if cols.size else (0, w - m)
        bx = max(0, cx0 - m)
        out.append({"x": bx, "y": top + ys0, "w": min(w, cx1 + m) - bx, "h": ye - ys0})
    return out


# ---------- small helpers the tests and the probe share ----------

def psnr(a, b):
    """The peak signal-to-noise ratio of two uint8 pictures of one shape, in dB (inf when equal)."""
    d = np.asarray(a, np.float64) - np.asarray(b, np.float64)
    mse = float((d * d).mean())
    return float("inf") if mse == 0 else 10 * math.log10(255 * 255 / mse)


def pack(a):
    """A uint8 / float32 array as {shape, dtype, z}: zlib + base64 (the parity fixtures)."""
    a = np.ascontiguousarray(a)
    return {"shape": list(a.shape), "dtype": str(a.dtype), "z": base64.b64encode(zlib.compress(a.tobytes(), 9)).decode()}


def unpack(d):
    """pack's {shape, dtype, z} back, or {shape, dtype, b64} (raw bytes, base64: what a browser sends)."""
    raw = zlib.decompress(base64.b64decode(d["z"])) if "z" in d else base64.b64decode(d["b64"])
    return np.frombuffer(raw, np.dtype(d["dtype"])).reshape(d["shape"])


# ---------- a document's shape (geometry.ts docShape) ----------

def doc_shape(q, w, h):
    """A document's shape in the photo's pixels (geometry.ts docShape): every side at least 15 % of the longest and
    every corner between 35° and 145°."""
    P = [(float(x) * w, float(y) * h) for x, y in q]
    sides = [math.hypot(P[(i + 1) % 4][0] - P[i][0], P[(i + 1) % 4][1] - P[i][1]) for i in range(4)]
    if min(sides) < 0.15 * max(sides):
        return False
    for i in range(4):
        a, b, c = P[(i + 3) % 4], P[i], P[(i + 1) % 4]
        u, v = (a[0] - b[0], a[1] - b[1]), (c[0] - b[0], c[1] - b[1])
        n = math.hypot(*u) * math.hypot(*v)
        if not n:
            return False
        deg = math.degrees(math.acos(max(-1.0, min(1.0, (u[0] * v[0] + u[1] * v[1]) / n))))
        if not 35 <= deg <= 145:
            return False
    return True


# ---------- more documents on one photo: findNext's and findInside's rules (index.html) ----------

INSIDE_MIN, INSIDE_MAX = 0.03, 0.6   # findInside: a document lying on another covers 3–60 % of its flat cut
LAB_MAX_DOCS = 5                     # geometry.ts MAX_DOCS: the documents of one shot, those lying on others included


def _quad_area(q):
    return abs(sum(q[i][0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * q[i][1] for i in range(4))) / 2


def _quad_convex(q):
    sg = 0
    for i in range(4):
        a, b, c = q[i], q[(i + 1) % 4], q[(i + 2) % 4]
        z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
        if z:
            s = 1 if z > 0 else -1
            if sg and s != sg:
                return False
            sg = s
    return True


def lab_good_quad(pts, conf):
    """geometry.ts goodQuad: four corners, sure (conf ≥ 0.5), convex and over 3 % of the picture — no aspect rule (the
    lab's shape rule is doc_shape, in the photo's pixels)."""
    if pts is None or len(pts) != 4 or any(p is None for p in pts) or conf < 0.5:
        return False
    q = [(float(p[0]), float(p[1])) for p in pts]
    return _quad_convex(q) and _quad_area(q) > 0.03


def in_quad(q, x, y):
    """geometry.ts inQuad: the crossing test of the points (x, y) — numbers or numpy arrays — against the quad q."""
    x, y = np.asarray(x, np.float64), np.asarray(y, np.float64)
    inside = np.zeros(np.broadcast(x, y).shape, bool)
    j = 3
    with np.errstate(divide="ignore", invalid="ignore"):
        for i in range(4):
            xi, yi = float(q[i][0]), float(q[i][1])
            xj, yj = float(q[j][0]), float(q[j][1])
            inside ^= ((yi > y) != (yj > y)) & (x < (xj - xi) * (y - yi) / (yj - yi) + xi)
            j = i
    return inside


_GRID = (np.arange(64) + 0.5) / 64


def lab_quad_iou(a, b):
    """geometry.ts quadIoU: the overlap of two quads (0..1) counted at the centres of a 64 × 64 grid."""
    gx, gy = np.meshgrid(_GRID, _GRID)
    p, q = in_quad(a, gx, gy), in_quad(b, gx, gy)
    both, any_ = int((p & q).sum()), int((p | q).sum())
    return both / any_ if any_ else 0.0


def lab_border_colour(img, kernel="bilinear"):
    """findNext's paint colour: the photo drawn onto a 32 × 32 canvas (drawImage at the default smoothing: the capture
    op's kernel), its border's 128 pixels (each i: (i, 0), (i, 31), (0, i), (31, i) — the corners twice) and of each
    channel the upper middle value (a.sort()[n >> 1]). In the image's own channel order."""
    return lab_ring_colour(resample(np.ascontiguousarray(img[..., :3]), (32, 32), kernel))


def lab_ring_colour(t):
    """The colour of a 32 × 32 picture's border ring as findNext takes it (lab_border_colour after the resample)."""
    ring = [t[y, x] for i in range(32) for x, y in ((i, 0), (i, 31), (0, i), (31, i))]
    ring = np.sort(np.array(ring, np.int64), axis=0)
    return [int(v) for v in ring[len(ring) >> 1]]


def lab_paint_polys(quads01, w, h):
    """findNext's paths on a w × h canvas: each found quad (0..1) grown 4 % from its centre (its corners' mean), in
    canvas pixels (x + (x - cx) * 0.04) * w, as the lab's lineTo gets them."""
    out = []
    for q in quads01:
        q = np.asarray(q, np.float64)
        c = q.sum(0) / 4
        out.append((q + (q - c) * 0.04) * [w, h])
    return out


def lab_paint(img, quads01, kernel=None, colour=None):
    """The picture with the found quads (0..1) painted over as the lab's findNext paints them: in the colour of its
    border (lab_border_colour; kernel: the drawImage kernel, default the capture op's), each quad grown 4 % from its
    centre, filled antialiased like a canvas fill (a canvas fills pixel areas; OpenCV's pixel centres are whole: -0.5).
    The one copy: docfind.find_next_lab, the scenes' next pictures (gen/scene.py paint) and pull.painted."""
    import cv2
    out = np.ascontiguousarray(img[..., :3]).copy()
    if not quads01:
        return out
    h, w = out.shape[:2]
    col = colour if colour is not None else lab_border_colour(out, kernel or kernel_for("capture"))
    for poly in lab_paint_polys(quads01, w, h):
        cv2.fillPoly(out, [np.round((poly - 0.5) * 16).astype(np.int32)], col, lineType=cv2.LINE_AA, shift=4)
    return out


# ---------- the probe: fixed frames for measuring a browser's resamplers ----------

HE_BOXES = ([0.06, 0.18, 0.42, 0.07], [0.5, 0.42, 0.3, 0.06], [0.12, 0.7, 0.55, 0.09], [0.3, 0.52, 0.05, 0.02])   # he_line probes (shares; the last one is enlarged)
PROBE_SIZES = ((1920, 1080), (1280, 720), (1080, 1920), (1600, 1200), (720, 1280))
# The cut's probe (gen/phone_run.py cuts every page with warp_rgba): one quad (0..1, clockwise from the top-left) per
# frame for the first len(CUT_QUADS) frames — tilted, turned, one reaching the frame's edge — cut by the lab's own
# warpRGBA in a browser and by warp_rgba here (tests/e2e/phone-parity.test.js: PSNR >= 35 dB on each).
CUT_QUADS = (((0.18, 0.2), (0.82, 0.16), (0.86, 0.8), (0.14, 0.84)), ((0.3, 0.1), (0.9, 0.3), (0.7, 0.9), (0.1, 0.7)),
             ((0.05, 0.05), (0.95, 0.05), (0.95, 0.95), (0.05, 0.95)), ((0.4, 0.2), (0.62, 0.22), (0.6, 0.58), (0.38, 0.55)),
             ((0.85, 0.15), (0.88, 0.85), (0.12, 0.88), (0.15, 0.12)), ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)),
             ((0.22, 0.35), (0.78, 0.3), (0.74, 0.62), (0.26, 0.66)), ((0.5, 0.05), (0.95, 0.5), (0.5, 0.95), (0.05, 0.5)),
             ((0.1, 0.4), (0.45, 0.38), (0.47, 0.6), (0.12, 0.63)), ((0.6, 0.55), (0.97, 0.5), (0.99, 0.98), (0.58, 0.97)))


def probe_frames(n=20, seed=5):
    """n fixed made-up camera frames (RGB): a textured table, a pale card in perspective with lines of strokes, fine
    stripes and a gradient — what aliasing shows on. Drawn once by `python -m gen profile --frames DIR`; the probe reads
    the PNG files, not this function (numpy's streams may change between versions)."""
    import cv2
    rng = np.random.default_rng(seed)
    out = []
    for i in range(n):
        W, H = PROBE_SIZES[i % len(PROBE_SIZES)]
        base = rng.integers(40, 200, 3)
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        img = np.empty((H, W, 3), np.float32)
        for c in range(3):
            img[..., c] = base[c] + 30 * np.sin(xx / (40 + 9 * c) + i) * np.cos(yy / (55 + 7 * c))
        small = rng.normal(0, 18, (H // 8 + 1, W // 8 + 1, 3)).astype(np.float32)
        img += cv2.resize(small, (W, H), interpolation=cv2.INTER_LINEAR)
        img += rng.normal(0, 6, (H, W, 3)).astype(np.float32)
        cx, cy = W * rng.uniform(0.35, 0.65), H * rng.uniform(0.35, 0.65)
        dw, dh = W * rng.uniform(0.3, 0.42), H * rng.uniform(0.25, 0.38)
        quad = np.array([[cx - dw, cy - dh], [cx + dw, cy - dh], [cx + dw, cy + dh], [cx - dw, cy + dh]])
        quad += rng.normal(0, 0.03 * min(W, H), quad.shape)
        card = np.full((600, 950, 3), rng.integers(200, 245, 3), np.float32)
        for row in range(40, 560, 34):
            x = 40
            while x < 900:
                lw = int(rng.integers(6, 40))
                cv2.rectangle(card, (x, row), (min(910, x + lw), row + int(rng.integers(8, 20))), tuple(float(v) for v in rng.integers(10, 90, 3)), -1)
                x += lw + int(rng.integers(3, 12))
        for k in range(0, 950, 3 + i % 3):        # fine stripes: aliasing shows here first
            card[520:580, k] = 30
        M = cv2.getPerspectiveTransform(np.float32([[0, 0], [950, 0], [950, 600], [0, 600]]), quad.astype(np.float32))
        mask = cv2.warpPerspective(np.ones((600, 950), np.float32), M, (W, H))
        warped = cv2.warpPerspective(card, M, (W, H))
        img = img * (1 - mask[..., None]) + warped * mask[..., None]
        out.append(np.clip(img + 0.5, 0, 255).astype(np.uint8))
    return out


def write_probe_frames(folder, n=20, seed=5):
    """The probe's frames as PNG files (RGB) in folder, with frames.json: {frames: [names], heBoxes, cutQuads}."""
    import cv2
    folder = pathlib.Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    names = []
    for i, f in enumerate(probe_frames(n, seed)):
        name = f"{i:02d}.png"
        cv2.imwrite(str(folder / name), f[..., ::-1])
        names.append(name)
    (folder / "frames.json").write_text(json.dumps({"frames": names, "heBoxes": [list(b) for b in HE_BOXES],
                                                    "cutQuads": [[list(p) for p in q] for q in CUT_QUADS]}), encoding="utf-8")
    return names


# ---------- the probe's paths and the profile's fit ----------

# A probe output's path → the op whose kernel makes it: "live" (createImageBitmap), "capture" (smallRGBA), the
# document type square and the face finder's letterbox (drawImage at the default smoothing), the field and zone lines
# ('high'). A path may carry ":<n>" (he:0 — the n-th of HE_BOXES; mrz:0 — the zone's line n). "cut" (the frame's quad
# cut by warpRGBA, its quad in "box") is no resampling: it is measured once against warp_rgba (fit_profile's "cuts").
PSNR_CAP = 99.0   # dB written for equal pictures (JSON has no infinity)
PATH_OP = {"live": "live", "capture": "capture", "doctype": "capture", "face": "capture", "he": "high", "mrz": "high"}


def probe_picture(path, a):
    """A probe output as the browser sent it (live / capture: the 256 RGBA; doctype: the float32 tensor 0..1; face:
    0..255 BGR; he / mrz: grey 0..1) → float64 0..255 in one layout for the PSNR."""
    kind = path.split(":")[0]
    a = np.asarray(a)
    if kind in ("live", "capture"):
        return a.reshape(S, S, -1)[..., :3].astype(np.float64)
    if kind == "doctype":
        return a.reshape(3, S, S).astype(np.float64) * 255
    if kind == "face":
        return a.reshape(3, FN, FN).astype(np.float64)
    return a.reshape(1, MRZ_H, MRZ_W).astype(np.float64) * 255


def probe_reference(path, frame, kernel, box=None):
    """What phone.py makes of a probe frame (RGB) for a path with one kernel, in probe_picture's layout."""
    kind, _, n = path.partition(":")
    if kind in ("live", "capture"):
        return frame_to_S(frame, kind, kernel=kernel).astype(np.float64)
    if kind == "doctype":
        return doctype_input(frame, kernel=kernel).astype(np.float64) * 255
    if kind == "face":
        return face_input(frame, 0, kernel=kernel).astype(np.float64)
    if kind == "he":
        got = he_line(frame, box if box is not None else HE_BOXES[int(n or 0)], kernel=kernel)
        return None if got is None else got.astype(np.float64) * 255
    if kind == "mrz":
        return line_input(frame, box, kernel=kernel).astype(np.float64) * 255
    raise ValueError(f"unknown probe path {path!r}")


def fit_profile(probe, frames_dir=None, kernels=KERNELS):
    """The kernel of each op that comes nearest a browser's own outputs (probe: {browser, device, frames: [{name,
    paths: {path: {shape, dtype, b64|z, box?}}}]}, the frames read from frames_dir or probe["framesDir"]) →
    {name, measured, browser, device, ops: {op: {kernel, mean, min}}, paths: {path: {kernel: {mean, min}}},
    zoneBoxes: [frames where mrz_find's boxes differ from the browser's], cuts: {n, mean, min} — warp_rgba against the
    browser's warpRGBA on the "cut" paths, None when there are none} — PSNR in dB, the mean and the worst frame."""
    import cv2
    folder = pathlib.Path(frames_dir or probe.get("framesDir") or ".")
    per = {}                      # path kind → kernel → [psnr per output]
    boxes_off, cuts = [], []
    for fr in probe["frames"]:
        frame = cv2.imread(str(folder / fr["name"]), cv2.IMREAD_COLOR)
        if frame is None:
            raise SystemExit(f"probe frame {fr['name']} is not in {folder}")
        frame = frame[..., ::-1]
        zone = [p for p in fr["paths"] if p.startswith("mrz")]
        if zone:
            want = mrz_find(frame)
            got = [fr["paths"][p].get("box") for p in sorted(zone)]
            if [[b["x"], b["y"], b["w"], b["h"]] for b in want] != [[b["x"], b["y"], b["w"], b["h"]] for b in got if b]:
                boxes_off.append(fr["name"])
        for path, out in fr["paths"].items():
            kind = path.split(":")[0]
            if kind == "cut":   # the cut: warp_rgba against the lab's warpRGBA, no kernel to pick
                cuts.append(cut_psnr(frame, out["box"], unpack(out)))
                continue
            seen = probe_picture(path, unpack(out))
            for k in kernels:
                ref = probe_reference(path, frame, k, out.get("box"))
                if ref is None:
                    continue
                per.setdefault(kind, {}).setdefault(k, []).append(min(PSNR_CAP, psnr(np.clip(np.floor(ref + 0.5), 0, 255), seen)))
    paths = {kind: {k: {"mean": round(float(np.mean(v)), 2), "min": round(float(np.min(v)), 2), "n": len(v)}
                    for k, v in ks.items()} for kind, ks in per.items()}
    ops = {}
    for op in OPS:
        kinds = [kind for kind in paths if PATH_OP[kind] == op]
        if not kinds:
            continue
        score = {k: min(paths[kind][k]["min"] for kind in kinds if k in paths[kind]) for k in kernels}
        best = max(kernels, key=lambda k: (score[k], -KERNELS.index(k)))
        ops[op] = {"kernel": best, "min": score[best],
                   "mean": round(float(np.mean([paths[kind][best]["mean"] for kind in kinds])), 2)}
    return {"name": "-".join(str(probe.get(k) or "") for k in ("browser", "device")).strip("-") or "probe", "measured": True,
            "browser": probe.get("browser"), "device": probe.get("device"), "ops": ops, "paths": paths, "zoneBoxes": boxes_off,
            "cuts": {"n": len(cuts), "mean": round(float(np.mean(cuts)), 2), "min": round(float(np.min(cuts)), 2)} if cuts else None}


def cut_psnr(frame, quad, got):
    """The PSNR (dB, capped at PSNR_CAP) of warp_rgba's cut of a frame (RGB) by quad against a browser's warpRGBA cut
    (H × W × 4); 0 when the sizes differ."""
    want = warp_rgba(frame, [list(map(float, p)) for p in quad])
    got = np.asarray(got).reshape(want.shape) if np.asarray(got).size == want.size else None
    if got is None:
        return 0.0
    return min(PSNR_CAP, psnr(want[..., :3], got[..., :3]))


def browser_kernel(browser, op, profile=None):
    """The kernel the profile records as measured for a browser's op ("chromium": tests/e2e/phone-parity.test.js),
    None when that browser was not measured."""
    prof = profile if isinstance(profile, dict) else load_profile(profile)
    return ((prof.get("browsers") or {}).get(browser) or {}).get(op)
