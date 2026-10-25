// Admin → Scanner (docs/hf-plan.md → Admin → Scanner; a super-admin's): where each of the
// scanner's own models stands — the examples collected for it, the versions in the lab and on
// the site (Hugging Face) —, how the document type model is used (Off / Shadow: it reads beside
// Haiku, only compared / Mixed: a page it is sure of needs no Haiku), the shadow's figures, the
// passport zone reader's figures in shadow (H8b: right on how many saved passports, against the AI), and
// which firms' full documents are collected for the field reader model (on unless turned off), and the
// automatic training cycle on the owner's PC: its last cycles (docs/scan-training.md → The automatic cycle → Reports).
// The figures and the settings come from scan_feedback (src/scan/server.ts).
import * as React from 'react';
import { IconExternalLink } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { CheckGrid, CheckTile } from '@/components/ui/checkbox';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Figures, Section } from '@/components/shared/section';
import { PagedList } from '@/components/shared/paged-list';
import { Plate } from '@/components/shared/plate';
import { scanSettings, trainingStats, type DoctypeMode, type LoopReport, type ScanSettings, type TrainingStats } from '@/scan/server';
import { LOOP_MODELS, loopModelName, loopReason, loopStateName } from './logic/scanloop';
import { shortWhen } from './adminlogs';
import type { AdminSnapshot, ManagerBridge } from './bridge';

const RETRAIN_AT = 20, DOCTYPE_AT = 20; // functions/feedback.py RETRAIN_AT, DOCTYPE_AT
const DOCTYPES = ['id_front', 'id_back', 'sefach', 'passport', 'contract'] as const;
const HF_MODELS = 'https://huggingface.co/OutStaff/scanner-models';

async function versionOf(path: string): Promise<string> {
  try { const r = await fetch(path, { cache: 'no-cache' }); return r.ok ? String((await r.json()).version || '—') : '—'; } catch { return '—'; }
}
const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) + '%' : '—');

export function ScanAdmin({ snap, api }: { snap: AdminSnapshot; api: ManagerBridge }) {
  const [stats, setStats] = React.useState<TrainingStats | null>(null);
  const [set, setSet] = React.useState<ScanSettings | null>(null);
  const [versions, setVersions] = React.useState<{ lab: string; site: string } | null>(null);
  const [err, setErr] = React.useState('');
  React.useEffect(() => {
    void api.loadFirms();
    void trainingStats().then(setStats);
    scanSettings().then(setSet, e => setErr(String(e?.message || e)));
    void Promise.all([versionOf('/scan-lab/models.json'), versionOf('/scan/models.json')]).then(([lab, site]) => setVersions({ lab, site }));
  }, [api]);
  const change = async (c: Parameters<typeof scanSettings>[0]) => {
    try { setSet(await scanSettings(c)); api.toast(tr('Saved')); } catch (e: any) { api.toast(tr(String(e?.message || 'Save failed'))); }
  };
  const s = stats?.stats || {};
  const docs = stats?.doctypes || {};
  const docMin = Math.min(...DOCTYPES.map(k => Number(docs[k] || 0)));
  const shadowPages = Number(s.shadowPages || 0);
  const mrzPassports = Number(s.mrzShadowPassports || 0);
  const heCards = Number(s.heShadowCards || 0);
  const firms = (snap.firms || []).map(f => ({ id: f.tenantId, name: f.companyName || f.tenantId }));
  for (const id of Object.keys(set?.collect || {})) if (!firms.some(f => f.id === id)) firms.push({ id, name: id });

  return (
    <div data-testid="scan-admin">
      {!stats ? <Skeleton className="mb-3 h-[66px] rounded-[14px]" /> : (
        <Figures items={[
          { key: 'edges', label: tr('Document edges: corrections'), value: `${stats.edgesSince}/${RETRAIN_AT}`, color: stats.due ? 'var(--ok)' : undefined },
          { key: 'doctype', label: tr('Document type: pages of each type'), value: `${Number.isFinite(docMin) ? docMin : 0}/${DOCTYPE_AT}`, color: stats.doctypesDue ? 'var(--ok)' : undefined },
          { key: 'docs', label: tr('Full documents collected'), value: Number(s.documents || 0) },
          { key: 'fixed', label: tr('Fields the user corrected'), value: Number(s.fieldsCorrected || 0) },
        ]} />
      )}

      <Section label={tr('Models')} panel>
        <div className="grid gap-1 text-sm" data-testid="scan-admin-versions">
          <span>{tr('Version in the lab: {0}', { 0: versions?.lab || '…' })}</span>
          <span>{tr('Version on the site: {0}', { 0: versions?.site || '…' })}</span>
          <a className="inline-flex items-center gap-1 text-[var(--accent)]" href={HF_MODELS} target="_blank" rel="noopener">
            {tr('Every version on Hugging Face')} <IconExternalLink className="size-3.5" />
          </a>
          <span className="text-muted-foreground">{tr('Training runs on the PC: /scan-train, when the bell says it is due.')}</span>
        </div>
      </Section>

      <AutoTraining history={stats ? stats.loop?.history || [] : null} locale={snap.locale} />

      <Section label={tr('Document type model')} panel>
        <p className="mb-2 text-sm text-muted-foreground">{tr('Off: Haiku gives every page its type. Shadow: the model reads beside Haiku and is only compared. Mixed: a page the model is sure of needs no Haiku.')}</p>
        {!set ? <Skeleton className="h-9 w-64" /> : (
          <ToggleGroup type="single" value={set.doctypeMode} onValueChange={v => { if (v && v !== set.doctypeMode) void change({ doctypeMode: v as DoctypeMode }); }} className="w-auto" data-testid="scan-doctype-mode">
            <ToggleGroupItem value="off" data-v="off" className="flex-none">{tr('Off')}</ToggleGroupItem>
            <ToggleGroupItem value="shadow" data-v="shadow" className="flex-none">{tr('Shadow')}</ToggleGroupItem>
            <ToggleGroupItem value="mixed" data-v="mixed" className="flex-none">{tr('Mixed')}</ToggleGroupItem>
          </ToggleGroup>
        )}
        <p className="mt-2 text-sm" data-testid="scan-shadow">
          {shadowPages
            ? tr('In shadow: {0} pages — the model right on {1}, Haiku on {2}', { 0: shadowPages, 1: pct(Number(s.shadowModelRight || 0), shadowPages), 2: pct(Number(s.shadowHaikuRight || 0), shadowPages) })
            : tr('No page read in shadow yet (the model reads once a version has one).')}
        </p>
      </Section>

      <Section label={tr('Passport zone reader')} panel>
        <p className="mb-2 text-sm text-muted-foreground">{tr('The firm\'s own small model reads the two lines at the bottom of a passport beside the AI, only compared: on each saved passport, did it get the number, the dates and the sex the user kept?')}</p>
        <p className="text-sm" data-testid="scan-mrz">
          {mrzPassports
            ? tr('In shadow: {0} passports — the reader right on {1}, the AI on {2}', { 0: mrzPassports, 1: pct(Number(s.mrzShadowRight || 0), mrzPassports), 2: pct(Number(s.mrzAiRight || 0), mrzPassports) })
            : tr('No passport read in shadow yet (the reader reads once a version has one).')}
        </p>
      </Section>

      <Section label={tr('Hebrew field reader')} panel>
        <p className="mb-2 text-sm text-muted-foreground">{tr('The firm\'s own small model reads an Israeli ID card\'s names, ID number and dates beside the AI, only compared: on each saved ID card, did it get the fields the user kept?')}</p>
        <p className="text-sm" data-testid="scan-he">
          {heCards
            ? tr('In shadow: {0} ID cards — the reader right on {1}, the AI on {2}', { 0: heCards, 1: pct(Number(s.heShadowRight || 0), heCards), 2: pct(Number(s.heAiRight || 0), heCards) })
            : tr('No ID card read in shadow yet (the reader reads once a version has one).')}
        </p>
      </Section>

      <Section label={tr('Full documents for the field reader model')} panel>
        <p className="mb-2 text-sm text-muted-foreground">{tr('After a scan, the saved worker window sends the document and the fields saved. On for every firm unless turned off here.')}</p>
        {err && <p className="text-sm text-bad">{tr(err)}</p>}
        {!set ? <Skeleton className="h-12 w-full" /> : (
          <CheckGrid data-testid="scan-collect">
            {firms.map(f => (
              <CheckTile key={f.id} label={f.name} data-firm={f.id} checked={set.collect[f.id] !== false}
                onCheckedChange={v => void change({ collect: { [f.id]: v === true } })} />
            ))}
          </CheckGrid>
        )}
      </Section>
    </div>
  );
}

