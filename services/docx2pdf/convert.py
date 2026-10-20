"""A Word file (.docx) to PDF with LibreOffice, headless (docs/contracts.md → Word templates, D7).

One conversion per process at a time: the service runs with concurrency 1 (one request per
instance), and each conversion gets its own LibreOffice profile in a temporary folder, so two
instances never share one. Hebrew is laid out right to left by LibreOffice itself (the image
carries the Culmus Hebrew fonts)."""

import os
import shutil
import subprocess
import tempfile
import uuid

MAX_BYTES = 20 * 1024 * 1024
TIMEOUT_S = 90
SOFFICE = os.environ.get("SOFFICE", "soffice")


class ConvertError(Exception):
    pass


def is_docx(data):
    """A .docx is a zip with word/document.xml."""
    if not data or data[:2] != b"PK":
        return False
    import io
    import zipfile
    try:
        return "word/document.xml" in zipfile.ZipFile(io.BytesIO(data)).namelist()
    except zipfile.BadZipFile:
        return False


def command(src, outdir, profile):
    return [SOFFICE, "-env:UserInstallation=file://" + profile, "--headless", "--norestore", "--nolockcheck",
            "--convert-to", "pdf:writer_pdf_Export", "--outdir", outdir, src]


def convert(data, run=subprocess.run):
    """The PDF of a .docx; raises ConvertError with the reason."""
    if len(data) > MAX_BYTES:
        raise ConvertError("The file is too big (20 MB at most)")
    if not is_docx(data):
        raise ConvertError("This file is not a Word document (.docx)")
    work = tempfile.mkdtemp(prefix="docx2pdf-")
    try:
        src = os.path.join(work, "in.docx")
        with open(src, "wb") as f:
            f.write(data)
        profile = os.path.join(work, "profile-" + uuid.uuid4().hex[:8])
        try:
            run(command(src, work, profile), check=True, timeout=TIMEOUT_S, capture_output=True)
        except subprocess.TimeoutExpired:
            raise ConvertError("Converting took too long")
        except subprocess.CalledProcessError as e:
            raise ConvertError("LibreOffice could not convert it: " + (e.stderr or b"").decode("utf-8", "replace")[-300:])
        out = os.path.join(work, "in.pdf")
        if not os.path.exists(out):
            raise ConvertError("LibreOffice made no PDF")
        with open(out, "rb") as f:
            return f.read()
    finally:
        shutil.rmtree(work, ignore_errors=True)
