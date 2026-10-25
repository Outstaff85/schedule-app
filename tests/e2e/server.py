# Test-only server: the real functions-auth functions on the emulators.
import json, os, sys
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, '..', 'auth'))
sys.path.insert(0, os.path.join(_HERE, '..', '..', 'functions-auth'))
os.environ['ANTHROPIC_API_KEY'] = 'sk-browser-test'
os.environ['STORAGE_EMULATOR_HOST'] = 'http://127.0.0.1:9199'
from test_core import DB, _clear, seed_legacy, T1, T2
import main
from firebase_admin import storage as _st
_orig_bucket = _st.bucket
main.storage.bucket = lambda name=None: _orig_bucket('demo-schedule.appspot.com')
from flask import Flask
app = Flask(__name__)
# The contract templates (functions/contracts.py — the `functions/` codebase, without its
# deploy-only imports): the same gate as functions/main.py, the emulators' Firestore and Storage.
sys.path.append(os.path.join(_HERE, '..', '..', 'functions'))
import contracts as _contracts, gate as _gate
sys.path.append(os.path.join(_HERE, '..', '..', 'services', 'docx2pdf'))
import convert as _docx2pdf
def contract_templates(request):
    body = request.get_json(silent=True, force=True) or {}
    if body.get('ping') is True:
        return app.response_class(json.dumps({'ok': True, 'warm': True}), mimetype='application/json')
    status, error, claims = _gate.claims_of(request.headers, lambda t: main.auth.verify_id_token(t, check_revoked=True))
    if status:
        return app.response_class(json.dumps({'error': error}), status=status, mimetype='application/json')
    try:
        # a Word file: the docx2pdf service's own conversion (services/docx2pdf/convert.py, LibreOffice here)
        out = _contracts.run(DB, _orig_bucket('demo-schedule.appspot.com'), claims, body, docx=_docx2pdf.convert)
    except ValueError as e:
        return app.response_class(json.dumps({'error': str(e)}), status=400, mimetype='application/json')
    return app.response_class(json.dumps(out, default=str), mimetype='application/json')
# One signature for Form 101 and the contract (functions/signing.py), with the real Form 101 build
# of functions/main.py (loaded under another name: functions-auth's main is `main` here).
import importlib.util as _ilu
_spec = _ilu.spec_from_file_location('fmain', os.path.join(_HERE, '..', '..', 'functions', 'main.py'))
_fmain = _ilu.module_from_spec(_spec); _spec.loader.exec_module(_fmain)
import signing as _signing
def sign_documents(request):
    body = request.get_json(silent=True, force=True) or {}
    if body.get('ping') is True:
        return app.response_class(json.dumps({'ok': True, 'warm': True}), mimetype='application/json')
    bucket = _orig_bucket('demo-schedule.appspot.com')
    try:
        if body.get('token') and not (request.headers.get('Authorization') or '').startswith('Bearer '):
            out = _signing.run_worker(DB, bucket, body, _fmain.build_form101_pdf)
        else:
            status, error, claims = _gate.claims_of(request.headers, lambda t: main.auth.verify_id_token(t, check_revoked=True))
            if status:
                return app.response_class(json.dumps({'error': error}), status=status, mimetype='application/json')
            out = _signing.run(DB, bucket, claims, body, _fmain.build_form101_pdf)
    except ValueError as e:
        return app.response_class(json.dumps({'error': str(e)}), status=400, mimetype='application/json')
    return app.response_class(json.dumps(out, default=str), mimetype='application/json')
# The worker's documents built on request (functions/workerdocs.py, the `worker_docs` function): the same gate, the
# real Form 101 build, the emulators' Firestore and Storage; a PDF is answered raw with its headers.
import workerdocs as _workerdocs
def worker_docs(request):
    body = request.get_json(silent=True, force=True) or {}
    if body.get('ping') is True:
        return app.response_class(json.dumps({'ok': True, 'warm': True}), mimetype='application/json')
    status, error, claims = _gate.claims_of(request.headers, lambda t: main.auth.verify_id_token(t, check_revoked=True))
    if status:
        return app.response_class(json.dumps({'error': error}), status=status, mimetype='application/json')
    out = _workerdocs.run(DB, _orig_bucket('demo-schedule.appspot.com'), claims, body, _fmain.build_form101_pdf)
    if out.get('error'):
        return app.response_class(json.dumps({'error': out['error']}), status=out.get('status') or 400, mimetype='application/json')
    return app.response_class(out['pdf'], headers=_workerdocs.headers(out))

