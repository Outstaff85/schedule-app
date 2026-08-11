// ═══════════════════════════════════════════════════════════════
//  Schedule Manager — Google Apps Script Backend
//  No QR — GPS verification only
//  CHANGES vs your version:
//   • radius is always stored as a NUMBER (default 100m) on save AND load
//   • new human-readable "Clients" tab shows Name/Address/Lat/Lng/Radius
//   • wired up savePushSubscription in doPost (was defined but never reachable)
//  PunchLog handling is UNCHANGED — your existing log is safe.
// ═══════════════════════════════════════════════════════════════

const SH_SCHEDULE = 'Schedule';
const SH_PUNCHLOG = 'PunchLog';
const SH_SALARY   = 'Salary';
const SH_CLIENTS  = 'Clients';
const DEFAULT_RADIUS = 100; // ← standard geofence radius in metres
const SH_BACKUP   = 'Backups';
const SH_ERRORS   = 'Errors';
// Shared key — MUST equal API_SECRET in schedule-manager.html / worker-punch.html.
const API_SECRET  = 'odinson-7Kq2x9';

// ── Entry points ──────────────────────────────────────────────────────────────
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    // Write actions require the shared secret (deterrent against random writes).
    const WRITE = ['saveSchedule','savePunch','deletePunch','updatePunch','savePushSubscription','aiReadDoc','saveWorkerDoc','deleteWorkerDoc'];
    if (WRITE.indexOf(body.action) !== -1 && body.secret !== API_SECRET) {
      return jsonResponse({error: 'Unauthorized'});
    }
    switch (body.action) {
      case 'saveSchedule':         return jsonResponse(saveSchedule(body.data, body.baseSavedAt));
      case 'savePunch':            return jsonResponse(savePunch(body.data));
      case 'deletePunch':          return jsonResponse(deletePunch(body.id));
      case 'updatePunch':          return jsonResponse(updatePunch(body.data));
      case 'calcSalary':           return jsonResponse(calcSalary(body.filter));
      case 'savePushSubscription': return jsonResponse(savePushSubscription(body));
      case 'logError':             return jsonResponse(logError(body));
      case 'aiReadDoc':            return jsonResponse(aiReadDoc(body));
      case 'saveWorkerDoc':        return jsonResponse(saveWorkerDoc(body));
      case 'deleteWorkerDoc':      return jsonResponse(deleteWorkerDoc(body));
      default:                     return jsonResponse({error: 'Unknown action: ' + body.action});
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

// ── Clients: keep geofence fields as clean numbers ────────────────────────────
// radius is ALWAYS coerced to a number; if missing/empty/invalid it falls back to 100m.
function normalizeClients(clients) {
  return (clients || []).map(function(c) {
    var lat    = (c.lat    !== undefined && c.lat    !== null && c.lat    !== '') ? Number(c.lat)    : null;
    var lng    = (c.lng    !== undefined && c.lng    !== null && c.lng    !== '') ? Number(c.lng)    : null;
    var radius = (c.radius !== undefined && c.radius !== null && c.radius !== '') ? Number(c.radius) : DEFAULT_RADIUS;
    if (isNaN(radius) || radius <= 0) radius = DEFAULT_RADIUS;
    if (lat !== null && isNaN(lat)) lat = null;
    if (lng !== null && isNaN(lng)) lng = null;
    return Object.assign({}, c, {lat: lat, lng: lng, radius: radius});
  });
}

// ── SCHEDULE ──────────────────────────────────────────────────────────────────
function saveSchedule(data, baseSavedAt) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = getOrCreateSheet(ss, SH_SCHEDULE);
  const current = readScheduleMap(sh);

  // Empty-payload guard: refuse to overwrite existing data with nothing.
  const incomingEmpty   = (!data.workers || !data.workers.length) && (!data.clients || !data.clients.length);
  const currentHasData  = (current.workers && current.workers.length) || (current.clients && current.clients.length);
  if (incomingEmpty && currentHasData) {
    return {ok:false, skipped:true, reason:'empty-payload-guard', savedAt: current.savedAt};
  }

  // Optimistic concurrency: reject if the client edited an older version.
  if (baseSavedAt && current.savedAt && baseSavedAt !== current.savedAt) {
    return {ok:false, conflict:true, serverSavedAt: current.savedAt};
  }

  const clients = normalizeClients(data.clients || []);
  const savedAt = new Date().toISOString();
  sh.clearContents();
  sh.getRange(1,1,1,2).setValues([['key','value']]);
  sh.getRange(2,1,1,2).setValues([['workers',  JSON.stringify(data.workers || [])]]);
  sh.getRange(3,1,1,2).setValues([['clients',  JSON.stringify(clients)]]);
  sh.getRange(4,1,1,2).setValues([['weekStart', data.weekStart || '']]);
  sh.getRange(5,1,1,2).setValues([['savedAt',  savedAt]]);
  writeWorkersTable(sh, data.workers || []);
  writeClientsTable(ss, clients);
  return {ok: true, savedAt: savedAt};
}

