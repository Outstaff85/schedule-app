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

def seed():
    _clear()
    t1, t2 = DB.collection('tenants').document(T1), DB.collection('tenants').document(T2)
    t1.set({'companyName': 'Firm One', 'phone': '0501234567', 'deductionsFileNumber': '012345678', 'street': 'Herzl', 'streetNumber': '1', 'city': 'Haifa'})
    t2.set({'companyName': 'Firm Two', 'phone': '0507654321', 'deductionsFileNumber': '87654321', 'street': 'Bialik', 'streetNumber': '2', 'city': 'Tel Aviv'})
    seed_legacy('u-admin1', 'owner1', 'owner-pass-1', role='tenant_admin', tenantId=T1, permissions='*')
    seed_legacy('u-sup1', 'sup1', 'sup-pass-11', role='supplier', tenantId=T1, permissions='', supplierId='s-1')
    seed_legacy('u-super', 'boss', 'boss-pass-1', role='superadmin', tenantId=None, permissions='*')
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
        if self.path == '/seed':
            seed(); status, data = 200, b'{"ok":true}'
        elif self.path == '/aicalls':
            status, data = 200, json.dumps(CALLS, ensure_ascii=False).encode(); CALLS.clear()
        elif self.path == '/revoke':
            DB.collection('tenants').document(T1).collection('workers').document('w1').update({'token': 'tok-new'})
            status, data = 200, b'{"ok":true}'
        elif self.path.startswith('/lang/'):
            DB.collection('tenants').document(T1).set({'language': self.path[6:]}, merge=True)
            status, data = 200, b'{"ok":true}'
        elif self.path == '/punches':
            docs = [d.to_dict() for d in DB.collection('tenants').document(T1).collection('punches').stream()]
            status, data = 200, json.dumps({'n': len(docs), 'ids': sorted(d['id'] if isinstance(d.get('id'), str) else str(d.get('id')) for d in docs), 'days': [d.get('day') for d in docs]}).encode()
        else:
            fn = {'/login': main.login, '/users_admin': main.users_admin, '/punch': main.punch, '/supplier': main.supplier, '/ai_read': main.ai_read}[self.path]
            hdr = {'Content-Type': 'application/json'}
            if self.headers.get('Authorization'): hdr['Authorization'] = self.headers['Authorization']
            with app.test_request_context('/', method='POST', data=raw, headers=hdr):
                from flask import request
                r = fn(request)
                status, data = r.status_code, r.get_data()
        self.send_response(status); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(data)

seed()
print('ready', flush=True)
ThreadingHTTPServer(('127.0.0.1', 5055), H).serve_forever()
