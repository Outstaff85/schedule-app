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


_FUNCTIONS_MAIN = "functions_main"


@pytest.fixture(scope="session")
def functions_main():
    """functions/main.py, executed once for the whole run and shared by every test that needs it (test_form101_build.py,
    test_scan_feedback.py). It declares its secrets (`SecretParam("HF_DATA_TOKEN")`) at import, and firebase_functions keeps
    one process-wide registry of declared params, so a second copy loaded under another name fails with "Duplicate
    Parameter Error". Kept under a name of its own: functions-auth's tests import theirs as "main". A failed load is not
    left half-built in sys.modules."""
    import importlib.util
    import pathlib
    import sys
    if _FUNCTIONS_MAIN in sys.modules:
        return sys.modules[_FUNCTIONS_MAIN]
    fn = pathlib.Path(__file__).resolve().parents[2] / "functions"
    if str(fn) not in sys.path:
        sys.path.append(str(fn))  # after functions-auth: its main stays `main`; main.py's own modules (contracts, signing, datastore, feedback, gate)
    spec = importlib.util.spec_from_file_location(_FUNCTIONS_MAIN, fn / "main.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[_FUNCTIONS_MAIN] = mod
    try:
        spec.loader.exec_module(mod)
    except BaseException:
        sys.modules.pop(_FUNCTIONS_MAIN, None)
        raise
    return mod