# Anthropic stand-in for aiFindField: finds the city (ישוב), nothing else.
CALLS = []
def _fake_anthropic(url, payload, headers):
    text = payload['messages'][0]['content'][0].get('text', '')
    v = ''
    if 'Find ONLY these fields' in text:
        out = {'fields': {k: {'value': 'חיפה' if k == 'city' else '', 'page': 0} for k in ('docGiven', 'docSurname', 'docId', 'docDob', 'docSex', 'address', 'houseNumber', 'city') if '"' + k + '":' in text}}
        CALLS.append(sorted(out['fields']))
        return 200, json.dumps({'content': [{'type': 'text', 'text': json.dumps(out, ensure_ascii=False)}]})
    if 'Find ONLY this one field' in text and 'ישוב' in text:
        v = 'חיפה'
    return 200, json.dumps({'content': [{'type': 'text', 'text': json.dumps({'value': v, 'page': 0}, ensure_ascii=False)}]})
main._anthropic_post = _fake_anthropic
# OpenWeatherMap stand-in for the greeting (stage 12): light rain, 14.4°.
os.environ['OPENWEATHER_API_KEY'] = 'owm-browser-test'
main._owm_get = lambda url, params: (200, {'weather': [{'id': 500}], 'main': {'temp': 14.4}})