// Read the Schedule key/value sheet into {workers, clients, savedAt}.
function readScheduleMap(sh){
  const map = {};
  if (sh && sh.getLastRow() >= 1) {
    sh.getDataRange().getValues().slice(1).forEach(function(r){ if(r[0]) map[r[0]] = r[1]; });
  }
  var workers = [], clients = [];
  try { workers = map.workers ? JSON.parse(map.workers) : []; } catch(e){}
  try { clients = map.clients ? JSON.parse(map.clients) : []; } catch(e){}
  return { workers: workers, clients: clients, savedAt: map.savedAt || null };
}

// ── Auto-backup ───────────────────────────────────────────────────────────────
// Daily snapshot of the schedule (workers+clients) into a Backups sheet.
// The schedule is the data most at risk from overwrite; PunchLog is append-only.
function backupNow(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = getOrCreateSheet(ss, SH_BACKUP);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['When','Workers','Clients','Schedule JSON']);
    sh.getRange(1,1,1,4).setFontWeight('bold').setBackground('#e8eaf0');
    sh.setFrozenRows(1);
  }
  const m = readScheduleMap(ss.getSheetByName(SH_SCHEDULE) || sh);
  const json = JSON.stringify({ workers: m.workers, clients: m.clients, savedAt: m.savedAt });
  sh.appendRow([ new Date().toISOString(), (m.workers||[]).length, (m.clients||[]).length,
                 json.length < 48000 ? json : '(too large to store inline)' ]);
  const extra = sh.getLastRow() - 1 - 30;   // keep last 30 snapshots
  if (extra > 0) sh.deleteRows(2, extra);
  return {ok:true, savedAt: m.savedAt};
}

function setupDailyBackup(){
  ScriptApp.getProjectTriggers().forEach(function(t){
    if (t.getHandlerFunction() === 'backupNow') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('backupNow').timeBased().everyDays(1).atHour(2).create();
  Logger.log('Daily backup trigger created (runs ~02:00).');
}

// Manual restore: run with the row number from the Backups sheet (2 = newest).
function restoreBackupRow(rowNum){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SH_BACKUP);
  if (!sh) return {error:'No Backups sheet'};
  const json = sh.getRange(rowNum, 4).getValue();
  if (!json) return {error:'No JSON in that row'};
  const d = JSON.parse(json);
  return saveSchedule({ workers: d.workers||[], clients: d.clients||[], weekStart: d.weekStart||'' }, null);
}

function loadSchedule() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_SCHEDULE);
  if (!sh) return {workers:[], clients:[], weekStart:null};
  const map = {};
  sh.getDataRange().getValues().slice(1).forEach(r => { if(r[0]) map[r[0]] = r[1]; });
  return {
    workers:   map.workers  ? JSON.parse(map.workers)  : [],
    clients:   map.clients  ? normalizeClients(JSON.parse(map.clients)) : [],   // ← radius guaranteed numeric
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

// Human-readable Clients tab so you can SEE the geofence radius in the sheet.
function writeClientsTable(ss, clients) {
  const sh = getOrCreateSheet(ss, SH_CLIENTS);
  sh.clearContents();
  const headers = ['Name','Address','Latitude','Longitude','Radius (m)','Notes'];
  sh.getRange(1,1,1,headers.length).setValues([headers]).setFontWeight('bold').setBackground('#e8eaf0');
  if (clients.length) {
    const rows = clients.map(c => [
      c.name || '',
      c.address || '',
      c.lat != null ? c.lat : '',
      c.lng != null ? c.lng : '',
      c.radius != null ? c.radius : DEFAULT_RADIUS,
      c.notes || '',
    ]);
    sh.getRange(2,1,rows.length,headers.length).setValues(rows);
  }
  sh.setFrozenRows(1);
  try { sh.autoResizeColumns(1, headers.length); } catch(e) {}
}

// ── PUNCH LOG (unchanged from your version) ───────────────────────────────────
const PUNCH_HEADERS = [
  'ID','WorkerID','Worker','Type','Time','Date','Timestamp',
  'Site','Distance(m)','GPS Accuracy(m)','GPS Suspicious','GPS Warnings',
  'Notes','EditedAt','ClientID'
];

// One-time migration: appends the 'ClientID' header to an existing PunchLog
// sheet that predates this column, without touching any existing rows/columns.
// Run once from the Apps Script editor after deploying this version.
function migrateAddClientIdColumn(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_PUNCHLOG);
  if (!sh || sh.getLastRow() === 0) return {ok:true, note:'sheet empty or missing, nothing to migrate'};
  const headers = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  if (headers.indexOf('ClientID') === -1) {
    const col = headers.length + 1;
    sh.getRange(1, col).setValue('ClientID').setFontWeight('bold').setBackground('#e8eaf0');
    return {ok:true, addedAtColumn: col};
  }
  return {ok:true, note:'ClientID column already present'};
}

