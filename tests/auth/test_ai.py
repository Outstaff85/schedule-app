"""Tests for functions-auth/ai.py (the ai_read function).

Every request ai.py sends to Anthropic, and every result it returns for a
given Anthropic reply, must equal ai_golden.json: the requests and results of
the original Apps Script AI actions, recorded from apps-script/Kod.js (run in
Node) before Apps Script was removed. The prompts live in ai_prompts.json.
"""

import json
import os
import sys

import pytest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "..", "functions-auth"))

import ai  # noqa: E402

MODEL, ALIGN = "claude-sonnet-5", "claude-haiku-4-5-20251001"
with open(os.path.join(HERE, "ai_golden.json"), encoding="utf-8") as f:
    GOLDEN = json.load(f)


@pytest.fixture(autouse=True)
def no_pause(monkeypatch):
    monkeypatch.setattr(ai, "_sleep", lambda s: None)


def apps_script(action, body, reply='{"content":[{"type":"text","text":"{}"}]}', status=200):
    """The recorded Apps Script request and result for this case."""
    return GOLDEN[json.dumps([action, body, reply, status], ensure_ascii=False, sort_keys=True)]


def python(action, body, reply='{"content":[{"type":"text","text":"{}"}]}', status=200):
    sent = []

    def post(url, payload, headers):
        sent.append({"url": url, "payload": payload, "headers": headers})
        return status, reply
    result = ai.run(action, body, "KEY", post, MODEL, ALIGN)
    return {"request": sent[0] if sent else None, "result": result}


def test_prompts_file_has_every_prompt():
    for k in ("readDoc", "readSefach", "detectAlign", "verifyField", "readHoursTable", "verifyFieldsHead", "verifyFieldsKind"):
        assert k in ai.PROMPTS


REQUESTS = [
    ("aiReadDoc", {"image": "AAA", "mediaType": "image/png"}),
    ("aiReadDoc", {"image": "AAA"}),
    ("aiReadSefach", {"image": "BBB", "mediaType": "image/jpeg"}),
    ("aiDetectAlign", {"image": "CCC"}),
    ("aiReadHoursTable", {"image": "DDD", "mediaType": "image/webp"}),
    ("aiVerifyField", {"image": "E", "kind": "digits9"}),
    ("aiVerifyField", {"image": "E", "kind": "date"}),
    ("aiVerifyField", {"image": "E", "kind": "passportNo"}),
    ("aiVerifyField", {"image": "E", "kind": "weird"}),
    ("aiVerifyField", {"image": "E"}),
    ("aiVerifyFields", {"jobs": [{"field": "idNo", "kind": "digits9", "image": "1"},
                                 {"field": "dob", "kind": "date", "image": "2", "mediaType": "image/png"},
                                 {"field": "x", "kind": "odd", "image": "3"}]}),
    ("aiVerifyFields", {"jobs": [{"field": "passportNo", "kind": "passportNo", "image": "9"}]}),
]


@pytest.mark.parametrize("action,body", REQUESTS)
def test_same_request(action, body):
    a, p = apps_script(action, body), python(action, body)
    assert p["request"]["url"] == a["request"]["url"]
    assert p["request"]["payload"] == a["request"]["payload"]
    assert p["request"]["headers"] == a["request"]["headers"]
    assert p["result"] == a["result"]


@pytest.mark.parametrize("action,body", [("aiReadDoc", {}), ("aiReadSefach", {"image": ""}), ("aiDetectAlign", {}),
                                         ("aiVerifyField", {"kind": "date"}), ("aiReadHoursTable", {}),
                                         ("aiVerifyFields", {"jobs": []}), ("aiVerifyFields", {})])
def test_same_result_without_input(action, body):
    a, p = apps_script(action, body), python(action, body)
    assert a["request"] is None and p["request"] is None
    assert p["result"] == a["result"]


def reply(text, **extra):
    return json.dumps(dict({"content": [{"type": "text", "text": text}]}, **extra), ensure_ascii=False)


