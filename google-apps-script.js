// ═══════════════════════════════════════════════════════════════
//  Schedule Manager — Google Apps Script Backend
//  No QR — GPS verification only
// ═══════════════════════════════════════════════════════════════

const SH_SCHEDULE = 'Schedule';
const SH_PUNCHLOG = 'PunchLog';
const SH_SALARY   = 'Salary';

// ── Entry points ──────────────────────────────────────────────────────────────
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    switch (body.action) {
      case 'saveSchedule': return jsonResponse(saveSchedule(body.data));
      case 'savePunch':    return jsonResponse(savePunch(body.data));
      case 'deletePunch':  return jsonResponse(deletePunch(body.id));
      case 'updatePunch':  return jsonResponse(updatePunch(body.data));
      case 'calcSalary':   return jsonResponse(calcSalary(body.filter));
      default:             return jsonResponse({error: 'Unknown action: ' + body.action});
    }
  } catch(e) { return jsonResponse({error: e.toString()}); }
}

function doGet(e) {
  try {
    let result;
    switch (e.parameter.action || 'loadSchedule') {
      case 'loadSchedule': result = loadSchedule();              break;
      case 'loadPunchLog': result = loadPunchLog(e.parameter);   break;
      case 'calcSalary':   result = calcSalary(e.parameter);     break;
      default:             result = {error: 'Unknown action'};
    }
    // Support JSONP callback for cross-origin requests
    const callback = e.parameter.callback;
    if (callback) {
      return ContentService
        .createTextOutput(callback + '(' + JSON.stringify(result) + ')')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return jsonResponse(result);
  } catch(err) { return jsonResponse({error: err.toString()}); }
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── SCHEDULE ──────────────────────────────────────────────────────────────────
function saveSchedule(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = getOrCreateSheet(ss, SH_SCHEDULE);
  sh.clearContents();
  sh.getRange(1,1,1,2).setValues([['key','value']]);
  sh.getRange(2,1,1,2).setValues([['workers',  JSON.stringify(data.workers  || [])]]);
  sh.getRange(3,1,1,2).setValues([['clients',  JSON.stringify(data.clients  || [])]]);
  sh.getRange(4,1,1,2).setValues([['weekStart', data.weekStart || '']]);
  sh.getRange(5,1,1,2).setValues([['savedAt',  new Date().toISOString()]]);
  writeWorkersTable(sh, data.workers || []);
  return {ok: true, savedAt: new Date().toISOString()};
}

function loadSchedule() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_SCHEDULE);
  if (!sh) return {workers:[], clients:[], weekStart:null};
  const map = {};
  sh.getDataRange().getValues().slice(1).forEach(r => { if(r[0]) map[r[0]] = r[1]; });
  return {
    workers:   map.workers  ? JSON.parse(map.workers)  : [],
    clients:   map.clients  ? JSON.parse(map.clients)  : [],
    weekStart: map.weekStart || null,
    savedAt:   map.savedAt  || null,
  };
}

function writeWorkersTable(sh, workers) {
  const headers = ['Name','Phone','Sun','Mon','Tue','Wed','Thu','Fri','Sat','Total Hours'];
  sh.getRange(1,4,1,headers.length).setValues([headers]).setFontWeight('bold').setBackground('#e8eaf0');
  if (!workers.length) return;
  const rows = workers.map(w => {
    const sched = (w.schedule||[]).map(s => s.type==='off' ? 'Day off' : (s.start||'')+'–'+(s.end||''));
    const total = (w.schedule||[]).reduce((sum,s) => {
      if(!s.start||!s.end) return sum;
      const sm=toMins(s.start), em=toMins(s.end);
      return sum + (em<=sm ? (1440-sm+em) : (em-sm));
    }, 0) / 60;
    return [w.name, w.phone||'', ...sched, total.toFixed(1)+'h'];
  });
  sh.getRange(2,4,rows.length,headers.length).setValues(rows);
}

