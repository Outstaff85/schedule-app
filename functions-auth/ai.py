"""AI document reading (the ai_read function).

The actions aiReadDoc, aiReadSefach, aiDetectAlign, aiVerifyField,
aiVerifyFields, aiReadHoursTable and aiFindField: the Anthropic request for each, and the
reply handling and result shape the app's scan code expects. The prompt
texts are in ai_prompts.json — edit them there. tests/auth/test_ai.py checks
every request and result against ai_golden.json (recorded from the original
Apps Script actions).
"""

import datetime
import json
import os
import re
import time
from pathlib import Path

PROMPTS = json.loads(Path(__file__).with_name("ai_prompts.json").read_text(encoding="utf-8"))

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
# Defaults; override with the function's environment variables ANTHROPIC_MODEL /
# ANTHROPIC_ALIGN_MODEL.
DEFAULT_MODEL = "claude-sonnet-5"
DEFAULT_ALIGN_MODEL = "claude-haiku-4-5-20251001"

ACTIONS = ("aiReadDoc", "aiReadSefach", "aiDetectAlign", "aiVerifyField", "aiVerifyFields", "aiReadHoursTable", "aiFindField")

# aiFindField: at most this many page photos per request.
FIND_MAX_PAGES = 4

E_NO_IMAGE = "No image"
E_UNREADABLE = "The AI returned an unreadable answer"
E_TRUNCATED = "The AI answer was cut at max_tokens — raise the limit"

# A busy Anthropic (HTTP 429 / 5xx / 529, or an overloaded_error reply) or a
# dropped connection is tried again after these pauses (seconds). Scans send
# several reads at once, so a burst can hit a rate limit; one failed align or
# ספח read used to leave the page crooked or its address empty.
RETRY_PAUSES = (1.5, 4)
_sleep = time.sleep


def models():
    return (os.environ.get("ANTHROPIC_MODEL") or DEFAULT_MODEL,
            os.environ.get("ANTHROPIC_ALIGN_MODEL") or DEFAULT_ALIGN_MODEL)


def _image(body):
    return {"type": "image", "source": {"type": "base64", "media_type": body.get("mediaType") or "image/jpeg",
                                        "data": body.get("image")}}


