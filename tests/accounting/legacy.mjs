// The Accounting tab's figures as they were in schedule-manager.html before
// stage 6e of the React migration (docs/react-migration-plan.md), from main at
// 7d113d5 — never edit. tests/accounting/compare.test.mjs runs it and
// src/manager/accounting.ts on the same data and requires identical figures.
//
// Part 1 is copied verbatim by a script (the page's functions by name).
// Part 2 is the arithmetic of the page's draw and export functions
// (renderSalary, renderAccFigs, renderSupplierPayable, renderHrPayable,
// renderClientBillable, openSupplierPayDetail, openClientBillDetail,
// openPayModal, exportSalary, exportAccountantReport, exportPayableSummary,
// renderHourApprovals), copied line for line with the HTML left out; each
// returns the figures the old page showed or wrote.
//
// legacyAccounting(env): env = { workers, clients, suppliers, log, tr, uiLocale,
// session, hrUsers, isFirmAdmin, Payroll } — the page's globals.
export function legacyAccounting(env) {
  const { workers, clients, suppliers, tr, Payroll } = env;
  const getPunchLog = () => env.log;
  const uiLocale = () => env.uiLocale || 'en';
  const getSession = () => env.session;
  const hrPayOnly = () => !!env.session && env.session.role === 'hr';
  const hrUsers = () => env.hrUsers || [];
  const isFirmAdminSession = () => !!env.isFirmAdmin;
  // The page's payroll wrappers (unchanged by stage 6e).
  const PAY_RULES = Payroll.PAY_RULES;
  function israeliDayPay(hours, rate, isSat){ return Payroll.israeliDayPay(hours, rate, isSat); }
  function effectiveRates(w, clientId){ return Payroll.effectiveRates(w, clientId, clients); }
  function wRegRate(w,clientId){ return effectiveRates(w,clientId).regRate; }
  function analyzeDayPunches(entries,date){ return Payroll.analyzeDayPunches(entries,date,{tr}); }
  function groupPunchesIntoShifts(entries){ return Payroll.groupPunchesIntoShifts(entries); }
  function isDailyPay(w){ return Payroll.isDailyPay(w); }
  function dailyRate(w){ return Payroll.dailyRate(w); }
  function shiftPayFor(hours, w, isSat, clientId, date, seenDays){ return Payroll.shiftPayFor(hours, w, isSat, clientId, date, seenDays, clients); }
  function travelPay(w, days, months){ return Payroll.travelPay(w, days, months); }
  function salaryPeriodKey(period, now){ return Payroll.salaryPeriodKey(period, now); }
  function dayOverride(w, key){ return Payroll.dayOverride(w, key); }
  function localYMD(d){ return Payroll.localYMD(d); }
  function wOwnRate(w){ return Payroll.wOwnRate(w); }
  // The places a tap opened: returned as [what, id] so the targets compare.
  const openWorkerCardById = id => ['worker', id], openPayModal = id => ['pay', id], openEditClient = id => ['client', id];

// ── Part 1: verbatim ──
function workerDocId(w){
  if(w.docId) return w.docId;
  const m = LEGACY_DOC_IN_ADDRESS.exec(w.address || '');
  return m ? m[1] : '';
}
const LEGACY_DOC_IN_ADDRESS = /^\s*(?:ת\.ז\.|Passport)\s*(\S+)\s*$/;
function clientBillRate(client){
  const v = client && (client.billRate!=null && client.billRate!=='' ? client.billRate : client.defaultHourlyRate);
  return Number(v)||0;
}
function clientBillPay(hours, client, isSat){
  if(!client) return 0;
  if(client.rateMode==='fixed') return hours*(Number(client.fixedBillRate)||0);
  // By the day: one dailyBillRate for each worked shift, whatever its hours.
  if(client.rateMode==='daily') return hours>0 ? (Number(client.dailyBillRate)||0) : 0;
  const rate=clientBillRate(client), has=v=>v!=null&&v!=='';
  if(isSat){
    if(has(client.billShabbatRate)) return hours*Number(client.billShabbatRate);
    return israeliDayPay(hours, rate, true).total;
  }
  if(has(client.billOtRate)){ const RM=PAY_RULES.regularMax; return Math.min(hours,RM)*rate + Math.max(hours-RM,0)*Number(client.billOtRate); }
  return israeliDayPay(hours, rate, false).total;
}
function salaryEntriesFor(period){
  const log      = getPunchLog();
  const now      = new Date();
  let filtered   = log;

  if(period==='week'){
    const ws=new Date(now); ws.setDate(ws.getDate()-ws.getDay()); ws.setHours(0,0,0,0);
    filtered=log.filter(e=>new Date(e.ts)>=ws);
  } else if(period==='month'){
    const ms=new Date(now.getFullYear(),now.getMonth(),1);
    filtered=log.filter(e=>new Date(e.ts)>=ms);
  } else if(/^m:\d{4}-\d{2}$/.test(period)){
    const [y,m]=period.slice(2).split('-').map(Number);
    const from=new Date(y,m-1,1), to=new Date(y,m,1);
    filtered=log.filter(e=>{ const d=new Date(e.ts); return d>=from && d<to; });
  }

  // Pair IN/OUT per worker into shifts (workerId-keyed so two workers who share a
  // display name never get merged; shift-based so overnight shifts stay intact)
  const byWorkerPunches={};
  filtered.forEach(e=>{ (byWorkerPunches[e.workerId]=byWorkerPunches[e.workerId]||[]).push(e); });
  const byWorkerDay={};
  Object.entries(byWorkerPunches).forEach(([wid,list])=>{
    groupPunchesIntoShifts(list).forEach((bucket,i)=>{
      byWorkerDay[wid+'|'+i]={worker:list[0].workerName,workerId:wid,date:bucket.date,entries:bucket.entries};
    });
  });

  // Sum hours + Israeli pay per worker, flagging anomalies
  const byWorker={};
  const byClient={};
  Object.values(byWorkerDay).forEach(({worker,workerId,date,entries})=>{
    if(!byWorker[workerId]) byWorker[workerId]={worker,workerId,hours:0,days:0,regH:0,otH:0,shabH:0,total:0,travel:0,warns:[],clientHours:{},seen:new Set(),dayKeys:new Set()};
    const _res=analyzeDayPunches(entries,date);
    const _dstr=date.toLocaleDateString('en-GB');
    _res.warnings.forEach(wn=> byWorker[workerId].warns.push(_dstr+': '+wn));
    const h=_res.hours;
    if(h>0){
      const isSat=date.getDay()===6, RM=PAY_RULES.regularMax;
      const wc=workers.find(w=>w.id===workerId);
      if(isSat){ byWorker[workerId].shabH+=h; }
      else { byWorker[workerId].regH+=Math.min(h,RM); byWorker[workerId].otH+=Math.max(h-RM,0); }
      byWorker[workerId].hours+=h;
      byWorker[workerId].days++;
      // The shift's own clientId (from its opening IN punch) picks up any
      // per-client rate override — a worker who worked at two clients with
      // different rates in the same period still gets each shift priced
      // correctly, even though this table shows one summed row per worker.
      const cid=entries[0]&&entries[0].clientId;
      byWorker[workerId].total+=shiftPayFor(h,wc,isSat,cid,date,byWorker[workerId].seen);
      // The supplier's own commission, shift by shift (its rate on that date).
      if(wc && wc.supplierId){ const sp=suppliers.find(s=>s.id===wc.supplierId), bw=byWorker[workerId];
        bw.supCom=(bw.supCom||0)+supplierShiftCommission(sp&&sp.commission, h, date, bw.supDays||(bw.supDays=new Set())); }
      byWorker[workerId].dayKeys.add(localYMD(date));
      if(cid) byWorker[workerId].clientHours[cid]=(byWorker[workerId].clientHours[cid]||0)+h;
      // Billable-by-client — a parallel, independent figure (see
      // clientBillPay()'s own comment); never derived from/feeding the
      // worker's own wage line above.
      if(cid){
        if(!byClient[cid]) byClient[cid]={hours:0,total:0};
        const cl=clients.find(c=>c.id===cid);
        byClient[cid].hours+=h;
        byClient[cid].total+=clientBillPay(h,cl,isSat);
      }
    }
  });
  // Days worked (from the punches) and, for a daily-paid worker, days set by
  // hand for this period replace the counted ones.
  const periodKey=salaryPeriodKey(period);
  Object.values(byWorker).forEach(e=>{
    e.countedDays=e.dayKeys.size;
    const wc=workers.find(w=>w.id===e.workerId), ov=isDailyPay(wc)?dayOverride(wc,periodKey):null;
    if(ov!=null) e.total=ov*dailyRate(wc);
    e.daysUsed=ov!=null?ov:e.countedDays;
    e.travel=travelPay(wc,e.daysUsed,new Set([...e.dayKeys].map(k=>k.slice(0,7))).size);
  });

  return {byWorker, byClient};
}
const SUPPLIER_DEFAULT_RATE = 5;
function supplierCommissionRate(w, supplierId){
  const ov = w.supplierRates && w.supplierRates[supplierId];
  return (ov && ov.rate!=null) ? ov.rate : SUPPLIER_DEFAULT_RATE;
}
function supplierDayCommission(w, supplierId){
  const ov = w.supplierRates && w.supplierRates[supplierId];
  return (ov && ov.dayRate!=null) ? ov.dayRate : null;
}
function commissionFor(w, e, hourRate, dayRate){
  if(isDailyPay(w) && Number(dayRate)>0) return (Number(e.daysUsed!=null?e.daysUsed:e.days)||0)*Number(dayRate);
  return (Number(e.hours)||0)*(Number(hourRate)||0);
}
function supplierRateOn(list, date){
  const d=localYMD(date); let best=null;
  (list||[]).forEach(x=>{ if(x && (!x.from || x.from<=d) && (!best || String(x.from||'')>=String(best.from||''))) best=x; });
  return best && best.rate!=null && best.rate!=='' ? best : null;  // an emptied rate = the default from its date
}
function supplierShiftCommission(list, h, date, seenDays){
  const r=supplierRateOn(list, date);
  if(!r) return h*SUPPLIER_DEFAULT_RATE;
  if(r.mode==='day'){ const k=localYMD(date); if(seenDays.has(k)) return 0; seenDays.add(k); return Number(r.rate)||0; }
  return h*(Number(r.rate)||0);
}
function workerHasSupplierOverride(w, sid){
  const ov=w && w.supplierRates && w.supplierRates[sid];
  return !!ov && (ov.rate!=null || (isDailyPay(w) && Number(ov.dayRate)>0));
}
function supplierCommission(wc, e, sid){
  if(workerHasSupplierOverride(wc, sid)) return commissionFor(wc, e, supplierCommissionRate(wc, sid), supplierDayCommission(wc, sid));
  return Number(e.supCom)||0;
}
function accAlerts(entries, byClient){
  const out=[], money=n=>'₪'+Math.round(Number(n)||0);
  entries.forEach(e=>{
    const wc=workers.find(w=>w.id===e.workerId); if(!wc) return;
    (e.warns||[]).forEach(wn=>{
      if(/still at work/.test(wn)) return;
      const m=String(wn).match(/^([^:]+):\s*(.*)$/), date=m?m[1]:'', text=m?m[2]:wn;
      out.push({sec:'punch', lvl:/open shift|>12h/.test(text)?'amber':'red', icon:'ti-clock-exclamation', title:text, sub:[e.worker, date].filter(Boolean).join(' · '), fn:()=>openWorkerCardById(wc.id)});
    });
    const mainCid=Object.entries(e.clientHours||{}).sort((a,b)=>b[1]-a[1]).map(x=>x[0])[0]||(wc.clientIds||[])[0]||'';
    const own=wOwnRate(wc);
    if(isDailyPay(wc)){ if(own==='') out.push({sec:'pay', lvl:'red', icon:'ti-calendar-dollar', title:tr('No daily rate — pay 0'), sub:e.worker+' · '+tr('{n} days',{n:e.daysUsed}), fn:()=>openPayModal(wc.id)}); }
    else if(own==='' && !(effectiveRates(wc,mainCid).regRate>0)) out.push({sec:'pay', lvl:'red', icon:'ti-cash-off', title:tr('No rate — pay 0'), sub:e.worker+' · '+tr('{h}h',{h:e.hours.toFixed(1)}), fn:()=>openPayModal(wc.id)});
    if(!(wc.bank||wc.bankBranch||wc.bankAccountNumber)) out.push({sec:'pay', lvl:'amber', icon:'ti-building-bank', title:tr('No bank details'), sub:e.worker+(e.total>0?' · '+money(e.total):''), fn:()=>openPayModal(wc.id)});
  });
  Object.entries(byClient||{}).forEach(([cid,v])=>{
    const c=clients.find(x=>x.id===cid); if(!c || !(v.hours>0)) return;
    const has=c.rateMode==='fixed'?Number(c.fixedBillRate)>0:c.rateMode==='daily'?Number(c.dailyBillRate)>0:clientBillRate(c)>0;
    if(!has) out.push({sec:'client', lvl:'red', icon:'ti-receipt-off', title:tr('No billing rate — billed 0'), sub:c.name+' · '+tr('{h}h',{h:v.hours.toFixed(1)}), fn:()=>openEditClient(cid)});
  });
  return out;
}
function buildSalaryExportRows(period, onlyIds){
  const only=onlyIds&&onlyIds.length?new Set(onlyIds.map(String)):null;
  const log=getPunchLog().filter(e=>!only||only.has(String(e.workerId))); const now=new Date();
  let filtered=log;
  if(period==='week'){ const ws=new Date(now); ws.setDate(ws.getDate()-ws.getDay()); ws.setHours(0,0,0,0); filtered=log.filter(e=>new Date(e.ts)>=ws); }
  else if(period==='month'){ filtered=log.filter(e=>new Date(e.ts)>=new Date(now.getFullYear(),now.getMonth(),1)); }
  else if(/^m:\d{4}-\d{2}$/.test(period)){
    const [y,m]=period.slice(2).split('-').map(Number);
    const from=new Date(y,m-1,1), to=new Date(y,m,1);
    filtered=log.filter(e=>{ const d=new Date(e.ts); return d>=from && d<to; });
  }
  const byWorkerPunches={};
  filtered.forEach(e=>{ (byWorkerPunches[e.workerId]=byWorkerPunches[e.workerId]||[]).push(e); });
  const byWD={};
  Object.entries(byWorkerPunches).forEach(([wid,list])=>{
    groupPunchesIntoShifts(list).forEach((bucket,i)=>{
      byWD[wid+'|'+i]={worker:list[0].workerName,wid,date:bucket.date,entries:bucket.entries};
    });
  });
  const rows=[], seenBy={};
  Object.values(byWD).sort((a,b)=> a.worker<b.worker?-1 : a.worker>b.worker?1 : (a.date-b.date)).forEach(d=>{
    const res=analyzeDayPunches(d.entries,d.date);
    const ins=d.entries.filter(x=>x.type==='in').map(x=>x.time).sort();
    const outs=d.entries.filter(x=>x.type==='out').map(x=>x.time).sort();
    const _w=workers.find(w=>w.id===d.wid);
    const shiftClientId=d.entries[0]&&d.entries[0].clientId;
    const daily=isDailyPay(_w);
    const rate=daily?dailyRate(_w):wRegRate(_w,shiftClientId);
    const isSat=d.date.getDay()===6;
    const seen=seenBy[d.wid]||(seenBy[d.wid]=new Set());
    const pay=res.hours>0?shiftPayFor(res.hours,_w,isSat,shiftClientId,d.date,seen):0;
    const clientObj=punchClientObject(d.entries[0])||workerClientObject(d.wid);
    const supName=suppliers.find(s=>s.id===_w?.supplierId)?.name||'';
    rows.push({worker:d.worker, client:clientObj, supplier:supName, date:d.date.toLocaleDateString('en-GB'), firstIn:ins[0]||'', lastOut:outs[outs.length-1]||'', hours:res.hours, rate:daily?rate+tr('/day'):rate, pay, notes:res.warnings.join('; ')});
  });
  // A daily-paid worker whose days were set by hand for this period: one more
  // row brings the total to days × rate, the same as the Salary table.
  const key=salaryPeriodKey(period, now);
  Object.entries(seenBy).forEach(([wid,seen])=>{
    const _w=workers.find(w=>w.id===wid), ov=isDailyPay(_w)?dayOverride(_w,key):null;
    if(ov==null||ov===seen.size) return;
    rows.push({worker:_w.name||'', client:'', supplier:suppliers.find(s=>s.id===_w.supplierId)?.name||'', date:'', firstIn:'', lastOut:'', hours:0,
      rate:dailyRate(_w)+tr('/day'), pay:(ov-seen.size)*dailyRate(_w), notes:tr('Days set by hand: {n} (punches: {m})',{n:ov,m:seen.size})});
  });
  return rows;
}
function salaryMonthOf(period){
  if(period==='month') return localYMD(new Date()).slice(0,7);
  return /^m:\d{4}-\d{2}$/.test(period||'') ? period.slice(2) : null;
}
function hourDayLines(doc, month){
  const [y,m]=month.split('-').map(Number), from=new Date(y,m-1,1), to=new Date(y,m,1);
  const lo=new Date(y,m-1,0), hi=new Date(y,m,2);
  let pick;
  if(doc.kind==='client') pick=e=>e.clientId===doc.ownerId;
  else{
    let ids=null;
    if(doc.kind==='supplier') ids=new Set(workers.filter(w=>w.supplierId===doc.ownerId).map(w=>w.id));
    else if(doc.ownOnly!==false) ids=new Set(workers.filter(w=>w.hrId===doc.ownerId).map(w=>w.id));
    pick=e=>!ids||ids.has(e.workerId);
  }
  const byW={};
  getPunchLog().filter(e=>{ const d=new Date(e.ts); return d>=lo&&d<hi&&pick(e); }).forEach(e=>{ (byW[e.workerId]=byW[e.workerId]||[]).push(e); });
  const days={};
  Object.entries(byW).forEach(([wid,list])=>groupPunchesIntoShifts(list).forEach(b=>{
    if(b.date<from||b.date>=to) return;
    const inE=b.entries.find(e=>e.type==='in'), outE=[...b.entries].reverse().find(e=>e.type==='out');
    const k=wid+'|'+localYMD(b.date); (days[k]=days[k]||[]).push([inE&&inE.time||'',outE&&outE.time||'']);
  }));
  const out={};
  Object.entries(days).forEach(([k,sh])=>{ out[k]=[k,sh.map(x=>x[0]).join(','),sh.map(x=>x[1]).join(',')].join('|'); });
  return out;
}
function hourEntryState(e, line){
  if((e.status==='approved'||e.status==='fixed') && e.line!==line) return 'changed';
  return e.status||'pending';
}
const HOUR_ST={approved:['var(--green)','ti-circle-check','Approved'],fixed:['var(--green)','ti-circle-check','Fix accepted'],
  changed:['var(--amber)','ti-alert-triangle','Changed after approval'],disputed:['var(--amber)','ti-alert-triangle','Disputed'],
  fix:['var(--accent)','ti-pencil','Fix proposed'],rejected:['var(--red)','ti-circle-x','Fix rejected'],pending:['var(--text3)','ti-clock','Waiting for approval']};
const HOUR_KIND={client:['ti-building-store','Client'],supplier:['ti-truck-delivery','Supplier'],hr:['ti-user-check','HR']};
function hourApprovalSummary(doc, month){
  const lines=hourDayLines(doc, month), days=doc.days||{};
  const open=Object.entries(days).map(([k,e])=>({k,e,st:hourEntryState(e,lines[k]||'')}))
    .filter(x=>x.st!=='approved'&&x.st!=='fixed').sort((a,b)=>a.k.split('|')[1].localeCompare(b.k.split('|')[1]));
  const done=Object.entries(days).filter(([k,e])=>hourEntryState(e,lines[k]||'')==='approved'||hourEntryState(e,lines[k]||'')==='fixed').length;
  return {lines, open, done, total:new Set([...Object.keys(lines),...Object.keys(days)]).size};
}
function punchClientObject(e){
  if(e && e.clientId){ const c=clients.find(x=>x.id===e.clientId); if(c) return c.object||c.name||''; }
  return '';
}
function workerClientObject(workerId){
  const w = workers.find(x=>x.id===workerId);
  if(!w) return '';
  const c = (w.clientIds||[]).map(id=>clients.find(x=>x.id===id)).filter(Boolean)[0];
  return c ? (c.object||c.name||'') : '';
}
function salaryExportPeriodOptions(){
  const now=new Date(), opts=[['week',tr(SALARY_PERIOD_LABELS.week)],['month',tr(SALARY_PERIOD_LABELS.month)]];
  for(let i=1;i<=12;i++){
    const d=new Date(now.getFullYear(), now.getMonth()-i, 1);
    opts.push(['m:'+d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'), d.toLocaleDateString(uiLocale(),{month:'long',year:'numeric'})]);
  }
  opts.push(['all',tr(SALARY_PERIOD_LABELS.all)]);
  return opts;
}
function salaryPeriodLabel(period){
  const o=salaryExportPeriodOptions().find(([v])=>v===period);
  return o ? o[1] : period;
}
const SALARY_PERIOD_LABELS={week:'This Week',month:'This Month',all:'All Time'};

// ── Part 2: the figures of the draw and export functions ──
// renderSalary (+ renderAccFigs, accAlerts): the rows, the totals over the
// rows shown (search q), the figures on top, the alerts, an HR's commission.
function salaryFigures(period, q){
  const {byWorker, byClient} = salaryEntriesFor(period);
  const periodKey = salaryPeriodKey(period);
  const clientBillEntries=Object.entries(byClient).map(([clientId,v])=>({clientId,...v}));
  const payOnly=hrPayOnly(), me=getSession()||{};
  const hrRate=Number(me.commissionRate)||0, hrDayRate=Number(me.commissionDayRate)||0;
  const hrCom=e=>commissionFor(workers.find(w=>w.id===e.workerId),e,hrRate,hrDayRate);
  const entries=Object.values(byWorker).filter(e=>!payOnly||((workers.find(w=>w.id===e.workerId)||{}).hrId===me.uid));
  // renderAccFigs
  const figs={hours:Math.round(entries.reduce((t,e)=>t+e.hours,0)), payroll:Math.round(Number(entries.reduce((t,e)=>t+e.total+e.travel,0))||0)};
  const alerts=(payOnly?[]:accAlerts(entries, byClient)).map(a=>({sec:a.sec, lvl:a.lvl, icon:a.icon, title:a.title, sub:a.sub, go:a.fn()}));
  q=(q||'').trim().toLowerCase();
  const shown=q?entries.filter(e=>String(e.worker||'').toLowerCase().includes(q)):entries;
  const totalHours=shown.reduce((s,e)=>s+e.hours,0);
  const payTotal=shown.reduce((s,e)=>s+e.total,0), travelTotal=shown.reduce((s,e)=>s+e.travel,0);
  const rows=shown.map(e=>{
    const wc=workers.find(w=>w.id===e.workerId);
    const mainCid=Object.entries(e.clientHours||{}).sort((a,b)=>b[1]-a[1]).map(x=>x[0])[0]||(wc&&wc.clientIds||[])[0]||'';
    const er=wc?effectiveRates(wc,mainCid):{regRate:0,src:''};
    const daily=isDailyPay(wc), own=wOwnRate(wc);
    const rate=daily?(own!==''?['day',own]:['day-none']):(own!==''?['hour',own]:(er.regRate>0?['client',er.regRate]:['none']));
    const byHand=daily&&dayOverride(wc,periodKey)!=null;
    return {workerId:e.workerId, worker:e.worker, hours:e.hours, regH:e.regH, otH:e.otH, shabH:e.shabH, days:e.daysUsed, counted:e.countedDays, byHand,
      rate, pay:e.total, travel:e.travel, total:e.total+e.travel, warns:e.warns.slice(), myCom:payOnly?hrCom(e):null};
  });
  return {figs, alerts, rows, totals:{hours:totalHours, pay:payTotal, travel:travelTotal, total:payTotal+travelTotal, myCom:payOnly?shown.reduce((t,e)=>t+hrCom(e),0):null},
    entries, clientBillEntries};
}
// renderSupplierPayable (+ exportPayableSummary's rows) and openSupplierPayDetail.
function supplierPayableFigures(entries){
  const bySupplier={};
  entries.forEach(e=>{
    const wc=workers.find(w=>w.id===e.workerId);
    const sid=wc&&wc.supplierId;
    if(!sid) return;
    if(!bySupplier[sid]) bySupplier[sid]={hours:0,total:0};
    bySupplier[sid].hours+=e.hours;
    bySupplier[sid].total+=supplierCommission(wc,e,sid);
  });
  const rows=suppliers.filter(s=>bySupplier[s.id]&&bySupplier[s.id].hours>0&&bySupplier[s.id].total>0).map(s=>({sup:s,...bySupplier[s.id]}));
  const exportRows = rows.map(r=>({ label:r.sup.name, hours:r.hours, rate:tr('commission'), total:r.total }));
  const details=rows.map(r=>{
    const sid=r.sup.id;
    const list=entries.map(e=>({e,wc:workers.find(w=>w.id===e.workerId)})).filter(x=>x.wc&&x.wc.supplierId===sid);
    const drows=list.map(({e,wc})=>({n:e.worker,h:tr('{h}h',{h:e.hours.toFixed(1)}),v:supplierCommission(wc,e,sid),hrs:e.hours}))
      .sort((a,b)=>b.v-a.v).map(r=>({...r,m:'₪'+r.v.toFixed(0)}));
    return {id:sid, rows:drows.map(x=>({n:x.n,h:x.h,m:x.m})), total:{h:tr('{h}h',{h:drows.reduce((t,r)=>t+r.hrs,0).toFixed(1)}), m:'₪'+drows.reduce((t,r)=>t+r.v,0).toFixed(0)}};
  });
  return {rows:rows.map(r=>({id:r.sup.id, hours:r.hours, total:r.total, shown:r.total>0?'₪'+r.total.toFixed(0):'—'})), exportRows, details};
}
// renderHrPayable.
function hrPayableFigures(entries){
  const hrs=isFirmAdminSession()?hrUsers():[];
  const rows=hrs.map(u=>{
    const mine=entries.filter(e=>((workers.find(w=>w.id===e.workerId)||{}).hrId)===u.id);
    const hours=mine.reduce((t,e)=>t+e.hours,0);
    const rate=Number(u.commissionRate)||0, dayRate=Number(u.commissionDayRate)||0;
    const total=mine.reduce((t,e)=>t+commissionFor(workers.find(w=>w.id===e.workerId),e,rate,dayRate),0);
    return {u, hours, rate, dayRate, total};
  }).filter(r=>r.hours>0&&r.total>0);
  return rows.map(r=>({id:r.u.id, hours:r.hours, rate:r.rate, dayRate:r.dayRate, total:r.total, shown:r.total>0?'₪'+r.total.toFixed(0):'—'}));
}
// renderClientBillable and openClientBillDetail.
function clientBillableFigures(billEntries, payEntries){
  const rows=billEntries.map(e=>({cl:clients.find(c=>c.id===e.clientId),...e})).filter(r=>r.cl&&r.hours>0&&r.total>0);
  return rows.map(r=>{
    const cid=r.cl.id, cl=r.cl;
    const bill=(billEntries||[]).find(x=>x.clientId===cid)||{hours:0,total:0};
    const drows=payEntries.filter(e=>(e.clientHours||{})[cid]>0).map(e=>({n:e.worker,hrs:e.clientHours[cid]}))
      .sort((a,b)=>b.hrs-a.hrs).map(r=>({...r,h:tr('{h}h',{h:r.hrs.toFixed(1)}),m:''}));
    return {id:cid, hours:r.hours, total:r.total, shown:r.total>0?'₪'+r.total.toFixed(0):'—',
      mode:r.cl.rateMode==='fixed'?tr('Fixed'):r.cl.rateMode==='daily'?tr('Daily'):tr('Tiered'),
      detail:{rows:drows.map(x=>({n:x.n,h:x.h})), total:{h:tr('{h}h',{h:bill.hours.toFixed(1)}), m:bill.total>0?'₪'+bill.total.toFixed(0):'—'}}};
  });
}
// openPayModal's figures for one worker: the days counted by the punches, the
// client's rate shown in the placeholder, the period key the days are saved under.
function payWindowFigures(wid, period, lastSalaryEntries){
  const w=workers.find(x=>x.id===wid); if(!w) return null;
  const daily=isDailyPay(w), cid=(w.clientIds||[])[0];
  const clientRate=effectiveRates({...w,hourlyRate:0,regRate:null,otRate:null,shabbatRate:null,clientRates:w.clientRates},cid);
  const pKey=salaryPeriodKey(period), counted=((lastSalaryEntries||[]).find(e=>e.workerId===wid)||{}).countedDays||0;
  return {daily, own:wOwnRate(w), clientRate:clientRate.regRate, clientSrc:clientRate.src, key:pKey, days:dayOverride(w,pKey), counted};
}
// exportSalary: the sheet / PDF / CSV table (header, rows, total).
function salaryExportAoa(period, onlyIds){
  const rows=buildSalaryExportRows(period, onlyIds);
  const header=['Worker','Object/Client','Supplier','Date','First In','Last Out','Hours','Rate (₪/h or /day)','Day Pay (₪)','Notes'].map(h=>tr(h));
  const toArr=r=>[r.worker, r.client, r.supplier, r.date, r.firstIn, r.lastOut, r.hours.toFixed(2), r.rate, r.pay.toFixed(2), r.notes];
  const totalHours=rows.reduce((s,r)=>s+r.hours,0), totalPay=rows.reduce((s,r)=>s+r.pay,0);
  return [header, ...rows.map(toArr), ['','','','','',tr('Total'),totalHours.toFixed(2),'',totalPay.toFixed(2),'']];
}
// exportAccountantReport: the Summary rows, the Shifts sheet, the Hours approvals sheet.
function accountantSheets(period, approvals, firmName){
  const month=salaryMonthOf(period);
  const {byWorker}=salaryEntriesFor(period);
  const money=v=>Math.round((Number(v)||0)*100)/100, hrs=v=>Math.round((Number(v)||0)*100)/100;
  const head=['Worker','ID / Passport','Supplier','Pay mode','Rate','Days','Regular hours','Overtime hours','Shabbat hours','Total hours','Pay (₪)','Travel (₪)','Total (₪)','Bank','Branch','Account','Warnings'].map(h=>tr(h));
  const list=Object.values(byWorker).map(e=>({e, w:workers.find(x=>x.id===e.workerId)||{name:e.worker}}))
    .sort((a,b)=>String(a.w.name||'').localeCompare(String(b.w.name||'')));
  const rows=list.map(({e,w})=>[w.name||e.worker, workerDocId(w)||'', (suppliers.find(s=>s.id===w.supplierId)||{}).name||'',
    isDailyPay(w)?tr('By the day'):tr('By the hour'), isDailyPay(w)?dailyRate(w):(wOwnRate(w)||''),
    e.daysUsed, hrs(e.regH), hrs(e.otH), hrs(e.shabH), hrs(e.hours), money(e.total), money(e.travel), money(e.total+e.travel),
    w.bank||'', w.bankBranch||'', w.bankAccountNumber||'', e.warns.length]);
  const sum=k=>money(list.reduce((s,{e})=>s+(k==='grand'?e.total+e.travel:e[k]),0));
  rows.push([tr('Total'),'','','','',list.reduce((s,{e})=>s+e.daysUsed,0),sum('regH'),sum('otH'),sum('shabH'),sum('hours'),sum('total'),sum('travel'),sum('grand'),'','','','']);
  const shifts=buildSalaryExportRows(period);
  const sHead=['Worker','Object/Client','Supplier','Date','First In','Last Out','Hours','Rate (₪/h or /day)','Day Pay (₪)','Notes'].map(h=>tr(h));
  const sRows=shifts.map(r=>[r.worker, r.client, r.supplier, r.date, r.firstIn, r.lastOut, hrs(r.hours), r.rate, money(r.pay), r.notes]);
  const title=[tr('Accountant report — {period}',{period:salaryPeriodLabel(period)})], firm=[firmName||''];
  const sheets={summary:[title, firm, [], head, ...rows], shifts:[sHead, ...sRows]};
  if(approvals && approvals.length){
    const aRows=[];
    approvals.forEach(doc=>{
      const lines=hourDayLines(doc, month), who=doc.ownerName||doc.ownerId, kind=tr((HOUR_KIND[doc.kind]||HOUR_KIND.client)[1]);
      Object.entries(doc.days||{}).sort((x,y)=>x[0].split('|')[1].localeCompare(y[0].split('|')[1])).forEach(([k,e])=>{
        const [wid,day]=k.split('|');
        aRows.push([who, kind, (workers.find(w=>w.id===wid)||{}).name||wid, day, tr((HOUR_ST[hourEntryState(e,lines[k]||'')]||HOUR_ST.pending)[2]),
          e.inT?e.inT+'–'+e.outT:'', e.comment||'', e.byName||'', e.at?new Date(e.at).toLocaleString('en-GB'):'']);
      });
    });
    sheets.approvals=[[tr('Login'),tr('Role'),tr('Worker'),tr('Date'),tr('Status'),tr('Proposed fix'),tr('Comment'),tr('By'),tr('When')], ...aRows];
  }
  return sheets;
}
// exportPayableSummary: the sheet (Label, Hours, Rate, Total and the total row).
function payableAoa(rows){
  const grand = rows.reduce((s,r)=>s+r.total,0);
  const aoa=[['Label','Hours','Rate','Total'].map(h=>tr(h))];
  rows.forEach(r=>aoa.push([r.label, r.hours.toFixed(2), r.rate, r.total.toFixed(2)]));
  aoa.push(['','',tr('Total'), grand.toFixed(2)]);
  return aoa;
}
// renderHourApprovals: per login document of the month, the counts and the days that need a look.
function approvalsFigures(docs, month){
  docs=docs.filter(d=>Object.keys(d.days||{}).length).sort((a,b)=>(a.kind+a.ownerName).localeCompare(b.kind+b.ownerName));
  return docs.map(doc=>{
    const {lines,open,done,total}=hourApprovalSummary(doc, month);
    const allOk=!open.length&&done>=total;
    return {id:doc.id, done, total, allOk, open:open.map(({k,e,st})=>{
      const now=(lines[k]||'').split('|');
      const times=now.length===4?now[2].split(',').map((x,i)=>(x||'--:--')+'–'+(now[3].split(',')[i]||'--:--')).join(', '):'';
      return {k, st, times, fix:e.inT?' → '+e.inT+'–'+e.outT:''};
    })};
  });
}

  return { salaryEntriesFor, commissionFor, supplierCommission, clientBillPay, buildSalaryExportRows, hourDayLines, hourEntryState, hourApprovalSummary,
    salaryMonthOf, salaryExportPeriodOptions, salaryPeriodLabel, accAlerts,
    salaryFigures, supplierPayableFigures, hrPayableFigures, clientBillableFigures, payWindowFigures, salaryExportAoa, accountantSheets, payableAoa, approvalsFigures };
}
