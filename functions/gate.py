"""The sign-in gate of the `functions/` codebase's functions (fill_form_101,
scan_feedback — docs/backend.md): a request carries the caller's Firebase ID
token ("Authorization: Bearer <ID token>", as the europe-west3 functions take
it), and only a manager-side login passes — a super-admin, a firm's owner,
staff or HR. A supplier or client login, a missing, bad or revoked token: no.
The warm-up ping ({"ping": true}) needs none: it reads and returns nothing.
Kept apart from main.py so it is tested without that module's image and PDF
libraries (tests/auth/test_scan_gate.py)."""

E_SESSION = "Session expired or invalid — please sign in again"
E_ROLE = "This login may not use the scanner"
MANAGER_ROLES = ("superadmin", "tenant_admin", "staff", "hr")


def check(headers, verify):
    """(None, None) when the caller may go on, else (status, error text).
    verify(token) returns the token's claims or raises."""
    status, error, _ = claims_of(headers, verify)
    return status, error


def claims_of(headers, verify):
    """(None, None, claims) for a manager-side login, else (status, error text, None)."""
    header = (headers.get("Authorization") if headers else "") or ""
    token = header[7:] if header.startswith("Bearer ") else ""
    if not token:
        return 401, E_SESSION, None
    try:
        claims = verify(token)
    except Exception:
        return 401, E_SESSION, None
    if not isinstance(claims, dict) or claims.get("role") not in MANAGER_ROLES:
        return 403, E_ROLE, None
    return None, None, claims
