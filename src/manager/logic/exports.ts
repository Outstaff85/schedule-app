// The Schedule's exports (Excel, a print-ready PDF page, JSON) and one
// worker's month of hours (the worker card's Export hours), from
// schedule-manager.html. The hours come from groupPunchesIntoShifts() /
// analyzeDayPunches() only — never a calculation of their own. "PDF" is a
// print-ready page (window.print()).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { state, type Rec } from '../data/state';
import { notify } from '../data/events';
import { getPunchLog } from '../data/punches';
import { tr, uiLocale } from './i18n';
import { esc, loadXlsx, calcHours, toMins } from './util';
import { localYMD, groupPunchesIntoShifts, analyzeDayPunches } from './pay';
import { view, DAYS, DAYS_HE, WORKER_COLORS, weekShifts, workerTotalHours, getVisible } from './schedule';

declare const XLSX: any;

export function fmtDate(d: Date): string { return d.toLocaleDateString(uiLocale(), {day: '2-digit', month: 'short'}); }
export function fmtRange(d: Date): string { const e = new Date(d); e.setDate(e.getDate() + 6); return fmtDate(d) + ' – ' + fmtDate(e); }

// --- Export Excel -------------------------------------------------------------
export function exportExcel(): void {
  if(typeof XLSX==='undefined'){ loadXlsx().then(()=>exportExcel()).catch(()=>notify(tr('Excel library not loaded'))); return; }
  try {
    const wb=XLSX.utils.book_new();
    const headers=['Worker','Phone',...DAYS.map((d: string, i: number)=>{ const dt=new Date(view.weekStart); dt.setDate(dt.getDate()+i); return d+' '+fmtDate(dt); }),'Total Hours'];
    const rows=[headers];
    const exW=getVisible();
    exW.forEach((w: Rec)=>{
      const row=[w.name,w.phone||'']; let total=0;
      weekShifts(w).forEach((sh: Rec)=>{ if(sh.type==='work'&&sh.start&&sh.end){ const h=calcHours(sh.start,sh.end); total+=h; row.push(sh.start+' – '+sh.end+' ('+h.toFixed(1)+'h)'); } else row.push('Day off'); });
      row.push(total.toFixed(1)+'h'); rows.push(row);
    });
    rows.push([]);
    const totals=['TOTAL',''];
    DAYS.forEach((_,i)=>totals.push(exW.filter(w=>weekShifts(w)[i]?.type==='work').length+' working'));
    totals.push(exW.reduce((s,w)=>s+workerTotalHours(w),0).toFixed(1)+'h');
    rows.push(totals);
    const ws=XLSX.utils.aoa_to_sheet(rows);
    ws['!cols']=[{wch:16},{wch:14},...DAYS.map(()=>({wch:22})),{wch:13}];
    XLSX.utils.book_append_sheet(wb,ws,'Schedule');

    const statsRows=[['Statistics',fmtRange(view.weekStart)],[],['Worker','Hours','Shifts','Days Off','Clients','Supplier'],
      ...exW.map(w=>{ const cn=state.clients.filter(c=>(w.clientIds||[]).includes(c.id)).map(c=>c.name).join(', ');
        const sn=state.suppliers.find(s=>s.id===w.supplierId)?.name||'';
        return [w.name,workerTotalHours(w).toFixed(1),weekShifts(w).filter(s=>s.type==='work').length,weekShifts(w).filter(s=>s.type!=='work').length,cn||'Unassigned',sn]; })];
    const ws2=XLSX.utils.aoa_to_sheet(statsRows);
    ws2['!cols']=[{wch:18},{wch:10},{wch:8},{wch:10},{wch:28},{wch:20}];
    XLSX.utils.book_append_sheet(wb,ws2,'Statistics');

    const fname='Schedule_'+localYMD(view.weekStart)+'.xlsx';
    XLSX.writeFile(wb,fname);
    notify(tr('Excel exported!'));
  } catch(e: any){ notify(tr('Export failed: {0}',{0:(e.message)})); }
}

