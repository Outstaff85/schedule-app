"""The sign-in gate of fill_form_101 and scan_feedback (functions/gate.py):
only a manager-side login with a valid ID token passes."""
import importlib.util
import pathlib

_spec = importlib.util.spec_from_file_location("gate", pathlib.Path(__file__).resolve().parents[2] / "functions" / "gate.py")
gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)


def verify_as(claims):
    def verify(token):
        assert token == "good-token"
        return claims
    return verify


def bad_token(token):
    raise ValueError("Token expired")


def test_no_token_is_turned_away():
    assert gate.check({}, verify_as({"role": "superadmin"})) == (401, gate.E_SESSION)
    assert gate.check({"Authorization": "Basic abc"}, verify_as({"role": "superadmin"})) == (401, gate.E_SESSION)


def test_a_bad_or_revoked_token_is_turned_away():
    assert gate.check({"Authorization": "Bearer nope"}, bad_token) == (401, gate.E_SESSION)


def test_manager_side_logins_pass():
    for role in ("superadmin", "tenant_admin", "staff", "hr"):
        assert gate.check({"Authorization": "Bearer good-token"}, verify_as({"role": role})) == (None, None), role


def test_supplier_client_and_roleless_logins_are_refused():
    for claims in ({"role": "supplier"}, {"role": "client"}, {}, None):
        assert gate.check({"Authorization": "Bearer good-token"}, verify_as(claims)) == (403, gate.E_ROLE), claims
