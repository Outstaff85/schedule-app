"""The capture settings: how the phone's camera treats a scene's frame (docs/scan-training.md → "The automatic cycle" →
"The generator tunes itself"). Two files the generator writes for itself decide them, both in <home>/gen/:

  tune.json       python -m gen tune: the camera's parameters moved a bounded step toward the real attempts (gen/tune.py)
  ablation.json   python -m gen ablate: which effects stay on — only those that help the real exam (gen/ablate.py)

`python -m gen build --model edges` (and the phone's own cuts, which draw the same scenes) reads them for a TRAINING run
only, when either file is there: the settings go into the run's params ("capture", with "tune": what they came from), so
`gen verify` draws the same bytes again from run.json alone, whatever the files say by then. An exam or select run never
reads them (the exam is drawn the same every time). With neither file every draw is exactly as before — gen/scene.py
takes the old path (synth_docs.camera) when a scene has no capture settings.

The settings (DEFAULTS are today's constants, LIMITS the hard bounds no tune moves past):
- blurP — the share of frames blurred (synth_docs.camera's blur OneOf, 0.5);
- noiseP, noiseMax — the share of frames with sensor noise and its strongest Gaussian std (0.5, 0.08; ISO noise scaled alike);
- brightnessShift — the brightness range's centre (RandomBrightnessContrast's ±0.25 moved by it, 0);
- nearPower — how much more often the camera stands near its nearest pose (gen/camera.py: the distance's draw
  rng.random() ** nearPower, 2: larger fills the frame more);
- tiltMax — the camera's largest tilt from straight down (45°);
- effects — {"mip", "shadow", "glare", "jpeg"}: each on unless an ablation found the real exam better without it. An
  effect switched off still draws its random numbers, so the rest of the scene stays the same picture."""
import hashlib
import json
import pathlib

DEFAULTS = {"blurP": 0.5, "noiseP": 0.5, "noiseMax": 0.08, "brightnessShift": 0.0, "nearPower": 2.0, "tiltMax": 45.0}
LIMITS = {"blurP": (0.2, 0.9), "noiseP": (0.2, 0.9), "noiseMax": (0.04, 0.16), "brightnessShift": (-0.15, 0.15),
          "nearPower": (1.0, 4.0), "tiltMax": (30.0, 60.0)}
EFFECTS = ("mip", "shadow", "glare", "jpeg")
TUNE, ABLATION = "tune.json", "ablation.json"


def gen_dir(work=None):
    import home
    return pathlib.Path(work or home.WORK) / "gen"


def read(path):
    try:
        got = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return got if isinstance(got, dict) else None


def write(path, data):
    """Written aside, then put in place: a stop while writing leaves the last file whole."""
    p = pathlib.Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
    tmp.replace(p)


def bounded(name, value):
    lo, hi = LIMITS[name]
    return round(min(hi, max(lo, float(value))), 4)


def normal(cap):
    """A capture dict made whole: every parameter (bounded), every effect (a bool)."""
    cap = dict(cap or {})
    out = {k: bounded(k, cap.get(k, v)) for k, v in DEFAULTS.items()}
    fx = cap.get("effects") or {}
    out["effects"] = {e: bool(fx.get(e, True)) for e in EFFECTS}
    return out


def settings_id(cap):
    """A short id of the settings themselves (not of the files' history): a panel drawn with them is theirs."""
    return hashlib.sha256(json.dumps(normal(cap), sort_keys=True).encode("utf-8")).hexdigest()[:16]


def settings(work=None):
    """The capture settings the next training run draws with → {"capture": dict, "record": what they came from}, or None
    when neither tune.json nor ablation.json is there (the draw is then exactly as before)."""
    d = gen_dir(work)
    tune, abl = read(d / TUNE), read(d / ABLATION)
    if not tune and not abl:
        return None
    cap = dict((tune or {}).get("capture") or {})
    fx = {e: v["on"] for e, v in ((abl or {}).get("effects") or {}).items() if isinstance(v, dict) and "on" in v}
    cap["effects"] = fx
    cap = normal(cap)
    rec = {"id": settings_id(cap), "tuneAt": (tune or {}).get("at"), "ablationAt": ((abl or {}).get("lastRun") or {}).get("at")}
    return {"capture": cap, "record": rec}


def effects_of(cap):
    return normal(cap)["effects"] if cap else {e: True for e in EFFECTS}


def pipeline(seed, cap):
    """synth_docs.camera with the capture settings: the same transforms in the same order (today's values give the same
    pictures), the blur's and noise's shares, the noise's strength and the brightness's centre from cap, JPEG off when
    the ablation said so (p 0: the earlier transforms draw as before)."""
    import albumentations as A
    c = normal(cap)
    s, k = c["brightnessShift"], c["noiseMax"] / DEFAULTS["noiseMax"]
    return A.Compose([
        A.RandomBrightnessContrast(brightness_limit=(-0.25 + s, 0.25 + s), contrast_limit=0.25, p=0.8),
        A.RandomGamma(gamma_limit=(70, 140), p=0.4),
        A.HueSaturationValue(hue_shift_limit=8, sat_shift_limit=20, val_shift_limit=10, p=0.4),
        A.RandomShadow(shadow_roi=(0, 0, 1, 1), num_shadows_limit=(1, 2), shadow_dimension=5, shadow_intensity_range=(0.15, 0.4), p=0.15),
        A.OneOf([A.GaussianBlur(blur_limit=(3, 7)), A.MotionBlur(blur_limit=(3, 9)), A.Defocus(radius=(1, 3))], p=c["blurP"]),
        A.OneOf([A.GaussNoise(std_range=(0.02, c["noiseMax"])), A.ISONoise(color_shift=(0.01, 0.05), intensity=(0.1, round(0.5 * k, 4)))],
                p=c["noiseP"]),
        A.Downscale(scale_range=(0.4, 0.9), p=0.2),
        A.ImageCompression(quality_range=(45, 95), p=0.7 if c["effects"]["jpeg"] else 0.0),
    ], seed=seed)


def camera_kw(cap):
    """gen/camera.py sample()'s arguments the settings change ({} without settings: today's)."""
    if not cap:
        return {}
    c = normal(cap)
    from .camera import TILT
    return {"tilt": (TILT[0], c["tiltMax"]), "near_power": c["nearPower"]}


def for_run(a, split, work=None):
    """gen build's capture settings for a run → (capture or None, record or None): --capture FILE when given (an
    ablation's trial; refused for the exam), else the work folder's files for a training run unless --no-tune."""
    given = getattr(a, "capture", None)
    if given:
        if split == "exam":
            raise SystemExit("--capture is for a training run: the exam is drawn the same every time")
        got = read(given)
        if got is None:
            raise SystemExit(f"--capture {given}: not a readable JSON object")
        cap = normal(got.get("capture", got))
        return cap, {"id": settings_id(cap), "file": pathlib.Path(given).name}
    if split != "train" or getattr(a, "no_tune", False):
        return None, None
    got = settings(work)
    return (got["capture"], got["record"]) if got else (None, None)
