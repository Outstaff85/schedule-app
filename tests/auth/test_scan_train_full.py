"""SCAN_TRAIN_FULL=1 (tests/auth/conftest.py; docs/tests.md → Functions): the scanner's training packages are imported
outright where a test asks pytest.importorskip for them, so in CI a missing one fails instead of skipping."""
import pytest

import conftest


def test_a_training_package_missing_fails_instead_of_skipping(monkeypatch):
    monkeypatch.setattr(conftest, "FULL", conftest.FULL + ("no_such_training_package",))
    with pytest.raises(ImportError):
        conftest.strict_importorskip("no_such_training_package")
    with pytest.raises(pytest.skip.Exception):   # any other module still skips as before
        conftest.strict_importorskip("no_such_other_package")
    assert conftest.strict_importorskip("json").__name__ == "json"


def test_ci_turns_it_on_where_the_training_packages_are_installed():
    import pathlib
    wf = (pathlib.Path(__file__).resolve().parents[2] / ".github" / "workflows" / "tests.yml").read_text(encoding="utf-8")
    assert "SCAN_TRAIN_FULL: '1'" in wf
    for pkg in ("onnxruntime", "albumentations==2.0.8", "albucore==0.0.24", "timm", "onnx2torch", "download.pytorch.org/whl/cpu"):
        assert pkg in wf, pkg
