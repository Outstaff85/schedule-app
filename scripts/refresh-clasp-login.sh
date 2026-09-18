#!/usr/bin/env bash
# Run this after a "Deploy to Apps Script" CI failure showing:
#   "error":"invalid_grant","error_description":"reauth related error (invalid_rapt)"
#
# This Google Workspace account periodically forces OAuth re-authentication for
# the Apps Script scopes clasp uses, which invalidates the refresh token stored
# in the CLASP_CREDENTIALS GitHub secret. Re-authentication itself requires a
# human to complete a Google login in a browser — that step cannot be
# automated. This script automates everything around it: opens the login,
# pushes the fresh token to GitHub, and re-triggers the deploy.
#
# Requires: the OAuth client JSON at CREDS_FILE (Web application type, with
# redirect_uris containing http://localhost:$REDIRECT_PORT, and that same URI
# registered under "Authorized redirect URIs" in Cloud Console project
# schedule-manager-498317 — already set up as of 2026-09-18).
set -euo pipefail

CREDS_FILE="${CLASP_OAUTH_CREDS:-H:/Tokens/Google api.json}"
REDIRECT_PORT="${CLASP_REDIRECT_PORT:-8085}"
REPO="Outstaff85/schedule-app"

echo "== Step 1/3: Google login (browser will open) =="
npx @google/clasp login --creds "$CREDS_FILE" --redirect-port "$REDIRECT_PORT"

echo "== Step 2/3: updating CLASP_CREDENTIALS secret =="
gh secret set CLASP_CREDENTIALS --repo "$REPO" < "$HOME/.clasprc.json"

echo "== Step 3/3: re-running Apps Script deploy =="
gh workflow run "Deploy to Apps Script" --repo "$REPO"

sleep 5
gh run list --repo "$REPO" --workflow="Deploy to Apps Script" --limit 3
