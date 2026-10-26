"""The scanner's training examples (functions/feedback.py, docs/scan-plan.md → S6):
what is kept, what is only counted, what is refused; the gate's claims; the
server and the site use the same model version."""
import base64
import datetime
import importlib.util
import pathlib
import types

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


def test_the_passport_zone_readers_shadow_is_kept_and_counted_against_the_ai():
    zone = {"lines": ["P<UKRSHEVCHENKO<<OKSANA" + "<" * 21, "x" * 80, "third"], "docId": "FA123456", "docDob": "01/02/1990",
            "docExpiry": "03/04/2030", "docSex": "F", "allChecks": True, "bogus": "no"}
    saved = {"docType": "passport", "docId": "FA123456", "docDob": "01/02/1990", "docExpiry": "03/04/2030", "docSex": "F", "docGiven": "OKSANA"}
    d, _ = feedback.check_document(doc(saved=saved, scanned=dict(saved, docExpiry="04/03/2030"), mrzShadow=zone))
    z = d["mrzShadow"]
    assert len(z["lines"]) == 2 and len(z["lines"][1]) == 60 and z["allChecks"] is True and "bogus" not in z
    assert feedback.document_record(d, "t1", "now", "x", ["p1", "p2"])["mrzShadow"] == z
    assert feedback.mrz_counts(d) == {"mrzShadowPassports": 1, "mrzShadowRight": 1, "mrzAiRight": 0}
    # the reader missed the birth date: wrong; an Israeli's docId (the ID number) is not compared
    d, _ = feedback.check_document(doc(saved=saved, scanned=saved, mrzShadow=dict(zone, docDob="")))
    assert feedback.mrz_counts(d) == {"mrzShadowPassports": 1, "mrzShadowRight": 0, "mrzAiRight": 1}
    il = {"docType": "israeli_id", "docId": "123456782", "docDob": "01/02/1990"}
    d, _ = feedback.check_document(doc(saved=il, scanned=il, read={"mrzLine2": "x"}, mrzShadow={"lines": [], "docDob": "01/02/1990"}))
    assert feedback.mrz_counts(d) == {"mrzShadowPassports": 1, "mrzShadowRight": 1, "mrzAiRight": 1}
    # an ID card with no zone, or no reader: nothing counted, nothing kept
    d, _ = feedback.check_document(doc(saved=il, scanned=il, mrzShadow={"lines": []}))
    assert feedback.mrz_counts(d) == {}
    d, _ = feedback.check_document(doc(mrzShadow="nope"))
    assert "mrzShadow" not in d and feedback.mrz_counts(d) == {}


def test_the_hebrew_field_readers_shadow_is_kept_and_counted_against_the_ai():
    he = {"layout": "new", "idOk": True, "docSurname": "כהן", "docGiven": "דוד", "docId": "123456782",
          "docDob": "01/02/1990", "docExpiry": "", "bogus": "no"}
    saved = {"docType": "israeli_id", "docSurname": "כהן", "docGiven": "דוד", "docId": "123456782", "docDob": "01/02/1990"}
    d, _ = feedback.check_document(doc(saved=saved, scanned=dict(saved, docSurname="כחן"), heShadow=he))
    h = d["heShadow"]
    assert h == {"layout": "new", "idOk": True, "docSurname": "כהן", "docGiven": "דוד", "docId": "123456782", "docDob": "01/02/1990"}
    assert feedback.document_record(d, "t1", "now", "x", ["p1", "p2"])["heShadow"] == h
    assert feedback.he_counts(d) == {"heShadowCards": 1, "heShadowRight": 1, "heAiRight": 0}
    # the reader missed the ID number: wrong; quote marks' forms and spaces do not count
    d, _ = feedback.check_document(doc(saved=dict(saved, docSurname="בן־ג'ורג'"), scanned=dict(saved, docSurname="בן־ג׳ורג׳"),
                                       heShadow=dict(he, docId="123456781", docSurname="בן־ג’ורג’")))
    assert feedback.he_counts(d) == {"heShadowCards": 1, "heShadowRight": 0, "heAiRight": 1}
    # a passport, no layout or no reader: nothing counted
    d, _ = feedback.check_document(doc(saved=dict(saved, docType="passport"), scanned=saved, heShadow=he))
    assert feedback.he_counts(d) == {}
    d, _ = feedback.check_document(doc(saved=saved, scanned=saved, heShadow=dict(he, layout="")))
    assert "heShadow" not in d and feedback.he_counts(d) == {}
    d, _ = feedback.check_document(doc(heShadow="nope"))
    assert "heShadow" not in d and feedback.he_counts(d) == {}


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


