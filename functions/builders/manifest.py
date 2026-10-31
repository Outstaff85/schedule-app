"""A signing's input manifest (docs/documents-plan.md → Decisions 2; used from S4 on): canonical JSON — sorted keys, no
spaces, UTF-8 — and its SHA-256. The same values give the same bytes whatever their key order or the writer's spacing.
Only plain JSON values go in (a date is written as text by its caller): anything else raises TypeError, and so does a
NaN or an infinity (ValueError), rather than be written in a way a later reader could not read back."""

import hashlib
import json


def canonical(values):
    """The manifest's bytes."""
    return json.dumps(values, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def sha256(values):
    """The SHA-256 (hex) of the manifest's bytes."""
    return hashlib.sha256(canonical(values)).hexdigest()
