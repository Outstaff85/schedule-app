"""The server's document finder (functions/docfind.py): corners from the model's
heatmaps, photos on a white page, several documents on one photo, the phone's
corners kept when the model is not sure, the cut page. The model is a stand-in
that answers with heatmaps drawn around known corners."""
import importlib.util
import pathlib

import cv2
import numpy as np

_spec = importlib.util.spec_from_file_location("docfind", pathlib.Path(__file__).resolve().parents[2] / "functions" / "docfind.py")
docfind = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(docfind)


def heatmaps(pts, peak=0.9):
    hm = np.zeros((1, 4, docfind.HM, docfind.HM), np.float32)
    ys, xs = np.mgrid[0:docfind.HM, 0:docfind.HM]
    for k, (x, y) in enumerate(pts):
        cx, cy = x * docfind.HM - 0.5, y * docfind.HM - 0.5
        hm[0, k] = peak * np.exp(-((xs - cx) ** 2 + (ys - cy) ** 2) / 8)
    return hm


class Named:
    def __init__(self, name):
        self.name = name


class Model:
    """Answers with the corners of the first light rectangle it sees (the documents
    are drawn white on a dark background), or with nothing."""
    def __init__(self, sure=True):
        self.sure = sure
        self.calls = 0

    def get_inputs(self):
        return [Named("img")]

    def run(self, _, feeds):
        self.calls += 1
        x = feeds["img"][0].transpose(1, 2, 0)
        mask = (x.min(axis=2) > 0.8).astype(np.uint8)
        n, _, st, _ = cv2.connectedComponentsWithStats(mask)
        if n < 2 or not self.sure:
            return [np.zeros((1, 4, docfind.HM, docfind.HM), np.float32)]
        j = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
        x0, y0, w, h = (st[j, k] / docfind.S for k in range(4))
        return [heatmaps([(x0, y0), (x0 + w, y0), (x0 + w, y0 + h), (x0, y0 + h)])]


def photo(*rects, size=(800, 600), back=(40, 60, 50)):
    img = np.zeros((size[1], size[0], 3), np.uint8)
    img[:] = back
    for x0, y0, x1, y1 in rects:
        cv2.rectangle(img, (x0, y0), (x1, y1), (245, 245, 245), -1)
        cv2.putText(img, "ID", (x0 + 10, y0 + 40), cv2.FONT_HERSHEY_SIMPLEX, 1, (30, 30, 30), 2)
    return img


def test_corners_from_heatmaps():
    pts, conf = docfind.corners(heatmaps([(0.2, 0.25), (0.8, 0.25), (0.8, 0.75), (0.2, 0.75)])[0])
    assert conf > 0.8
    assert np.abs(pts - [[0.2, 0.25], [0.8, 0.25], [0.8, 0.75], [0.2, 0.75]]).max() < 0.01


def test_a_missing_corner_gives_none():
    hm = heatmaps([(0.2, 0.25), (0.8, 0.25), (0.8, 0.75), (0.2, 0.75)])[0]
    hm[2] = 0.1
    pts, conf = docfind.corners(hm)
    assert pts is None and conf < 0.3


def test_one_document_is_cut_flat():
    pages = docfind.find_documents(photo((200, 150, 600, 400)), Model())
    assert len(pages) == 1 and pages[0]["source"] == "model"
    h, w = pages[0]["image"].shape[:2]
    assert abs(w - 400) < 12 and abs(h - 250) < 12
    assert pages[0]["turn"] == -1  # no face finder given


def test_two_documents_on_one_photo():
    pages = docfind.find_documents(photo((60, 100, 360, 300), (440, 260, 760, 480)), Model())
    assert [p["source"] for p in pages] == ["model", "more"]
    assert docfind.quad_iou(np.array(pages[0]["quad"]), np.array(pages[1]["quad"])) == 0


def test_the_phone_corners_when_the_model_is_not_sure():
    hint = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]
    pages = docfind.find_documents(photo((200, 150, 600, 400)), Model(sure=False), hint=hint)
    assert len(pages) == 1 and pages[0]["source"] == "phone" and pages[0]["quad"] == hint


def test_nothing_found_keeps_the_whole_picture():
    pages = docfind.find_documents(photo(), Model(sure=False))
    assert len(pages) == 1 and pages[0]["source"] == "whole" and pages[0]["image"].shape[:2] == (600, 800)