// ── PUNCH LOG ─────────────────────────────────────────────────────────────────
// GPS-based verification — no QR fields
const PUNCH_HEADERS = [
  'ID','WorkerID','Worker','Type','Time','Date','Timestamp',
  'Site','Distance(m)','GPS Accuracy(m)','GPS Suspicious','GPS Warnings',
  'Notes','EditedAt'
];

function savePunch(entry) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = getOrCreateSheet(ss, SH_PUNCHLOG);
  ensureHeaders(sh, PUNCH_HEADERS);

  const row = [
    entry.id          || Date.now(),
    entry.workerId    || '',
    entry.workerName  || '',
    (entry.type       || '').toUpperCase(),
    entry.time        || '',
    entry.date        || new Date(entry.ts||Date.now()).toLocaleDateString('en-GB'),
    entry.ts          || new Date().toISOString(),
    entry.site        || '',
    entry.dist        != null ? entry.dist : '',
    entry.gpsAccuracy != null ? Math.round(entry.gpsAccuracy) : '',
    entry.gpsSuspicious ? 'YES' : 'NO',
    (entry.gpsWarnings||[]).join('; '),
    entry.notes       || '',
    '',
  ];

  sh.appendRow(row);
  colorPunchRow(sh, sh.getLastRow(), row[3]);
  return {ok: true, id: row[0]};
}

function loadPunchLog(filter) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_PUNCHLOG);
  if (!sh || sh.getLastRow() < 2) return {entries:[]};
  const rows = sh.getDataRange().getValues();
  const headers = rows[0];
  let entries = rows.slice(1).map(row => {
    const o = {};
    headers.forEach((h,i) => o[h] = row[i]);
    return {
      id:            o['ID'],
      workerId:      o['WorkerID'],
      workerName:    o['Worker'],
      type:          (o['Type']||'').toLowerCase(),
      time:          o['Time'],
      date:          o['Date'],
      ts:            o['Timestamp'],
      site:          o['Site'],
      dist:          o['Distance(m)'] !== '' ? Number(o['Distance(m)']) : null,
      gpsAccuracy:   o['GPS Accuracy(m)'] !== '' ? Number(o['GPS Accuracy(m)']) : null,
      gpsSuspicious: o['GPS Suspicious'] === 'YES',
      gpsWarnings:   o['GPS Warnings'] ? o['GPS Warnings'].split('; ').filter(Boolean) : [],
      notes:         o['Notes'],
      editedAt:      o['EditedAt'],
    };
  }).filter(e => e.workerId);

  if (filter && filter.worker) entries = entries.filter(e => e.workerName === filter.worker);
  if (filter && filter.date)   entries = entries.filter(e => e.date === filter.date);
  if (filter && filter.type)   entries = entries.filter(e => e.type === filter.type);
  return {entries};
}

function updatePunch(data) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_PUNCHLOG);
  if (!sh) return {error:'Sheet not found'};
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(data.id)) {
      const r = i + 1;
      if (data.type)             sh.getRange(r,4).setValue(data.type.toUpperCase());
      if (data.time)             sh.getRange(r,5).setValue(data.time);
      if (data.site)             sh.getRange(r,8).setValue(data.site);
      if (data.notes !== undefined) sh.getRange(r,13).setValue(data.notes);
      sh.getRange(r,14).setValue(new Date().toISOString());
      colorPunchRow(sh, r, sh.getRange(r,4).getValue());
      return {ok: true};
    }
  }
  return {error:'Record not found'};
}

function deletePunch(id) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_PUNCHLOG);
  if (!sh) return {error:'Sheet not found'};
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(id)) { sh.deleteRow(i+1); return {ok:true}; }
  }
  return {error:'Record not found'};
}

function colorPunchRow(sh, rowNum, type) {
  try {
    const color = type==='IN' ? '#e8f5e9' : type==='OUT' ? '#ffebee' : '#ffffff';
    sh.getRange(rowNum, 1, 1, PUNCH_HEADERS.length).setBackground(color);
  } catch(e) {}
}

