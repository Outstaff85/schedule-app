"""MIDV's annotations as the document edges models' examples (scripts/scan-train/midv.py,
docs/scan-training.md → MIDV): both formats read, the corners in the model's order, a document
that goes out of the picture left out."""
import importlib.util
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "scan-train"
sys.path.insert(0, str(HERE))
_spec = importlib.util.spec_from_file_location("midv", HERE / "midv.py")
midv = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(midv)

TURNED = [[400, 100], [500, 600], [100, 700], [50, 150]]   # the document's own top-left first, lying on its side


def test_midv500_frames_quad():
    assert midv.quads_of({"quad": TURNED}) == [(None, [[float(x), float(y)] for x, y in TURNED])]
    assert midv.quads_of({"field01": {"quad": TURNED, "value": "X"}}) == []   # the template's fields, no frame


def test_midv2020_via_projects_doc_quad():
    region = {"shape_attributes": {"name": "polygon", "all_points_x": [p[0] for p in TURNED], "all_points_y": [p[1] for p in TURNED]},
              "region_attributes": {"field_name": "doc_quad"}}
    face = {"shape_attributes": {"name": "rect", "x": 1, "y": 1, "width": 5, "height": 5}, "region_attributes": {"field_name": "face"}}
    project = {"_via_settings": {}, "_via_img_metadata": {"00.jpg123": {"filename": "00.jpg", "regions": [face, region]}}}
    assert midv.quads_of(project) == [("00.jpg", [[float(x), float(y)] for x, y in TURNED])]
    assert midv.quads_of(project["_via_img_metadata"]) == midv.quads_of(project)
    assert midv.quads_of({"a": {"filename": "1.jpg", "regions": {"0": region}}})[0][0] == "1.jpg"   # VIA 1


def test_corners_in_the_models_order_and_inside():
    assert midv.normalised(TURNED, 600, 800) == [[50 / 600, 150 / 800], [400 / 600, 100 / 800], [500 / 600, 600 / 800], [100 / 600, 700 / 800]]
    assert midv.normalised([[-60, 0], [500, 0], [500, 700], [0, 700]], 600, 800) is None


def test_kinds_by_folder():
    assert midv.kind_of("photo/aze_passport/00.jpg") == "passport"
    assert midv.kind_of("39_rus_internalpassport/images/TS") == "passport"
    assert midv.kind_of("48_usa_passportcard/x") == "id_front" and midv.kind_of("alb_id/00.jpg") == "id_front"
    assert midv.kind_of("21_esp_drvlic/images/TS") == "other"   # a driving licence: "other", like the owner's (the class table)


_sd = importlib.util.spec_from_file_location("smartdoc", HERE / "smartdoc.py")
smartdoc = importlib.util.module_from_spec(_sd)
_sd.loader.exec_module(smartdoc)


def test_smartdoc_metadata_rows():
    # the file lists the corners tl, bl, br, tr (its README's own example line)
    csv = ("bg_name,bg_id,model_name,model_id,modeltype_name,modeltype_id,model_subid,image_path,frame_index,model_width,"
           "model_height,tl_x,tl_y,bl_x,bl_y,br_x,br_y,tr_x,tr_y\n"
           "background01,0,datasheet001,0,datasheet,0,0,background01/datasheet001/frame_0001.jpeg,1,2100.0,2970.0,"
           "698.087,200.476,692.141,891.077,1253.18,869.656,1178.15,191.515\n")
    [(path, kind, quad)] = smartdoc.rows(csv)
    assert path == "background01/datasheet001/frame_0001.jpeg" and kind == "datasheet"
    assert quad == [[698.087, 200.476], [1178.15, 191.515], [1253.18, 869.656], [692.141, 891.077]]   # clockwise
    assert smartdoc.frame_no(path) == 1


def test_a_turned_smartdoc_frame_keeps_its_corners():
    # a quarter turn clockwise: (x, y) → (1 - y, x); still the photo's top-left first, clockwise
    c = [[0.3, 0.2], [0.6, 0.2], [0.6, 0.8], [0.3, 0.8]]
    got = smartdoc.turned(c)
    want = [[0.2, 0.3], [0.8, 0.3], [0.8, 0.6], [0.2, 0.6]]
    assert all(abs(a - b) < 1e-9 for p, q in zip(got, want) for a, b in zip(p, q))


def test_the_owners_own_pages_in_the_bucket():
    # pull_templates.py copies templates/<kind>/<picture> — not a deeper folder, an unknown kind or another file
    import types
    saved = sys.modules.get("common")
    sys.modules["common"] = types.SimpleNamespace(DATA="x/y", WORK=pathlib.Path("/tmp"))
    try:
        spec = importlib.util.spec_from_file_location("pull_templates", HERE / "pull_templates.py")
        pt = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(pt)
    finally:
        if saved is None:
            sys.modules.pop("common", None)
        else:
            sys.modules["common"] = saved
    paths = ["templates/id_front/new_type.jpg", "templates/sefach/sefah.JPG", "templates/id_back/back.png",
             "templates/id_front/notes.txt", "templates/visa/a.jpg", "templates/id_front/old/a.jpg", "documents/t/2026-10/x/page-0.jpg"]
    assert pt.own_pages(paths) == [("templates/id_front/new_type.jpg", "id_front", "new_type.jpg"),
                                   ("templates/sefach/sefah.JPG", "sefach", "sefah.JPG"),
                                   ("templates/id_back/back.png", "id_back", "back.png")]


