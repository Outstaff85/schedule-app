"""The docx2pdf Cloud Run service (docs/contracts.md → Word templates, D7): POST {"docxBase64"} with
the user's Firebase ID token → {"pdfBase64"}. Only a firm's admin or the super-admin (the ones who
manage contract templates); the firm is the token's (a super-admin's: asTenantId). It keeps nothing.
Deployed with concurrency 1, cpu 1, max-instances 5 (.github/workflows/deploy-docx2pdf.yml)."""

import base64
import json
import os

import firebase_admin
from firebase_admin import auth
from flask import Flask, request

from convert import ConvertError, convert

app = Flask(__name__)
ALLOWED = ("superadmin", "tenant_admin")
CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Authorization, Content-Type"}


def reply(obj, status=200):
    return app.response_class(json.dumps(obj), status=status, mimetype="application/json", headers=CORS)


def check(headers, verify):
    """(None, claims) for a firm's admin or the super-admin, else (status, error)."""
    h = headers.get("Authorization") or ""
    token = h[7:] if h.startswith("Bearer ") else ""
    if not token:
        return 401, "Session expired or invalid — please sign in again"
    try:
        claims = verify(token)
    except Exception:
        return 401, "Session expired or invalid — please sign in again"
    if claims.get("role") not in ALLOWED:
        return 403, "Only the firm's admin uploads contract templates"
    return None, claims


@app.route("/", methods=["POST", "OPTIONS"])
def handle():
    if request.method == "OPTIONS":
        return reply({})
    body = request.get_json(silent=True, force=True) or {}
    if body.get("ping") is True:
        return reply({"ok": True, "warm": True})
    if not firebase_admin._apps:
        firebase_admin.initialize_app()
    status, info = check(request.headers, lambda t: auth.verify_id_token(t, check_revoked=True))
    if status:
        return reply({"error": info}, status)
    if info.get("role") == "tenant_admin" and not info.get("tenantId"):
        return reply({"error": "No firm"}, 403)
    try:
        pdf = convert(base64.b64decode(str(body.get("docxBase64") or "").split(",")[-1] or b""))
    except ConvertError as e:
        return reply({"error": str(e)}, 400)
    return reply({"ok": True, "pdfBase64": base64.b64encode(pdf).decode()})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
