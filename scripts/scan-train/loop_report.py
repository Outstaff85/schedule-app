"""The automatic cycle's reports (docs/scan-training.md → The automatic cycle → Reports): loop.py hands each report
of a cycle here — when the cycle starts, pauses at 08:00, and ends — and send(report) tells the owner in two places:

  - **Firestore** `scanTrainingStats/loop`, next to the bell's counters (`scanTrainingStats/current`), written with the
    owner's own Google credentials as publish.py writes the counters (common.db(): Application Default Credentials):
      {"latest": <the report>, "history": [<the last 20 reports, newest first>], "updatedAt": iso}
    A report sent again under the same "id" (the same cycle: running → paused → published) replaces its entry in the
    history instead of adding one. The app reads it only through scan_feedback's "stats" answer ("loop": the super-admin's
    bell and Admin → Scanner → Automatic training); firestore.rules lets only a super-admin read the document and nobody
    write it (the PC writes through the Admin side of the owner's credentials).
  - **A Windows toast** on the PC with one line (line(): the state, and the version or what needs the owner), drawn by
    the built-in Windows.UI.Notifications through Windows PowerShell — BurntToast is not installed —, else `msg *`.

Only the fields of the shared report dict are written (clean()): unknown keys are dropped, every string is cut short,
the lists capped, and in the free texts (notes, needsOwner, the exams' failed rules) any run of 7 or more digits — what
an ID or passport number would be — is replaced by "…": no worker's name, number or picture ever goes into a report
(loop.py never puts one there; this is the second guard).

send() never raises: a report that cannot be stored or a toast that cannot be shown is printed as a warning on stderr
and the loop goes on. To look at what would be written without writing it:

  python loop_report.py <report.json> --dry-run     # the cleaned report, the toast's line; nothing written or shown
  python loop_report.py <report.json>                # writes it to Firestore and shows the toast (as the loop does)
"""
import argparse
import base64
import datetime
import json
import os
import re
import subprocess
import sys

COLLECTION, DOC = "scanTrainingStats", "loop"   # next to scanTrainingStats/current (the bell's counters)
HISTORY = 20                                     # the cycles kept in the history
STATES = ("not-due", "running", "paused", "published", "rejected", "waiting-golden", "failed")
MODELS = ("edges", "doctype", "mrz", "he")
VERDICTS = ("yes", "no")
TEXT_MAX, LIST_MAX = 300, 20                     # a string's length and a list's items in a stored report
DIGITS = re.compile(r"\d{7,}")                   # an ID / passport number's digits: never stored
APP_ID = r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"   # Windows PowerShell's own toast sender
TITLE = "Scanner training"


def _text(v, scrub=False):
    """A stored string: cut to TEXT_MAX; a free text with its long digit runs replaced."""
    if v is None:
        return None
    s = str(v)
    if scrub:
        s = DIGITS.sub("…", s)
    return s[:TEXT_MAX]


def _texts(v):
    return [_text(x, scrub=True) for x in (v if isinstance(v, (list, tuple)) else [])][:LIST_MAX]


def _due(v):
    """The counters that made the cycle due (the bell's): numbers, booleans and {kind: number} only."""
    out = {}
    for k, x in (v.items() if isinstance(v, dict) else []):
        k = _text(k)[:64]
        if isinstance(x, bool) or isinstance(x, (int, float)):
            out[k] = x
        elif isinstance(x, dict):
            out[k] = {_text(a)[:64]: b for a, b in x.items() if isinstance(b, (int, float)) and not isinstance(b, bool)}
    return dict(list(out.items())[:LIST_MAX])


def _model(v):
    v = v if isinstance(v, dict) else {}
    return {"trained": bool(v.get("trained")), "verdict": v.get("verdict") if v.get("verdict") in VERDICTS else None,
            "failed": _texts(v.get("failed")), "examReport": _text(v.get("examReport"))}


def clean(report):
    """The report as stored: exactly the fields of the shared dict (loop.py), each of its type."""
    r = report if isinstance(report, dict) else {}
    models = r.get("models") if isinstance(r.get("models"), dict) else {}
    return {
        "id": _text(r.get("id")) or "",
        "startedAt": _text(r.get("startedAt")),
        "finishedAt": _text(r.get("finishedAt")),
        "state": r.get("state") if r.get("state") in STATES else "failed",
        "due": _due(r.get("due")),
        "models": {m: _model(models[m]) for m in MODELS if m in models},
        "version": _text(r.get("version")),
        "branch": _text(r.get("branch")),
        "prUrl": _text(r.get("prUrl")) if str(r.get("prUrl") or "").startswith("https://") else None,
        "notes": _texts(r.get("notes")),
        "needsOwner": _texts(r.get("needsOwner")),
        "log": _text(r.get("log")),
    }