// The automatic training cycle (docs/scan-training.md → The automatic cycle): the last cycles the owner's PC reported,
// newest first — the date, the state, the version and its pull request, each model's verdict, and why.
const LOOP_COLOR: Record<string, string> = { published: 'var(--ok)', rejected: 'var(--warn)', failed: 'var(--bad)', 'waiting-golden': 'var(--accent)', running: 'var(--accent)', paused: 'var(--neutral)', 'not-due': 'var(--neutral)' };

function AutoTraining({ history, locale }: { history: LoopReport[] | null; locale: string }) {
  return (
    <Section label={tr('Automatic training')} count={history?.length || undefined} panel data-testid="scan-loop">
      <p className="mb-2 text-sm text-muted-foreground">{tr('The PC trains by itself at night (Sunday and Wednesday, 02:00–08:00) when a model is due, and gives the lab a new version only when every exam says it is better — as a pull request to merge. The site is never changed by it.')}</p>
      {!history ? <Skeleton className="h-12 w-full" /> : (
        <PagedList items={history} empty={<p className="text-sm text-muted-foreground" data-testid="scan-loop-empty">{tr('No cycle reported yet.')}</p>} render={r => {
          const verdicts = LOOP_MODELS.filter(m => r.models[m]?.trained).map(m => loopModelName(m) + ': ' + (r.models[m]?.verdict === 'yes' ? tr('better') : r.models[m]?.verdict === 'no' ? tr('not better') : '—'));
          const reason = loopReason(r);
          return (
            <Plate key={r.id} data-testid="scan-loop-row" data-state={r.state} className="mb-1.5" color={LOOP_COLOR[r.state] || 'var(--neutral)'}
              title={<span>{loopStateName(r.state)}{r.version ? <span className="font-normal text-ink-3"> · {r.version}</span> : null}</span>}
              sub={<span className="grid whitespace-normal">
                <span><span className="font-mono">{shortWhen(r.startedAt || undefined, locale)}</span>{verdicts.length ? ' · ' + verdicts.join(' · ') : ''}</span>
                {reason && <span data-testid="scan-loop-reason">{reason}</span>}
              </span>}
              right={r.prUrl ? <a className="inline-flex items-center gap-1 text-sm text-[var(--accent)]" href={r.prUrl} target="_blank" rel="noopener" data-testid="scan-loop-pr">
                {tr('Pull request')} <IconExternalLink className="size-3.5" /></a> : undefined} />
          );
        }} />
      )}
    </Section>
  );
}