def test_a_tick_in_the_lab_is_kept_as_doctype_confirmed_and_a_site_sample_is_not():
    now = datetime.datetime(2026, 10, 24, tzinfo=datetime.timezone.utc)
    lab = {"source": "page", "origin": "lab", "model": "v6", "doctypeModel": "passport", "doctypeFixed": "passport",
           "doctypeBy": "model", "pageImage": JPG, "doctypeConfirmed": True, "keep": True}
    e, why = feedback.check(lab)
    assert why is None and e["doctypeConfirmed"] is True and feedback.kept(e) and not feedback.correction(e)
    assert feedback.record(e, "t", now, None, "p")["doctypeConfirmed"] is True
    site, _ = feedback.check({"source": "page", "doctypeModel": "passport", "doctypeBy": "model", "pageImage": JPG, "keep": True})
    assert site["doctypeConfirmed"] is False and feedback.record(site, "t", now, None, "p")["doctypeConfirmed"] is False
    # only a phone-cut page carries it, as a bool, and only with a type
    assert feedback.check(ex(keep=True, doctypeModel="passport", doctypeConfirmed=True))[0]["doctypeConfirmed"] is False
    assert feedback.check({"source": "page", "doctypeModel": "passport", "doctypeConfirmed": "yes", "keep": True})[0]["doctypeConfirmed"] is False
    assert feedback.check({"source": "page", "doctypeConfirmed": True, "keep": True})[0]["doctypeConfirmed"] is False


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


# ---------- Training 2: the scan's session, the worker, the copy's turn; attempts told the worker; firm checks ----------
def test_a_page_copy_keeps_its_scan_session_worker_and_who_set_its_turn():
    e, why = feedback.check({"source": "page", "doctypeModel": "sefach", "doctypeFixed": "id_back", "pageImage": JPG,
                             "sessionId": "3f1c-9a_b", "workerId": "w1", "turnBy": "haiku", "turnModel": 2, "turnFixed": 0})
    assert why is None and e["sessionId"] == "3f1c-9a_b" and e["workerId"] == "w1" and e["origin"] == "site"
    assert e["turnBy"] == "haiku" and e["turnModel"] == 2 and e["turnFixed"] == 0
    now = datetime.datetime(2026, 10, 24, tzinfo=datetime.timezone.utc)
    r = feedback.record(e, "t1", now, None, "p")
    assert {k: r[k] for k in ("sessionId", "workerId", "turnBy", "turnModel", "turnFixed", "origin")} == \
        {"sessionId": "3f1c-9a_b", "workerId": "w1", "turnBy": "haiku", "turnModel": 2, "turnFixed": 0, "origin": "site"}


def test_bad_session_worker_and_turn_fields_are_dropped_not_refused():
    e, why = feedback.check({"source": "page", "doctypeModel": "sefach", "sessionId": "../x", "workerId": "w" * 80,
                             "turnBy": "guess", "turnModel": 4, "turnFixed": True, "origin": "elsewhere"})
    assert why is None and e["sessionId"] is None and e["workerId"] == "w" * 64 and e["turnBy"] is None
    assert e["turnModel"] is None and e["turnFixed"] is None and e["origin"] == "site"
    e, _ = feedback.check({"source": "page", "doctypeModel": "sefach"})
    assert e["workerId"] is None and e["sessionId"] is None
    for who in feedback.TURN_BY:
        assert feedback.check({"source": "page", "doctypeModel": "sefach", "turnBy": who})[0]["turnBy"] == who


