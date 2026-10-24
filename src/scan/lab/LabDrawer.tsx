// The scanner lab's tools (docs/scan-plan.md → S9, package 7): a pull-up "Lab tools" drawer over the full-screen
// scanner (the design system's BottomSheet, ui/drawer) with what the lab's page showed under its camera — the
// figures as glass tiles (where the models run, the camera's frames per second, the model's ms per frame, how
// sure it is — 0.50 is found —, the model's load, the camera's resolution, the screen's frames per second, the
// capture, the follow's frames per second and ms; drawn only while the drawer is open, useFigures), the training
// queue ("In queue: n / 5") and the new attempts since the last training (a super-admin's), the settings (the
// models; the CPU's ONNX Runtime build, which reloads the page with ?ort=130 as the lab's did; the backend —
// switching clears the frame and the figures), the readouts of every page, the errors (newest on top, with
// their times, and the earlier failures on this device) and the loading-and-work log. The log and error lines
// are the engine's own English text (data, like the error texts the functions return); the labels go through tr().
import * as React from 'react';
import { IconAdjustments } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Figures } from '@/components/shared/section';
import { PagedList } from '@/components/shared/paged-list';
import { Plate } from '@/components/shared/plate';
import { QUEUE_MAX, type TrainFigures } from '../engine/attempts';
import type { EngineSettings } from '../engine/engines';
import type { Figures as LiveFigures } from '../engine/live';
import type { ShotPage } from '../engine/shot';
import type { Want } from '../engine/models';
import type { OrtDir } from '../engine/surface';
import { useFigures } from '../ui/useFigures';
import type { ScanSessionLike } from '../ui/useScanSession';
import { PageReadouts } from './Readouts';

/** The lab's model choices (the live model + the capture model, or one for both); the labels are read when drawn
 *  (the language picked). */
export const MODEL_CHOICES: { value: string; label: () => string }[] = [
  { value: 'lite.onnx+sa24_w16.onnx', label: () => tr('Live: light · capture: accurate') },
  { value: 'sa24_w16.onnx', label: () => tr('Accurate only (42 MB)') },
  { value: 'lite.onnx', label: () => tr('Light only (5 MB)') },
];
const ENGINE_CHOICES: { value: OrtDir; label: () => string }[] = [
  { value: 'ort', label: () => tr('CPU engine: ONNX Runtime 1.22') },
  { value: 'ort130', label: () => tr('CPU engine: ONNX Runtime 1.30') },
];
const BACKEND_CHOICES: { value: Want; label: () => string }[] = [
  { value: 'auto', label: () => tr('Auto (GPU, else CPU)') },
  { value: 'webgpu', label: () => tr('GPU (WebGPU)') },
  { value: 'wasm', label: () => tr('CPU (WASM)') },
];

const dash = '—';
const fixed = (v: number | null | undefined, d: number): string => (v == null || !isFinite(v) ? dash : v.toFixed(d));
const whole = (v: number | null | undefined): string => (v == null || !isFinite(v) ? dash : String(Math.round(v)));

/** The figures as the tiles show them. */
function figureItems(f: LiveFigures | null) {
  return [
    { key: 'runs', label: tr('runs on'), value: <span className="block truncate text-[13px] leading-[26px]">{f?.runsOn || dash}</span> },
    { key: 'fps', label: tr('camera frames/s'), value: fixed(f?.fps, 1) },
    { key: 'ms', label: tr('ms per frame (model)'), value: whole(f?.modelMs) },
    { key: 'conf', label: tr('confidence (≥ 0.50 = found)'), value: fixed(f?.conf, 2) },
    { key: 'load', label: tr('model load, s'), value: fixed(f?.loadSeconds, 1) },
    { key: 'res', label: tr('camera resolution'), value: <span className="block truncate text-[15px] leading-[26px]">{f?.resolution || dash}</span> },
    { key: 'ui', label: tr('screen frames/s (smoothness)'), value: whole(f?.uiFps) },
    { key: 'cap', label: tr('capture, ms'), value: whole(f?.captureMs) },
    { key: 'track', label: tr('frame follows, frames/s'), value: whole(f?.followFps) },
    { key: 'trackMs', label: tr('follow, ms per frame'), value: whole(f?.followMs) },
  ];
}