// One-time fix: an earlier version of PUNCH_HEADERS didn't have 'GPS Suspicious'/
// 'GPS Warnings' — those fields' DATA has been written to columns K:L ever since
// they were added to the code, but this sheet's row-1 LABELS were never updated
// (ensureHeaders only writes headers to a brand-new, empty sheet), so K:L still
// show the old 'Notes'/'EditedAt' labels while the real Notes/EditedAt data lives
// unlabeled in M:N. loadPunchLog() reads by header name, so this silently hid
// GPS Suspicious/Warnings and Notes/EditedAt from the app. Rewrites K1:N1 text
// only — never touches any data row. Safe to run more than once.
function fixPunchLogHeaderDrift(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_PUNCHLOG);
  if (!sh || sh.getLastRow() === 0) return {ok:true, note:'sheet empty or missing, nothing to fix'};
  const headers = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  if (headers[10] === 'GPS Suspicious' && headers[11] === 'GPS Warnings') {
    return {ok:true, note:'headers already correct'};
  }
  sh.getRange(1,11,1,4).setValues([['GPS Suspicious','GPS Warnings','Notes','EditedAt']]);
  return {ok:true, fixedColumns:'K:N'};
}

// One-time fix: column J's header is still the legacy 'QR Verified' label from
// before the app switched to GPS-only verification — the code has positionally
// written GPS accuracy into that same column ever since, so loadPunchLog()'s
// o['GPS Accuracy(m)'] name-based lookup has silently never matched it. Rewrites
// J1 text only. Safe to run more than once.
function fixGpsAccuracyHeaderLabel(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_PUNCHLOG);
  if (!sh || sh.getLastRow() === 0) return {ok:true, note:'sheet empty or missing, nothing to fix'};
  const cur = sh.getRange(1,10).getValue();
  if (cur === 'GPS Accuracy(m)') return {ok:true, note:'header already correct'};
  sh.getRange(1,10).setValue('GPS Accuracy(m)');
  return {ok:true, fixedColumn:'J', from: cur, to:'GPS Accuracy(m)'};
}

// One-time backfill: punches recorded with site:'Office A' predate the clientId
// field and predate client c1 being renamed from its old seed name 'Office A' to
// its current name — so their historical client link is unrecoverable from the
// name alone. Sets clientId='c1' only on rows that still have no clientId, so
// it's safe to run more than once and never overwrites a punch that already has
// a (possibly different, correctly-chosen) clientId.
function backfillOfficeAClientId(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_PUNCHLOG);
  if (!sh || sh.getLastRow() < 2) return {ok:true, note:'no data'};
  const rows = sh.getDataRange().getValues();
  const headers = rows[0];
  const siteCol = headers.indexOf('Site');
  const clientIdCol = headers.indexOf('ClientID');
  if (siteCol === -1 || clientIdCol === -1) return {error:'Site or ClientID header not found'};
  let fixed = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][siteCol] === 'Office A' && !rows[i][clientIdCol]) {
      sh.getRange(i+1, clientIdCol+1).setValue('c1');
      fixed++;
    }
  }
  return {ok:true, fixed};
}