def test_a_lab_example_keeps_the_version_the_lab_names():
    lab, _ = feedback.check({"source": "page", "origin": "lab", "model": "v5", "doctypeModel": "sefach", "doctypeFixed": "id_back",
                             "pageImage": JPG, "turnModel": 1, "turnBy": "face"})
    site, _ = feedback.check({"source": "page", "model": "v5", "doctypeModel": "sefach", "doctypeFixed": "id_back", "pageImage": JPG})
    assert lab["origin"] == "lab" and feedback.example_version(lab, "base-v1") == "v5"
    assert site["origin"] == "site" and feedback.example_version(site, "base-v1") == "base-v1"


def test_a_full_document_keeps_its_scan_session():
    d, _ = feedback.check_document(doc(sessionId="s-1"))
    assert d["sessionId"] == "s-1" and feedback.document_record(d, "t1", "now", "x", ["p1", "p2"])["sessionId"] == "s-1"
    d, _ = feedback.check_document(doc(workerId="w" * 70, sessionId="bad id"))
    assert d["workerId"] == "w" * 64 and d["sessionId"] is None


NOT_FIRM = "not this firm" + chr(39) + "s attempt"


def test_a_saved_outcome_needs_the_worker_and_the_attempts_own_firm():
    answer = {"id": "s12", "tenantId": "t1"}
    out, why = feedback.check_outcome({"outcome": "saved", "workerId": "w1"}, "t1", answer)
    assert why is None and out == {"outcome": "saved", "page": None, "workerId": "w1"}
    assert feedback.check_outcome({"outcome": "saved"}, "t1", answer)[1] == "a saved attempt needs its worker"
    assert feedback.check_outcome({"outcome": "saved", "workerId": "w1"}, "t2", answer)[1] == NOT_FIRM
    assert feedback.check_outcome({"outcome": "saved", "workerId": "w1"}, "", answer)[1] == NOT_FIRM
    assert feedback.check_outcome({"outcome": "saved", "workerId": "w1"}, "t1", None)[1] == "no such attempt"
    assert feedback.check_outcome({"outcome": "kept"}, "t1", answer)[1] == "bad outcome"
    out, _ = feedback.check_outcome({"outcome": "deleted", "page": 2}, "t1", answer)
    assert out == {"outcome": "deleted", "page": 2, "workerId": None}
    # the super-admin's lab attempts carry no firm: only a login with no firm adds to them
    assert feedback.check_outcome({"outcome": "deleted"}, "", {"tenantId": ""})[0]["outcome"] == "deleted"
    assert feedback.check_outcome({"outcome": "saved", "workerId": "w" * 80}, "t1", answer)[0]["workerId"] == "w" * 64


# ---------- the server's side (functions/main.py) with Storage, the bucket and Firestore mocked ----------
# functions/main.py comes from the `functions_main` fixture (conftest.py): loaded once per run, as test_form101_build.py's


class _Ref:
    def __init__(self, store, n):
        self.id, self.store = f"r{n}", store

    def set(self, rec, merge=False):
        self.store.append((self.id, rec))


class _Note:
    """An attempt's owner note, Firestore scanAttempts/<id>."""
    def __init__(self, notes, nid):
        self.notes, self.nid = notes, nid

    def set(self, rec, merge=False):
        self.notes[self.nid] = rec

    def get(self):
        rec = self.notes.get(self.nid)
        return types.SimpleNamespace(exists=rec is not None, to_dict=lambda: dict(rec) if rec is not None else None)


