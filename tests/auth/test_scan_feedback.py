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
    return dict({"image": JPG, "edgesModel": MODEL, "edgesFixed": MODEL, "source": "model", "model": "base-v1"}, **kw)


def test_a_moved_page_is_kept_with_how_far_it_moved():
    fixed = [[0.12, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.95]]
    e, why = feedback.check(ex(edgesFixed=fixed))
    assert why is None and abs(e["moved"] - 0.05) < 1e-6 and e["moved"] >= feedback.MOVED_MIN


def test_a_page_the_model_got_right_is_only_counted_and_needs_no_copy():
    e, why = feedback.check(ex(image=None))
    assert why is None and e["moved"] == 0 < feedback.MOVED_MIN and e["image"] is None


def test_bad_examples_are_refused():
    assert feedback.check(ex(edgesFixed=[[0, 0]]))[1] == "bad corners"
    assert feedback.check(ex(edgesModel=[[0, 0], [2, 0], [1, 1], [0, 1]]))[1] == "bad corners"
    moved = [[0.2, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]
    assert feedback.check(ex(edgesFixed=moved, image="not base64!"))[1] == "bad image"
    assert feedback.check(ex(edgesFixed=moved, image=None))[1] == "the image is not a small JPEG"
    assert feedback.check(ex(edgesFixed=moved, image=base64.b64encode(b"PNG....").decode()))[1] == "the image is not a small JPEG"
    big = base64.b64encode(b"\xff\xd8" + b"\0" * feedback.MAX_IMAGE_BYTES).decode()
    assert feedback.check(ex(edgesFixed=moved, image=big))[1] == "the image is not a small JPEG"
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
    e, why = feedback.check(ex(image=None, doctypeModel="sefach", doctypeFixed="contract", pageImage=JPG))
    assert why is None and feedback.kept(e) and e["doctypeModel"] == "sefach" and e["doctypeFixed"] == "contract" and e["pageImage"]
    now = datetime.datetime(2026, 10, 18, tzinfo=datetime.timezone.utc)
    r = feedback.record(e, "t1", now, None, feedback.image_path(now, "abc", "-page"))
    assert r["image"] is None and r["pageImage"] == "training/scan/2026-10/abc-page.jpg" and r["doctypeFixed"] == "contract"


def test_a_kind_left_as_it_was_is_only_counted_and_bad_kinds_are_dropped():
    e, _ = feedback.check(ex(image=None, doctypeModel="passport", doctypeFixed="passport"))
    assert not feedback.kept(e) and e["pageImage"] is None
    e, _ = feedback.check(ex(image=None, doctypeModel="nonsense", doctypeFixed="x"))
    assert e["doctypeModel"] is None and e["doctypeFixed"] is None and not feedback.kept(e)
    assert feedback.check(ex(image=None, doctypeModel="sefach", doctypeFixed="other"))[1] == "a changed document type needs a small JPEG of the page"


def test_one_in_five_right_pages_is_kept_with_its_copy_but_is_no_correction():
    e, why = feedback.check(ex(keep=True))
    assert why is None and e["right"] and feedback.kept(e) and not feedback.correction(e) and e["image"]
    assert feedback.check(ex(keep=True, image=None))[1] == "the image is not a small JPEG"
    e, _ = feedback.check(ex(image=None))
    assert not e["right"] and not feedback.kept(e)
    now = datetime.datetime(2026, 10, 18, tzinfo=datetime.timezone.utc)
    assert feedback.record(e, "t", now, None)["right"] is False


def test_a_sampled_right_page_also_keeps_its_page_copy_for_the_doctype_model():
    e, why = feedback.check(ex(keep=True, doctypeModel="passport", doctypeFixed="passport", pageImage=JPG))
    assert why is None and e["right"] and e["pageImage"] and not feedback.correction(e)
    e, why = feedback.check(ex(keep=True, doctypeModel="passport", pageImage="bad"))
    assert why is None and e["right"] and e["pageImage"] is None  # the page copy is optional here
    e, _ = feedback.check(ex(image=None, doctypeModel="passport", doctypeFixed="passport", pageImage=JPG))
    assert e["pageImage"] is None and not feedback.kept(e)  # only a sampled page keeps it


def test_the_doctype_model_is_due_when_every_kind_has_enough_copies():
    assert feedback.doctype_counts({})["sefach"] == 0 and not feedback.doctypes_due({})
    full = {k: feedback.DOCTYPE_AT for k in feedback.DOCTYPES_TRAINED}
    assert feedback.doctypes_due({"doctypesSince": full})
    assert not feedback.doctypes_due({"doctypesSince": dict(full, id_back=feedback.DOCTYPE_AT - 1)})
    assert "other" not in feedback.DOCTYPES_TRAINED


def test_who_gave_the_kind_is_kept():
    e, _ = feedback.check(ex(image=None, doctypeModel="sefach", doctypeFixed="contract", pageImage=JPG, doctypeBy="model"))
    now = datetime.datetime(2026, 10, 19, tzinfo=datetime.timezone.utc)
    assert feedback.record(e, "t", now, None, "p")["doctypeBy"] == "model"
    e, _ = feedback.check(ex(image=None, doctypeModel="sefach", doctypeFixed="contract", pageImage=JPG, doctypeBy="odd"))
    assert e["doctypeBy"] == "haiku"


def test_the_names_before_h0_are_still_read():
    old = ex(image=None)
    old["cornersModel"], old["cornersFixed"] = old.pop("edgesModel"), old.pop("edgesFixed")
    old.update(kindModel="sefach", kindFixed="sefach", kindBy="model")
    got, why = feedback.check(old)
    assert why is None and got["edgesModel"] and got["doctypeModel"] == "sefach" and got["doctypeBy"] == "model"


def test_the_counters_before_h0_are_added():
    st = {"newSince": 150, "edgesSince": 60, "kindsSince": {"sefach": 40}, "doctypesSince": {"sefach": 70, "passport": 5}}
    assert feedback.edges_since(st) == 210
    c = feedback.doctype_counts(st)
    assert c["sefach"] == 110 and c["passport"] == 5 and c["other"] == 0


DOC_JPG = JPG


def doc(**kw):
    return dict({"workerId": "w1", "pages": [{"b64": DOC_JPG, "doctype": "id_front", "primary": True}, {"b64": DOC_JPG, "doctype": "sefach"}],
                 "read": {"given": "Dana", "fieldBoxes": {"given": [0.1, 0.1, 0.3, 0.2]}}, "reads": [{"city": "Haifa"}],
                 "scanned": {"docGiven": "Dana", "docSurname": "Levi", "city": "Hifa"}, "saved": {"docGiven": "Dana", "docSurname": "Levi", "city": "Haifa", "phone": "050"}}, **kw)


def test_a_full_document_keeps_its_pages_reads_and_the_fields_corrected():
    d, why = feedback.check_document(doc())
    assert why is None and len(d["pages"]) == 2 and d["pages"][0]["primary"] and d["pages"][1]["doctype"] == "sefach"
    assert d["corrected"] == ["city"] and "phone" not in d["saved"] and d["read"]["fieldBoxes"] and d["workerId"] == "w1"
    rec = feedback.document_record(d, "t1", "now", "x", ["p1", "p2"])
    assert rec["pages"][1] == {"path": "p2", "doctype": "sefach", "primary": False} and rec["tenantId"] == "t1" and "image" not in rec["pages"][0]


def test_a_full_document_is_refused_without_pages_or_saved_fields():
    assert feedback.check_document(doc(pages=[]))[1] == "no pages"
    assert feedback.check_document(doc(pages=[{"b64": "bm90IGpwZWc="}]))[1] == "a page is not a JPEG"
    assert feedback.check_document(doc(saved={}))[1] == "nothing saved"
    assert feedback.check_document(doc(pages=[{"b64": DOC_JPG}] * 7))[1] == "no pages"


def test_a_shadow_answer_is_kept_and_counted_against_haiku():
    e, _ = feedback.check(ex(image=None, doctypeModel="sefach", doctypeFixed="sefach", doctypeShadow="sefach"))
    assert e["doctypeShadow"] == "sefach" and feedback.shadow_counts(e) == {"shadowPages": 1, "shadowModelRight": 1, "shadowHaikuRight": 1}
    e, _ = feedback.check(ex(image=None, pageImage=JPG, doctypeModel="sefach", doctypeFixed="contract", doctypeShadow="contract"))
    assert feedback.shadow_counts(e) == {"shadowPages": 1, "shadowModelRight": 1, "shadowHaikuRight": 0}
    e, _ = feedback.check(ex(image=None, doctypeModel="sefach", doctypeFixed="sefach", doctypeShadow="bogus"))
    assert e["doctypeShadow"] is None and feedback.shadow_counts(e) == {}


def test_a_phone_cut_page_teaches_only_its_document_type():
    # the scan window's page (the scanner lab cut it): no corners, no edges copy, never an edges correction
    e, why = feedback.check({"source": "page", "image": JPG, "doctypeModel": "sefach", "doctypeFixed": "contract", "doctypeBy": "haiku", "pageImage": JPG})
    assert why is None and e["image"] is None and e["moved"] == 0 and e["edgesModel"] == feedback.WHOLE
    assert feedback.kept(e) and feedback.correction(e) and not feedback.edges_correction(e)
    e, why = feedback.check({"source": "page", "doctypeModel": "id_front", "doctypeBy": "model", "keep": True, "pageImage": JPG})
    assert why is None and e["right"] and e["pageImage"] and e["doctypeBy"] == "model" and not feedback.correction(e)
    e, why = feedback.check({"source": "page", "doctypeModel": "id_front"})
    assert why is None and not feedback.kept(e)
    assert feedback.check({"source": "page", "doctypeModel": "id_front", "doctypeFixed": "sefach"})[1] == "a changed document type needs a small JPEG of the page"


def test_a_corner_fix_from_the_old_window_still_counts_toward_the_edges_retraining():
    fixed = [[0.12, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.95]]
    e, _ = feedback.check(ex(edgesFixed=fixed))
    assert feedback.edges_correction(e)


# ---------- every scan attempt (S8) ----------
BIG = base64.b64encode(b"\xff\xd8" + b"\0" * 1000 + b"\xff\xd9").decode()


def att(**kw):
    return dict({"id": "s12", "group": "g3", "source": "site", "outcome": "kept", "picture": BIG,
                 "edgesModel": MODEL, "model": "base-v1", "way": "bg-gpulive", "input": "camera", "pages": 2}, **kw)


def test_an_attempt_is_kept_with_its_picture_corners_and_outcome():
    a, why = feedback.check_attempt(att())
    assert why is None and a["picture"].startswith(b"\xff\xd8") and a["edgesModel"] == MODEL
    assert a["outcome"] == "kept" and a["group"] == "g3" and a["source"] == "site" and a["pages"] == 2 and a["edgesFixed"] is None and a["edgesMore"] == []
    other = [[0.5, 0.5], [0.8, 0.5], [0.8, 0.8], [0.5, 0.8]]
    assert feedback.check_attempt(att(edgesMore=[other, [[9, 9]], "x"]))[0]["edgesMore"] == [other]


def test_corners_moved_by_hand_on_another_document_are_kept_beside_it():
    other = [[0.5, 0.5], [0.8, 0.5], [0.8, 0.8], [0.5, 0.8]]
    moved = [[0.45, 0.5], [0.8, 0.5], [0.8, 0.8], [0.5, 0.8]]
    third = [[0.1, 0.6], [0.3, 0.6], [0.3, 0.9], [0.1, 0.9]]
    a, _ = feedback.check_attempt(att(edgesMore=[other, third], edgesMoreFixed=[moved, third]))
    assert a["edgesMore"] == [other, third] and a["edgesMoreFixed"] == [moved, None]
    a, _ = feedback.check_attempt(att(edgesMore=[other], edgesMoreFixed="x"))
    assert a["edgesMoreFixed"] == [None]
    now = datetime.datetime(2026, 10, 20, 12, tzinfo=datetime.timezone.utc)
    assert feedback.attempt_dir(a, now) == "attempts/new/site/2026-10-20/s12"
    rec = feedback.attempt_record(a, "t1", now, "attempts/new/site/2026-10-20/s12/picture.jpg")
    assert rec["tenantId"] == "t1" and "picture" in rec and not isinstance(rec["picture"], bytes)


def test_moved_corners_are_the_answer_and_a_tiny_move_is_none():
    fixed = [[0.2, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]
    a, _ = feedback.check_attempt(att(edgesFixed=fixed))
    assert a["edgesFixed"] == fixed and a["moved"] > 0.05
    a, _ = feedback.check_attempt(att(edgesFixed=MODEL))
    assert a["edgesFixed"] is None and a["moved"] == 0


def test_a_picture_taken_whole_has_no_corners_and_a_retake_keeps_its_group():
    a, why = feedback.check_attempt(att(edgesModel=None, outcome="retaken", source="lab", input="pdf"))
    assert why is None and a["edgesModel"] is None and a["outcome"] == "retaken" and a["source"] == "lab" and a["input"] == "pdf"
    a, _ = feedback.check_attempt(att(group=None))
    assert a["group"] == "s12" and a["deletedPages"] == []
    assert feedback.check_attempt(att(deletedPages=[2, 1, 2, -1, 99, True, "x"]))[0]["deletedPages"] == [1, 2]


def test_bad_attempts_are_refused():
    assert feedback.check_attempt(att(id="../x"))[0] is None
    assert feedback.check_attempt(att(source="other"))[0] is None
    assert feedback.check_attempt(att(outcome="maybe"))[0] is None
    assert feedback.check_attempt(att(picture="not base64!"))[0] is None
    assert feedback.check_attempt(att(picture=base64.b64encode(b"PNG...").decode()))[0] is None
    assert feedback.check_attempt(att(picture=base64.b64encode(b"\xff\xd8" + b"\0" * 1_600_000).decode()))[0] is None
    assert feedback.check_attempt(att(edgesModel=[[0, 0]]))[0] is None
    assert feedback.check_attempt("x")[0] is None


def test_a_later_outcome_names_only_an_attempts_folder():
    assert feedback.outcome_dir("attempts/new/site/2026-10-20/s12") == "attempts/new/site/2026-10-20/s12"
    for bad in ("attempts/used/site/2026-10-20/s12", "attempts/new/x/2026-10-20/s12", "attempts/new/site/20-10/s12",
                "attempts/new/site/2026-10-20/../s", "documents/t/2026-10/x", None):
        assert feedback.outcome_dir(bad) is None, bad


def test_a_training_is_due_at_15_attempts():
    assert feedback.ATTEMPTS_AT == 15
    assert not feedback.attempts_due({"attemptsSince": 14}) and feedback.attempts_due({"attemptsSince": 15})
    assert feedback.attempts_since({}) == 0


def test_a_firm_with_its_collection_off_sends_no_attempts():
    assert feedback.attempts_wanted("t1", True) and not feedback.attempts_wanted("t1", False)
    assert feedback.attempts_wanted("", False)  # the super-admin in the lab
