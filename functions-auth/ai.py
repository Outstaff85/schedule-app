"""AI document reading on Cloud Functions (FIRESTORE_PLAN.md stage 7).

A port of the Apps Script actions aiReadDoc, aiReadSefach, aiDetectAlign,
aiVerifyField, aiVerifyFields and aiReadHoursTable (apps-script/Код.js): the
same Anthropic requests, the same reply handling, the same result shapes, so
the app's scan code doesn't change. The prompt texts are not retyped here —
ai_prompts.json is generated from Код.js (tests/auth/apps_script_ai.js), and
tests/auth/test_ai.py checks every request and result against the Apps Script
code itself, so the two can't drift apart.

Calling from a Cloud Function instead of Apps Script saves Apps Script's own
1-3 s per call (and its concurrent-execution limit during a scan burst).
"""

import json
import os
import re
from pathlib import Path

PROMPTS = json.loads(Path(__file__).with_name("ai_prompts.json").read_text(encoding="utf-8"))

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
# Same defaults as the Apps Script Script Properties ANTHROPIC_MODEL /
# ANTHROPIC_ALIGN_MODEL; override with the function's environment variables.
DEFAULT_MODEL = "claude-sonnet-5"
DEFAULT_ALIGN_MODEL = "claude-haiku-4-5-20251001"

ACTIONS = ("aiReadDoc", "aiReadSefach", "aiDetectAlign", "aiVerifyField", "aiVerifyFields", "aiReadHoursTable")

E_NO_IMAGE = "Нет изображения"
E_UNREADABLE = "AI вернул нечитаемый ответ"
E_TRUNCATED = "Ответ ИИ обрезан лимитом max_tokens — увеличьте лимит"


def models():
    return (os.environ.get("ANTHROPIC_MODEL") or DEFAULT_MODEL,
            os.environ.get("ANTHROPIC_ALIGN_MODEL") or DEFAULT_ALIGN_MODEL)


def _image(body):
    return {"type": "image", "source": {"type": "base64", "media_type": body.get("mediaType") or "image/jpeg",
                                        "data": body.get("image")}}


def build_request(action, body, model, align_model):
    """(payload, extra headers) Apps Script would send, or (None, error)."""
    cached = {"anthropic-beta": "prompt-caching-2024-07-31"}
    if action == "aiVerifyFields":
        jobs = body.get("jobs") or []
        if not jobs:
            return None, None
        head = PROMPTS["verifyFieldsHead"]
        content = [{"type": "text", "text": head[0] + str(len(jobs)) + head[1]}]
        kinds = PROMPTS["verifyFieldsKind"]
        for j in jobs:
            content.append({"type": "text", "text": 'Field "' + str(j.get("field")) + '": ' + kinds.get(j.get("kind"), kinds["*"]) + "."})
            content.append(_image(j))
        return {"model": model, "max_tokens": 200, "messages": [{"role": "user", "content": content}]}, {}
    if not body.get("image"):
        return None, E_NO_IMAGE
    if action == "aiReadDoc":
        return {"model": model, "max_tokens": 8000, "messages": [{"role": "user", "content": [
            {"type": "text", "text": PROMPTS["readDoc"], "cache_control": {"type": "ephemeral"}},
            _image(body),
            {"type": "text", "text": "Read this document and return the JSON object only."}]}]}, cached
    if action == "aiReadSefach":
        return {"model": model, "max_tokens": 4500, "messages": [{"role": "user", "content": [
            {"type": "text", "text": PROMPTS["readSefach"], "cache_control": {"type": "ephemeral"}},
            _image(body),
            {"type": "text", "text": "Read this and return the JSON object only."}]}]}, cached
    if action == "aiDetectAlign":
        return {"model": align_model, "max_tokens": 200, "messages": [{"role": "user", "content": [
            {"type": "text", "text": PROMPTS["detectAlign"]}, _image(body),
            {"type": "text", "text": "Return the JSON object only."}]}]}, {}
    if action == "aiVerifyField":
        vf = PROMPTS["verifyField"]
        return {"model": model, "max_tokens": 50, "messages": [{"role": "user", "content": [
            {"type": "text", "text": vf.get(body.get("kind"), vf["*"])}, _image(body)]}]}, {}
    if action == "aiReadHoursTable":
        return {"model": model, "max_tokens": 4000, "messages": [{"role": "user", "content": [
            {"type": "text", "text": PROMPTS["readHoursTable"]}, _image(body),
            {"type": "text", "text": "Return the JSON object only."}]}]}, {}
    return None, "Unknown action"


def _first_object(text):
    """Apps Script: strip ```json fences, then take the first {...} span."""
    text = re.sub(r"```json|```", "", text).strip()
    m = re.search(r"\{[\s\S]*\}", text)
    return json.loads(m.group(0) if m else text), text


def parse_reply(action, status, raw):
    """What Apps Script returns for this Anthropic reply."""
    try:
        reply = json.loads(raw)
    except ValueError:
        return {"error": f"Неверный ответ от Anthropic (HTTP {status})"}
    if reply.get("error"):
        return {"error": (reply["error"] or {}).get("message") or "Ошибка Anthropic"}
    text = "".join(c.get("text", "") for c in (reply.get("content") or []) if c.get("type") == "text")

    if action == "aiVerifyField":
        return {"ok": True, "value": text.strip()}
    if action == "aiVerifyFields":
        try:
            values = json.loads(re.sub(r"```$", "", re.sub(r"^```(?:json)?", "", text.strip())).strip())
        except ValueError:
            return {"ok": True, "values": {}}
        # JS `values && typeof values === 'object'`: any array passes too.
        return {"ok": True, "values": values if isinstance(values, (dict, list)) else {}}
    try:
        parsed, cleaned = _first_object(text)
    except ValueError:
        cleaned = re.sub(r"```json|```", "", text).strip()
        if action in ("aiReadDoc", "aiReadSefach"):
            truncated = reply.get("stop_reason") == "max_tokens"
            return {"error": E_TRUNCATED if truncated else E_UNREADABLE, "raw": cleaned[:400]}
        return {"error": E_UNREADABLE, "raw": cleaned[:300]}
    if action == "aiDetectAlign":
        return {"ok": True, "align": parsed}
    if action == "aiReadHoursTable":
        entries = parsed.get("entries") if isinstance(parsed, dict) else None
        return {"ok": True, "entries": entries if isinstance(entries, list) else []}
    return {"ok": True, "parsed": parsed}


def run(action, body, key, post, model=None, align_model=None):
    """post(url, payload, headers) -> (status, text). Returns the action's result."""
    if action not in ACTIONS:
        return {"error": "Unknown action"}
    if not key:
        return {"error": "ANTHROPIC_API_KEY не задан"}
    m, am = models()
    payload, extra = build_request(action, body, model or m, align_model or am)
    if payload is None:
        return {"ok": True, "values": {}} if action == "aiVerifyFields" and extra is None else {"error": extra}
    headers = dict({"x-api-key": key, "anthropic-version": "2023-06-01"}, **extra)
    try:
        status, raw = post(ANTHROPIC_URL, payload, headers)
    except Exception as e:  # network
        return {"error": "Запрос к Anthropic не прошёл: " + str(e)}
    return parse_reply(action, status, raw)
