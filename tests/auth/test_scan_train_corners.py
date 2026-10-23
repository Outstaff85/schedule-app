"""The 4 corners picked together from the heatmaps (scripts/scan-train/docfind.py corners; the phone's copy is
scan-lab/scan-core.js corners, checked on the same maps by tests/scan/corners.test.mjs): with two documents
on a picture the highest spot of one heatmap may lie on the other document — the frame is then taken from
the spots that make one document (the owner's ID card below its ספח, 2026-10-22); one spot each, as before."""
import importlib.util
import pathlib
import sys

import numpy as np

HERE = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "scan-train"
sys.path.insert(0, str(HERE))
_spec = importlib.util.spec_from_file_location("docfind", HERE / "docfind.py")
docfind = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(docfind)

H, SIGMA = 128, 2.4
# the accurate model's spots on the owner's picture: (x, y, height) for each corner's heatmap
TWO_DOCS = [[(0.07, 0.29, 0.70), (0.21, 0.59, 0.63)],   # top-left: the ספח's corner highest, the card's second
            [(0.80, 0.58, 0.89)], [(0.80, 0.78, 0.80)], [(0.21, 0.75, 0.77), (0.04, 0.84, 0.48)]]
# the owner's ספח with its ID card above it (2026-10-23): the card's top-right spot a little higher than the ספח's
CARD_ABOVE = [[(0.04, 0.44, 0.94), (0.29, 0.18, 0.88)], [(0.78, 0.17, 0.92), (0.98, 0.43, 0.91)],
              [(0.99, 0.96, 0.81)], [(0.03, 0.98, 0.64)]]
ONE_DOC = [[(0.10, 0.12, 0.9)], [(0.90, 0.15, 0.8)], [(0.88, 0.85, 0.85)], [(0.12, 0.88, 0.9)]]


def maps(spots):
    ys, xs = np.mgrid[0:H, 0:H].astype(np.float32)
    hm = np.zeros((4, H, H), np.float32)
    for k, spot in enumerate(spots):
        for x, y, a in spot:
            hm[k] = np.maximum(hm[k], a * np.exp(-((xs - (x * H - 0.5)) ** 2 + (ys - (y * H - 0.5)) ** 2) / (2 * SIGMA ** 2)))
    return hm


def test_two_documents_one_frame():
    pts, conf = docfind.corners(maps(TWO_DOCS))
    assert np.allclose(pts, [[0.21, 0.59], [0.80, 0.58], [0.80, 0.78], [0.21, 0.75]], atol=0.01)   # the card, whole
    assert abs(conf - 0.63) < 0.03


def test_a_card_above_its_sheet_not_mixed():
    pts, _ = docfind.corners(maps(CARD_ABOVE))
    assert np.allclose(pts, [[0.04, 0.44], [0.98, 0.43], [0.99, 0.96], [0.03, 0.98]], atol=0.01)   # the ספח, its sides parallel


def test_one_document_as_before():
    pts, conf = docfind.corners(maps(ONE_DOC))
    assert np.allclose(pts, [[x, y] for (x, y, _), in ONE_DOC], atol=0.01)
    assert abs(conf - 0.8) < 0.03   # the spot falls between the map's cells


def test_a_corner_missing():
    hm = maps(ONE_DOC)
    hm[2] *= 0.2
    pts, conf = docfind.corners(hm)
    assert pts is None and conf < 0.3