class _Db:
    def __init__(self, notes=None):
        self.records, self.n, self.notes, self._col = [], 0, dict(notes or {}), None

    def collection(self, name):
        assert name in ("scanTraining", "scanAttempts")
        self._col = name
        return self

    def document(self, nid=None):
        if self._col == "scanAttempts":
            return _Note(self.notes, nid)
        self.n += 1
        return _Ref(self.records, self.n)


class _Stats:
    def __init__(self):
        self.updates = []

    def set(self, update, merge=False):
        self.updates.append(update)


def _body(resp):
    import json
    return resp.status_code, json.loads(resp.get_data())


def _server(monkeypatch, main, collects=True, answer=None):
    put, asked = [], []
    monkeypatch.setattr(main, "collects_documents", lambda db, t: asked.append(t) or collects)
    monkeypatch.setattr(main.datastore, "put", lambda files, fb=None: put.extend(files) or [p for p, _ in files])
    monkeypatch.setattr(main.datastore, "on_hf", lambda: False)
    monkeypatch.setattr(main.datastore, "get", lambda path, fb=None: answer(path) if callable(answer) else answer)
    return main, put, asked


PAGE = {"source": "page", "doctypeModel": "sefach", "doctypeFixed": "id_back", "pageImage": JPG}


def test_the_server_keeps_the_lab_version_and_the_new_fields(monkeypatch, functions_main):
    main, put, _ = _server(monkeypatch, functions_main)
    db, stats = _Db(), _Stats()
    lab = dict(PAGE, origin="lab", model="v5", turnModel=1, turnBy="face")
    site = dict(PAGE, model="v5", sessionId="s1", workerId="w1", turnBy="haiku")
    code, j = _body(main._scan_add({"examples": [lab, site]}, {"tenantId": "t1"}, db, stats, None))
    assert code == 200 and j["kept"] == 2
    recs = dict(db.records)
    assert recs["r1"]["model"] == "v5" and recs["r1"]["origin"] == "lab" and recs["r1"]["turnBy"] == "face" and recs["r1"]["turnModel"] == 1
    assert recs["r2"]["model"] == main.SITE_VERSION and recs["r2"]["sessionId"] == "s1" and recs["r2"]["workerId"] == "w1" and recs["r2"]["turnBy"] == "haiku"
    assert len(put) == 2


def test_a_firm_with_its_collection_off_keeps_no_page_copy(monkeypatch, functions_main):
    main, put, asked = _server(monkeypatch, functions_main, collects=False)
    db, stats = _Db(), _Stats()
    code, j = _body(main._scan_add({"examples": [PAGE, dict(PAGE, doctypeFixed="sefach", keep=True)]}, {"tenantId": "t1"}, db, stats, None))
    assert code == 200 and j["kept"] == 0 and j["right"] == 1 and put == [] and db.records == [] and asked == ["t1"]
    assert "doctypesSince" not in stats.updates[-1]
    # the super-admin in the lab (no firm) always keeps them
    main, put, asked = _server(monkeypatch, functions_main, collects=False)
    code, j = _body(main._scan_add({"examples": [PAGE]}, {"role": "superadmin"}, _Db(), _Stats(), None))
    assert j["kept"] == 1 and len(put) == 1 and asked == []


DIR = "attempts/new/site/2026-10-24/s12"


