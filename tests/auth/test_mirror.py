"""The server's model mirror (scripts/scan/mirror.py, docs/hf-plan.md → H4): a Storage version
folder goes only when Hugging Face holds every one of its files, under today's names."""
import importlib.util
import pathlib

_spec = importlib.util.spec_from_file_location("mirror", pathlib.Path(__file__).resolve().parents[2] / "scripts" / "scan" / "mirror.py")
mirror = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mirror)


def test_old_names_map_to_hugging_face_names():
    assert [mirror.hf_name(n) for n in ("sa24.onnx", "lite.onnx", "yunet640.onnx", "report.json", "doctype.onnx")] == [
        "edges.onnx", "edges-lite.onnx", "face.onnx", "report.json", "doctype.onnx"]


def test_a_version_goes_only_when_all_of_it_is_on_hugging_face():
    hf = {"edges.onnx": 1, "edges-lite.onnx": 1, "face.onnx": 1, "report.json": 1}
    assert mirror.deletable(["sa24.onnx", "lite.onnx", "yunet640.onnx", "report.json"], hf)
    assert not mirror.deletable(["sa24.onnx", "lite.onnx", "yunet640.onnx", "doctype.onnx"], hf)  # its document type model is not there
    assert not mirror.deletable(["sa24.onnx"], None)  # the version is not on Hugging Face at all
    assert not mirror.deletable([], hf)