def test_the_accurate_model_first_then_the_light_one():
    sure, unsure = Model(), Model(sure=False)
    pages = docfind.find_documents(photo((200, 150, 600, 400)), [unsure, sure])
    assert unsure.calls >= 1 and sure.calls == 1 and pages[0]["source"] == "model"


def test_photos_on_a_white_page_and_not_the_dark_bar():
    page = np.full((1600, 800, 3), 255, np.uint8)
    page[200:600, 100:700] = (90, 120, 150)     # a photo
    page[800:1250, 60:740] = (60, 140, 90)      # another photo
    page[1400:1600, :] = (20, 20, 20)           # a screenshot's bottom bar
    boxes = docfind.photos_on_page(page)
    assert len(boxes) == 2
    assert abs(boxes[0][1] - 200) < 10 and abs(boxes[1][3] - 1250) < 10


def test_a_plain_photo_is_not_split():
    assert docfind.photos_on_page(photo((200, 150, 600, 400))) == []


def test_turns_are_clockwise_quarter_turns():
    img = np.zeros((10, 20, 3), np.uint8)
    img[0, 0] = 255
    one = docfind.turned(img, 1)
    assert one.shape[:2] == (20, 10) and one[0, -1].max() == 255


def test_a_cut_takes_the_documents_exact_proportion_when_close():
    # a card foreshortened to 400 × 240 (1.67) → ID-1 (1.585); a passport page → ID-3; A4 → A4
    assert docfind.exact_size(400, 240) == (400, 252)
    assert docfind.exact_size(240, 400) == (252, 400)
    assert docfind.exact_size(710, 480) == (710, 500)
    assert docfind.exact_size(1000, 1400) == (990, 1400)
    # far from every document's proportion (a 4:3 photo, a square): kept as measured
    assert docfind.exact_size(800, 600) == (800, 600)
    assert docfind.exact_size(500, 500) == (500, 500)


def test_a_whole_picture_keeps_its_own_size():
    img = np.zeros((300, 470, 3), np.uint8)  # 1.567, close to ID-1, but kept whole
    full = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], np.float64)
    assert docfind.warp(img, full, exact=False).shape[:2] == (300, 470)
    assert docfind.warp(img, full).shape[:2] == (296, 470)


class KindModel:
    """A stand-in page-kind model: answers the given kind and turn probabilities."""
    def __init__(self, kind, turn):
        self.kind, self.turn, self.seen = np.array([kind], np.float32), np.array([turn], np.float32), None

    def get_inputs(self):
        return [Named("img")]

    def get_outputs(self):
        return [Named("kind"), Named("turn")]

    def run(self, _, feeds):
        self.seen = feeds["img"].shape
        return [self.kind, self.turn]


def test_no_kind_model_changes_nothing():
    page = np.zeros((10, 20, 3), np.uint8)
    assert docfind.with_kind(None, page, -1) == (page, -1, {})


def test_a_sure_kind_model_names_the_page_and_turns_one_with_no_face():
    page = np.zeros((10, 20, 3), np.uint8)
    m = KindModel([0.01, 0.01, 0.95, 0.01, 0.01, 0.01], [0.02, 0.96, 0.01, 0.01])  # a ספח that needs 90°
    out, turn, kd = docfind.with_kind(m, page, -1)
    assert m.seen == (1, 3, 256, 256)
    assert kd["kind"] == "sefach" and kd["kindSure"] and turn == 1 and out.shape[:2] == (20, 10) and kd["kindTurn"] == 0
    # a face already set it upright: its turn stays
    out, turn, kd = docfind.with_kind(m, page, 0)
    assert turn == 0 and out.shape[:2] == (10, 20) and kd["kindTurn"] == 90 and kd["kindSure"]


def test_an_unsure_kind_model_leaves_the_page_to_haiku():
    page = np.zeros((10, 20, 3), np.uint8)
    m = KindModel([0.5, 0.4, 0.02, 0.02, 0.03, 0.03], [0.5, 0.5, 0, 0])
    out, turn, kd = docfind.with_kind(m, page, -1)
    assert not kd["kindSure"] and turn == -1 and out is page


def test_find_documents_passes_the_kind_on():
    m = KindModel([0.97, 0.01, 0.01, 0.0, 0.0, 0.01], [0.99, 0.01, 0, 0])
    pages = docfind.find_documents(photo((200, 150, 600, 400)), Model(), kind=m)
    assert pages[0]["kind"] == "id_front" and pages[0]["kindSure"] and pages[0]["turn"] == 0
