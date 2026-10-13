"""Tests for the weather in the greeting (functions-auth/weather.py) on the
Firestore emulator. OpenWeatherMap is replaced by a stand-in."""

from datetime import datetime, timedelta, timezone

from test_core import DB, _clear  # noqa: F401 — also initializes the Admin SDK

import pytest

import weather

T1, T2 = "t-one", "t-two"
NOW = datetime(2026, 10, 13, 12, 0, tzinfo=timezone.utc)


class OWM:
    def __init__(self, status=200, code=500, temp=14.6):
        self.calls, self.status, self.code, self.temp = [], status, code, temp

    def __call__(self, url, params):
        self.calls.append(dict(params))
        return self.status, {"weather": [{"id": self.code}], "main": {"temp": self.temp}}


@pytest.fixture(autouse=True)
def fresh():
    _clear()
    t1 = DB.collection("tenants").document(T1)
    t1.collection("workers").document("w1").set({"id": "w1", "name": "Avi", "token": "tok-avi", "clientIds": ["c2", "c1"]})
    t1.collection("workers").document("w2").set({"id": "w2", "name": "Dana", "token": "tok-dana", "clientIds": ["c2"]})
    t1.collection("clients").document("c1").set({"id": "c1", "lat": 32.08, "lng": 34.78, "sortIndex": 1})
    t1.collection("clients").document("c2").set({"id": "c2", "sortIndex": 0})
    t1.collection("clients").document("c3").set({"id": "c3", "lat": 31.25, "lng": 34.79, "sortIndex": 2})
    yield


def test_kinds():
    assert [weather.kind_of(c) for c in (211, 301, 502, 601, 741, 800, 803, 900, None)] == [
        "thunder", "rain", "rain", "snow", "fog", "clear", "clouds", None, None]


def test_worker_gets_the_weather_at_their_first_site_with_a_map_point():
    owm = OWM()
    assert weather.weather_action(DB, {"token": "tok-avi"}, None, "k", owm, NOW) == {"kind": "rain", "temp": 15}
    assert owm.calls == [{"lat": 32.08, "lon": 34.78, "units": "metric", "appid": "k"}]


def test_the_site_picked_on_the_punch_page_comes_first_when_it_is_theirs():
    owm = OWM()
    DB.collection("tenants").document(T1).collection("workers").document("w1").update({"clientIds": ["c1", "c3"]})
    weather.weather_action(DB, {"token": "tok-avi", "clientId": "c3"}, None, "k", owm, NOW)
    assert owm.calls[-1]["lat"] == 31.25
    weather.weather_action(DB, {"token": "tok-dana", "clientId": "c3"}, None, "k", owm, NOW)  # not Dana's site
    assert len(owm.calls) == 1


def test_manager_gets_the_firms_main_site_and_nothing_but_kind_and_temp():
    owm = OWM(code=800, temp=-0.4)
    r = weather.weather_action(DB, {}, {"tenantId": T1}, "k", owm, NOW)
    assert r == {"kind": "clear", "temp": 0}
    assert owm.calls[0]["lat"] == 32.08  # c2 has no point, c1 is next by sortIndex


def test_one_read_per_area_every_30_minutes():
    owm = OWM()
    weather.weather_action(DB, {"token": "tok-avi"}, None, "k", owm, NOW)
    weather.weather_action(DB, {}, {"tenantId": T1}, "k", owm, NOW + timedelta(minutes=29))
    assert len(owm.calls) == 1
    weather.weather_action(DB, {"token": "tok-avi"}, None, "k", owm, NOW + timedelta(minutes=31))
    assert len(owm.calls) == 2


def test_nothing_to_show_gives_empty():
    owm = OWM()
    assert weather.weather_action(DB, {"token": "tok-dana"}, None, "k", owm, NOW) == {}  # no site with a point
    assert weather.weather_action(DB, {"token": "nope"}, None, "k", owm, NOW) == {}
    assert weather.weather_action(DB, {}, {"tenantId": T2}, "k", owm, NOW) == {}       # a firm with no clients
    assert weather.weather_action(DB, {}, {"tenantId": None}, "k", owm, NOW) == {}
    assert owm.calls == []
    assert weather.weather_action(DB, {"token": "tok-avi"}, None, "k", OWM(status=401), NOW) == {}
    assert weather.weather_action(DB, {"token": "tok-avi"}, None, "", owm, NOW) == {}  # no key
    assert owm.calls == []


def test_no_token_and_no_session_is_refused():
    assert "error" in weather.weather_action(DB, {}, None, "k", OWM(), NOW)
