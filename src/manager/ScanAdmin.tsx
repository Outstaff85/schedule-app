// Admin → Scanner (docs/hf-plan.md → Admin → Scanner; a super-admin's): where each of the
// scanner's own models stands — the examples collected for it, the versions in the lab and on
// the site (Hugging Face) —, how the document type model is used (Off / Shadow: it reads beside
// Haiku, only compared / Mixed: a page it is sure of needs no Haiku), the shadow's figures, and
// which firms' full documents are collected for the field reader model (on unless turned off).
// The figures and the settings come from scan_feedback (src/scan/server.ts).
import * as React from 'react';
import { IconExternalLink } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { CheckGrid, CheckTile } from '@/components/ui/checkbox';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Figures, Section } from '@/components/shared/section';
import { scanSettings, trainingStats, type DoctypeMode, type ScanSettings, type TrainingStats } from '@/scan/server';
import type { AdminSnapshot, ManagerBridge } from './bridge';

const RETRAIN_AT = 200, DOCTYPE_AT = 100; // functions/feedback.py RETRAIN_AT, DOCTYPE_AT
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