def merged(doc, report, now):
    """The new scanTrainingStats/loop: the report as latest, at the head of the history (its earlier entry of the same
    cycle replaced), the history cut to HISTORY."""
    old = [h for h in ((doc or {}).get("history") or []) if isinstance(h, dict) and h.get("id") != report["id"]]
    return {"latest": report, "history": [report, *old][:HISTORY], "updatedAt": now}


def store(report, client=None, now=None):
    """Writes the cleaned report into Firestore scanTrainingStats/loop with the owner's credentials (common.db())."""
    if client is None:
        from common import db   # the Google package only here: the tests and the toast need none
        client = db()
    now = now or datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    ref = client.collection(COLLECTION).document(DOC)
    snap = ref.get()
    doc = snap.to_dict() if getattr(snap, "exists", False) else {}
    ref.set(merged(doc, report, now))


def line(report):
    """The toast's one line: the state, and the version or what needs the owner."""
    st, v = report.get("state"), report.get("version")
    need = (report.get("needsOwner") or [None])[0]
    failed = next((f for m in report.get("models", {}).values() for f in m.get("failed") or []), None)
    text = {
        "published": f"new lab version {v} — PR to merge" if v else "published to the lab — PR to merge",
        "rejected": "not better — nothing published" + (f": {failed}" if failed else ""),
        "waiting-golden": "trained and examined; waiting for the golden set",
        "failed": "failed" + (f": {need or (report.get('notes') or [None])[-1]}" if (need or report.get("notes")) else ""),
        "paused": "paused at 08:00 — goes on next night",
        "running": "started",
        "not-due": "nothing due",
    }.get(st, str(st))
    if need and st != "failed":
        text += f" · needs you: {need}"
    return text[:TEXT_MAX]


def _xml(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;").replace("'", "&apos;")


def toast_script(text):
    """The Windows PowerShell script that shows the toast (Windows.UI.Notifications, built into Windows 10/11)."""
    xml = f'<toast><visual><binding template="ToastGeneric"><text>{_xml(TITLE)}</text><text>{_xml(text)}</text></binding></visual></toast>'
    q = lambda s: "'" + s.replace("'", "''") + "'"
    return ("$ErrorActionPreference='Stop';"
            "[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]>$null;"
            "[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]>$null;"
            "$x=New-Object Windows.Data.Xml.Dom.XmlDocument;"
            f"$x.LoadXml({q(xml)});"
            f"[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier({q(APP_ID)}).Show([Windows.UI.Notifications.ToastNotification]::new($x))")


def toast(text, run=subprocess.run, windows=None):
    """Shows the toast; with the toast refused, `msg *` (a message box). Never raises; True when one was shown."""
    if not (os.name == "nt" if windows is None else windows):
        return False
    encoded = base64.b64encode(toast_script(text).encode("utf-16-le")).decode("ascii")   # no quoting through the command line
    tries = [["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
             ["msg", "*", "/TIME:3600", f"{TITLE}: {text}"]]
    for cmd in tries:
        try:
            if run(cmd, capture_output=True, timeout=30).returncode == 0:
                return True
        except Exception:
            continue
    return False


def send(report, client=None, run=subprocess.run, windows=None):
    """The loop's one call (loop.py): the report to Firestore and a toast on the PC. Never raises."""
    r = clean(report)
    try:
        store(r, client)
    except Exception as e:
        print(f"warning: the loop's report was not stored in Firestore ({type(e).__name__}: {e})", file=sys.stderr)
    try:
        if not toast(line(r), run=run, windows=windows):
            print(f"note: no toast shown — {TITLE}: {line(r)}", file=sys.stderr)
    except Exception as e:
        print(f"warning: no toast ({type(e).__name__}: {e})", file=sys.stderr)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Send (or with --dry-run, only show) a report of the automatic training cycle.")
    ap.add_argument("report", help="a report as JSON (the shared report dict)")
    ap.add_argument("--dry-run", action="store_true", help="print the cleaned report and the toast's line; write and show nothing")
    a = ap.parse_args(argv)
    with open(a.report, encoding="utf-8") as f:
        report = json.load(f)
    if a.dry_run:
        r = clean(report)
        print(json.dumps(r, ensure_ascii=False, indent=2))
        print(f"toast: {TITLE}: {line(r)}")
        print(f"would write: Firestore {COLLECTION}/{DOC} (latest + the last {HISTORY})")
        return
    send(report)


if __name__ == "__main__":
    main()