_mz = importlib.util.spec_from_file_location("midv_mrz", HERE / "midv_mrz.py")
midv_mrz = importlib.util.module_from_spec(_mz)
_mz.loader.exec_module(midv_mrz)

L1 = "P<AZESPECIMEN<<ANAR<<<<<<<<<<<<<<<<<<<<<<<<<"
L2 = "C012345678AZE8001014M3001014<<<<<<<<<<<<<<04"


def test_a_templates_zone_lines_by_their_values():
    def rect(x, y, w, h, **attrs):
        return {"shape_attributes": {"name": "rect", "x": x, "y": y, "width": w, "height": h}, "region_attributes": attrs}
    ann = {"_via_img_metadata": {
        "00.jpg1": {"filename": "00.jpg", "regions": [rect(10, 700, 1000, 40, field_name="line_b", value=L2),
                                                     rect(10, 640, 1000, 40, field_name="line_a", value=L1),
                                                     rect(400, 100, 300, 40, field_name="surname", value="SPECIMEN")]},
        "01.jpg1": {"filename": "01.jpg", "regions": [rect(10, 640, 1000, 100, field_name="mrz", value=L1 + "\n" + L2)]},
        "02.jpg1": {"filename": "02.jpg", "regions": [rect(10, 640, 1000, 40, field_name="mrz", value=L1)]}}}
    z = midv_mrz.zones(ann)
    assert z["00.jpg"] == [((10.0, 640.0, 1000.0, 40.0), L1), ((10.0, 700.0, 1000.0, 40.0), L2)]   # top to bottom
    assert z["01.jpg"] == [((10.0, 640.0, 1000.0, 50.0), L1), ((10.0, 690.0, 1000.0, 50.0), L2)]   # one field, split
    assert "02.jpg" not in z                                                                       # one line only


def test_which_template_a_picture_shows_and_the_exam_split():
    p = pathlib.Path
    assert midv_mrz.template_id(p("photo/images/aze_passport/85.jpg"), p("photo/annotations/aze_passport.json"),
                                p("photo/images/aze_passport/85.jpg")) == "85"
    assert midv_mrz.template_id(p("clips/images/grc_passport/07/000013.jpg"), p("clips/annotations/grc_passport/07.json"),
                                p("clips/images/grc_passport/07/000013.jpg")) == "07"
    assert midv_mrz.type_of("midv-2020/photo/images/lva_passport/00.jpg") == "lva_passport"
    assert midv_mrz.is_exam("80") and midv_mrz.is_exam("99") and not midv_mrz.is_exam("79")


def test_the_edges_exam_keeps_whole_documents_apart():
    # MIDV-2020's documents 80–99 and SmartDoc's fifth page of each kind are the exam: every photo, scan and frame of them
    m = lambda i, src="midv-2020/photo": {"id": f"midv-midv-2020-photo-images-alb_id-{i}", "midv": True, "source": src}
    assert midv.open_exam(m("80")) and midv.open_exam(m("99")) and not midv.open_exam(m("79"))
    assert midv.open_exam(m("85", "midv-2020/scan_rotated")) and not midv.open_exam(m("85", "midv-500"))
    sd = lambda doc: {"id": f"smartdoc-background03-{doc}-frame_0012", "smartdoc": True}
    assert midv.open_exam(sd("tax005")) and midv.open_exam(sd("datasheet005")) and not midv.open_exam(sd("tax004"))
    assert not midv.open_exam({"id": "a-user-page-80", "exam": False})   # the users' own exam is pull.py's
    # a clip's frames by their clip's document (its folder), not by the frame number at the end of the id
    clip = {"id": "midv-midv-2020-clips-images-alb_id-85-000013", "midv": True, "source": "midv-2020/clips"}
    assert midv.open_exam(clip) and not midv.open_exam({**clip, "id": "midv-midv-2020-clips-images-alb_id-07-000013"})
    assert midv.open_exam({**clip, "doc_no": "85"}) and not midv.open_exam({**clip, "doc_no": "07"})   # build() keeps doc_no
    p = pathlib.Path
    assert midv.doc_number(p("midv-2020/clips/images/alb_id/85/000013.jpg"), p("raw/midv-2020/clips/annotations/alb_id/85.json"),
                           p("raw/midv-2020/clips/images/alb_id/85/000013.jpg")) == "85"
    assert midv.doc_number(p("midv-2020/photo/images/alb_id/07.jpg"), p("raw/midv-2020/photo/annotations/alb_id.json"),
                           p("raw/midv-2020/photo/images/alb_id/07.jpg")) == "07"