function Head({ children }: { children: React.ReactNode }) {
  return <div className="og-label mt-1">{children}</div>;
}

function Choice<T extends string>({ value, choices, onChange, testid }: { value: T; choices: { value: T; label: () => string }[]; onChange: (v: T) => void; testid: string }) {
  return (
    <Select value={value} onValueChange={v => onChange(v as T)}>
      <SelectTrigger data-testid={testid} className="min-w-0"><SelectValue /></SelectTrigger>
      <SelectContent>{choices.map(c => <SelectItem key={c.value} value={c.value}>{c.label()}</SelectItem>)}</SelectContent>
    </Select>
  );
}

export function LabDrawer({ session, figuresNow, errors, lines, settings, onSettings, cpuDir, onCpuDir, train, pages }: {
  session: ScanSessionLike;
  /** the figures now (the tiles before the first figures event) */
  figuresNow: () => LiveFigures;
  /** the Errors block and the Loading-and-work log, newest on top */
  errors: string[];
  lines: string[];
  settings: EngineSettings;
  onSettings: (patch: Partial<EngineSettings>) => void;
  cpuDir: OrtDir;
  onCpuDir: (dir: OrtDir) => void;
  train: TrainFigures | null;
  /** the pages found, in order, with their readouts */
  pages: ShotPage[];
}) {
  const [open, setOpen] = React.useState(false);
  const live = useFigures(session, open);
  const figures = live || (open ? figuresNow() : null);
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <Button size="sm" data-testid="lab-tools"
          className="absolute left-4 top-[calc(76px+env(safe-area-inset-top,0px))] z-10">
          <IconAdjustments className="size-[18px]" />{tr('Lab tools')}
        </Button>
      </DrawerTrigger>
      <DrawerContent data-testid="lab-drawer">
        <DrawerHeader>
          <DrawerTitle>{tr('Lab tools')}</DrawerTitle>
          <DrawerDescription>{tr('How fast and how sure the models are on this phone')}</DrawerDescription>
        </DrawerHeader>

        <div data-testid="lab-figures"><Figures items={figureItems(figures)} className="!mb-0 !grid-cols-[repeat(auto-fill,minmax(150px,1fr))]" /></div>
        {train && (train.waiting > 0 || train.fresh) && (
          <div data-testid="lab-train" className="text-[12.5px] text-ink-2">
            {[train.waiting > 0 ? tr('In queue: {n} / {max}', { n: train.waiting, max: QUEUE_MAX }) : '',
              train.fresh ? tr('New for training: {n} / {at}', { n: train.fresh.n, at: train.fresh.at }) : ''].filter(Boolean).join(' · ')}
          </div>
        )}

        <Head>{tr('Settings')}</Head>
        <div data-testid="lab-settings" className="grid gap-2">
          <Choice testid="lab-model" value={settings.model} choices={MODEL_CHOICES} onChange={model => onSettings({ model })} />
          <div className="grid grid-cols-2 gap-2">
            <Choice testid="lab-engine" value={cpuDir} choices={ENGINE_CHOICES} onChange={onCpuDir} />
            <Choice testid="lab-backend" value={settings.backend} choices={BACKEND_CHOICES} onChange={backend => onSettings({ backend })} />
          </div>
        </div>

        <Head>{tr('Readouts')}</Head>
        <div data-testid="lab-readouts" className="grid gap-2">
          <PagedList items={pages} empty={<div className="text-[12.5px] text-ink-2">{tr('No pages yet')}</div>}
            render={(p, i) => (
              <Plate key={p.id} size="sm" title={tr('Page {n}', { n: i + 1 })} expanded>
                <PageReadouts page={p} />
              </Plate>
            )} />
        </div>

        <Head>{tr('Errors')}</Head>
        <pre data-testid="lab-errors" className="m-0 whitespace-pre-wrap break-words font-mono text-[12px] leading-4 text-[var(--red-text)]">{errors.length ? errors.join('\n') : ''}</pre>
        {!errors.length && <div className="text-[12px] text-ink-2">{tr('No errors')}</div>}

        <Head>{tr('Loading and work')}</Head>
        <pre data-testid="lab-log" className="m-0 whitespace-pre-wrap break-words font-mono text-[12px] leading-4 text-ink-2">{lines.join('\n')}</pre>
      </DrawerContent>
    </Drawer>
  );
}
