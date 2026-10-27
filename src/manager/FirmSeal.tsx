// The firm's signature and stamp (docs/contracts.md → The firm's signature and stamp): two plates —
// the firm's signature (drawn with a finger, or a picture) and its stamp (a picture: a photo or a scan,
// its paper made transparent on the server) — each with its preview on a white card. Drawn at the bottom
// right of every page of the contracts whose template has it ticked, the signature first and the stamp
// over it, and where a template has {{company_signature}} or {{stamp}}. Only the firm's owner, the
// super-admin or a login with the right "Firm's signature and stamp" (canFirmSign) changes them — the
// others see whether each is set. Saved on its own (functions/seal.py through the contract_templates
// function); a delete goes through the Undo snack. Shown in the firm window, in Admin → Contract
// templates (FirmSealWindow) and in the worker window's Contract section.
import * as React from 'react';
import { IconLoader2, IconPencil, IconPhotoUp, IconRubberStamp, IconSignature } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Plate } from '@/components/shared/plate';
import { Window } from '@/components/shared/window';
import { undoDelete } from '@/components/shared/undo';
import { SignaturePad, type SignaturePadHandle } from '@/components/shared/signature-pad';
import { downscaleForUpload, readFileB64 } from './logic/uploads';
import { deleteSeal, saveSeal, sealInfo, type SealInfo, type SealKind } from './contracts';

type Toast = (msg: string, ms?: number) => void;