def test_a_kept_attempt_gets_an_owner_note_and_a_saved_outcome_is_checked_against_it_without_reading_the_bucket(monkeypatch, functions_main):
    import json
    seen = []
    main, put, _ = _server(monkeypatch, functions_main, answer=lambda p: seen.append(p) or None)
    db = _Db()
    code, j = _body(main._scan_attempts({"attempts": [att()]}, {"tenantId": "t1"}, db, _Stats(), None))
    base = j["dirs"]["s12"]
    assert code == 200 and db.notes == {feedback.attempt_key(base): {"tenantId": "t1", "dir": base, "createdAt": db.notes[feedback.attempt_key(base)]["createdAt"]}}
    put.clear()
    code, j = _body(main._scan_attempt_outcome({"dir": base, "outcome": "saved", "workerId": "w1"}, {"tenantId": "t1"}, db, None))
    assert code == 200 and j["ok"] and seen == []   # the server's bucket token may only write: nothing read back
    (path, data), = put
    rec = json.loads(data)
    assert path.startswith(base + "/outcome-") and path.endswith(".json")
    assert rec["outcome"] == "saved" and rec["workerId"] == "w1" and rec["page"] is None and rec["at"]
    assert _body(main._scan_attempt_outcome({"dir": base, "outcome": "saved", "workerId": "w1"}, {"tenantId": "t2"}, db, None))[0] == 403


def test_an_attempt_kept_before_the_notes_is_checked_by_its_answer_json(monkeypatch, functions_main):
    import json
    seen = []
    main, put, _ = _server(monkeypatch, functions_main, answer=lambda p: seen.append(p) or json.dumps({"tenantId": "t1"}).encode())
    code, j = _body(main._scan_attempt_outcome({"dir": DIR, "outcome": "saved", "workerId": "w1"}, {"tenantId": "t1"}, _Db(), None))
    assert code == 200 and j["ok"] and seen == [DIR + "/answer.json"] and len(put) == 1
    # a note for another folder under the same key is never taken
    db = _Db({feedback.attempt_key(DIR): {"tenantId": "t2", "dir": "attempts/new/site/2026-10-24/other"}})
    assert _body(main._scan_attempt_outcome({"dir": DIR, "outcome": "deleted"}, {"tenantId": "t1"}, db, None))[0] == 200


def test_an_outcome_from_another_firm_or_for_no_attempt_is_refused(monkeypatch, functions_main):
    import json
    dir_ = DIR
    main, put, _ = _server(monkeypatch, functions_main, answer=json.dumps({"tenantId": "t1"}).encode())
    assert _body(main._scan_attempt_outcome({"dir": dir_, "outcome": "saved", "workerId": "w1"}, {"tenantId": "t2"}, _Db(), None))[0] == 403
    assert _body(main._scan_attempt_outcome({"dir": dir_, "outcome": "saved"}, {"tenantId": "t1"}, _Db(), None))[0] == 400
    assert _body(main._scan_attempt_outcome({"dir": dir_, "outcome": "kept"}, {"tenantId": "t1"}, _Db(), None))[0] == 400
    assert _body(main._scan_attempt_outcome({"dir": "documents/t1/x", "outcome": "deleted"}, {"tenantId": "t1"}, _Db(), None))[0] == 400
    assert put == []
    main, put, _ = _server(monkeypatch, functions_main, answer=None)
    assert _body(main._scan_attempt_outcome({"dir": dir_, "outcome": "deleted", "page": 1}, {"tenantId": "t1"}, _Db(), None))[0] == 404
    # the firm in the note decides, not the answer.json
    db = _Db({feedback.attempt_key(dir_): {"tenantId": "t9", "dir": dir_}})
    assert _body(main._scan_attempt_outcome({"dir": dir_, "outcome": "deleted"}, {"tenantId": "t1"}, db, None))[0] == 403
    assert put == []


# ---------- the readers' counters for the bell (completeness fixes 2) ----------
PASSPORT = {"docType": "passport", "docId": "FA123456", "docDob": "01/02/1990", "docGiven": "OKSANA"}
IL_ID = {"docType": "israeli_id", "docSurname": "כהן", "docId": "123456782"}