// Visual formatting pass for PunchLog — bolds/colors the header row and freezes
// it, and auto-fits column widths, matching the style already used for the
// Clients/Backups/Errors tabs. Formatting only, never touches any data. Safe to
// run more than once (and worth re-running after adding a column, since new
// header cells don't inherit the existing bold/background styling).
function formatPunchLogSheet(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_PUNCHLOG);
  if (!sh || sh.getLastRow() === 0) return {ok:true, note:'sheet empty or missing'};
  const lastCol = sh.getLastColumn();
  sh.getRange(1,1,1,lastCol).setFontWeight('bold').setBackground('#e8eaf0');
  sh.setFrozenRows(1);
  try { sh.autoResizeColumns(1, lastCol); } catch(e) {}
  return {ok:true, columns: lastCol};
}

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
    entry.date        || Utilities.formatDate(new Date(entry.ts||Date.now()), 'Asia/Jerusalem', 'dd/MM/yyyy'),
    entry.ts          || new Date().toISOString(),
    entry.site        || '',
    entry.dist        != null ? entry.dist : '',
    entry.gpsAccuracy != null ? Math.round(entry.gpsAccuracy) : '',
    entry.gpsSuspicious ? 'YES' : 'NO',
    (entry.gpsWarnings||[]).join('; '),
    entry.notes       || '',
    '',
    entry.clientId     || '',
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
      time:          (o['Time'] instanceof Date) ? Utilities.formatDate(o['Time'], _TZ_(), 'HH:mm') : (o['Time']==null?'':String(o['Time'])),
      date:          (o['Date'] instanceof Date) ? Utilities.formatDate(o['Date'], _TZ_(), 'dd/MM/yyyy') : o['Date'],
      ts:            (o['Timestamp'] instanceof Date) ? o['Timestamp'].toISOString() : o['Timestamp'],
      site:          o['Site'],
      dist:          o['Distance(m)'] !== '' ? Number(o['Distance(m)']) : null,
      gpsAccuracy:   o['GPS Accuracy(m)'] !== '' ? Number(o['GPS Accuracy(m)']) : null,
      gpsSuspicious: o['GPS Suspicious'] === 'YES',
      gpsWarnings:   o['GPS Warnings'] ? String(o['GPS Warnings']).split('; ').filter(Boolean) : [],
      notes:         o['Notes'],
      editedAt:      o['EditedAt'],
      clientId:      o['ClientID'] || null,
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
      if (data.type)                    sh.getRange(r,4).setValue(data.type.toUpperCase());
      if (data.time)                    sh.getRange(r,5).setValue(data.time);
      if (data.site)                    sh.getRange(r,8).setValue(data.site);
      if (data.notes !== undefined)     sh.getRange(r,13).setValue(data.notes);
      if (data.clientId !== undefined)  sh.getRange(r,15).setValue(data.clientId || '');
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

function _TZ_(){ return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || 'Asia/Jerusalem'; }
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

// ── Test (run this once to confirm radius persists) ───────────────────────────
function testSetup() {
  Logger.log('Spreadsheet: ' + SpreadsheetApp.getActiveSpreadsheet().getName());
  const testData = {
    workers: [{id:'w1', name:'Raveendra', colorIdx:0, phone:'', clientIds:['c1'], schedule:[
      {type:'work',start:'07:00',end:'15:00'},{type:'work',start:'09:00',end:'21:00'},
      {type:'off',start:null,end:null},{type:'work',start:'07:00',end:'16:00'},
      {type:'work',start:'07:00',end:'16:00'},{type:'work',start:'07:00',end:'18:00'},
      {type:'work',start:'07:00',end:'18:00'}
    ]}],
    clients: [{id:'c1', name:'Office A', color:'#4f8ef7', address:'Tel Aviv',
      lat:32.0853, lng:34.7818, radius:150, notes:''}],   // custom radius to prove persistence
    weekStart: new Date().toISOString()
  };
  Logger.log('Save: ' + JSON.stringify(saveSchedule(testData)));
  const loaded = loadSchedule();
  Logger.log('Load radius (should be 150): ' + (loaded.clients[0] && loaded.clients[0].radius));
  Logger.log('Done.');
}