export function FirmSealSection({ tenantId, toast }: { tenantId?: string | null; toast: Toast }) {
  const [info, setInfo] = React.useState<SealInfo | null>(null);
  const [err, setErr] = React.useState('');
  const [busy, setBusy] = React.useState<SealKind | null>(null);
  const [hidden, setHidden] = React.useState<SealKind[]>([]);
  const [drawing, setDrawing] = React.useState(false);
  const files = { stamp: React.useRef<HTMLInputElement>(null), signature: React.useRef<HTMLInputElement>(null) };
  const load = React.useCallback(() => {
    sealInfo(tenantId).then(i => { setInfo(i); setErr(''); }, e => setErr(String(e?.message || e)));
  }, [tenantId]);
  React.useEffect(load, [load]);

  const took = (kind: SealKind, i: SealInfo) => {
    setInfo(i);
    toast(kind === 'stamp' ? tr('Stamp saved') : tr("Firm's signature saved"));
  };
  const save = async (kind: SealKind, b64: string, drawn: boolean) => {
    setBusy(kind);
    try { took(kind, await saveSeal(kind, b64, drawn, tenantId)); } catch (e: any) { toast(tr(String(e?.message || e))); } finally { setBusy(null); }
  };
  const upload = async (kind: SealKind, f: File) => {
    try {
      const small = await downscaleForUpload(await readFileB64(f), f.type || 'image/jpeg');
      await save(kind, small.b64, false);
    } catch (e: any) { toast(tr(String(e?.message || e))); }
  };
  const remove = (kind: SealKind) => {
    setHidden(h => [...h, kind]);
    undoDelete(kind === 'stamp' ? tr('Stamp') : tr("Firm's signature"),
      () => { deleteSeal(kind, tenantId).then(setInfo, e => toast(tr(String(e?.message || e)))).finally(() => setHidden(h => h.filter(k => k !== kind))); },
      () => setHidden(h => h.filter(k => k !== kind)));
  };

  if (err && !info) return <p className="text-[13px] text-bad" data-testid="firm-seal-error">{tr(err)}</p>;
  if (!info) return <p className="inline-flex items-center gap-2 text-sm text-ink-2" data-testid="firm-seal-loading"><IconLoader2 className="size-4 animate-spin" />{tr('Loading…')}</p>;
  const can = info.canFirmSign;
  const has = (k: SealKind) => !hidden.includes(k) && (k === 'stamp' ? info.hasStamp : info.hasSignature);

  const plate = (kind: SealKind) => {
    const set = has(kind), preview = set ? info.previews?.[kind] : null;
    const sub = !set ? tr('Not set') : kind === 'signature' && info.signatureWay ? (info.signatureWay === 'drawn' ? tr('Drawn') : tr('A picture')) : tr('Set');
    return (
      <Plate data-testid={'firm-seal-' + kind} data-set={set ? '1' : '0'} className="mb-1.5" color={set ? 'var(--ok)' : 'var(--neutral)'}
        icon={kind === 'stamp' ? <IconRubberStamp /> : <IconSignature />}
        title={kind === 'stamp' ? tr('Stamp') : tr("Firm's signature")} sub={sub}
        onOpen={can ? () => (kind === 'signature' ? setDrawing(true) : files.stamp.current?.click()) : undefined}
        onDelete={can && set ? () => remove(kind) : undefined}
        expanded={can} >
        {can && <div className="grid gap-2 pb-1">
          {preview && <div className="grid place-items-center rounded-lg border border-line bg-white p-2">
            <img src={'data:image/png;base64,' + preview} alt={kind === 'stamp' ? tr('Stamp') : tr("Firm's signature")} data-testid={'firm-seal-preview-' + kind}
              className="max-h-28 max-w-full object-contain" />
          </div>}
          <div className="flex flex-wrap gap-1.5">
            {kind === 'signature' && <Button size="sm" data-testid="firm-seal-draw" disabled={!!busy} onClick={() => setDrawing(true)}>
              <IconPencil className="size-4" />{tr('Draw')}</Button>}
            <Button size="sm" data-testid={'firm-seal-upload-' + kind} disabled={!!busy} onClick={() => files[kind].current?.click()}>
              {busy === kind ? <IconLoader2 className="size-4 animate-spin" /> : <IconPhotoUp className="size-4" />}{tr('Upload picture')}</Button>
          </div>
          <input ref={files[kind]} type="file" accept="image/*" className="hidden" data-testid={'firm-seal-file-' + kind}
            onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(kind, f); }} />
        </div>}
      </Plate>
    );
  };
  return (
    <div className="grid gap-1" data-testid="firm-seal" data-can={can ? '1' : '0'}>
      {plate('signature')}
      {plate('stamp')}
      <p className="text-[11px] leading-normal text-ink-3">
        {tr('Drawn bottom right on every page of the contracts whose template has it ticked, the signature first and the stamp over it; also where a template has {{company_signature}} or {{stamp}}.')}</p>
      {!can && <p className="text-[11px] text-ink-3" data-testid="firm-seal-readonly">{tr("Only the firm's admin or a login with the right \"Firm's signature and stamp\" changes them.")}</p>}
      {drawing && <DrawWindow onClose={() => setDrawing(false)} onSave={png => { setDrawing(false); void save('signature', png, true); }} />}
    </div>
  );
}

/** The firm's signature drawn with a finger: one Save. */
function DrawWindow({ onClose, onSave }: { onClose: () => void; onSave: (pngDataUrl: string) => void }) {
  const pad = React.useRef<SignaturePadHandle>(null);
  const [ink, setInk] = React.useState(false);
  return (
    <Window open onOpenChange={o => { if (!o) onClose(); }} title={tr("Firm's signature")}
      footer={<Button variant="primary" data-testid="firm-seal-draw-save" disabled={!ink} onClick={() => { const png = pad.current?.image(); if (png) onSave(png); }}>{tr('Save')}</Button>}>
      <div className="grid gap-2 px-1 pb-2" data-testid="firm-seal-draw-window">
        <p className="text-sm text-ink-2">{tr("Sign as the firm signs its contracts.")}</p>
        <SignaturePad ref={pad} onInk={setInk} />
      </div>
    </Window>
  );
}

/** The section in its own window (Admin → Contract templates, the worker window's Contract section). */
export function FirmSealWindow({ tenantId, toast, onClose }: { tenantId?: string | null; toast: Toast; onClose: () => void }) {
  return (
    <Window open onOpenChange={o => { if (!o) onClose(); }} title={tr("Firm's signature and stamp")}>
      <div className="px-1 pb-2" data-testid="firm-seal-window"><FirmSealSection tenantId={tenantId} toast={toast} /></div>
    </Window>
  );
}
