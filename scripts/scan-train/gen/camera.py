"""A phone's camera over the table (docs/scan-training.md → "Scenes: one camera for the table and the documents"): a
pinhole camera looking at the plane the background and the documents lie on, so ONE homography takes the table and
every document on it to the frame — the background is no flat crop under a tilted document any more (the edges model
could tell them apart by that).

- The plane: z = 0, in millimetres (x right, y down as a page is drawn); the camera is on the side z < 0.
- Camera(W, H, fov, target, distance, tilt, azimuth, roll): the frame W × H pixels (pixel edges: (0, 0) is the frame's
  top-left corner), the field of view along its long side, looking at `target` (a point of the plane) from `distance` mm,
  tilted `tilt` degrees from straight down, from the side `azimuth`, turned `roll` about its axis.
- .H: the plane (mm) → the frame (pixels) homography; .project(points with z): a point lifted off the plane (a bent
  page) goes through the same camera; .back(pixels): the frame → the plane; .ppm_at(point): the frame's pixels per mm
  there; .footprint(): the frame's corners on the plane.
- sample(rng, points): a phone's shot of points on the plane — the frame of one of PROFILES (1920×1080, 1280×720, a
  ~4000×3000 photo; upright or wide), drawn at most RENDER_MAX on its long side, fov 65–80°, 12–55 cm, tilt 0–45°, the
  points all inside the frame (or, partial, some of them outside).
Pure: numpy only."""
import math
from dataclasses import dataclass, field

import numpy as np

PROFILES = ((1920, 1080), (1280, 720), (4000, 3000))    # the native frames: the live video's two and a photo
RENDER_MAX = 1600       # the frame is drawn at most this long (newAttempt keeps a photo at 1600: gen/phone.py store_attempt)
FOV = (65.0, 80.0)      # degrees, along the long side
DISTANCE = (120.0, 550.0)   # mm, the camera to the point it looks at
TILT = (0.0, 45.0)      # degrees from straight down
MARGIN = 0.015          # the documents' corners at least this far inside the frame (a share of its sides)


@dataclass
class Camera:
    W: int
    H: int
    native: tuple
    fov: float
    target: tuple
    distance: float
    tilt: float
    azimuth: float
    roll: float
    K: np.ndarray = field(default=None, repr=False)
    R: np.ndarray = field(default=None, repr=False)
    t: np.ndarray = field(default=None, repr=False)

    def __post_init__(self):
        f = (max(self.W, self.H) / 2) / math.tan(math.radians(self.fov) / 2)
        self.K = np.array([[f, 0, self.W / 2], [0, f, self.H / 2], [0, 0, 1]], np.float64)
        th, ph = math.radians(self.tilt), math.radians(self.azimuth)
        T = np.array([self.target[0], self.target[1], 0.0])
        C = T + self.distance * np.array([math.sin(th) * math.cos(ph), math.sin(th) * math.sin(ph), -math.cos(th)])
        z = (T - C) / np.linalg.norm(T - C)
        down = np.array([0.0, 1.0, 0.0])
        y = down - z * float(down @ z)
        if np.linalg.norm(y) < 1e-6:
            y = np.array([1.0, 0.0, 0.0]) - z * float(z[0])
        y /= np.linalg.norm(y)
        x = np.cross(y, z)
        r = math.radians(self.roll)
        x, y = x * math.cos(r) + y * math.sin(r), -x * math.sin(r) + y * math.cos(r)
        self.R = np.stack([x, y, z])
        self.t = -self.R @ C
        self.C = C

    @property
    def Hm(self):
        """The plane (x, y mm, z = 0) → the frame (pixel edges) homography, 3 × 3."""
        return self.K @ np.column_stack([self.R[:, 0], self.R[:, 1], self.t])

    def project(self, pts):
        """Points (N × 2 on the plane, or N × 3 with z: < 0 toward the camera) → the frame (N × 2 pixel edges)."""
        P = np.asarray(pts, np.float64)
        if P.ndim == 1:
            P = P[None]
        if P.shape[1] == 2:
            P = np.column_stack([P, np.zeros(len(P))])
        c = P @ self.R.T + self.t
        uv = c @ self.K.T
        return uv[:, :2] / uv[:, 2:3]

    def depth(self, pts):
        P = np.asarray(pts, np.float64)
        if P.shape[1] == 2:
            P = np.column_stack([P, np.zeros(len(P))])
        return (P @ self.R.T + self.t)[:, 2]

    def back(self, uv):
        """Frame points (pixel edges) → where their rays meet the plane (mm)."""
        Hi = np.linalg.inv(self.Hm)
        P = np.column_stack([np.asarray(uv, np.float64), np.ones(len(uv))]) @ Hi.T
        return P[:, :2] / P[:, 2:3]

    def ppm_at(self, pt=None):
        """Pixels per mm the frame shows the plane at pt (default the point it looks at): the larger of the two
        axes' scales there."""
        p = np.asarray(self.target if pt is None else pt, np.float64)
        uv = self.project(np.array([p, p + [1.0, 0.0], p + [0.0, 1.0]]))
        return float(max(np.linalg.norm(uv[1] - uv[0]), np.linalg.norm(uv[2] - uv[0])))

    def footprint(self):
        """The frame's corners back on the plane (mm), None when a corner's ray misses it (the horizon in sight)."""
        Q = self.back([[0, 0], [self.W, 0], [self.W, self.H], [0, self.H]])
        return None if (self.depth(Q) <= 1).any() else Q

    def info(self):
        return {"size": [self.W, self.H], "native": list(self.native), "fov": round(self.fov, 3), "distance": round(self.distance, 2),
                "tilt": round(self.tilt, 3), "azimuth": round(self.azimuth, 3), "roll": round(self.roll, 3),
                "target": [round(float(v), 2) for v in self.target]}