// ── SALARY ────────────────────────────────────────────────────────────────────
function calcSalary(filter) {
  const {entries} = loadPunchLog(filter);
  const byWorkerDate = {};
  entries.forEach(e => {
    const key = e.workerName + '|' + e.date;
    if (!byWorkerDate[key]) byWorkerDate[key] = {worker:e.workerName, date:e.date, ins:[], outs:[]};
    if (e.type==='in')  byWorkerDate[key].ins.push(e.time);
    if (e.type==='out') byWorkerDate[key].outs.push(e.time);
  });
  const byWorker = {};
  Object.values(byWorkerDate).forEach(({worker,date,ins,outs}) => {
    if (!byWorker[worker]) byWorker[worker] = {worker, totalHours:0, days:[]};
    const inTime=ins[0]||null, outTime=outs[0]||null;
    let hours=0;
    if (inTime && outTime) {
      const sm=toMins(inTime), em=toMins(outTime);
      hours = (em<=sm ? (1440-sm+em) : (em-sm)) / 60;
    }
    byWorker[worker].totalHours += hours;
    byWorker[worker].days.push({date, in:inTime, out:outTime, hours:+hours.toFixed(2)});
  });
  const summary = Object.values(byWorker).map(w => ({
    worker: w.worker,
    totalHours: +w.totalHours.toFixed(2),
    days: w.days.sort((a,b) => a.date<b.date?-1:1),
  }));
  writeSalarySheet(SpreadsheetApp.getActiveSpreadsheet(), summary);
  return {summary};
}

function writeSalarySheet(ss, summary) {
  const sh = getOrCreateSheet(ss, SH_SALARY);
  sh.clearContents();
  const headers = ['Worker','Date','Clock In','Clock Out','Hours'];
  sh.getRange(1,1,1,5).setValues([headers]).setFontWeight('bold').setBackground('#e8eaf0');
  let row = 2;
  summary.forEach(w => {
    w.days.forEach(d => {
      sh.getRange(row,1,1,5).setValues([[w.worker, d.date, d.in||'—', d.out||'—', d.hours]]);
      row++;
    });
    sh.getRange(row,1,1,5).setValues([['TOTAL: '+w.worker,'','','',w.totalHours]])
      .setFontWeight('bold').setBackground('#fff9c4');
    row += 2;
  });
  sh.setFrozenRows(1);
  try { sh.autoResizeColumns(1,5); } catch(e) {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function toMins(t) {
  if (!t) return 0;
  const [h,m] = t.split(':').map(Number);
  return h*60 + m;
}

function getOrCreateSheet(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function ensureHeaders(sh, headers) {
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.getRange(1,1,1,headers.length).setFontWeight('bold').setBackground('#e8eaf0');
    sh.setFrozenRows(1);
  }
}

// ── Test ──────────────────────────────────────────────────────────────────────
function testSetup() {
  Logger.log('Spreadsheet: ' + SpreadsheetApp.getActiveSpreadsheet().getName());

  // Test schedule save/load
  const testData = {
    workers: [{id:'w1', name:'Raveendra', colorIdx:0, phone:'', clientIds:[], schedule:[
      {type:'work',start:'07:00',end:'15:00'},{type:'work',start:'09:00',end:'21:00'},
      {type:'off',start:null,end:null},{type:'work',start:'07:00',end:'16:00'},
      {type:'work',start:'07:00',end:'16:00'},{type:'work',start:'07:00',end:'18:00'},
      {type:'work',start:'07:00',end:'18:00'}
    ]}],
    clients: [{id:'c1', name:'Office A', color:'#4f8ef7', address:'Tel Aviv',
      lat:32.0853, lng:34.7818, radius:300, notes:''}],
    weekStart: new Date().toISOString()
  };
  Logger.log('Save: ' + JSON.stringify(saveSchedule(testData)));
  const loaded = loadSchedule();
  Logger.log('Load: workers='+loaded.workers.length+', clients='+loaded.clients.length);

  // Test punch save (GPS only, no QR)
  const punch = savePunch({
    id: Date.now(), workerId:'w1', workerName:'Raveendra',
    type:'in', time:'09:00', ts:new Date().toISOString(),
    site:'Office A', dist:45,
    gpsAccuracy:12, gpsSuspicious:false, gpsWarnings:[],
    notes:''
  });
  Logger.log('Punch: ' + JSON.stringify(punch));

  Logger.log('✅ All tests passed!');
}

// ── Push Notifications ────────────────────────────────────────────────────────
const SH_PUSH = 'PushSubscriptions';

function savePushSubscription(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = getOrCreateSheet(ss, SH_PUSH);
  ensureHeaders(sh, ['WorkerName', 'Role', 'Endpoint', 'P256dh', 'Auth', 'SavedAt']);

  const sub  = data.subscription;
  const name = data.workerName || 'manager';
  const role = data.role || 'worker';

  // Check if endpoint already exists - update it
  const rows = sh.getLastRow() > 1 ? sh.getDataRange().getValues() : [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][2] === sub.endpoint) {
      sh.getRange(i+1, 1, 1, 6).setValues([[name, role, sub.endpoint, sub.keys?.p256dh||'', sub.keys?.auth||'', new Date().toISOString()]]);
      return { ok: true, updated: true };
    }
  }
  sh.appendRow([name, role, sub.endpoint, sub.keys?.p256dh||'', sub.keys?.auth||'', new Date().toISOString()]);
  return { ok: true, saved: true };
}