REPLIES = [
    reply('{"type":"israeli_id","idNo":"012345678","children":[]}'),
    reply('```json\n{"type":"passport","passportNo":"X1"}\n```'),
    reply('Here you go: {"a":{"b":1}} thanks'),
    reply('{"type":"israeli_id","surname":"כה', stop_reason="max_tokens"),
    reply("not json at all"),
    reply(""),
    json.dumps({"error": {"type": "overloaded_error", "message": "Overloaded"}}),
    json.dumps({"error": {"type": "x"}}),
    "<html>502 Bad Gateway</html>",
    json.dumps({"content": [{"type": "text", "text": '{"x":'}, {"type": "text", "text": "1}"}, {"type": "tool_use"}]}),
]
VERIFY_REPLIES = [reply("012345678"), reply("  05/04/1995 \n"), reply('```json\n{"idNo":"012345678","dob":"05/04/1995"}\n```'),
                  reply('{"idNo":"1"}'), reply('["a"]'), reply("null"), reply("garbage")]
HOURS_REPLIES = [reply('{"entries":[{"date":"01/09/2026","inTime":"08:00","outTime":""}]}'), reply('{"entries":"x"}'),
                 reply("{}"), reply("bad")]


@pytest.mark.parametrize("action", ["aiReadDoc", "aiReadSefach", "aiDetectAlign"])
@pytest.mark.parametrize("raw", REPLIES)
def test_same_result_for_replies(action, raw):
    status = 502 if raw.startswith("<html") else 200
    assert python(action, {"image": "I"}, raw, status)["result"] == apps_script(action, {"image": "I"}, raw, status)["result"]


@pytest.mark.parametrize("raw", VERIFY_REPLIES + REPLIES[6:9])
def test_same_result_for_verify_replies(raw):
    status = 502 if raw.startswith("<html") else 200
    for action, body in (("aiVerifyField", {"image": "I", "kind": "date"}),
                         ("aiVerifyFields", {"jobs": [{"field": "idNo", "kind": "digits9", "image": "I"}]})):
        assert python(action, body, raw, status)["result"] == apps_script(action, body, raw, status)["result"]


@pytest.mark.parametrize("raw", HOURS_REPLIES + REPLIES[6:9])
def test_same_result_for_hours_replies(raw):
    status = 502 if raw.startswith("<html") else 200
    assert python("aiReadHoursTable", {"image": "I"}, raw, status)["result"] == apps_script("aiReadHoursTable", {"image": "I"}, raw, status)["result"]