// --- Export PDF ---------------------------------------------------------------
export function exportPDF(): void {

  const dateHdrs=DAYS.map((d: string, i: number)=>{
    const dt=new Date(view.weekStart); dt.setDate(dt.getDate()+i);
    const today=dt.toDateString()===new Date().toDateString();
    return '<th style="background:#1e2333;border-radius:8px;color:'+(today?'#7eb8ff':'#c0c4d4')+';padding:6px 4px;text-align:center;font-size:14px;font-weight:500">'+d+'<br><span style="font-weight:400;font-size:11px;color:#8b90a0">'+fmtDate(dt)+'</span><br><span style="color:#6fa8e0;font-size:12px;font-weight:500">'+DAYS_HE[i]+'</span></th>';
  }).join('');

  const exW = getVisible();
  const workerRows=exW.map((w,ri)=>{
    const c=WORKER_COLORS[w.colorIdx%8];
    const rowBg=ri%2===0?'#181c27':'#13161f';
    const cells=weekShifts(w).map(sh=>{
      if(sh.type==='work'&&sh.start&&sh.end){
        const h=calcHours(sh.start,sh.end);
        const mid=toMins(sh.end)!<=toMins(sh.start)!;
        const cBg=mid?'#16202e':'#152620', cFg=mid?'#6fa8e0':'#6dd6a0', cSub=mid?'#9ec4ec':'#a7e8c8';
        return '<td style="padding:2px;text-align:center;background:'+rowBg+';border:none"><div style="background:'+cBg+';color:'+cFg+';border-radius:10px;padding:0;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;height:78px;font-size:15px;font-weight:500;line-height:1.15;font-family:\'DM Mono\',ui-monospace,monospace;-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important">'+sh.start+'<br>'+sh.end+'<br><span style="color:'+cSub+';font-size:12px;font-weight:500;margin-top:0">'+h.toFixed(1)+'h</span></div></td>';
      }
      return '<td style="padding:2px;text-align:center;background:'+rowBg+';border:none"><div style="background:#2a2012;color:#f5a623;border-radius:10px;padding:0;display:flex;align-items:center;justify-content:center;width:100%;height:78px;font-size:15px;font-weight:500;letter-spacing:0.3px;font-family:\'DM Sans\',sans-serif;-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important">'+tr('Day off')+'</div></td>';
    }).join('');
    const ini=w.name.slice(0,2).toUpperCase(), total=workerTotalHours(w).toFixed(1);
    return '<tr><td style="padding:4px 8px;background:'+rowBg+';border:none;width:130px;max-width:130px"><div style="display:flex;align-items:center;gap:6px;overflow:hidden"><div style="width:32px;height:32px;border-radius:50%;background:'+c.bg+';color:'+c.text+';display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;flex-shrink:0">'+ini+'</div><div style="overflow:hidden;min-width:0"><div style="font-weight:500;color:#ffffff;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(w.name)+'</div><div style="color:#8b90a0;font-size:12px;margin-top:1px;white-space:nowrap">'+total+'h / week</div></div></div></td>'+cells+'</tr>';
  }).join('');

  const summary=exW.map(w=>{ const c=WORKER_COLORS[w.colorIdx%8]; return '<div style="font-size:13px;background:#1e2333;padding:8px 12px;border-radius:8px;min-width:80px"><div style="color:'+c.text+';font-weight:500;font-size:13px">'+esc(w.name)+'</div><div style="color:#ffffff;font-weight:600;font-size:15px;margin-top:3px;font-family:\'DM Mono\',ui-monospace,monospace">'+workerTotalHours(w).toFixed(1)+'h</div></div>'; }).join('');
  const grand=exW.reduce((s,w)=>s+workerTotalHours(w),0).toFixed(1);
  const genDate=new Date().toLocaleDateString(uiLocale(),{day:'2-digit',month:'short',year:'numeric'});
  const weekLabel=fmtRange(view.weekStart);

  const html='<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Schedule '+weekLabel+'</title>'
    +'<link href="'+location.origin+'/fonts/fonts.css" rel="stylesheet"><style>*{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important;}html,body{background:#0f1117;min-height:100%;width:100%;}body{font-family:"DM Sans","Heebo",-apple-system,Arial,sans-serif;background:#0f1117;color:#e8eaf0;padding:8px;}@media print{*{-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important;}html,body{background:#0f1117 !important;}body{padding:6px;}@page{size:A4 landscape;margin:4mm;}html{height:auto;}body{height:auto;}table{font-size:11px;}}table{width:100%;border-collapse:separate !important;border-spacing:3px !important;table-layout:fixed;}th,td{border:none !important;}th{font-weight:500;}tr{height:82px !important;page-break-inside:avoid;break-inside:avoid;}</style>'
    +'</head><body><div style="width:100%;background:#0f1117;padding:0"><div style="max-width:100%;margin:0 auto;padding:16px">'
    +'<div style="text-align:center;margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,0.06)">'
    +(()=>{ const cl=view.clientId?state.clients.find(c=>c.id===view.clientId):null; return cl?'<div style="font-size:28px;font-weight:600;color:#7eb8ff;margin-bottom:6px;font-family:Heebo,Arial,sans-serif">'+esc(cl.name)+'</div>':'<div style="font-size:26px;font-weight:500;color:#5a6075;margin-bottom:6px;letter-spacing:1px">'+tr('ALL CLIENTS')+'</div>'; })()
    +'<div style="font-size:20px;font-weight:600;color:#ffffff;letter-spacing:-0.5px;line-height:1">'+weekLabel+'</div>'
    +'<div style="display:flex;justify-content:center;gap:28px;margin-top:12px">'
    +'<div style="color:#8b90a8;font-size:13px">Schedule Manager</div>'
    +'<div style="color:#8b90a8;font-size:13px">Generated: '+genDate+'</div>'
    +'<div style="color:#8b90a8;font-size:13px">'+tr('Workers:')+' <span style="color:#ffffff;font-weight:500">'+exW.length+'</span></div>'
    +'<div style="color:#8b90a8;font-size:13px">'+tr('Total:')+' <span style="color:var(--green);font-weight:500">'+grand+'h</span></div>'
    +'</div></div>'
    +'<table><thead><tr>'
    +'<th style="background:#1e2333;color:#c0c4d4;padding:8px 10px;text-align:left;font-size:16px;font-weight:500;min-width:120px">'+tr('Worker')+'</th>'
    +dateHdrs+'</tr></thead><tbody>'+workerRows+'</tbody></table>'
    +'<div style="margin-top:16px;padding:14px;background:#181c27;border-radius:10px;page-break-inside:avoid;page-break-before:avoid">'
    +'<div style="font-weight:700;margin-bottom:10px;font-size:13px;color:#ffffff;font-weight:500;border-bottom:1px solid rgba(255,255,255,0.06);padding-bottom:8px">'+tr('Week Summary')+'</div>'
    +'<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:stretch">'+summary
    +'<div style="font-size:14px;margin-left:auto;background:#152620;padding:8px 14px;border-radius:8px;display:flex;align-items:center;color:var(--green);font-weight:600;font-family:\'DM Mono\',ui-monospace,monospace">Total: '+grand+'h</div>'
    +'</div></div></div></body></html>';

  const win=window.open('','_blank')!;
  win.document.write(html);
  win.document.close();
  setTimeout(()=>win.print(),600);
  notify(tr('PDF — Ctrl+P → Save as PDF'));
}
// --- Export JSON --------------------------------------------------------------
export function exportJSON(): void {
  const data={workers: state.workers, clients: state.clients, weekStart: view.weekStart.toISOString(),exportedAt:new Date().toISOString()};
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download='schedule_'+localYMD(view.weekStart)+'.json';
  a.click(); URL.revokeObjectURL(url);
  notify(tr('JSON exported!'));
}

