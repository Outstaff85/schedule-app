"""The PDF builders (docs/documents-plan.md → S1). A builder version gives the same bytes from the same inputs, for good:
`*_b1.py` are frozen copies — never edited, never wrappers around live code, so a later edit of contracts.py or
idsheet.py cannot change what b1 builds. A change is a new version: new files (`*_b2.py`), a new entry in BUILDERS and
LOCKED, BUILDER_VERSION moved on. The guard is the golden output hashes (tests/auth/builder_golden.json, from CI only),
compared on CI, on the Cloud Functions image and on production after each deploy (selftest.py).

The template and the font are fixed too, by their hashes, checked here at import: a Form 101 template is a new file
beside the old ones (assets/form101/v<n>.pdf) with a new entry in FORM101_TEMPLATES."""

import hashlib
import pathlib

BUILDER_VERSION = "b1"

_ASSETS = pathlib.Path(__file__).resolve().parent.parent / "assets"
FORM101_TEMPLATES = {"v1": "83f60ef6066dd4fb49b3075e187867f7858f7bfc13b8329355aae44985545b56"}
FONT_SHA256 = "95549e378d1f97fc12c070177dd4dc9770304fd34f1f525ccf82658c72ac67df"

# What goes into a builder's bytes, as functions/requirements.lock pins it (mupdf: pymupdf.VersionFitz, pymupdf: VersionBind).
# Pillow stays because the signature and any page that is not a stored JPEG go through it. A new version of one of
# these is a new builder version (tests/auth/test_builder_determinism.py).
LOCKED = {"b1": {"pymupdf": "2.0", "mupdf": "1.28.5", "python-bidi": "0.6.12", "pillow": "13.0.0"}}


def _sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_assets():
    """Raises when the template or the font is not the file a builder was frozen with."""
    for version, want in FORM101_TEMPLATES.items():
        if _sha256(_ASSETS / "form101" / f"{version}.pdf") != want:
            raise RuntimeError(f"The Form 101 template {version} is not the frozen file")
    if _sha256(_ASSETS / "heebo-hebrew.ttf") != FONT_SHA256:
        raise RuntimeError("The font is not the frozen file")


check_assets()

from . import contract_b1, form101_b1, sheets_b1  # noqa: E402  (after the check: they read the files checked above)

BUILDERS = {"b1": {"form101": form101_b1.build_form101_pdf, "contract": contract_b1.fill, "sheet": sheets_b1.sheet_pdf}}