// ── AI document reader (passport + Israeli ID via Anthropic Vision) ─────────────
// Ключ хранится в Script Properties: ANTHROPIC_API_KEY
// Модель: ANTHROPIC_MODEL (по умолчанию claude-haiku-4-5-20251001)
// Стоимость: ~$0.002 за скан (Haiku). Кэширует системный промпт (экономия ~10%).
function aiReadDoc(body){
  var props = PropertiesService.getScriptProperties();
  var key   = props.getProperty('ANTHROPIC_API_KEY');
  var model = props.getProperty('ANTHROPIC_MODEL') || 'claude-haiku-4-5-20251001';
  if(!key)        return {error:'ANTHROPIC_API_KEY не задан в Script Properties'};
  if(!body.image) return {error:'Нет изображения'};

  var SYSTEM = 'You are a document reader for passports and Israeli ID cards (תעודת זהות). ' +
    'Extract ALL relevant fields and return ONLY valid JSON — no prose, no markdown, no code fences. ' +
    'For a foreign PASSPORT return: ' +
    '{"type":"passport","surname":"...","given":"...","passportNo":"...","nationality":"...","dob":"DD/MM/YYYY","sex":"M or F","expiry":"DD/MM/YYYY","issuer":"..."} ' +
    'For an ISRAELI ID (תעודת זהות / biometric passport) return: ' +
    '{"type":"israeli_id","surname":"...","given":"...","idNo":"9-digit number","dob":"DD/MM/YYYY","sex":"M or F","address":"...","city":"...","expiry":"DD/MM/YYYY","children":[{"name":"...","idNo":"9-digit number or empty","dob":"DD/MM/YYYY"}]} ' +
    'Rules: dates always DD/MM/YYYY. Names exactly as printed. ' +
    'For Israeli ID the surname is שם משפחה, given name is שם פרטי, ID number is מספר זהות (9 digits). ' +
    'The address is usually on the back/appendix card (ספח לתעודת זהות), which has THREE separate labeled rows: ' +
    'מען (street name), מס\' בית (house/building number), and ישוב (city/town name). ' +
    'Combine מען and מס\' בית into the "address" field as "STREET NUMBER" (e.g. "יהודה הלוי 16"), ' +
    'and put ישוב alone into the "city" field (e.g. "פתח תקווה") — do not mix them up or put the city in "address". ' +
    'The back/appendix card (ספח) sometimes also lists the holder\'s registered children (ילדים) with their own name/ID/birth date rows — ' +
    'if such a section is present and populated, extract each child into the "children" array; if absent or empty, return "children":[]. ' +
    'If a field is not visible or unreadable use empty string. ' +
    'Also include a top-level "imageAlign" object (for both document types) describing how to straighten the ORIGINAL photo: ' +
    '{"rotate":0,"crop":{"x0":0,"y0":0,"x1":1,"y1":1},"corners":{"tl":{"x":0,"y":0},"tr":{"x":1,"y":0},"br":{"x":1,"y":1},"bl":{"x":0,"y":1}}} — ' +
    '"rotate" is the clockwise degrees needed to make the document upright and right-reading, and MUST be exactly one of 0, 90, 180, 270 (use 0 if already upright); ' +
    '"corners" are the document\'s four actual physical corners (tl/tr/br/bl = top-left/top-right/bottom-right/bottom-left AS THE DOCUMENT WILL APPEAR AFTER "rotate" is applied, but each point\'s x/y given as fractions, 0 to 1, of the ORIGINAL pre-rotation image width/height) — trace the document\'s true outline even if the photo was taken at an angle (so the four points form a skewed quadrilateral, not necessarily an axis-aligned rectangle), never cutting off any printed text, photo, or edge; ' +
    '"crop" is a simple axis-aligned bounding box fallback covering the same area (x0/y0 top-left, x1/y1 bottom-right, each 0 to 1, measured against the same pre-rotation image) — kept only for older clients that don\'t use "corners". ' +
    'If the document already fills the frame, use the full-frame defaults shown above. ' +
    'Return ONLY the JSON object.';

  var payload = {
    model: model,
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: SYSTEM,
          cache_control: {type: 'ephemeral'}
        },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: body.mediaType || 'image/jpeg',
            data: body.image
          }
        },
        {
          type: 'text',
          text: 'Read this document and return the JSON object only.'
        }
      ]
    }]
  };

  var opts = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var res;
  try { res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', opts); }
  catch(e){ return {error:'Запрос к Anthropic не прошёл: ' + e}; }

  var json;
  try { json = JSON.parse(res.getContentText()); }
  catch(e){ return {error:'Неверный ответ от Anthropic (HTTP ' + res.getResponseCode() + ')'}; }

  if(json.error) return {error: json.error.message || 'Ошибка Anthropic'};

  var text = '';
  (json.content || []).forEach(function(c){ if(c.type === 'text') text += c.text; });

  // strip any accidental markdown fences
  text = text.replace(/```json|```/g,'').trim();
  var m = text.match(/\{[\s\S]*\}/);

  var parsed;
  try { parsed = JSON.parse(m ? m[0] : text); }
  catch(e){ return {error:'AI вернул нечитаемый ответ', raw: String(text).slice(0,400)}; }

  return {ok: true, parsed: parsed};
}