// --- One worker's hours → PDF / Excel (the worker card's Export hours) ------
// Built from groupPunchesIntoShifts()/analyzeDayPunches() only — never a
// calculation of its own. "PDF" is a print-ready page (window.print()).

// Detail mode: one worker, one calendar month, Date/In/Out/Hours per shift.
export function getWorkerMonthShifts(workerId: string, year: number, month: number, workerLog?: Rec[]): {date: Date; inTime: string; outTime: string; hours: number}[] {
  const log = workerLog || getPunchLog().filter(e=>e.workerId===workerId);
  return groupPunchesIntoShifts(log)
    .filter(b => b.date.getFullYear()===year && b.date.getMonth()===month)
    .map(b => {
      const res = analyzeDayPunches(b.entries, b.date);
      const ins = b.entries.filter(x=>x.type==='in').map(x=>x.time).sort();
      const outs = b.entries.filter(x=>x.type==='out').map(x=>x.time).sort();
      return { date: b.date, inTime: ins[0]||'', outTime: outs[outs.length-1]||'', hours: res.hours };
    })
    .sort((a,b)=>a.date.getTime()-b.date.getTime());
}
export function exportShiftsDetail(workerId: string, year: number, month: number, format: string): void {
  if(format==='excel' && typeof XLSX==='undefined'){ loadXlsx().then(()=>exportShiftsDetail(workerId, year, month, format)).catch(()=>notify(tr('Excel library not loaded'))); return; }
  const w = state.workers.find(x=>x.id===workerId);
  const shifts = getWorkerMonthShifts(workerId, year, month);
  const monthLabel = new Date(year, month, 1).toLocaleDateString(uiLocale(),{month:'long',year:'numeric'});
  const totalHours = shifts.reduce((s,x)=>s+x.hours,0);
  const fname = 'hours-'+(w?w.name.replace(/\s+/g,'_'):workerId)+'-'+year+'-'+String(month+1).padStart(2,'0');
  if(format==='excel'){
    const aoa=[['Date','In','Out','Hours'].map(h=>tr(h))];
    shifts.forEach(s=>aoa.push([s.date.toLocaleDateString('en-GB'), s.inTime, s.outTime, s.hours.toFixed(2)]));
    aoa.push(['','',tr('Total'), totalHours.toFixed(2)]);
    const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), tr('Hours'));
    XLSX.writeFile(wb, fname+'.xlsx');
  } else {
    const rowsHtml = shifts.map(s=>`<tr><td>${s.date.toLocaleDateString('en-GB')}</td><td>${esc(s.inTime)}</td><td>${esc(s.outTime)}</td><td>${s.hours.toFixed(2)}</td></tr>`).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(tr('Hours'))} — ${esc(w?w.name:'')}</title>
      <style>body{font-family:Arial,sans-serif;padding:20px;color:#111}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ccc;padding:6px 10px;text-align:left}th{background:#f0f0f0}tfoot td{font-weight:bold}</style>
      </head><body><h2>${esc(w?w.name:'')} — ${esc(monthLabel)}</h2>
      <table><thead><tr><th>${tr('Date')}</th><th>${tr('In')}</th><th>${tr('Out')}</th><th>${tr('Hours')}</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
      <tfoot><tr><td colspan="3">${tr('Total')}</td><td>${totalHours.toFixed(2)}</td></tr></tfoot>
      </table></body></html>`;
    const win=window.open('','_blank')!; win.document.write(html); win.document.close(); setTimeout(()=>win.print(),400);
  }
  notify(tr('Hours exported'));
}


