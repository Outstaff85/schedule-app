"""The functions tests' shared setup (docs/tests.md → Functions).

SCAN_TRAIN_FULL=1 (set by the CI's Functions tests step, where the scanner's training packages are installed): a test's
pytest.importorskip of one of the training packages (FULL) imports it for real, so a missing package fails the test
instead of skipping it — the numeric scanner-training checks (the weighted losses, the turn loss, gen build --focus,
the ONNX parity...) then always run in CI. Without it (a PC with only the functions' packages) they skip as before."""
import importlib
import os

import pytest

FULL = ("torch", "timm", "onnxruntime", "albumentations", "onnx2torch", "onnx", "cv2", "numpy", "PIL")
_importorskip = pytest.importorskip


def strict_importorskip(modname, minversion=None, reason=None, **kw):
    """pytest.importorskip, but a FULL package is imported outright (ImportError: the test fails, never skips)."""
    if modname.split(".")[0] not in FULL:
        return _importorskip(modname, minversion=minversion, reason=reason, **kw)
    mod = importlib.import_module(modname)
    if minversion is not None:
        from packaging.version import Version
        have = getattr(mod, "__version__", None)
        if have is None or Version(have) < Version(minversion):
            raise ImportError(f"{modname} {have} is older than the {minversion} the test needs (SCAN_TRAIN_FULL=1)")
    return mod


if os.environ.get("SCAN_TRAIN_FULL") == "1":
    pytest.importorskip = strict_importorskip
