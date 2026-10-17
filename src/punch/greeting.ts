// The greeting on the punch screen (the same as the manager app's Today —
// duplicated on purpose, CLAUDE.md): "Good morning / afternoon / evening /
// night, <first name>" by the device's local time (5–12, 12–17, 17–21, 21–5)
// with a small animated icon; the weather at the site (the `weather`
// function's {kind, temp}) replaces it ("clear" keeps the time-of-day icon).
// The icons are fixed SVG markup; the name and the temperature go in through esc().
import { tr } from '@/lib/i18n';
import { esc } from '@/lib/utils';

export const GREET_ICONS: Record<string, string> = {
  morning:'<svg class="gic" viewBox="0 0 32 32" aria-hidden="true"><defs><clipPath id="gicHz"><rect x="0" y="0" width="32" height="23"/></clipPath></defs><g clip-path="url(#gicHz)"><g class="rise"><circle cx="16" cy="22" r="7" fill="#f7c062"/>'+[0,51,102,154,205,257,308].map(a=>`<line x1="16" y1="12" x2="16" y2="9" stroke="#f7c062" stroke-width="2" stroke-linecap="round" transform="rotate(${a} 16 22)"/>`).join('')+'</g></g><line x1="4" y1="23.5" x2="28" y2="23.5" stroke="rgba(255,255,255,.55)" stroke-width="2" stroke-linecap="round"/></svg>',
  day:'<svg class="gic" viewBox="0 0 32 32" aria-hidden="true"><g class="spin">'+[0,45,90,135,180,225,270,315].map(a=>`<line x1="16" y1="6" x2="16" y2="2" stroke="#fde68a" stroke-width="2.2" stroke-linecap="round" transform="rotate(${a} 16 16)"/>`).join('')+'</g><circle class="pulse" cx="16" cy="16" r="6.5" fill="#fcd34d"/></svg>',
  evening:'<svg class="gic" viewBox="0 0 32 32" aria-hidden="true"><defs><clipPath id="gicHz2"><rect x="0" y="0" width="32" height="21"/></clipPath></defs><g clip-path="url(#gicHz2)"><g class="sink"><circle cx="16" cy="20" r="8" fill="#f9a8d4"/></g></g><line x1="4" y1="21.5" x2="28" y2="21.5" stroke="rgba(255,255,255,.6)" stroke-width="2" stroke-linecap="round"/><line x1="9" y1="25.5" x2="23" y2="25.5" stroke="rgba(255,255,255,.3)" stroke-width="2" stroke-linecap="round"/></svg>',
  night:'<svg class="gic" viewBox="0 0 32 32" aria-hidden="true"><path class="moon" d="M20 6a10 10 0 1 0 7 15A8 8 0 0 1 20 6z" fill="#c7d2fe"/><circle class="tw" cx="7" cy="8" r="1.4" fill="#fff"/><circle class="tw tw2" cx="11" cy="4" r="1" fill="#fff"/></svg>'};
export function partOfDay(d?: Date): string { const h=(d||new Date()).getHours(); return h>=5&&h<12?'morning':h>=12&&h<17?'day':h>=17&&h<21?'evening':'night'; }
// The weather in the greeting (redesign stage 12): the `weather` function's
// {kind, temp} for the site (punch page: the worker's site; manager app: the
// firm's main site). "clear" keeps the time-of-day icon; no answer = that icon.
const GIC_CLOUD = (fill: string, y: number) =>`<circle cx="12" cy="${15+y}" r="5" fill="${fill}"/><circle cx="18" cy="${12+y}" r="6.5" fill="${fill}"/><circle cx="23.5" cy="${16+y}" r="4.5" fill="${fill}"/><rect x="8" y="${15+y}" width="19.5" height="5.5" rx="2.75" fill="${fill}"/>`;
const WX_ICONS: Record<string, string> = {
  clouds:'<svg class="gic" viewBox="0 0 32 32" aria-hidden="true"><g transform="translate(4 -5)"><g class="drift d2" opacity=".55">'+GIC_CLOUD('#94a3b8',0)+'</g></g><g class="drift">'+GIC_CLOUD('#e2e8f0',2)+'</g></svg>',
  rain:'<svg class="gic" viewBox="0 0 32 32" aria-hidden="true"><g class="drift">'+GIC_CLOUD('#cbd5e1',-3)+'</g>'+[11,17,23].map((x,i)=>`<line class="drop d${i+1}" x1="${x}" y1="22" x2="${x-1.5}" y2="26" stroke="#7dd3fc" stroke-width="2" stroke-linecap="round"/>`).join('')+'</svg>',
  thunder:'<svg class="gic" viewBox="0 0 32 32" aria-hidden="true"><g class="drift">'+GIC_CLOUD('#94a3b8',-3)+'</g><path class="bolt" d="M17 19l-4 6h3.5l-2 5 6-7.5h-3.5l2-3.5z" fill="#fcd34d"/></svg>',
  snow:'<svg class="gic" viewBox="0 0 32 32" aria-hidden="true"><g class="drift">'+GIC_CLOUD('#e2e8f0',-3)+'</g>'+[11,17,23].map((x,i)=>`<circle class="flake d${i+1}" cx="${x}" cy="24" r="1.6" fill="#fff"/>`).join('')+'</svg>',
  fog:'<svg class="gic" viewBox="0 0 32 32" aria-hidden="true">'+([[6,26,10],[4,22,16],[9,28,22]] as const).map(([a,b,y],i)=>`<line class="fogl d${i+1}" x1="${a}" y1="${y}" x2="${b}" y2="${y}" stroke="#cbd5e1" stroke-width="2.4" stroke-linecap="round"/>`).join('')+'</svg>'};
export function weatherIconHtml(p: string, wx: { kind: string; temp?: number } | null): string {
  const k=wx&&wx.kind, ic=(k&&WX_ICONS[k])||GREET_ICONS[p];
  return ic+(wx&&Number.isFinite(wx.temp)?`<span class="gtemp">${esc(String(wx.temp))}°</span>`:'');
}
export function greetingHtml(name: string | undefined, wx: { kind: string; temp?: number } | null): string {
  const p=partOfDay(), first=String(name||'').trim().split(/\s+/)[0]||'';
  const text=({morning:'Good morning, {name}',day:'Good afternoon, {name}',evening:'Good evening, {name}',night:'Good night, {name}'} as Record<string, string>)[p];
  return esc(first?tr(text,{name:first}):tr(text,{name:''}).replace(/,\s*$/,''))+weatherIconHtml(p,wx);
}
