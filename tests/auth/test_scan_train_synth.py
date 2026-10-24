"""Made-up lines for the scanner's text readers (scripts/scan-train/synth.py, docs/hf-plan.md → H8b, H8c):
every passport zone has the ICAO layout and right check digits, every ID number a right check digit,
and the same seed gives the same lines."""
import importlib.util
import pathlib
import random
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "scripts" / "scan-train"))   # synth.py reads gen.common
_spec = importlib.util.spec_from_file_location("synth", pathlib.Path(__file__).resolve().parents[2] / "scripts" / "scan-train" / "synth.py")
synth = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(synth)


def test_the_check_digit_is_icaos():
    # ICAO 9303 part 3's own example
    assert synth.mrz_check("L898902C3") == 6 and synth.mrz_check("740812") == 2 and synth.mrz_check("120415") == 9


def test_every_made_up_passport_zone_is_valid():
    rng = random.Random(7)
    for _ in range(2000):
        l1, l2, f = synth.td3(rng)
        assert len(l1) == len(l2) == 44 and set(l1 + l2) <= set(synth.MRZ_CHARS)
        assert l1[0] == "P" and "<<" in l1
        assert int(l2[9]) == synth.mrz_check(l2[0:9])
        assert int(l2[19]) == synth.mrz_check(l2[13:19]) and int(l2[27]) == synth.mrz_check(l2[21:27])
        assert l2[42] == "<" and l2[28:42] == "<" * 14 or int(l2[42]) == synth.mrz_check(l2[28:42])
        assert int(l2[43]) == synth.mrz_check(l2[0:10] + l2[13:20] + l2[21:43])
        assert l2[20] in "MF<" and f["passportNo"] == l2[0:9].rstrip("<")
        assert re.fullmatch(r"\d\d/\d\d/(19|20)\d\d", f["dob"]) and f["dob"][-2:] == l2[13:15]


def test_every_made_up_id_number_has_a_right_check_digit():
    rng = random.Random(3)
    ids = [synth.israeli_id(rng) for _ in range(500)]
    assert all(synth.valid_israeli_id(i) for i in ids)
    assert not synth.valid_israeli_id("123456789") and synth.valid_israeli_id("123456782")


def test_the_hebrew_lines_are_hebrew_digits_and_dates():
    out = synth.lines("he", 400, seed=5)
    kinds = {k["kind"] for _, k in out}
    assert kinds == {"given", "surname", "idNo", "date", "street", "city"}
    for t, k in out:
        if k["kind"] in ("given", "surname", "city"):
            assert re.search(r"[א-ת]", t)
        if k["kind"] == "idNo":
            assert synth.valid_israeli_id(t.replace(" ", ""))


def test_the_same_seed_draws_the_same_lines():
    assert synth.lines("mrz", 50, seed=2) == synth.lines("mrz", 50, seed=2) != synth.lines("mrz", 50, seed=3)
    mrz = synth.lines("mrz", 10, seed=1)
    assert [i["line"] for _, i in mrz] == [1, 2] * 5


def test_the_corners_are_ordered_as_the_model_gives_them():
    # top-left of the photo first, then clockwise on the screen, whatever order they come in
    sq = [[0.2, 0.1], [0.8, 0.15], [0.75, 0.9], [0.25, 0.85]]
    for k in range(4):
        assert synth.order_corners(sq[k:] + sq[:k]) == sq
        assert synth.order_corners(list(reversed(sq[k:] + sq[:k]))) == sq


def test_a_made_up_document_lies_inside_the_photo_and_is_convex():
    rng = random.Random(5)
    for _ in range(500):
        W, H = rng.choice(((960, 1280), (1280, 960), (720, 1280)))
        q = synth.scene_quad(rng, rng.choice((85.6 / 54, 125 / 88, 0.8)), W, H)
        assert q is not None and synth._convex(q)
        assert all(0.01 * W <= x <= 0.99 * W and 0.01 * H <= y <= 0.99 * H for x, y in q)
        assert synth._area(q) >= 0.1 * W * H
    assert synth.scene_quad(random.Random(1), 1.5, 900, 1200) == synth.scene_quad(random.Random(1), 1.5, 900, 1200)


def test_the_same_real_pages_are_kept_apart_for_the_exam(tmp_path):
    # by their content in heldout.json (test_scan_train_split.py: a renamed file moves nothing); a page not listed is not
    p = tmp_path / "id_front" / "own-old_type.jpg"
    p.parent.mkdir()
    p.write_bytes(b"not one of the owner's held-out pages")
    assert not synth.held_out(p) and not synth.held_out(tmp_path / "missing.jpg")


def test_a_card_on_its_sheet_lies_inside_it():
    # two documents in sight (synth_docs.py PAIR_SHARE): the card lies wholly on the sheet, smaller, convex
    rng = random.Random(11)
    placed = 0
    for _ in range(300):
        W, H = rng.choice(((960, 1280), (1280, 960)))
        sheet_aspect = rng.choice((1.42, 0.7, 1.0))
        sheet = synth.scene_quad(rng, sheet_aspect, W, H, fill=(0.3, 0.7))
        card = synth.card_on_sheet(rng, sheet, sheet_aspect, 85.6 / 54)
        if card is None:
            continue
        placed += 1
        assert synth._convex(card) and synth._area(card) < 0.5 * synth._area(sheet)
        for x, y in card:   # every corner of the card inside the sheet
            inside = False
            for i in range(4):
                (x1, y1), (x2, y2) = sheet[i], sheet[(i + 1) % 4]
                if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                    inside = not inside
            assert inside
    assert placed > 250