def build_request(action, body, model, align_model):
    """(payload, extra headers) to send to Anthropic, or (None, error)."""
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
        # Up to ~7 fields per scan, Hebrew values included: 400 leaves room.
        return {"model": model, "max_tokens": 400, "messages": [{"role": "user", "content": content}]}, {}
    if action == "aiFindField":
        return _find_field_request(body, model)
    if not body.get("image"):
        return None, E_NO_IMAGE
    if action == "aiReadDoc":
        return {"model": model, "max_tokens": 8000, "messages": [{"role": "user", "content": [
            {"type": "text", "text": PROMPTS["readDoc"], "cache_control": {"type": "ephemeral"}},
            _image(body),
            {"type": "text", "text": "Read this document and return the JSON object only."}]}]}, cached
    if action == "aiReadSefach":
        # A real ספח answer is ~0.5-1.5k tokens; 3000 leaves room for many
        # children and cuts a runaway answer short (a truncated one is
        # salvaged, _salvage_object).
        # "part" (holder / family) asks for half of the answer: the app sends
        # both halves at once, so the answer — what takes the time — is
        # written in two parallel halves. The long prompt is the same, so
        # both requests share its cache.
        part = PROMPTS["readSefachPart"].get(body.get("part")) if body.get("part") else None
        return {"model": model, "max_tokens": 3000, "messages": [{"role": "user", "content": [
            {"type": "text", "text": PROMPTS["readSefach"], "cache_control": {"type": "ephemeral"}},
            _image(body),
            {"type": "text", "text": part or "Read this and return the JSON object only."}]}]}, cached
    if action == "aiDetectAlign":
        return {"model": align_model, "max_tokens": 400, "messages": [{"role": "user", "content": [
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


def _field_spec(key, doc):
    spec = PROMPTS["findFieldFields"].get(str(key or ""))
    if spec and doc == "passport" and isinstance(spec.get("passport"), dict):
        spec = spec["passport"]
    return spec


def _find_field_request(body, model):
    """Fields searched for on the worker's page photos: "field" (one) or
    "fields" (several, one request). The field keys and document type pick
    the labels and hints from ai_prompts.json (never text from the caller)."""
    doc = "passport" if body.get("docType") == "passport" else "israeli_id"
    many = isinstance(body.get("fields"), list)
    keys = [str(k) for k in body.get("fields")] if many else [body.get("field")]
    specs = [(k, _field_spec(k, doc)) for k in keys]
    if not specs or any(not sp for _, sp in specs):
        return None, "Unknown field"
    pages = [p for p in (body.get("images") or []) if isinstance(p, dict) and p.get("image")][:FIND_MAX_PAGES]
    if not pages:
        return None, E_NO_IMAGE
    head = PROMPTS["findFields" if many else "findField"].replace("{N}", str(len(pages))).replace("{DOC}", PROMPTS["findFieldDoc"][doc])
    if many:
        text = head.replace("{LIST}", "\n".join('"' + k + '": ' + sp["label"] + " — " + sp["hint"] for k, sp in specs))
    else:
        text = head.replace("{LABEL}", specs[0][1]["label"]).replace("{HINT}", specs[0][1]["hint"])
    content = [{"type": "text", "text": text}]
    for i, p in enumerate(pages):
        content.append({"type": "text", "text": "Photo " + str(i) + ":"})
        content.append(_image(p))
    content.append({"type": "text", "text": "Return the JSON object only."})
    return {"model": model, "max_tokens": 300 + 150 * (len(specs) - 1), "messages": [{"role": "user", "content": content}]}, {}


def _first_object(text):
    """Strip ```json fences, then take the first {...} span."""
    text = re.sub(r"```json|```", "", text).strip()
    m = re.search(r"\{[\s\S]*\}", text)
    return json.loads(m.group(0) if m else text), text


def _salvage_object(text):
    """A reply cut off by max_tokens: the longest prefix of its JSON object
    that ends after a complete value, with the open brackets closed — so the
    fields that came in full (address, spouse, the children listed so far)
    are kept instead of the whole read being lost. None when nothing parses."""
    start = text.find("{")
    if start < 0:
        return None
    cuts, stack, in_str, esc = [], [], False, False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append("}" if ch == "{" else "]")
        elif ch in "}]":
            if stack:
                stack.pop()
            if not stack:
                break
        elif ch == ",":
            cuts.append((i, list(stack)))
    for pos, open_ in reversed(cuts[-300:]):
        try:
            obj = json.loads(text[start:pos] + "".join(reversed(open_)))
        except ValueError:
            continue
        if isinstance(obj, dict):
            return obj
    return None


def _mrz_check(chars):
    """ICAO 9303 check digit: weights 7, 3, 1; digits as is, A-Z = 10-35, '<' = 0."""
    total = 0
    for i, ch in enumerate(chars):
        v = int(ch) if ch.isdigit() else (ord(ch) - 55 if "A" <= ch <= "Z" else 0)
        total += v * (7, 3, 1)[i % 3]
    return total % 10


def _mrz_part(line, start, end):
    """Characters start..end-1 of MRZ line 2 when the check digit right after
    them agrees, else None."""
    part, chk = line[start:end], line[end:end + 1]
    if len(part) < end - start or not chk.isdigit() or _mrz_check(part) != int(chk):
        return None
    return part


def _mrz_date(part, century):
    """YYMMDD → DD/MM/YYYY; century(yy) picks 19 or 20. None when not a date."""
    if not part or not part.isdigit():
        return None
    yy, mm, dd = part[:2], part[2:4], part[4:6]
    if not (1 <= int(mm) <= 12 and 1 <= int(dd) <= 31):
        return None
    return f"{dd}/{mm}/{century(int(yy))}{yy}"


def _from_mrz(parsed, field, value):
    """The field taken from the MRZ: the zoomed re-read of the printed one is
    then skipped (its box dropped)."""
    parsed[field] = value
    parsed[field + "FromMrz"] = True
    if isinstance(parsed.get("fieldBoxes"), dict):
        parsed["fieldBoxes"].pop(field, None)


def _expiry_from_mrz(parsed):
    """A passport's number, birth date and expiry from MRZ line 2 (ICAO 9303:
    characters 1-9 the number, 10 its check digit; 14-19 the birth date
    YYMMDD, 20 its check digit; 22-27 the expiry, 28 its check digit), each
    taken only when its check digit is right. The printed dates are easy to
    mix up (the issue date sits next to the expiry) and a printed number is
    easy to misread (O / 0, I / 1); the checked MRZ is not."""
    if not isinstance(parsed, dict):
        return parsed
    line = re.sub(r"\s", "", str(parsed.get("mrzLine2") or "")).upper()
    if len(line) < 28:
        return parsed
    number = _mrz_part(line, 0, 9)
    if number and number.strip("<") and "<" not in number.strip("<"):
        _from_mrz(parsed, "passportNo", number.strip("<"))
    this_year = datetime.date.today().year % 100
    dob = _mrz_date(_mrz_part(line, 13, 19), lambda yy: 19 if yy > this_year else 20)
    if dob:
        _from_mrz(parsed, "dob", dob)
    exp = _mrz_date(_mrz_part(line, 21, 27), lambda yy: 20)
    if exp:
        _from_mrz(parsed, "expiry", exp)
    return parsed


def _ddmmyyyy(v):
    m = re.fullmatch(r"\s*(\d{1,2})[/.](\d{1,2})[/.](\d{4})\s*", str(v or ""))
    if not m:
        return None
    try:
        return datetime.date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    except ValueError:
        return None


def _check_dates(parsed):
    """A guard for documents without an MRZ (an Israeli ID card) or an MRZ
    that didn't read: an expiry on or before the issue date means the two
    were swapped, so they are swapped back; an expiry less than a year after
    the issue date can't be right for an ID or a passport, so it is marked
    for checking (__uncertain, amber in the worker modal)."""
    if not isinstance(parsed, dict) or parsed.get("expiryFromMrz"):
        return parsed
    exp, iss = _ddmmyyyy(parsed.get("expiry")), _ddmmyyyy(parsed.get("issueDate"))
    if not exp or not iss:
        return parsed
    if exp <= iss:
        parsed["expiry"], parsed["issueDate"] = parsed["issueDate"], parsed["expiry"]
        parsed["datesSwapped"] = True
        if isinstance(parsed.get("fieldBoxes"), dict):
            parsed["fieldBoxes"].pop("expiry", None)
        exp, iss = iss, exp
    if (exp - iss).days < 365:
        unsure = parsed.get("__uncertain") if isinstance(parsed.get("__uncertain"), list) else []
        if "expiry" not in unsure:
            unsure.append("expiry")
        parsed["__uncertain"] = unsure
    return parsed


def parse_reply(action, status, raw):
    """The result the app gets for this Anthropic reply."""
    try:
        reply = json.loads(raw)
    except ValueError:
        return {"error": f"Bad reply from Anthropic (HTTP {status})"}
    if reply.get("error"):
        return {"error": (reply["error"] or {}).get("message") or "Anthropic error"}
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
            salvaged = _salvage_object(cleaned) if truncated else None
            if salvaged is not None:
                if action == "aiReadSefach":
                    salvaged["type"] = "israeli_id"
                else:
                    salvaged = _check_dates(_expiry_from_mrz(salvaged))
                return {"ok": True, "parsed": salvaged, "truncated": True}
            return {"error": E_TRUNCATED if truncated else E_UNREADABLE, "raw": cleaned[:400]}
        return {"error": E_UNREADABLE, "raw": cleaned[:300]}
    if action == "aiDetectAlign":
        return {"ok": True, "align": parsed}
    if action == "aiFindField":
        def one(found):
            found = found if isinstance(found, dict) else {}
            return {"value": str(found.get("value") or "").strip(), "page": found.get("page"),
                    "box": found.get("box") if isinstance(found.get("box"), dict) else None}
        if isinstance(parsed, dict) and isinstance(parsed.get("fields"), dict):
            return {"ok": True, "found": {str(k): one(v) for k, v in parsed["fields"].items()}}
        return {"ok": True, "found": one(parsed)}
    if action == "aiReadHoursTable":
        entries = parsed.get("entries") if isinstance(parsed, dict) else None
        return {"ok": True, "entries": entries if isinstance(entries, list) else []}
    if action == "aiReadDoc":
        parsed = _check_dates(_expiry_from_mrz(parsed))
    return {"ok": True, "parsed": parsed}


def run(action, body, key, post, model=None, align_model=None, meta=None):
    """post(url, payload, headers) -> (status, text). Returns the action's result.
    meta, when given, is filled with how the call went (for the app's Timings
    pane): apiMs (time spent waiting for Anthropic), tries, waitMs (retry
    pauses), and the last reply's stop reason and token counts."""
    meta = {} if meta is None else meta
    if action not in ACTIONS:
        return {"error": "Unknown action"}
    if not key:
        return {"error": "ANTHROPIC_API_KEY is not set"}
    m, am = models()
    payload, extra = build_request(action, body, model or m, align_model or am)
    if payload is None:
        return {"ok": True, "values": {}} if action == "aiVerifyFields" and extra is None else {"error": extra}
    headers = dict({"x-api-key": key, "anthropic-version": "2023-06-01"}, **extra)
    meta.update(apiMs=0, tries=0, waitMs=0)
    for attempt in range(len(RETRY_PAUSES) + 1):
        last = attempt == len(RETRY_PAUSES)
        t0 = time.monotonic()
        meta["tries"] += 1
        try:
            status, raw = post(ANTHROPIC_URL, payload, headers)
        except Exception as e:  # network
            meta["apiMs"] += int((time.monotonic() - t0) * 1000)
            if last:
                return {"error": "The request to Anthropic failed: " + str(e)}
        else:
            meta["apiMs"] += int((time.monotonic() - t0) * 1000)
            if last or not _busy(status, raw):
                _usage(raw, meta)
                return parse_reply(action, status, raw)
        meta["waitMs"] += int(RETRY_PAUSES[attempt] * 1000)
        _sleep(RETRY_PAUSES[attempt])


def _usage(raw, meta):
    """The reply's stop reason and token counts into meta."""
    try:
        reply = json.loads(raw) or {}
        u = reply.get("usage") or {}
    except (ValueError, AttributeError):
        return
    if not isinstance(u, dict):
        return
    for k, m in (("input_tokens", "inTok"), ("output_tokens", "outTok"),
                 ("cache_read_input_tokens", "cacheReadTok"), ("cache_creation_input_tokens", "cacheWriteTok")):
        if isinstance(u.get(k), int):
            meta[m] = u[k]
    if reply.get("stop_reason"):
        meta["stop"] = str(reply["stop_reason"])


def _busy(status, raw):
    """A reply worth trying again: rate limit, overload or a server error."""
    if status == 429 or status >= 500:
        return True
    try:
        err = (json.loads(raw) or {}).get("error")
    except (ValueError, AttributeError):
        return False
    return isinstance(err, dict) and err.get("type") in ("overloaded_error", "rate_limit_error", "api_error")
