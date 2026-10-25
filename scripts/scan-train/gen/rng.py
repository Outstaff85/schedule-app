"""The random streams of the generator (docs/scan-training.md → "Made-up sets: build, verify, QA").

- legacy(seed, index): the one stream each example of today's generators draws from — random.Random(seed *
  1_000_003 + index), exactly as synth_docs.py, synth_pages.py and synth_fields.py always did, so the same seed
  still draws the same pictures byte for byte. An example depends only on (seed, index): never on the batch it
  was drawn in, the number of processes or the examples before it.
- stream(run_seed, index, stage) / streams(run_seed, index): separate streams per stage (scene, page, camera,
  phone) from numpy's SeedSequence([run_seed, index, stage]), for the recipes that come next (a change in how the
  camera draws then moves nothing of the scene). The manifest names the scheme of each example ("rng").
Pure: numpy only (no torch)."""
import random

LEGACY_STEP = 1_000_003
STAGES = ("scene", "page", "camera", "phone")
LEGACY = "legacy"           # the manifest's "rng" of an example drawn from legacy()
STAGED = "seedsequence"     # … of one drawn from streams()


def legacy_seed(seed, index):
    return int(seed) * LEGACY_STEP + int(index)


def legacy(seed, index):
    """The example's one stream as today: random.Random(seed * 1_000_003 + index)."""
    return random.Random(legacy_seed(seed, index))


def _entropy(run_seed, index, stage):
    if stage not in STAGES:
        raise ValueError(f"unknown stage {stage!r} (one of {', '.join(STAGES)})")
    return [int(run_seed) & 0xFFFFFFFF, int(index) & 0xFFFFFFFF, STAGES.index(stage)]


def seed_sequence(run_seed, index, stage):
    import numpy as np
    return np.random.SeedSequence(_entropy(run_seed, index, stage))


def stream(run_seed, index, stage):
    """A numpy Generator of its own for one stage of one example."""
    import numpy as np
    return np.random.default_rng(seed_sequence(run_seed, index, stage))


def py_stream(run_seed, index, stage):
    """The same stage's stream as a random.Random (the drawing code uses random's choice / uniform / randint)."""
    state = seed_sequence(run_seed, index, stage).generate_state(4, dtype="uint32")
    return random.Random(int.from_bytes(b"".join(int(x).to_bytes(4, "little") for x in state), "little"))


def streams(run_seed, index):
    """{stage: random.Random} — one stream per stage of one example."""
    return {s: py_stream(run_seed, index, s) for s in STAGES}
