"""The weather in the greeting (redesign stage 12) — the `weather` function.

weather_action(db, body, caller, api_key, fetch, now=None)
  The place comes from the server's own data, never from the page: a worker
  punch-link token (body.token) gives that worker's site with a map point —
  body.clientId first when it is one of theirs (the site picked on the punch
  page), then their clients in order; a manager's ID token (caller) gives
  the firm's main site — its first client by sortIndex with a map point. Only {kind, temp} goes out: no
  coordinates, no names.

OpenWeatherMap's current weather (free tier, 1,000 calls a day) with the key
from Secret Manager (OPENWEATHER_API_KEY). One read per area (lat / lng
rounded to 0.1°, about 11 km) every 30 minutes, kept in weatherCache/{area}
(functions only). Anything that fails gives {} — the page then shows its
time-of-day icon.
"""

from datetime import datetime, timezone

import portal

OWM_URL = "https://api.openweathermap.org/data/2.5/weather"
CACHE_SECONDS = 30 * 60
KINDS = ("clear", "clouds", "rain", "thunder", "snow", "fog")


def kind_of(code):
    """OpenWeatherMap condition id -> one of KINDS."""
    try:
        c = int(code)
    except (TypeError, ValueError):
        return None
    if 200 <= c < 300:
        return "thunder"
    if 300 <= c < 600:
        return "rain"
    if 600 <= c < 700:
        return "snow"
    if 700 <= c < 800:
        return "fog"
    if c == 800:
        return "clear"
    if 800 < c < 900:
        return "clouds"
    return None


def _point(c):
    try:
        lat, lng = float(c.get("lat")), float(c.get("lng"))
    except (TypeError, ValueError):
        return None
    if not (-90 <= lat <= 90 and -180 <= lng <= 180) or (lat == 0 and lng == 0):
        return None
    return lat, lng


def _worker_point(db, token, client_id=None):
    tid, w = portal.find_worker(db, token)
    if not w:
        return None
    clients = db.collection("tenants").document(tid).collection("clients")
    ids = [str(c) for c in (w.to_dict() or {}).get("clientIds") or []]
    if client_id and str(client_id) in ids:  # the site the worker picked first
        ids.remove(str(client_id))
        ids.insert(0, str(client_id))
    for cid in ids:
        snap = clients.document(str(cid)).get()
        p = _point(snap.to_dict() or {}) if snap.exists else None
        if p:
            return p
    return None


def _firm_point(db, tid):
    if not tid:
        return None
    docs = [d.to_dict() or {} for d in db.collection("tenants").document(tid).collection("clients").stream()]
    docs.sort(key=lambda c: (c.get("sortIndex") if isinstance(c.get("sortIndex"), (int, float)) else 1e9))
    for c in docs:
        p = _point(c)
        if p:
            return p
    return None


def area_key(lat, lng):
    return f"{round(lat, 1):.1f}_{round(lng, 1):.1f}"


def weather_for(db, lat, lng, api_key, fetch, now=None):
    now = now or datetime.now(timezone.utc)
    ref = db.collection("weatherCache").document(area_key(lat, lng))
    snap = ref.get()
    if snap.exists:
        d = snap.to_dict() or {}
        at = d.get("at")
        if at and (now - at).total_seconds() < CACHE_SECONDS and d.get("kind") in KINDS:
            return {"kind": d["kind"], "temp": d.get("temp")}
    if not api_key:
        return {}
    status, data = fetch(OWM_URL, {"lat": round(lat, 2), "lon": round(lng, 2), "units": "metric", "appid": api_key})
    if status != 200 or not isinstance(data, dict):
        return {}
    kind = kind_of(((data.get("weather") or [{}])[0] or {}).get("id"))
    if not kind:
        return {}
    try:
        temp = round(float((data.get("main") or {}).get("temp")))
    except (TypeError, ValueError):
        temp = None
    ref.set({"kind": kind, "temp": temp, "at": now})
    return {"kind": kind, "temp": temp}


def weather_action(db, body, caller, api_key, fetch, now=None):
    if body.get("token"):
        p = _worker_point(db, body.get("token"), body.get("clientId"))
    elif caller:
        p = _firm_point(db, caller.get("tenantId"))
    else:
        return {"error": "Session expired or invalid — please sign in again"}
    if not p:
        return {}
    return weather_for(db, p[0], p[1], api_key, fetch, now)