def test_the_work_folder_can_be_on_another_disk(monkeypatch, tmp_path):
    # SCAN_TRAIN_HOME moves every copy (another disk); without it, ~/.scan-train
    spec = importlib.util.spec_from_file_location("home_t", HERE / "home.py")
    monkeypatch.setenv("SCAN_TRAIN_HOME", str(tmp_path / "scan-train"))
    home = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(home)
    assert home.WORK == tmp_path / "scan-train"
    monkeypatch.delenv("SCAN_TRAIN_HOME")
    home = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(home)
    assert home.WORK == pathlib.Path.home() / ".scan-train" and home.DATA == "OutStaff/scanner-data"


def test_drawing_leaves_the_first_core_free():
    # gentle() (home.py): off logical cores 0 and 1, two processes fewer than the cores
    spec = importlib.util.spec_from_file_location("home_g", HERE / "home.py")
    home = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(home)
    assert home.spare_cores(16) == (set(range(2, 16)), 14)
    assert home.spare_cores(4) == ({2, 3}, 2)
    assert home.spare_cores(2) == ({0, 1}, 1) and home.spare_cores(1) == ({0}, 1)


def test_the_zone_is_not_the_pages_dark_edge():
    # find_lines (mrzmodel.py; the lab's mrzFind the same): a thin dark band at the page's bottom edge
    # is not the zone's line 2 — both lines are the same height
    import numpy as np
    spec = importlib.util.spec_from_file_location("mrzmodel_t", HERE / "mrzmodel.py")
    mm = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mm)
    page = np.full((700, 1000), 230, np.uint8)
    for y in (560, 610):                                   # the zone's two lines: letters 22 px tall
        for x in range(40, 960, 21):
            page[y:y + 22, x:x + 15] = 20
    edge = page.copy()
    edge[694:] = 20                                        # the page's dark edge, 6 px
    for p in (page, edge):
        lines = mm.find_lines(p)
        assert len(lines) == 2 and all(l.shape[0] >= 22 for l in lines)


def test_the_edges_exam_takes_any_first_corner():
    # docfind.quad_error: a document turned near 45° has two "top-left" corners — the same quad
    # started from another corner is right; a quad turned the other way round is not
    spec = importlib.util.spec_from_file_location("docfind_t", HERE / "docfind.py")
    df = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(df)
    right = [[0.5, 0.1], [0.9, 0.5], [0.5, 0.9], [0.1, 0.5]]
    assert df.quad_error(right[1:] + right[:1], right) == 0.0
    assert df.quad_error([[0.51, 0.1], [0.9, 0.5], [0.5, 0.9], [0.1, 0.5]], right) < 0.011
    assert df.quad_error(right[::-1], right) > 0.5


def test_documents_70_to_79_are_the_zone_readers_real_check_neither_trained_nor_the_exam():
    assert midv_mrz.is_select("70") and midv_mrz.is_select("79") and not midv_mrz.is_select("69") and not midv_mrz.is_select("80")
    assert not any(midv_mrz.is_exam(str(n)) for n in range(70, 80))
    assert midv_mrz.SELECT_FROM == 70 < midv_mrz.EXAM_FROM == 80


def test_the_zone_reader_keeps_the_weights_best_on_the_real_lines_first(tmp_path):
    import pytest
    pytest.importorskip("torch")
    spec = importlib.util.spec_from_file_location("train_mrz_t7", HERE / "train_mrz.py")
    tm = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tm)
    # real lines right first, then the made-up ones, then fewer characters wrong
    assert tm.score((0.8, 0.1), (0.90, 0.02)) > tm.score((0.7, 0.1), (0.99, 0.01))
    assert tm.score(None, (0.95, 0.02)) == (-1.0, 0.95, -0.02)
    # an old best.pt better on made-up lines only does not throw away a run better on the real ones (both scored today)
    old, new = tm.score((0.60, 0.2), (0.97, 0.01)), tm.score((0.75, 0.1), (0.93, 0.02))
    assert not tm.keep_old(old, new) and tm.keep_old(new, old) and not tm.keep_old(None, new)
    rep = tm.train_report(0.9, 0.02, (0.75, 0.1), [1] * 10, [1] * 3, [1] * 4, True, {"at": "2026-10-20"}, 0.93, 1914, 1e-5)
    assert rep["keptOld"] is True and rep["keptFrom"] == "2026-10-20" and rep["newRunLinesRight"] == 0.93
    assert rep["realLinesRight"] == 0.75 and rep["midvLines"] == 1914 and rep["realCheckLines"] == 4
    rep = tm.train_report(0.9, 0.02, None, [1], [1], [], False, None, 0.9, 0, 0.0)
    assert rep["keptOld"] is False and rep["keptFrom"] is None and rep["realLinesRight"] is None
    # a phone-cut zone line found on the wrong place (find_ok 0) is left out of a labels.tsv
    (tmp_path / "labels.tsv").write_text("a.png\tLINE1\tcut-1\t1\nb.png\tLINE2\tcut-1\t0\nc.png\tLINE3\n", encoding="utf-8")
    assert [t for _, t in tm.load(tmp_path)] == ["LINE1", "LINE3"]