def seed():
    _clear()
    t1, t2 = DB.collection('tenants').document(T1), DB.collection('tenants').document(T2)
    t1.set({'companyName': 'Firm One', 'phone': '0501234567', 'deductionsFileNumber': '012345678', 'street': 'Herzl', 'streetNumber': '1', 'city': 'Haifa'})
    t2.set({'companyName': 'Firm Two', 'phone': '0507654321', 'deductionsFileNumber': '87654321', 'street': 'Bialik', 'streetNumber': '2', 'city': 'Tel Aviv'})
    # The permission templates: the defaults, and three more the HR checks put logins on.
    import core
    core._seed_templates(DB)
    HOURS = ['approveHours', 'disputeHours', 'fixHours']
    ED = ['editSchedule', 'editWorkers', 'editPunches']
    for tid, name, role, rights in (('hrpay', 'HR with pay', 'hr', {'rights': ['workers', 'commission', 'hours', *ED, *HOURS, 'seePay']}),
                                    ('hrpayedit', 'HR pay edit', 'hr', {'rights': ['workers', 'commission', 'hours', *ED, 'editPay', *HOURS, 'seePay']}),
                                    ('staffworkers', 'Workers only', 'staff', {'rights': ['today', 'workers', 'punchlog', *ED]})):
        DB.collection('permTemplates').document(tid).set(dict({'name': name, 'role': role}, **core._template_rights(role, rights)))
    seed_legacy('u-admin1', 'owner1', 'owner-pass-1', role='tenant_admin', tenantId=T1)
    seed_legacy('u-sup1', 'sup1', 'sup-pass-11', role='supplier', tenantId=T1, supplierId='s-1',
                rights=['today', 'workers', 'commission', 'hours', 'export', 'approveHours', 'seePay'])
    seed_legacy('u-super', 'boss', 'boss-pass-1', role='superadmin', tenantId=None)
    seed_legacy('u-client1', 'client1', 'client-pass-1', role='client', tenantId=T1, clientId='c2', fullName='Site B manager',
                rights=['schedule', 'hours', 'export', *HOURS])
    t1.collection('settings').document('schedule').set({'savedAt': 'S1'})
    t1.collection('clients').document('c1').set({'id': 'c1', 'name': 'Site A', 'lat': 32.0, 'lng': 34.8, 'radius': 100, 'sortIndex': 0})
    t1.collection('clients').document('c2').set({'id': 'c2', 'name': 'Site B', 'sortIndex': 1})
    t1.collection('suppliers').document('s-1').set({'id': 's-1', 'name': 'Agency', 'color': '#4f8ef7', 'sortIndex': 0})
    t1.collection('workers').document('w1').set({'id': 'w1', 'name': 'Avi Cohen', 'token': 'tok-avi', 'clientIds': ['c1'], 'supplierId': 's-1',
        'hourlyRate': 50, 'docUrl': 'https://x/doc.pdf', 'docFileId': 'tenants/t/w/form101/x.pdf', 'colorIdx': 0, 'schedule': [], 'sortIndex': 0})
    t1.collection('workers').document('w2').set({'id': 'w2', 'name': 'Dana Levi', 'token': 'tok-dana', 'clientIds': ['c2'], 'hourlyRate': 40, 'colorIdx': 1, 'schedule': [], 'sortIndex': 1})
    # E2E_NOW (run.sh: a Wednesday or Thursday from the 3rd, 12:00 UTC) — the
    # browser's clock is set to it too, so "yesterday", "this week" and
    # "this month" hold the same punches whatever day the tests run on.
    now = (datetime.fromisoformat(os.environ['E2E_NOW'].replace('Z', '+00:00')) if os.environ.get('E2E_NOW')
           else datetime.now(timezone.utc)).replace(microsecond=0)
    def punch(tref, pid, wid, name, typ, ts, cid):
        tref.collection('punches').document(pid).set({'id': pid, 'workerId': wid, 'workerName': name, 'type': typ,
            'time': ts.strftime('%H:%M'), 'ts': ts, 'day': ts.strftime('%Y-%m-%d'), 'site': '', 'clientId': cid,
            'dist': 12, 'gpsAccuracy': 7.6, 'gpsSuspicious': False, 'gpsWarnings': [], 'notes': 'n-' + pid, 'archived': False})
    d1 = (now - timedelta(days=1)).replace(hour=6, minute=0, second=0)    # yesterday 6:00-14:00 UTC
    d9 = (now - timedelta(days=9)).replace(hour=6, minute=0, second=0)
    punch(t1, 'p1', 'w1', 'Avi Cohen', 'in', d1, 'c2')                     # Avi worked at c2 (not his current client)
    punch(t1, 'p2', 'w1', 'Avi Cohen', 'out', d1 + timedelta(hours=8), 'c2')
    punch(t1, 'p3', 'w2', 'Dana Levi', 'in', d9, 'c2')
    punch(t1, 'p4', 'w2', 'Dana Levi', 'out', d9 + timedelta(hours=4), 'c2')
    # Firm two: its own client with a 100/h default rate; this week, 2h on a weekday.
    t2.collection('settings').document('schedule').set({'savedAt': 'S2'})
    t2.collection('clients').document('c9').set({'id': 'c9', 'name': 'Two Site', 'defaultHourlyRate': 100, 'sortIndex': 0})
    t2.collection('workers').document('w9').set({'id': 'w9', 'name': 'Other', 'token': 'tok-9', 'clientIds': ['c9'], 'sortIndex': 0})
    ws = now - timedelta(days=(now.weekday() + 1) % 7)                   # Sunday of this week
    day = ws.replace(hour=9, minute=0, second=0)
    if day.weekday() == 5: day += timedelta(days=1)
    if day > now: day = now - timedelta(hours=3)
    punch(t2, 'q1', 'w9', 'Other', 'in', day, 'c9')
    punch(t2, 'q2', 'w9', 'Other', 'out', day + timedelta(hours=2), 'c9')

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        raw = self.rfile.read(int(self.headers['Content-Length'] or 0))
        extra = {}
        if self.path == '/seed':
            seed(); status, data = 200, b'{"ok":true}'
        elif self.path == '/aicalls':
            status, data = 200, json.dumps(CALLS, ensure_ascii=False).encode(); CALLS.clear()
        elif self.path == '/revoke':
            DB.collection('tenants').document(T1).collection('workers').document('w1').update({'token': 'tok-new'})
            status, data = 200, b'{"ok":true}'
        elif self.path == '/swapSetup':
            # Stage 5b: Avi works every day 08:00-16:00 and Dana shares his site c1, so Avi can offer her a shift.
            wc = DB.collection('tenants').document(T1).collection('workers')
            wc.document('w1').update({'schedule': [{'type': 'work', 'start': '08:00', 'end': '16:00'}] * 7})
            wc.document('w2').update({'clientIds': ['c2', 'c1']})
            status, data = 200, b'{"ok":true}'
        elif self.path == '/swapState':
            t1 = DB.collection('tenants').document(T1)
            reqs = {d.id: d.to_dict() for d in t1.collection('shiftRequests').stream()}
            ws = {d.id: (d.to_dict() or {}).get('dateShifts') or {} for d in t1.collection('workers').stream()}
            status, data = 200, json.dumps({'requests': reqs, 'dateShifts': ws}, default=str).encode()
        elif self.path == '/signed':
            # Stage 5c: the client's signed month — the approval document's record and the PDF in Storage.
            docs = [d.to_dict() or {} for d in DB.collection('tenants').document(T1).collection('hourApprovals').stream()]
            sg = next((d['signed'] for d in docs if d.get('kind') == 'client' and d.get('signed')), None)
            pdf = _orig_bucket('demo-schedule.appspot.com').blob(sg['path']).download_as_bytes() if sg else b''
            if pdf:  # kept with the screenshots, to look at
                out = os.environ.get('E2E_OUT') or os.path.join(_HERE, 'out')
                os.makedirs(out, exist_ok=True)
                open(os.path.join(out, 'client-signed-month.pdf'), 'wb').write(pdf)
            status, data = 200, json.dumps({'signed': sg, 'size': len(pdf), 'head': pdf[:8].decode('latin1'), 'pages': pdf.count(b'/Type /Page /'),
                                            'jpegs': pdf.count(b'/Filter /DCTDecode')}, default=str).encode()
        elif self.path == '/contractPdf':
            # A contract template with marks typed in its text (docs/contracts.md): a Hebrew line, a Latin one, a typo.
            import pymupdf
            doc = pymupdf.open(); pg = doc.new_page()
            pg.insert_htmlbox(pymupdf.Rect(40, 60, 550, 160), '<p dir="rtl" style="font-size:12pt">אני {{full_name}} ת.ז. {{id}}' + '&nbsp;' * 12 + 'מסכים. {{tpyo}}</p>')
            pg.insert_text((50, 250), 'Name: {{given}} {{surname}}   Signature: {{signature}}   Date: {{sign_date}}', fontsize=12)
            status, data = 200, doc.tobytes()
        elif self.path == '/contractDocx':
            # a Word contract template with marks (D7)
            sys.path.insert(0, os.path.join(_HERE, '..', 'auth'))
            from test_docx2pdf import docx as _docx
            status, data = 200, _docx()
        elif self.path == '/contractTemplates':
            rows = [dict(d.to_dict() or {}, id=d.id) for d in DB.collection('tenants').document(T1).collection('contractTemplates').stream()]
            status, data = 200, json.dumps(rows, default=str).encode()
        elif self.path == '/transferSetup':
            # D6: firm two's worker gets an ID number, and firm one a contract template (the new firm's contract)
            import pymupdf
            DB.collection('tenants').document(T2).collection('workers').document('w9').update({'docId': '039337423', 'docKeys': ['039337423'],
                'docGiven': 'Other', 'docSurname': 'Worker', 'docType': 'passport', 'notes': 'old firm notes'})
            status, data = 200, b'{"ok":true}'
        elif self.path == '/transferCleanup':
            # the copy made by the transfer check goes, and firm two's worker is as seeded (the later checks count them)
            from google.cloud import firestore as _fs
            for d in DB.collection('tenants').document(T1).collection('workers').stream():
                if (d.to_dict() or {}).get('movedFromOtherFirm'):
                    d.reference.delete()
            DB.collection('tenants').document(T2).collection('workers').document('w9').update({'status': 'active', 'movedToOtherFirm': _fs.DELETE_FIELD,
                'movedAt': _fs.DELETE_FIELD, 'docKeys': _fs.DELETE_FIELD, 'docId': _fs.DELETE_FIELD})
            status, data = 200, b'{"ok":true}'
        elif self.path == '/transferState':
            t1w = [d.to_dict() for d in DB.collection('tenants').document(T1).collection('workers').stream()]
            moved = [w for w in t1w if w.get('movedFromOtherFirm')]
            old = DB.collection('tenants').document(T2).collection('workers').document('w9').get().to_dict() or {}
            reqs = [d.to_dict() for d in DB.collection('transferRequests').stream()]
            status, data = 200, json.dumps({'moved': moved, 'old': {k: old.get(k) for k in ('status', 'movedToOtherFirm', 'clientIds')},
                                            'reqs': [r.get('status') for r in reqs], 'log': len(list(DB.collection('transferLog').stream()))}, default=str).encode()
        elif self.path == '/signRequests':
            rows = [dict(d.to_dict() or {}, id=d.id) for d in DB.collection('tenants').document(T1).collection('signRequests').stream()]
            status, data = 200, json.dumps(rows, default=str).encode()
        elif self.path.startswith('/signedPdf/'):
            # the text of a signed PDF in Storage (a request's part): what was printed
            import pymupdf
            rid, which = self.path.split('/')[2:4]
            r = DB.collection('tenants').document(T1).collection('signRequests').document(rid).get().to_dict() or {}
            pdf = _orig_bucket('demo-schedule.appspot.com').blob(r['parts'][which]['path']).download_as_bytes()
            d = pymupdf.open(stream=pdf)
            out = os.environ.get('E2E_OUT') or os.path.join(_HERE, 'out')
            os.makedirs(out, exist_ok=True)
            open(os.path.join(out, 'signed-' + which + '.pdf'), 'wb').write(pdf)
            status, data = 200, json.dumps({'text': ''.join(pg.get_text() for pg in d), 'pages': d.page_count, 'images': sum(len(pg.get_images()) for pg in d)}).encode()
        elif self.path.startswith('/lang/'):
            DB.collection('tenants').document(T1).set({'language': self.path[6:]}, merge=True)
            status, data = 200, b'{"ok":true}'
        elif self.path == '/punches':
            docs = [d.to_dict() for d in DB.collection('tenants').document(T1).collection('punches').stream()]
            status, data = 200, json.dumps({'n': len(docs), 'ids': sorted(d['id'] if isinstance(d.get('id'), str) else str(d.get('id')) for d in docs), 'days': [d.get('day') for d in docs]}).encode()
        else:
            fn = {'/login': main.login, '/users_admin': main.users_admin, '/punch': main.punch, '/supplier': main.supplier, '/hours': main.hours, '/ai_read': main.ai_read, '/weather': main.weather, '/contract_templates': contract_templates, '/sign_documents': sign_documents, '/worker_docs': worker_docs}[self.path]
            hdr = {'Content-Type': 'application/json'}
            if self.headers.get('Authorization'): hdr['Authorization'] = self.headers['Authorization']
            with app.test_request_context('/', method='POST', data=raw, headers=hdr):
                from flask import request
                r = fn(request)
                status, data = r.status_code, r.get_data()
                # worker_docs answers a raw PDF: its own type and headers go back as they are
                extra = {k: v for k, v in r.headers.items() if k.startswith('X-') or k in ('Content-Type', 'Access-Control-Expose-Headers')} if self.path == '/worker_docs' else {}
        self.send_response(status)
        if 'Content-Type' not in extra: self.send_header('Content-Type', 'application/json')
        for k, v in extra.items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(data)

seed()
print('ready', flush=True)
ThreadingHTTPServer(('127.0.0.1', 5055), H).serve_forever()
