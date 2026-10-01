"""Stage 7 tests: functions-auth/ai.py against the real Apps Script AI actions.

Every request ai.py would send to Anthropic, and every result it returns for a
given Anthropic reply, must equal what apps-script/Код.js does (run in Node by
apps_script_ai.js). ai_prompts.json must equal a fresh extraction from Код.js.
"""

import json
import os
import subprocess
import sys
import tempfile

import pytest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "..", "functions-auth"))

import ai  # noqa: E402

TOOL = os.path.join(HERE, "apps_script_ai.js")
MODEL, ALIGN = "claude-sonnet-5", "claude-haiku-4-5-20251001"


def apps_script(action, body, reply='{"content":[{"type":"text","text":"{}"}]}', status=200):
    with tempfile.TemporaryDirectory() as d:
        bf, rf = os.path.join(d, "b.json"), os.path.join(d, "r.json")
        open(bf, "w", encoding="utf-8").write(json.dumps(body, ensure_ascii=False))
        open(rf, "w", encoding="utf-8").write(reply)
        out = subprocess.run(["node", TOOL, "run", action, bf, rf, str(status)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def python(action, body, reply='{"content":[{"type":"text","text":"{}"}]}', status=200):
    sent = []

    def post(url, payload, headers):
        sent.append({"url": url, "payload": payload, "headers": headers})
        return status, reply
    result = ai.run(action, body, "KEY", post, MODEL, ALIGN)
    return {"request": sent[0] if sent else None, "result": result}


def test_prompts_file_matches_apps_script():
    out = subprocess.run(["node", TOOL, "prompts"], capture_output=True, text=True, check=True).stdout
    assert json.loads(out) == ai.PROMPTS, "regenerate: node tests/auth/apps_script_ai.js prompts > functions-auth/ai_prompts.json"


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
    assert ai.run("aiReadDoc", {"image": "I"}, "", None)["error"] == "ANTHROPIC_API_KEY не задан"
    assert ai.run("nope", {}, "K", None)["error"] == "Unknown action"

    def boom(*a):
        raise OSError("down")
    assert ai.run("aiReadDoc", {"image": "I"}, "K", boom)["error"] == "Запрос к Anthropic не прошёл: down"


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
    assert "поставщика" in _call(main.ai_read, {"action": "aiReadDoc", "image": "I"}, {"Authorization": "Bearer " + sup})[1]["error"]
    staff = _id_token("u-st", {"role": "staff", "tenantId": "t", "perms": ["workers"]})
    status, r = _call(main.ai_read, {"action": "aiReadDoc", "image": "I", "token": "gs"}, {"Authorization": "Bearer " + staff})
    assert status == 200 and r == {"ok": True, "parsed": {"type": "passport"}}
    assert sent[0][1]["x-api-key"] == "sk-test" and sent[0][0]["messages"][0]["content"][1]["source"]["data"] == "I"