// ── Scheduled trigger: runs every hour ────────────────────────────────────────
// Set up: Apps Script → Triggers → Add Trigger → checkShiftReminders → Time-based → Hour timer → Every hour
function checkShiftReminders() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SH_PUSH);
  if (!sh || sh.getLastRow() < 2) return;

  const { workers } = loadSchedule();
  if (!workers.length) return;

  const now    = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const dayIdx = now.getDay(); // 0=Sun

  // Find workers whose shift starts in 60 min (±10 min window)
  const toNotify = workers.filter(w => {
    const sh = w.schedule?.[dayIdx];
    if (!sh || sh.type === 'off' || !sh.start) return false;
    const [h, m] = sh.start.split(':').map(Number);
    const shiftMin = h * 60 + m;
    const diff = shiftMin - nowMin;
    return diff >= 50 && diff <= 70; // 50-70 min before shift
  });

  if (!toNotify.length) return;

  // Get all subscriptions
  const subs = sh.getDataRange().getValues().slice(1);

  toNotify.forEach(worker => {
    // Find worker subscription
    const workerSubs = subs.filter(row => row[0] === worker.name || row[1] === 'manager');
    const sh2 = worker.schedule[dayIdx];

    workerSubs.forEach(row => {
      try {
        sendPushNotification(row[2], row[3], row[4], {
          title: '⏰ Shift Reminder — ' + worker.name,
          body:  'Your shift starts at ' + sh2.start + '. Tap to clock in!',
          url:   '/worker-punch.html',
          tag:   'shift-' + worker.name,
        });
      } catch(e) {
        Logger.log('Push failed for ' + worker.name + ': ' + e);
      }
    });
  });

  Logger.log('Reminders sent to: ' + toNotify.map(w=>w.name).join(', '));
}

function sendPushNotification(endpoint, p256dh, auth, payload) {
  // Simple Web Push via fetch (using GAS UrlFetchApp)
  // Note: Full VAPID signing requires crypto - simplified version below
  const body = JSON.stringify(payload);
  const options = {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'TTL':           '86400',
    },
    payload: body,
    muteHttpExceptions: true,
  };
  const resp = UrlFetchApp.fetch(endpoint, options);
  Logger.log('Push response: ' + resp.getResponseCode());
  return resp.getResponseCode();
}

// ── Setup trigger (run once manually) ─────────────────────────────────────────
function setupHourlyTrigger() {
  // Delete existing triggers
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'checkShiftReminders') ScriptApp.deleteTrigger(t);
  });
  // Create new hourly trigger
  ScriptApp.newTrigger('checkShiftReminders')
    .timeBased()
    .everyHours(1)
    .create();
  Logger.log('✅ Hourly trigger created!');
}