def frame_size(rng):
    """(render W, H, native (w, h)): one of PROFILES, upright half the time, drawn at most RENDER_MAX long."""
    w, h = rng.choice(PROFILES)
    if rng.random() < 0.5:
        w, h = h, w
    k = min(1.0, RENDER_MAX / max(w, h))
    return int(round(w * k)), int(round(h * k)), (w, h)


def inside(cam, pts, margin=MARGIN):
    uv = cam.project(pts)
    if (cam.depth(pts) <= 1).any():
        return False
    mx, my = margin * cam.W, margin * cam.H
    return bool(((uv[:, 0] >= mx) & (uv[:, 0] <= cam.W - mx) & (uv[:, 1] >= my) & (uv[:, 1] <= cam.H - my)).all())


def _tilt(rng, tilt, weights):
    """The tilt in degrees: uniform over tilt, or (weights {"lo-hi": w}, gen mine's focus) a bucket by its weight, then
    uniform inside it."""
    if not weights:
        return rng.uniform(*tilt)
    names = sorted(weights, key=lambda k: float(k.split("-")[0]))
    lo, hi = map(float, rng.choices(names, [weights[k] for k in names])[0].split("-"))
    return rng.uniform(max(lo, tilt[0]), min(hi, tilt[1]))


def sample(rng, pts, partial=False, fov=FOV, distance=DISTANCE, tilt=TILT, tries=40, tilt_weights=None, near_power=2):
    """A camera shooting the plane points pts (N × 2 mm, the documents' corners): every point inside the frame — or,
    partial, at least one outside and at least one inside. None when no try fits (the documents too big for 55 cm).
    tilt_weights: the tilt buckets' weights (gen mine's focus; None: uniform); near_power: how much more often the
    camera stands near its nearest pose (the capture settings' nearPower, gen/capture.py; 2 today)."""
    pts = np.asarray(pts, np.float64)
    lo, hi = pts.min(0), pts.max(0)
    centre, extent = (lo + hi) / 2, float(np.linalg.norm(hi - lo))
    W, H, native = frame_size(rng)
    for _ in range(tries):
        f, tl, az, rl = rng.uniform(*fov), _tilt(rng, tilt, tilt_weights), rng.uniform(0, 360), rng.gauss(0, 6)
        target = centre + np.array([rng.uniform(-0.12, 0.12), rng.uniform(-0.12, 0.12)]) * extent

        def cam(d):
            return Camera(W, H, native, f, (float(target[0]), float(target[1])), d, tl, az, rl)
        if partial:
            corner = pts[rng.randrange(len(pts))]
            target = corner + (centre - corner) * rng.uniform(0.0, 0.35)
            d = rng.uniform(distance[0], min(distance[1], distance[0] + 0.9 * extent))
            c = cam(d)
            uv, ok = c.project(pts), c.depth(pts) > 1
            inn = ok & (uv[:, 0] >= 0) & (uv[:, 0] <= W) & (uv[:, 1] >= 0) & (uv[:, 1] <= H)
            if inn.any() and not inn.all() and ok.all():
                return c
            continue
        if not inside(cam(distance[1]), pts):
            continue   # not all in sight even from the farthest: another pose
        a, b = distance[0], distance[1]
        if inside(cam(a), pts):
            dmin = a
        else:
            for _ in range(30):   # the nearest distance with every point inside
                m = (a + b) / 2
                a, b = (a, m) if inside(cam(m), pts) else (m, b)
            dmin = b
        dmax = min(distance[1], max(dmin * 1.7, dmin + 30))
        d = dmin + (dmax - dmin) * rng.random() ** near_power   # nearer shots (the documents filling the frame) more often
        c = cam(d)
        if inside(c, pts):
            return c
    return None