def test_a_saved_passport_or_id_card_counts_toward_its_reader():
    pp = [{"b64": DOC_JPG, "doctype": "passport", "primary": True}]
    d, _ = feedback.check_document(doc(pages=pp, saved=PASSPORT, scanned=PASSPORT))
    assert feedback.reader_counts(d) == {"passportsSince": 1}
    d, _ = feedback.check_document(doc(saved=IL_ID, scanned=IL_ID))   # doc(): an id_front page and a ספח
    assert feedback.reader_counts(d) == {"idCardsSince": 1}
    # no zone field kept, no page of its kind, another docType: nothing
    d, _ = feedback.check_document(doc(pages=pp, saved={"docType": "passport", "docGiven": "OKSANA"}))
    assert feedback.reader_counts(d) == {}
    d, _ = feedback.check_document(doc(saved=PASSPORT))                     # an id_front page, a passport saved
    assert feedback.reader_counts(d) == {}
    d, _ = feedback.check_document(doc(pages=pp, saved=IL_ID))              # a passport page, an ID card saved
    assert feedback.reader_counts(d) == {}
    d, _ = feedback.check_document(doc())                                   # no docType saved
    assert feedback.reader_counts(d) == {}


def test_the_readers_are_due_at_30_real_documents():
    assert feedback.REAL_NEEDED == 30
    assert feedback.readers_due({}) == {"passportsSince": 0, "idCardsSince": 0, "realNeeded": 30, "passportsDue": False, "idCardsDue": False}
    got = feedback.readers_due({"passportsSince": 30, "idCardsSince": 29})
    assert got["passportsDue"] and not got["idCardsDue"] and got["idCardsSince"] == 29


def test_the_server_counts_a_saved_passport_and_a_lab_tick(monkeypatch, functions_main):
    main, put, _ = _server(monkeypatch, functions_main)
    db, stats = _Db(), _Stats()
    payload = doc(pages=[{"b64": DOC_JPG, "doctype": "passport", "primary": True}], saved=PASSPORT, scanned=PASSPORT)
    code, j = _body(main._scan_document(payload, {"tenantId": "t1"}, db, stats, None))
    assert code == 200 and j["kept"] is True
    upd = stats.updates[-1]
    assert upd["passportsSince"].value == 1 and "idCardsSince" not in upd
    # the lab's tick on the model's own type: kept with doctypeConfirmed in its record
    tick = dict(PAGE, origin="lab", model="v6", doctypeModel="passport", doctypeFixed="passport", doctypeBy="model", keep=True,
                doctypeConfirmed=True)
    code, j = _body(main._scan_add({"examples": [tick]}, {"tenantId": "t1"}, db, stats, None))
    assert code == 200 and j["kept"] == 1 and db.records[-1][1]["doctypeConfirmed"] is True


def test_the_loop_reports_come_with_the_stats(functions_main):
    """The stats answer carries the automatic training cycle's reports (scanTrainingStats/loop, written by the PC's
    loop_report.py): the latest and the last 20, nothing when the PC never sent one."""
    main = functions_main
    snap = lambda d: types.SimpleNamespace(to_dict=lambda: d)
    reports = [{"id": f"c{i}", "state": "rejected"} for i in range(25)]

    class Db:
        def __init__(self, loop):
            self.loop, self.asked = loop, []

        def collection(self, name):
            assert name == "scanTrainingStats"
            return self

        def document(self, name):
            self.asked.append(name)
            return types.SimpleNamespace(get=lambda: snap(self.loop))

    current = types.SimpleNamespace(get=lambda: snap({"edgesSince": 21}))
    db = Db({"latest": reports[0], "history": reports})
    j = main._scan_stats(db, current)
    assert db.asked == ["loop"] and j["due"] is True and j["edgesSince"] == 21
    assert j["loop"]["latest"] == {"id": "c0", "state": "rejected"} and len(j["loop"]["history"]) == 20
    assert main._scan_stats(Db(None), current)["loop"] == {"latest": None, "history": []}
    assert feedback.loop_reports({"latest": "x", "history": ["y", {"id": "a"}]}) == {"latest": None, "history": [{"id": "a"}]}
