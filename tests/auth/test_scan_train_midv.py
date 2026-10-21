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
