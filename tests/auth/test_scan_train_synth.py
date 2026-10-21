"""Made-up lines for the scanner's text readers (scripts/scan-train/synth.py, docs/hf-plan.md → H8b, H8c):
every passport zone has the ICAO layout and right check digits, every ID number a right check digit,
and the same seed gives the same lines."""
import importlib.util
import pathlib
import random
import re

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
