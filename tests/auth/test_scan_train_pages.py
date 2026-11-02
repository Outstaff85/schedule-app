"""The white-page split's solid blocks (scripts/scan-train/docfind.py solid_blocks; the phone's copy is
src/scan/engine/pictures.ts solidBlocks, checked by tests/scan/engine.test.mjs): two sides of an ID card scanned
at their real size on an A4 page (41 % of its width, under the bands' 45 %) are two photos; side by side, two; a
form's framed tables (white inside) and a card as pale as the paper are none (owner, 2026-11-02)."""
import importlib.util
import pathlib
import sys

import cv2
import numpy as np

HERE = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "scan-train"
sys.path.insert(0, str(HERE))
_spec = importlib.util.spec_from_file_location("docfind", HERE / "docfind.py")
docfind = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(docfind)

W, H = 2480, 3508   # A4 at 300 dpi
CW, CH = round(85.6 / 210 * W), round(54 / 297 * H)


def page(boxes, frames=()):
    rng = np.random.default_rng(5)
    img = np.full((H, W, 3), 250, np.int16) + rng.integers(-6, 7, (H, W, 3))
    for x, y, c in boxes:
        img[y:y + CH, x:x + CW] = c
    for x0, y0, x1, y1 in frames:   # a framed table: a 6 px line, white inside
        for ys, xs in ((slice(y0, y0 + 6), slice(x0, x1)), (slice(y1 - 6, y1), slice(x0, x1)), (slice(y0, y1), slice(x0, x0 + 6)), (slice(y0, y1), slice(x1 - 6, x1))):
            img[ys, xs] = 30
    return img.clip(0, 255).astype(np.uint8)


def boxes_of(img):
    return docfind.photos_on_page(img)


def near(box, x, y):
    return abs(box[0] - x) < 0.02 * W and abs(box[1] - y) < 0.02 * H and abs(box[2] - x - CW) < 0.02 * W and abs(box[3] - y - CH) < 0.02 * H


def test_two_sides_one_above_the_other():
    got = boxes_of(page([(740, 500, (170, 140, 120)), (740, 1400, (120, 130, 150))]))
    assert len(got) == 2 and near(got[0], 740, 500) and near(got[1], 740, 1400), got


def test_two_sides_side_by_side():
    got = boxes_of(page([(150, 500, (170, 140, 120)), (1290, 500, (120, 130, 150))]))
    assert len(got) == 2 and near(got[0], 150, 500) and near(got[1], 1290, 500), got


def test_framed_tables_and_a_pale_card_are_no_photos():
    small = lambda img: cv2.resize(img, (round(W * 300 / H), 300), interpolation=cv2.INTER_AREA)
    assert docfind.solid_blocks(small(page([], [(120, 350, 2360, 1400), (120, 1580, 2360, 3150)]))) == []
    assert docfind.solid_blocks(small(page([(740, 500, (246, 246, 246))]))) == []