def test_models_and_errors(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_MODEL", "claude-x")
    monkeypatch.setenv("ANTHROPIC_ALIGN_MODEL", "claude-y")
    sent = []
    ai.run("aiReadDoc", {"image": "I"}, "K", lambda u, p, h: (sent.append(p), (200, reply("{}")))[1])
    ai.run("aiDetectAlign", {"image": "I"}, "K", lambda u, p, h: (sent.append(p), (200, reply("{}")))[1])
    assert [p["model"] for p in sent] == ["claude-x", "claude-y"]
    assert ai.run("aiReadDoc", {"image": "I"}, "", None)["error"] == "ANTHROPIC_API_KEY is not set"
    assert ai.run("nope", {}, "K", None)["error"] == "Unknown action"

    def boom(*a):
        raise OSError("down")
    assert ai.run("aiReadDoc", {"image": "I"}, "K", boom)["error"] == "The request to Anthropic failed: down"


def test_http_ai_read(monkeypatch):
    import main
    from test_core import _call, _clear
    from test_portal import _id_token
    _clear()
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    sent = []
    monkeypatch.setattr(main, "_anthropic_post", lambda u, p, h: (sent.append((p, h)), (200, reply('{"type":"passport"}')))[1])
    assert _call(main.ai_read, {"ping": True})[1]["warm"]
    assert _call(main.ai_read, {"action": "aiReadDoc", "image": "I"})[0] == 401
    sup = _id_token("u-s", {"role": "supplier", "tenantId": "t", "supplierId": "s"})
    assert "supplier" in _call(main.ai_read, {"action": "aiReadDoc", "image": "I"}, {"Authorization": "Bearer " + sup})[1]["error"]
    staff = _id_token("u-st", {"role": "staff", "tenantId": "t", "perms": ["workers"]})
    status, r = _call(main.ai_read, {"action": "aiReadDoc", "image": "I", "token": "gs"}, {"Authorization": "Bearer " + staff})
    meta = r.pop("_meta")
    assert status == 200 and r == {"ok": True, "parsed": {"type": "passport"}}
    assert meta["tries"] == 1 and meta["waitMs"] == 0
    assert sent[0][1]["x-api-key"] == "sk-test" and sent[0][0]["messages"][0]["content"][1]["source"]["data"] == "I"


def _replies(*answers):
    """post() that answers in turn; an Exception instance is raised."""
    sent = []

    def post(url, payload, headers):
        a = answers[len(sent)]
        sent.append(payload)
        if isinstance(a, Exception):
            raise a
        return a
    return post, sent


GOOD = (200, '{"content":[{"type":"text","text":"{\\"kind\\":\\"sefach\\"}"}]}')


@pytest.mark.parametrize("busy", [(429, "{}"), (502, "<html>502</html>"), (529, "{}"),
                                  (200, '{"error":{"type":"overloaded_error","message":"Overloaded"}}'),
                                  ConnectionError("reset")])
def test_busy_reply_is_tried_again(busy):
    post, sent = _replies(busy, GOOD)
    r = ai.run("aiDetectAlign", {"image": "I"}, "KEY", post, MODEL, ALIGN)
    assert r == {"ok": True, "align": {"kind": "sefach"}} and len(sent) == 2


def test_gives_up_after_three_tries():
    post, sent = _replies((529, "{}"), (529, "{}"), (529, "{}"), GOOD)
    r = ai.run("aiReadSefach", {"image": "I"}, "KEY", post, MODEL, ALIGN)
    assert "error" in r and len(sent) == 3


def test_real_error_is_not_tried_again():
    post, sent = _replies((400, '{"error":{"type":"invalid_request_error","message":"bad"}}'), GOOD)
    assert ai.run("aiReadDoc", {"image": "I"}, "KEY", post, MODEL, ALIGN) == {"error": "bad"} and len(sent) == 1


def _find(body, reply='{"content":[{"type":"text","text":"{\\"value\\":\\"חיפה\\",\\"page\\":1,\\"box\\":{\\"x0\\":0.1,\\"y0\\":0.2,\\"x1\\":0.3,\\"y1\\":0.25}}"}]}'):
    sent = []

    def post(url, payload, headers):
        sent.append(payload)
        return 200, reply
    return ai.run("aiFindField", body, "KEY", post, MODEL, ALIGN), sent


def test_find_field_request_and_result():
    r, sent = _find({"field": "city", "docType": "israeli_id",
                     "images": [{"image": "F"}, {"image": "S", "mediaType": "image/png"}]})
    assert r == {"ok": True, "found": {"value": "חיפה", "page": 1, "box": {"x0": 0.1, "y0": 0.2, "x1": 0.3, "y1": 0.25}}}
    p = sent[0]
    assert p["model"] == MODEL and p["max_tokens"] == 300
    text = p["messages"][0]["content"][0]["text"]
    assert "ישוב" in text and "2 photo(s)" in text and "ספח appendix" in text and "{" in text
    imgs = [c for c in p["messages"][0]["content"] if c["type"] == "image"]
    assert [i["source"]["data"] for i in imgs] == ["F", "S"] and imgs[1]["source"]["media_type"] == "image/png"


def test_find_field_passport_label_and_page_cap():
    r, sent = _find({"field": "docId", "docType": "passport", "images": [{"image": str(i)} for i in range(6)]})
    text = sent[0]["messages"][0]["content"][0]["text"]
    assert "passport number" in text and "מספר זהות" not in text
    assert len([c for c in sent[0]["messages"][0]["content"] if c["type"] == "image"]) == ai.FIND_MAX_PAGES


def test_find_field_refusals_and_not_found():
    assert _find({"field": "salary", "images": [{"image": "F"}]})[0] == {"error": "Unknown field"}
    assert _find({"field": "city", "images": []})[0] == {"error": ai.E_NO_IMAGE}
    r, _ = _find({"field": "city", "images": [{"image": "F"}]}, '{"content":[{"type":"text","text":"{\\"value\\":\\"\\"}"}]}')
    assert r == {"ok": True, "found": {"value": "", "page": None, "box": None}}


def test_text_kinds_for_zoomed_reads():
    sent = []

    def post(url, payload, headers):
        sent.append(payload)
        return 200, '{"content":[{"type":"text","text":"{\\"city\\":\\"חיפה\\"}"}]}'
    r = ai.run("aiVerifyFields", {"jobs": [{"field": "city", "kind": "hebrewText", "image": "1"},
                                           {"field": "given", "kind": "latinName", "image": "2"},
                                           {"field": "houseNumber", "kind": "houseNumber", "image": "3"}]}, "KEY", post, MODEL, ALIGN)
    assert r == {"ok": True, "values": {"city": "חיפה"}}
    texts = [c["text"] for c in sent[0]["messages"][0]["content"] if c["type"] == "text"]
    assert ai.PROMPTS["verifyFieldsKind"]["hebrewText"] in texts[1]
    assert ai.PROMPTS["verifyFieldsKind"]["latinName"] in texts[2]
    assert ai.PROMPTS["verifyFieldsKind"]["houseNumber"] in texts[3]
    for kind in ("hebrewText", "latinName", "houseNumber"):
        sent.clear()
        ai.run("aiVerifyField", {"image": "E", "kind": kind}, "KEY", post, MODEL, ALIGN)
        assert sent[0]["messages"][0]["content"][0]["text"] == ai.PROMPTS["verifyField"][kind]


def test_reads_ask_for_boxes_of_every_field():
    assert "given, surname, address, houseNumber, city" in ai.PROMPTS["readDoc"]
    assert "address, houseNumber, city that you found a value for" in ai.PROMPTS["readSefach"]


def test_reads_return_name_cross_checks():
    # The scan picks the holder's name by comparing readings (scan-pipeline.js
    # _resolveScanNames): the ספח / card back's own copy, the Latin spelling
    # and the MRZ name line.
    assert '"surname":"holder\'s surname, or empty","given":"holder\'s given name, or empty"' in ai.PROMPTS["readSefach"]
    for key in ('"latinSurname"', '"latinGiven"', '"mrzName"'):
        assert key in ai.PROMPTS["readDoc"]


def test_find_several_fields_in_one_request():
    reply = '{"content":[{"type":"text","text":"{\\"fields\\":{\\"city\\":{\\"value\\":\\"חיפה\\",\\"page\\":1},\\"address\\":{\\"value\\":\\"\\"}}}"}]}'
    r, sent = _find({"fields": ["city", "address"], "images": [{"image": "F"}, {"image": "S"}]}, reply)
    assert r == {"ok": True, "found": {"city": {"value": "חיפה", "page": 1, "box": None},
                                       "address": {"value": "", "page": None, "box": None}}}
    text = sent[0]["messages"][0]["content"][0]["text"]
    assert len(sent) == 1 and '"city": ישוב' in text and '"address": רחוב' in text and sent[0]["max_tokens"] == 450
    assert _find({"fields": ["city", "salary"], "images": [{"image": "F"}]})[0] == {"error": "Unknown field"}


def test_truncated_read_keeps_the_complete_fields():
    # A ספח answer cut at max_tokens in the middle of the children: the
    # address and the children that came in full are kept.
    text = '{"idNo":"000000018","address":"הרצל","city":"חיפה","children":[{"name":"נועה כהן","idNo":"000000026","dob":"01/01/2015"},{"name":"דני כ'
    reply = json.dumps({"content": [{"type": "text", "text": text}], "stop_reason": "max_tokens"})
    r = python("aiReadSefach", {"image": "I"}, reply)["result"]
    assert r["ok"] and r["truncated"]
    assert r["parsed"]["address"] == "הרצל" and r["parsed"]["city"] == "חיפה" and r["parsed"]["type"] == "israeli_id"
    assert [c["name"] for c in r["parsed"]["children"]] == ["נועה כהן"]
    # Not truncated and not JSON: still an error.
    bad = json.dumps({"content": [{"type": "text", "text": "not json"}]})
    assert "error" in python("aiReadSefach", {"image": "I"}, bad)["result"]


def test_sefach_part_asks_for_half_the_answer_with_the_same_cached_prompt():
    # The app reads a ספח in two parallel halves; both send the full prompt
    # (one cache entry) and differ only in the closing instruction.
    full = python("aiReadSefach", {"image": "I"})["request"]["payload"]
    holder = python("aiReadSefach", {"image": "I", "part": "holder"})["request"]["payload"]
    family = python("aiReadSefach", {"image": "I", "part": "family"})["request"]["payload"]
    for p in (holder, family):
        assert p["messages"][0]["content"][:2] == full["messages"][0]["content"][:2]
    assert "spouse, children" in family["messages"][0]["content"][2]["text"]
    assert "address, houseNumber, city" in holder["messages"][0]["content"][2]["text"]
    # An unknown part is a full read.
    odd = python("aiReadSefach", {"image": "I", "part": "x"})["request"]["payload"]
    assert odd == full


def test_meta_reports_tries_pauses_and_tokens(monkeypatch):
    monkeypatch.setattr(ai, "_sleep", lambda s: None)
    replies = iter([(529, '{"error":{"type":"overloaded_error"}}'),
                    (200, '{"content":[{"type":"text","text":"{}"}],"stop_reason":"end_turn",'
                          '"usage":{"input_tokens":120,"output_tokens":45,"cache_read_input_tokens":2900}}')])
    meta = {}
    r = ai.run("aiReadSefach", {"image": "I"}, "KEY", lambda u, p, h: next(replies), MODEL, ALIGN, meta=meta)
    assert r["ok"]
    assert meta["tries"] == 2 and meta["waitMs"] == 1500 and isinstance(meta["apiMs"], int)
    assert meta["outTok"] == 45 and meta["inTok"] == 120 and meta["cacheReadTok"] == 2900 and meta["stop"] == "end_turn"


def test_passport_expiry_comes_from_the_mrz_when_its_check_digit_is_right():
    # ICAO 9303 specimen line 2: expiry 120415, check digit 9.
    line2 = "L898902C36UTO7408122F1204159ZE184226B<<<<<10"
    doc = {"type": "passport", "expiry": "15/04/2002", "mrzLine2": line2,
           "fieldBoxes": {"expiry": {"x0": 0, "y0": 0, "x1": 1, "y1": 1}, "dob": {"x0": 0, "y0": 0, "x1": 1, "y1": 1}}}
    raw = json.dumps({"content": [{"type": "text", "text": json.dumps(doc)}]})
    out = ai.parse_reply("aiReadDoc", 200, raw)["parsed"]
    assert out["expiry"] == "15/04/2012" and out["expiryFromMrz"] is True
    assert "expiry" not in out["fieldBoxes"] and "dob" in out["fieldBoxes"]
    # a wrong check digit, a short line or no MRZ (an Israeli ID card) leave the read as it is
    for bad in (line2[:27] + "8" + line2[28:], line2[:20], ""):
        doc2 = dict(doc, mrzLine2=bad, fieldBoxes={"expiry": {}})
        raw2 = json.dumps({"content": [{"type": "text", "text": json.dumps(doc2)}]})
        out2 = ai.parse_reply("aiReadDoc", 200, raw2)["parsed"]
        assert out2["expiry"] == "15/04/2002" and "expiryFromMrz" not in out2 and "expiry" in out2["fieldBoxes"]
    # the ספח read is never touched
    raw3 = json.dumps({"content": [{"type": "text", "text": json.dumps(dict(doc, type="israeli_id"))}]})
    assert ai.parse_reply("aiReadSefach", 200, raw3)["parsed"]["expiry"] == "15/04/2002"


def test_read_doc_asks_for_mrz_line_2():
    assert '"mrzLine2"' in ai.PROMPTS["readDoc"]


def _read(doc, action="aiReadDoc"):
    raw = json.dumps({"content": [{"type": "text", "text": json.dumps(doc)}]})
    return ai.parse_reply(action, 200, raw)["parsed"]


def test_issue_and_expiry_dates_swapped_back_when_reversed():
    out = _read({"type": "israeli_id", "expiry": "01/03/2018", "issueDate": "01/03/2028", "fieldBoxes": {"expiry": {}}})
    assert out["expiry"] == "01/03/2028" and out["issueDate"] == "01/03/2018" and out["datesSwapped"] is True
    assert "expiry" not in out["fieldBoxes"] and "__uncertain" not in out


def test_expiry_too_close_to_the_issue_date_is_marked_for_checking():
    out = _read({"type": "israeli_id", "expiry": "05/06/2024", "issueDate": "01/03/2024", "__uncertain": ["dob"]})
    assert out["expiry"] == "05/06/2024" and out["__uncertain"] == ["dob", "expiry"]
    ok = _read({"type": "passport", "expiry": "01/03/2034", "issueDate": "01/03/2024"})
    assert "__uncertain" not in ok and "datesSwapped" not in ok
    # no issue date, an unreadable date, or an expiry from the MRZ: left alone
    for doc in ({"expiry": "01/03/2024"}, {"expiry": "1 MAR 2024", "issueDate": "01/03/2030"}):
        assert _read(doc) == doc
    mrz = _read({"type": "passport", "expiry": "x", "issueDate": "01/01/2030",
                 "mrzLine2": "L898902C36UTO7408122F1204159ZE184226B<<<<<10"})
    assert mrz["expiry"] == "15/04/2012" and "datesSwapped" not in mrz and "__uncertain" not in mrz
