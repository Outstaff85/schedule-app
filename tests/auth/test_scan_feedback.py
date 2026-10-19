"""The scanner's training examples (functions/feedback.py, docs/scan-plan.md → S6):
what is kept, what is only counted, what is refused; the gate's claims; the
server and the site use the same model version."""
import base64
import datetime
import importlib.util
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "functions" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


feedback = load("feedback")
gate = load("gate")

JPG = base64.b64encode(b"\xff\xd8" + b"\0" * 100 + b"\xff\xd9").decode()
MODEL = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]


def ex(**kw):
    return dict({"image": JPG, "cornersModel": MODEL, "cornersFixed": MODEL, "source": "model", "model": "base-v1"}, **kw)


def test_a_moved_page_is_kept_with_how_far_it_moved():
    fixed = [[0.12, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.95]]
    e, why = feedback.check(ex(cornersFixed=fixed))
    assert why is None and abs(e["moved"] - 0.05) < 1e-6 and e["moved"] >= feedback.MOVED_MIN


def test_a_page_the_model_got_right_is_only_counted_and_needs_no_copy():
    e, why = feedback.check(ex(image=None))
    assert why is None and e["moved"] == 0 < feedback.MOVED_MIN and e["image"] is None


def test_bad_examples_are_refused():
    assert feedback.check(ex(cornersFixed=[[0, 0]]))[1] == "bad corners"
    assert feedback.check(ex(cornersModel=[[0, 0], [2, 0], [1, 1], [0, 1]]))[1] == "bad corners"
    moved = [[0.2, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]
    assert feedback.check(ex(cornersFixed=moved, image="not base64!"))[1] == "bad image"
    assert feedback.check(ex(cornersFixed=moved, image=None))[1] == "the image is not a small JPEG"
    assert feedback.check(ex(cornersFixed=moved, image=base64.b64encode(b"PNG....").decode()))[1] == "the image is not a small JPEG"
    big = base64.b64encode(b"\xff\xd8" + b"\0" * feedback.MAX_IMAGE_BYTES).decode()
    assert feedback.check(ex(cornersFixed=moved, image=big))[1] == "the image is not a small JPEG"
    assert feedback.check("x")[1] == "not an object"


def test_the_record_is_deleted_after_a_year_and_names_its_firm():
    e, _ = feedback.check(ex(source="odd"))
    now = datetime.datetime(2026, 10, 18, tzinfo=datetime.timezone.utc)
    r = feedback.record(e, "t1", now, feedback.image_path(now, "abc"))
    assert r["image"] == "training/scan/2026-10/abc.jpg" and r["tenantId"] == "t1" and r["source"] == "model"
    assert r["deleteAt"] - r["createdAt"] == datetime.timedelta(days=365) and "imageBase64" not in r


def test_gate_gives_the_claims_of_a_manager_only():
    ok = lambda t: {"role": "staff", "tenantId": "t1"}
    assert gate.claims_of({"Authorization": "Bearer x"}, ok) == (None, None, {"role": "staff", "tenantId": "t1"})
    assert gate.claims_of({"Authorization": "Bearer x"}, lambda t: {"role": "client"})[0] == 403
    assert gate.claims_of({}, ok)[0] == 401


def test_server_and_site_use_the_same_model_version():
    server = (ROOT / "functions" / "scan_models_version.txt").read_text().strip()
    site = (ROOT / "scripts" / "scan" / "models-version").read_text().strip()
    assert server == site


def test_a_changed_kind_is_kept_with_a_copy_of_the_page():
    e, why = feedback.check(ex(image=None, kindModel="sefach", kindFixed="contract", pageImage=JPG))
    assert why is None and feedback.kept(e) and e["kindModel"] == "sefach" and e["kindFixed"] == "contract" and e["pageImage"]
    now = datetime.datetime(2026, 10, 18, tzinfo=datetime.timezone.utc)
    r = feedback.record(e, "t1", now, None, feedback.image_path(now, "abc", "-page"))
    assert r["image"] is None and r["pageImage"] == "training/scan/2026-10/abc-page.jpg" and r["kindFixed"] == "contract"


def test_a_kind_left_as_it_was_is_only_counted_and_bad_kinds_are_dropped():
    e, _ = feedback.check(ex(image=None, kindModel="passport", kindFixed="passport"))
    assert not feedback.kept(e) and e["pageImage"] is None
    e, _ = feedback.check(ex(image=None, kindModel="nonsense", kindFixed="x"))
    assert e["kindModel"] is None and e["kindFixed"] is None and not feedback.kept(e)
    assert feedback.check(ex(image=None, kindModel="sefach", kindFixed="other"))[1] == "a changed kind needs a small JPEG of the page"


def test_one_in_five_right_pages_is_kept_with_its_copy_but_is_no_correction():
    e, why = feedback.check(ex(keep=True))
    assert why is None and e["right"] and feedback.kept(e) and not feedback.correction(e) and e["image"]
    assert feedback.check(ex(keep=True, image=None))[1] == "the image is not a small JPEG"
    e, _ = feedback.check(ex(image=None))
    assert not e["right"] and not feedback.kept(e)
    now = datetime.datetime(2026, 10, 18, tzinfo=datetime.timezone.utc)
    assert feedback.record(e, "t", now, None)["right"] is False


def test_a_sampled_right_page_also_keeps_its_page_copy_for_the_kind_model():
    e, why = feedback.check(ex(keep=True, kindModel="passport", kindFixed="passport", pageImage=JPG))
    assert why is None and e["right"] and e["pageImage"] and not feedback.correction(e)
    e, why = feedback.check(ex(keep=True, kindModel="passport", pageImage="bad"))
    assert why is None and e["right"] and e["pageImage"] is None  # the page copy is optional here
    e, _ = feedback.check(ex(image=None, kindModel="passport", kindFixed="passport", pageImage=JPG))
    assert e["pageImage"] is None and not feedback.kept(e)  # only a sampled page keeps it


def test_the_kind_model_is_due_when_every_kind_has_enough_copies():
    assert feedback.kind_counts({})["sefach"] == 0 and not feedback.kinds_due({})
    full = {k: feedback.KIND_AT for k in feedback.KINDS_TRAINED}
    assert feedback.kinds_due({"kindsSince": full})
    assert not feedback.kinds_due({"kindsSince": dict(full, id_back=feedback.KIND_AT - 1)})
    assert "other" not in feedback.KINDS_TRAINED


def test_who_gave_the_kind_is_kept():
    e, _ = feedback.check(ex(image=None, kindModel="sefach", kindFixed="contract", pageImage=JPG, kindBy="model"))
    now = datetime.datetime(2026, 10, 19, tzinfo=datetime.timezone.utc)
    assert feedback.record(e, "t", now, None, "p")["kindBy"] == "model"
    e, _ = feedback.check(ex(image=None, kindModel="sefach", kindFixed="contract", pageImage=JPG, kindBy="odd"))
    assert e["kindBy"] == "haiku"