// ── Worker document storage (Drive) ────────────────────────────────────────────
// Saves an assembled worker PDF (Form 101 + signature + ID scan, combined
// client-side) into Drive under "Schedule manager APP/Workers", named by the
// client-supplied fileName (already built from the worker's name + doc number).
// Re-uploading with the same fileName replaces the previous file, so this is
// safe to call again after a re-scan without piling up duplicates.
function saveWorkerDoc(body){
  try{
    if(!body.fileBase64 || !body.fileName) return {error:'Нет fileBase64 или fileName'};
    const rootIter = DriveApp.getFoldersByName('Schedule manager APP');
    const root = rootIter.hasNext() ? rootIter.next() : DriveApp.createFolder('Schedule manager APP');
    const subIter = root.getFoldersByName('Workers');
    const folder = subIter.hasNext() ? subIter.next() : root.createFolder('Workers');

    // Prefer trashing the exact previous file by ID (stable across rescans,
    // where the OCR'd name/doc-number baked into fileName can drift and no
    // longer match the old file) — fall back to name matching for callers
    // that don't know their previous file's ID yet.
    if(body.previousFileId){
      try{ DriveApp.getFileById(body.previousFileId).setTrashed(true); }catch(e){}
    }
    const existing = folder.getFilesByName(body.fileName);
    while(existing.hasNext()) existing.next().setTrashed(true);
    // Automatic dedup: fileName is <docNumber>_<given>_<surname>.pdf (or the
    // legacy form101_<surname>_<docNumber>.pdf for older uploads) — either way
    // the ID/passport number is the one part that never changes between
    // rescans, even when OCR reads the name slightly differently each time.
    // Trash every other file in the folder sharing that same number so a
    // rescan can never pile up as a duplicate, regardless of naming drift.
    const docNumber = extractDocNumberFromFileName(body.fileName);
    if(docNumber){
      const all = folder.getFiles();
      while(all.hasNext()){
        const f = all.next();
        if(f.getName() !== body.fileName && extractDocNumberFromFileName(f.getName()) === docNumber){
          f.setTrashed(true);
        }
      }
    }

    const bytes = Utilities.base64Decode(body.fileBase64);
    const blob = Utilities.newBlob(bytes, body.mimeType || 'application/pdf', body.fileName);
    const file = folder.createFile(blob);
    // Link-accessible (not publicly indexed) so the manager's browser can open/
    // download it straight from the app without needing to be signed into this
    // Google account — the file still contains sensitive personal data (ID/
    // passport scans), so treat the link itself as something to keep private.
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return {ok:true, url: file.getUrl(), id: file.getId()};
  }catch(e){ return {error: e.toString()}; }
}

// Pulls the longest run of 5+ digits out of a worker doc filename — the
// ID/passport number, which is the one stable identifier across rescans
// (names can be OCR'd differently each time, the document number can't).
function extractDocNumberFromFileName(name){
  const matches = String(name||'').match(/\d{5,}/g);
  if(!matches) return null;
  return matches.reduce((a,b)=>b.length>a.length?b:a, '');
}

// Trashes a worker's stored PDF from Drive (called when the worker is deleted
// in the app, so removing a worker doesn't leave orphaned documents behind).
// Prefers a direct fileId; falls back to looking the file up by name inside
// the same "Schedule manager APP/Workers" folder used by saveWorkerDoc.
function deleteWorkerDoc(body){
  try{
    if(body.fileId){
      DriveApp.getFileById(body.fileId).setTrashed(true);
      return {ok:true};
    }
    if(body.fileName){
      const rootIter = DriveApp.getFoldersByName('Schedule manager APP');
      if(!rootIter.hasNext()) return {ok:true};
      const subIter = rootIter.next().getFoldersByName('Workers');
      if(!subIter.hasNext()) return {ok:true};
      const folder = subIter.next();
      const existing = folder.getFilesByName(body.fileName);
      while(existing.hasNext()) existing.next().setTrashed(true);
      return {ok:true};
    }
    return {error:'Нет fileId или fileName'};
  }catch(e){ return {error: e.toString()}; }
}

// ── Error telemetry ────────────────────────────────────────────────────────────
// Client-side errors land here so you can see failures without waiting for a complaint.
function logError(data){
  try{
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = getOrCreateSheet(ss, SH_ERRORS);
    if (sh.getLastRow() === 0) {
      sh.appendRow(['When','Page','Role','Worker','Message','Source','Stack']);
      sh.getRange(1,1,1,7).setFontWeight('bold').setBackground('#ffebee');
      sh.setFrozenRows(1);
    }
    const clip = function(v,n){ return String(v==null?'':v).slice(0,n); };
    sh.appendRow([
      new Date().toISOString(),
      clip(data.page,200), clip(data.role,40), clip(data.worker,80),
      clip(data.message,500), clip(data.source,300), clip(data.stack,1200)
    ]);
    const extra = sh.getLastRow() - 1 - 500;   // keep last 500 errors
    if (extra > 0) sh.deleteRows(2, extra);
    return {ok:true};
  }catch(e){ return {error:e.toString()}; }
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
function checkShiftReminders() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SH_PUSH);
  if (!sh || sh.getLastRow() < 2) return;
  const { workers } = loadSchedule();
  if (!workers.length) return;
  const now    = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const dayIdx = now.getDay();
  const toNotify = workers.filter(w => {
    const s = w.schedule?.[dayIdx];
    if (!s || s.type === 'off' || !s.start) return false;
    const [h, m] = s.start.split(':').map(Number);
    const diff = (h*60+m) - nowMin;
    return diff >= 50 && diff <= 70;
  });
  if (!toNotify.length) return;
  const subs = sh.getDataRange().getValues().slice(1);
  toNotify.forEach(worker => {
    const workerSubs = subs.filter(row => row[0] === worker.name || row[1] === 'manager');
    const s2 = worker.schedule[dayIdx];
    workerSubs.forEach(row => {
      try {
        sendPushNotification(row[2], row[3], row[4], {
          title: 'Shift Reminder — ' + worker.name,
          body:  'Your shift starts at ' + s2.start + '. Tap to clock in!',
          url:   '/worker-punch.html',
          tag:   'shift-' + worker.name,
        });
      } catch(e) { Logger.log('Push failed for ' + worker.name + ': ' + e); }
    });
  });
  Logger.log('Reminders sent to: ' + toNotify.map(w=>w.name).join(', '));
}

function sendPushNotification(endpoint, p256dh, auth, payload) {
  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'TTL': '86400' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };
  const resp = UrlFetchApp.fetch(endpoint, options);
  Logger.log('Push response: ' + resp.getResponseCode());
  return resp.getResponseCode();
}

function setupHourlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'checkShiftReminders') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkShiftReminders').timeBased().everyHours(1).create();
  Logger.log('Hourly trigger created!');
}
