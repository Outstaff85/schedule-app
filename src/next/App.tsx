// /next — the component gallery of the new stack (archive/docs/react-migration-plan.md →
// stage 1): every shared component and every shadcn/ui component in its
// states, inside the Shell, in the chosen language. Not linked from the app.
// Names and figures here are examples, not data.
import * as React from 'react';
import { AnimatePresence } from 'motion/react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import {
  IconAlertTriangle, IconBell, IconBuilding, IconCalendarEvent, IconChartBar, IconCheck, IconCircleCheck, IconCoins,
  IconDownload, IconFileText, IconInfoCircle, IconLayoutGrid, IconListDetails, IconPlus, IconUser, IconUsers, IconX,
  IconCalendar, IconCash, IconHome, IconLayoutSidebar, IconLock, IconTruckDelivery, IconUsersGroup,
} from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useIsPhone } from '@/hooks/use-phone';
import { Brand, Shell, ShellGreeting, type ShellSection } from '@/components/shared/shell';
import { PullRefresh } from '@/components/shared/pull-refresh';
import { PageHead } from '@/components/shared/page-head';
import { Figures, Section } from '@/components/shared/section';
import { Plate } from '@/components/shared/plate';
import { PagedList } from '@/components/shared/paged-list';
import { undoDelete } from '@/components/shared/undo';
import { SelectBar, SelectHead, useSelection } from '@/components/shared/select-mode';
import { Window } from '@/components/shared/window';
import { SignaturePad } from '@/components/shared/signature-pad';
import { SignDocuments } from '@/components/shared/sign-documents';
import { LanguageButton } from '@/components/shared/language';
import { AccountMenu } from '@/components/shared/account-menu';
import { AppBrand, ShellBell } from '@/components/shared/app-brand';
import { ThemeButton, ThemeSwitch } from '@/components/shared/theme-switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Progress } from '@/components/ui/progress';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Empty, EmptyContent, EmptyDescription, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { CheckGrid, CheckTile, Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ButtonGroup } from '@/components/ui/button-group';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Calendar } from '@/components/ui/calendar';
import { DatePicker } from '@/components/ui/date-picker';
import { Combobox } from '@/components/ui/combobox';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { ChartContainer, ChartTooltip, ChartTooltipContent, Recharts, type ChartConfig } from '@/components/ui/chart';
import { NewBadge } from '@/components/shared/new-badge';
import { FieldRow, Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormSection } from '@/components/ui/form';

/** One gallery block: the component's name, then its states. */
function Demo({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section data-testid={`demo-${id}`} className="min-w-0 rounded-[var(--radius-xl)] border border-border bg-white/[.03] p-4">
      <h2 className="og-label mb-3">{title}</h2>
      <div className="grid gap-3">{children}</div>
    </section>
  );
}
const Grid = ({ children }: { children: React.ReactNode }) => <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr))]">{children}</div>;
const Row = ({ children }: { children: React.ReactNode }) => <div className="flex flex-wrap items-center gap-2">{children}</div>;

// Example workers (names are data: never translated)
type W = { id: string; name: string; site: string; hours: number; color: string; note?: 'visa' | 'docs' };
const SITES = ['Haifa Port', 'Ashdod Logistics', 'Netanya Mall'];
const NAMES = ['Avi Cohen', 'Dana Levi', 'Andrei Popescu', 'Mikhail Orlov', 'Sara Mizrahi', 'Ion Rusu', 'Moshe Biton', 'Natalia Ivanova', 'Omar Haddad', 'Elena Bondar', 'Yosef Peretz', 'Rina Azoulay', 'Pavel Smirnov', 'Noa Friedman'];
const COLORS = ['var(--green)', 'var(--green)', 'var(--accent)', 'var(--amber)', 'var(--green)', 'var(--red)'];
const WORKERS: W[] = NAMES.map((name, i) => ({ id: 'w' + i, name, site: SITES[i % 3], hours: 96 + ((i * 37) % 90), color: COLORS[i % COLORS.length], note: i % 5 === 1 ? 'visa' : i % 7 === 3 ? 'docs' : undefined }));

function chipsOf(w: W) {
  if (w.note === 'visa') return <Badge variant="bad">{tr('Visa')}</Badge>;
  if (w.note === 'docs') return <Badge variant="warn">{tr('Docs')}</Badge>;
  return null;
}

/* ───────── Controls ───────── */
function Controls() {
  const [client, setClient] = React.useState<string>('');
  const [worker, setWorker] = React.useState<string>('w1');
  const [date, setDate] = React.useState('2026-10-17');
  const [pay, setPay] = React.useState('hour');
  const [loading, setLoading] = React.useState(false);
  return (
    <Grid>
      <Demo id="button" title={tr('Button')}>
        <Row>
          <Button variant="primary"><IconCheck className="size-[18px]" />{tr('Approve the month')}</Button>
          <Button className="og-new"><IconPlus className="size-[18px]" />{tr('New worker')}</Button>
          <Button>{tr('Export')}</Button>
        </Row>
        <Row>
          <Button size="icon" aria-label={tr('Download')}><IconDownload className="size-[18px]" /></Button>
          <Button on>{tr('Active')}</Button>
          <Button variant="danger">{tr('Delete')}</Button>
          <Button disabled>{tr('Disabled')}</Button>
          <Button size="sm" onClick={() => { setLoading(true); window.setTimeout(() => setLoading(false), 1500); }} disabled={loading}>
            {loading ? <Spinner /> : null}{loading ? tr('Saving…') : tr('Save')}
          </Button>
        </Row>
      </Demo>

      <Demo id="input" title={tr('Input and Textarea')}>
        <FieldRow>
          <div className="grid gap-1.5"><Label htmlFor="d-first">{tr('First name')}</Label><Input id="d-first" placeholder="Avi" /></div>
          <div className="grid gap-1.5"><Label htmlFor="d-phone">{tr('Phone')}</Label><Input id="d-phone" type="tel" defaultValue="050-1234567" /></div>
        </FieldRow>
        <FieldRow>
          <div className="grid gap-1.5"><Label htmlFor="d-bad">{tr('ID number')}</Label><Input id="d-bad" aria-invalid defaultValue="12345" /></div>
          <div className="grid gap-1.5"><Label htmlFor="d-off">{tr('Firm')}</Label><Input id="d-off" disabled defaultValue="Odinson" /></div>
        </FieldRow>
        <div className="grid gap-1.5"><Label htmlFor="d-note">{tr('Note')}</Label><Textarea id="d-note" placeholder={tr('A long text fills its line')} /></div>
      </Demo>

      <Demo id="select" title={tr('Select, Combobox, Date Picker')}>
        <div className="grid gap-1.5">
          <Label>{tr('Client')}</Label>
          <Select value={client} onValueChange={setClient}>
            <SelectTrigger data-testid="select-trigger"><SelectValue placeholder={tr('Choose a client')} /></SelectTrigger>
            <SelectContent>{SITES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <FieldRow>
          <div className="grid gap-1.5">
            <Label htmlFor="d-worker">{tr('Worker')}</Label>
            <Combobox id="d-worker" value={worker} onChange={setWorker} options={WORKERS.map(w => ({ value: w.id, label: w.name, hint: w.site }))} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="d-date">{tr('Date')}</Label>
            <DatePicker id="d-date" value={date} onChange={setDate} />
          </div>
        </FieldRow>
      </Demo>

      <Demo id="checkbox" title={tr('Tick tiles, Switch, Radio')}>
        <CheckGrid>
          <CheckTile label={tr('Hours')} defaultChecked />
          <CheckTile label={tr('Approve')} />
          <CheckTile label={tr('Export')} defaultChecked />
          <CheckTile label={tr('Sees own workers\' pay')} hint={tr('Rates and pay mode')} wide />
          <CheckTile label={tr('Disabled')} disabled />
        </CheckGrid>
        <Row>
          <Label className="text-sm text-ink"><Switch defaultChecked />{tr('Notifications')}</Label>
          <Label className="text-sm text-ink"><Switch disabled />{tr('Disabled')}</Label>
          <Label className="text-sm text-ink"><Checkbox defaultChecked />{tr('Plain checkbox')}</Label>
        </Row>
        <RadioGroup value={pay} onValueChange={setPay} className="flex gap-4">
          <Label className="text-sm text-ink"><RadioGroupItem value="hour" />{tr('Per hour')}</Label>
          <Label className="text-sm text-ink"><RadioGroupItem value="day" />{tr('Per day')}</Label>
          <Label className="text-sm text-ink"><RadioGroupItem value="none" disabled />{tr('Disabled')}</Label>
        </RadioGroup>
      </Demo>

      <Demo id="toggle-group" title={tr('Toggle Group and Button Group')}>
        <ToggleGroup type="single" defaultValue="info">
          <ToggleGroupItem value="info">{tr('Info')}</ToggleGroupItem>
          <ToggleGroupItem value="docs">{tr('Docs')}</ToggleGroupItem>
          <ToggleGroupItem value="hours">{tr('Hours')}</ToggleGroupItem>
        </ToggleGroup>
        <Row>
          <ButtonGroup><Button size="sm">Excel</Button><Button size="sm">PDF</Button></ButtonGroup>
          <ButtonGroup attached>
            <Button size="icon-sm" aria-label={tr('Earlier')}>‹</Button>
            <Button size="sm" className="!text-[var(--accent)]">{tr('October 2026')}</Button>
            <Button size="icon-sm" aria-label={tr('Later')}>›</Button>
          </ButtonGroup>
        </Row>
      </Demo>

      <WorkerForm />
    </Grid>
  );
}

// Form: React Hook Form + Zod; the messages are English keys shown through tr().
const workerSchema = z.object({
  first: z.string().min(1, 'Enter a first name'),
  last: z.string().min(1, 'Enter a last name'),
  phone: z.string().regex(/^0\d{1,2}-?\d{7}$/, 'Enter a phone like 050-1234567'),
  rate: z.coerce.number<string | number>().min(30, 'The rate is below the minimum wage'),
});
function WorkerForm() {
  const form = useForm<z.input<typeof workerSchema>, unknown, z.output<typeof workerSchema>>({ resolver: zodResolver(workerSchema), defaultValues: { first: '', last: '', phone: '', rate: 35 } });
  return (
    <Demo id="form" title={tr('Form')}>
      <Form {...form}>
        <form noValidate onSubmit={form.handleSubmit(v => toast.success(tr('{name} saved', { name: `${v.first} ${v.last}` })))} className="grid gap-3" data-testid="worker-form">
          <FormSection>{tr('Person')}</FormSection>
          <FieldRow>
            <FormField control={form.control} name="first" render={({ field }) => (
              <FormItem><FormLabel>{tr('First name')}</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="last" render={({ field }) => (
              <FormItem><FormLabel>{tr('Last name')}</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
            )} />
          </FieldRow>
          <FieldRow>
            <FormField control={form.control} name="phone" render={({ field }) => (
              <FormItem><FormLabel>{tr('Phone')}</FormLabel><FormControl><Input type="tel" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="rate" render={({ field }) => (
              <FormItem><FormLabel>{tr('Hourly rate, ₪')}</FormLabel><FormControl><Input type="number" {...field} value={String(field.value ?? '')} /></FormControl><FormMessage /></FormItem>
            )} />
          </FieldRow>
          <Button type="submit" variant="primary"><IconCheck className="size-[18px]" />{tr('Save')}</Button>
        </form>
      </Form>
    </Demo>
  );
}

/* ───────── Lists ───────── */
function Lists() {
  const [list, setList] = React.useState(WORKERS);
  const [open, setOpen] = React.useState<string | null>(null);
  const [edit, setEdit] = React.useState<W | null>(null);
  const [card, setCard] = React.useState<W | null>(null);
  const [filter, setFilter] = React.useState<string | null>(null);
  const [folded, setFolded] = React.useState(false);
  const sel = useSelection(list.map(w => w.id));
  const remove = (ids: string[]) => {
    const before = list;
    setList(l => l.filter(w => !ids.includes(w.id)));
    const one = before.find(w => w.id === ids[0]);
    undoDelete(ids.length === 1 && one ? tr('{name} deleted', { name: one.name }) : tr('{n} workers deleted', { n: ids.length }), () => {}, () => setList(before));
  };
  const shown = filter === 'notes' ? list.filter(w => w.note) : list;
  const total = shown.reduce((a, w) => a + w.hours, 0);
  return (
    <Grid>
      <Demo id="plate" title={tr('Plates, Section, Figures, Select, Undo, Show more')}>
        <PageHead title={tr('Workers')} count={shown.length}><Button size="sm" className="og-new"><IconPlus className="size-4" />{tr('New')}</Button></PageHead>
        <Figures
          items={[{ key: 'all', label: tr('Workers'), value: list.length }, { key: 'hours', label: tr('Hours'), value: total }, { key: 'notes', label: tr('Notices'), value: list.filter(w => w.note).length, color: 'var(--amber)' }]}
          active={filter}
          onPick={k => setFilter(f => (f === k || k !== 'notes' ? null : k))}
        />
        <div className="flex items-center gap-2"><SelectHead sel={sel} /></div>
        <Section label={tr('Active')} count={shown.length} folded={folded} onFold={() => setFolded(f => !f)}>
          <AnimatePresence initial={false}>
            <PagedList
              items={shown}
              render={w => (
                <Plate
                  key={w.id}
                  data-testid={`plate-${w.id}`}
                  title={w.name}
                  chips={chipsOf(w)}
                  sub={`${w.site} · ${tr('In')} 07:58`}
                  right={`${w.hours}h`}
                  color={w.color}
                  selecting={sel.on}
                  selected={sel.picked.has(w.id)}
                  onToggle={() => sel.toggle(w.id)}
                  onOpen={() => setOpen(o => (o === w.id ? null : w.id))}
                  onEdit={() => setEdit(w)}
                  onDelete={() => remove([w.id])}
                  actions={[{ label: tr('Open card'), icon: <IconUser />, onSelect: () => setCard(w) }]}
                  expanded={open === w.id}
                >
                  <div className="grid gap-1 text-[13px]">
                    <div className="flex justify-between"><span className="text-muted-foreground">{tr('Regular')}</span><span className="font-mono">{w.hours - 12}h</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">{tr('Overtime')}</span><span className="font-mono">12h</span></div>
                  </div>
                </Plate>
              )}
            />
          </AnimatePresence>
        </Section>
        <SelectBar sel={sel} onDelete={remove}>
          <Button size="icon-sm" aria-label={tr('Export')} disabled={!sel.picked.size}><IconDownload className="size-4" /></Button>
        </SelectBar>
      </Demo>

      <Demo id="plate-sizes" title={tr('Plate sizes and states')}>
        <Plate size="sm" title="Avi Cohen" sub={tr('Small')} right="8h" />
        <Plate title="Dana Levi" sub={tr('Medium (default)')} right="₪4,120" color="var(--accent)" />
        <Plate size="lg" title="Andrei Popescu" sub={tr('Large')} right="182h" color="var(--amber)" chips={<Badge variant="warn">{tr('Docs')}</Badge>} />
        <Plate title={tr('Visa expired')} sub="Mikhail Orlov" color="var(--red)" icon={<IconAlertTriangle />} />
        <Plate title="Odinson" sub={tr('Firm')} color="var(--accent)" icon={<IconBuilding />} right={<Badge variant="ok">{tr('Active')}</Badge>} />
        <Plate title="Noa Katz" sub={tr('Added today')} chips={<NewBadge createdAt={Date.now()} />} />
      </Demo>

      <Demo id="empty" title={tr('Empty, Skeleton')}>
        <Empty>
          <EmptyMedia><IconUsers /></EmptyMedia>
          <EmptyTitle>{tr('No workers yet')}</EmptyTitle>
          <EmptyDescription>{tr('Add the first worker, or scan a passport to fill the form.')}</EmptyDescription>
          <EmptyContent><Button size="sm" className="og-new"><IconPlus className="size-4" />{tr('New worker')}</Button></EmptyContent>
        </Empty>
        <div className="grid gap-2"><Skeleton className="h-[62px]" /><Skeleton className="h-[62px]" /><Skeleton className="h-4 w-2/3" /></div>
      </Demo>

      <Window open={!!edit} onOpenChange={o => !o && setEdit(null)} title={tr('Edit worker')} description={edit?.name}>
        {edit && (
          <FieldRow>
            <div className="grid gap-1.5"><Label htmlFor="e-name">{tr('Name')}</Label><Input id="e-name" defaultValue={edit.name} /></div>
            <div className="grid gap-1.5"><Label htmlFor="e-site">{tr('Site')}</Label><Input id="e-site" defaultValue={edit.site} /></div>
          </FieldRow>
        )}
      </Window>
      <Window open={!!card} onOpenChange={o => !o && setCard(null)} title={card?.name || ''} description={card?.site}
        footer={<Button variant="primary" onClick={() => { const w = card; setCard(null); if (w) setEdit(w); }}>{tr('Edit')}</Button>}>
        {card && <div className="grid grid-cols-2 gap-2">{[[tr('Hours'), `${card.hours}h`], [tr('Site'), card.site]].map(([k, v]) => (
          <div key={k} className="rounded-[14px] bg-plate px-3 py-2.5"><span className="og-label block !text-[10px]">{k}</span><b className="text-sm">{v}</b></div>
        ))}</div>}
      </Window>
    </Grid>
  );
}

/* ───────── Windows ───────── */
function Windows() {
  const phone = useIsPhone();
  const [win, setWin] = React.useState(false);
  const [second, setSecond] = React.useState(false);
  return (
    <Grid>
      <Demo id="window" title={tr('Window (Drawer on a phone, Dialog on a computer)')}>
        <p className="text-[13px] text-muted-foreground">{phone ? tr('On a phone it rises from the bottom: close it with a tap outside or a swipe down.') : tr('On a computer it opens in the middle: close it with a tap outside or Escape.')}</p>
        <Row><Button variant="primary" onClick={() => setWin(true)} data-testid="open-window">{tr('Open a window')}</Button></Row>
        <Window open={win && !second} onOpenChange={setWin} title={tr('Pay')} description="Avi Cohen"
          footer={<Button variant="primary" onClick={() => setWin(false)}><IconCheck className="size-[18px]" />{tr('Save')}</Button>}>
          <FieldRow>
            <div className="grid gap-1.5"><Label htmlFor="w-rate">{tr('Hourly rate, ₪')}</Label><Input id="w-rate" type="number" defaultValue={45} /></div>
            <div className="grid gap-1.5"><Label htmlFor="w-travel">{tr('Travel, ₪/day')}</Label><Input id="w-travel" type="number" defaultValue={22} /></div>
          </FieldRow>
          <Button onClick={() => setSecond(true)}>{tr('Open another window')}</Button>
        </Window>
        <Window open={second} onOpenChange={setSecond} title={tr('Bank details')} description={tr('Closing it goes back to the first window')}>
          <div className="grid gap-1.5"><Label htmlFor="w-bank">{tr('Bank')}</Label><Input id="w-bank" placeholder={tr('Bank, branch, account')} /></div>
        </Window>
      </Demo>

      <Demo id="signature" title={tr('Signature pad')}>
        <SignaturePad />
      </Demo>

      <Demo id="sign-documents" title={tr('Documents to sign')}>
        <SignDocuments signDate="01/01/2026" onSign={async () => { toast(tr('Signed')); }}
          docs={[{ key: 'a', title: tr('Form 101'), b64: SAMPLE_PDF }, { key: 'b', title: tr('Contract'), b64: SAMPLE_PDF }]} />
      </Demo>

      <Demo id="menu" title={tr('Dropdown Menu (⋮), Popover, Tooltip')}>
        <Row>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="icon" aria-label={tr('More')} data-testid="menu-trigger">⋮</Button></DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>{tr('Workers')}</DropdownMenuLabel>
              <DropdownMenuItem><IconFileText />{tr('Scan passport')}</DropdownMenuItem>
              <DropdownMenuItem><IconDownload />{tr('Export')}</DropdownMenuItem>
              <DropdownMenuItem><IconListDetails />{tr('Select…')}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive><IconX />{tr('Delete')}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Popover>
            <PopoverTrigger asChild><Button>{tr('Filters')}</Button></PopoverTrigger>
            <PopoverContent>
              <div className="grid gap-2">
                <b className="text-sm">{tr('Show')}</b>
                <CheckGrid><CheckTile label={tr('Active')} defaultChecked /><CheckTile label={tr('On vacation')} /></CheckGrid>
              </div>
            </PopoverContent>
          </Popover>
          <Tooltip>
            <TooltipTrigger asChild><Button size="icon" aria-label={tr('Info')}><IconInfoCircle className="size-[18px]" /></Button></TooltipTrigger>
            <TooltipContent>{tr('Hours of the month, every shift')}</TooltipContent>
          </Tooltip>
        </Row>
      </Demo>

      <Demo id="account" title={tr('Account menu')}>
        <Row>
          <AccountMenu name="Dana Levi" sub={tr('Client')} onSignOut={() => toast(tr('Sign out'))}>
            <DropdownMenuItem><IconUser />{tr('Profile')}</DropdownMenuItem>
          </AccountMenu>
        </Row>
      </Demo>

      <Demo id="theme" title={tr('Theme switch (Dark / Light / System)')}>
        <Row>
          <ThemeSwitch className="w-full max-w-[340px]" />
          <ThemeButton />
        </Row>
      </Demo>

      <Demo id="sheet" title={tr('Sheet and Alert Dialog')}>
        <Row>
          <Sheet>
            <SheetTrigger asChild><Button>{tr('Open a side panel')}</Button></SheetTrigger>
            <SheetContent side={phone ? 'bottom' : 'right'}>
              <SheetHeader><SheetTitle>{tr('Filters')}</SheetTitle><SheetDescription>{tr('A panel from the edge of the screen')}</SheetDescription></SheetHeader>
              <CheckGrid><CheckTile label={tr('Active')} defaultChecked /><CheckTile label={tr('Pending')} /><CheckTile label={tr('On vacation')} /></CheckGrid>
            </SheetContent>
          </Sheet>
          <AlertDialog>
            <AlertDialogTrigger asChild><Button variant="danger">{tr('Clear Log')}</Button></AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{tr('Clear the punch log?')}</AlertDialogTitle>
                <AlertDialogDescription>{tr('Every punch of this month is removed. This cannot be undone.')}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter><AlertDialogCancel>{tr('Keep')}</AlertDialogCancel><AlertDialogAction danger>{tr('Clear')}</AlertDialogAction></AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </Row>
        <p className="text-xs text-faint">{tr('Only an action that cannot be undone asks first; a delete uses Undo.')}</p>
      </Demo>
    </Grid>
  );
}

/* ───────── Feedback ───────── */
function Feedback() {
  const [p, setP] = React.useState(62);
  return (
    <Grid>
      <Demo id="alert" title={tr('Alert and Badge')}>
        <Alert variant="ok"><IconCircleCheck /><AlertTitle>{tr('Hours approved')}</AlertTitle><AlertDescription>{tr('Haifa Port approved every day of October.')}</AlertDescription></Alert>
        <Alert variant="info"><IconInfoCircle /><AlertTitle>{tr('Schedule updated')}</AlertTitle></Alert>
        <Alert variant="warn"><IconAlertTriangle /><AlertTitle>{tr('Visa expires in 9 days')}</AlertTitle><AlertDescription>Mikhail Orlov</AlertDescription></Alert>
        <Alert variant="bad"><IconX /><AlertTitle>{tr('No punch today')}</AlertTitle><AlertDescription>Ion Rusu · {tr('shift 07:00')}</AlertDescription></Alert>
        <Row><Badge>{tr('Draft')}</Badge><Badge variant="ok">{tr('Approved')}</Badge><Badge variant="info">{tr('Night')}</Badge><Badge variant="warn">{tr('Waiting')}</Badge><Badge variant="bad">{tr('Disputed')}</Badge></Row>
      </Demo>

      <Demo id="toast" title={tr('Toasts (Sonner) and the Undo snack')}>
        <Row>
          <Button onClick={() => toast(tr('Saved'))} data-testid="toast-plain">{tr('Message')}</Button>
          <Button onClick={() => toast.success(tr('Hours approved'))}>{tr('Success')}</Button>
          <Button onClick={() => toast.error(tr('No connection: the punch waits and is sent later'))}>{tr('Error')}</Button>
          <Button onClick={() => undoDelete(tr('{name} deleted', { name: 'Avi Cohen' }), () => toast(tr('Deleted for good')), () => toast(tr('Restored')))} data-testid="undo-demo">{tr('Delete with Undo')}</Button>
        </Row>
      </Demo>

      <Demo id="progress" title={tr('Progress and Spinner')}>
        <Progress value={p} />
        <Row>
          <Button size="sm" onClick={() => setP(v => (v >= 100 ? 0 : v + 19))}>{tr('Next step')}</Button>
          <span className="font-mono text-sm text-fig">{p}%</span>
          <Spinner className="size-5 text-ink-2" />
        </Row>
      </Demo>
    </Grid>
  );
}

/* ───────── Data ───────── */
// The Data Table demo: 14 rows (Show more after 10), sorting by a tap on a column head, the totals row.
const DATA_ROWS = WORKERS.slice(0, 14);
const CHART_DATA = [7.5, 8, 9.25, 0, 8, 10, 6.5, 8, 8.5, 0, 0, 9, 8, 7].map((hours, i) => ({ label: String(i + 1), hours }));
const DATA_COLUMNS: DataColumn<W>[] = [
  { id: 'name', header: () => tr('Worker'), accessorFn: r => r.name, sortFn: 'alphanumeric' },
  { id: 'hours', header: () => tr('Hours'), accessorFn: r => r.hours, cell: c => c.row.original.hours + 'h', meta: { num: true } },
  { id: 'pay', header: () => tr('Pay'), accessorFn: r => r.hours * 45, cell: c => '₪' + (c.row.original.hours * 45).toLocaleString('en-US'), meta: { num: true } },
];
function Data() {
  const [day, setDay] = React.useState<Date | undefined>(new Date(2026, 9, 17));
  const rows = WORKERS.slice(0, 5).map((w, i) => ({ ...w, reg: w.hours - 10 - i, ot: 10 + i, pay: w.hours * 45 }));
  const sum = (k: 'reg' | 'ot' | 'pay') => rows.reduce((a, r) => a + r[k], 0);
  return (
    <Grid>
      <Demo id="table" title={tr('Table')}>
        <Table>
          <TableHeader><TableRow><TableHead>{tr('Worker')}</TableHead><TableHead num>{tr('Regular')}</TableHead><TableHead num>{tr('Overtime')}</TableHead><TableHead num>{tr('Total')}</TableHead></TableRow></TableHeader>
          <TableBody>{rows.map(r => (
            <TableRow key={r.id}><TableCell><span className="mr-2 inline-block h-3.5 w-1 rounded-sm align-middle" style={{ background: r.color }} />{r.name}</TableCell><TableCell num>{r.reg}h</TableCell><TableCell num>{r.ot}h</TableCell><TableCell num className="text-fig">₪{r.pay.toLocaleString('en-US')}</TableCell></TableRow>
          ))}</TableBody>
          <TableFooter><TableRow><TableCell>{tr('Total')} · {rows.length}</TableCell><TableCell num>{sum('reg')}h</TableCell><TableCell num>{sum('ot')}h</TableCell><TableCell num className="text-fig">₪{sum('pay').toLocaleString('en-US')}</TableCell></TableRow></TableFooter>
        </Table>
      </Demo>

      <Demo id="data-table" title={tr('Data Table')}>
        <DataTable
          data-testid="data-table-demo"
          columns={DATA_COLUMNS}
          data={DATA_ROWS}
          rowId={r => r.id}
          footer={[tr('Total') + ' · ' + DATA_ROWS.length, DATA_ROWS.reduce((a, r) => a + r.hours, 0) + 'h', '₪' + DATA_ROWS.reduce((a, r) => a + r.hours * 45, 0).toLocaleString('en-US')]}
          card={r => <Plate key={r.id} title={r.name} sub={r.site} right={r.hours + 'h'} color={r.color} />}
        />
      </Demo>

      <Demo id="chart" title={tr('Chart')}>
        <ChartContainer data-testid="chart-demo" config={{ hours: { label: tr('Hours'), color: 'var(--info)' } } satisfies ChartConfig} className="aspect-auto h-[160px] w-full">
          <Recharts.BarChart data={CHART_DATA} margin={{ top: 4, right: 4, bottom: 0, left: -18 }}>
            <Recharts.CartesianGrid vertical={false} />
            <Recharts.XAxis dataKey="label" tickLine={false} axisLine={false} />
            <Recharts.YAxis tickLine={false} axisLine={false} width={44} />
            <ChartTooltip content={<ChartTooltipContent formatter={v => v + 'h'} />} />
            <Recharts.Bar dataKey="hours" fill="var(--color-hours)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </Recharts.BarChart>
        </ChartContainer>
      </Demo>

      <Demo id="calendar" title={tr('Calendar')}>
        <Calendar mode="single" selected={day} onSelect={setDay} defaultMonth={new Date(2026, 9, 1)} className="mx-auto" />
      </Demo>

      <Demo id="card" title={tr('Card and Separator')}>
        <Card>
          <CardHeader><div><CardTitle>{tr('Pay')}</CardTitle><CardDescription>{tr('October 2026 · an estimate before deductions')}</CardDescription></div><CardAction><Badge variant="ok">{tr('Approved')}</Badge></CardAction></CardHeader>
          <CardContent className="grid gap-1.5 text-[13px]">
            {[[tr('Regular'), '160h', '₪7,200'], [tr('Overtime'), '12h', '₪675'], [tr('Shabbat'), '8h', '₪540']].map(([k, h, v]) => (
              <div key={k} className="flex justify-between"><span className="text-muted-foreground">{k} · <span className="font-mono">{h}</span></span><span className="font-mono">{v}</span></div>
            ))}
            <Separator className="my-1" />
            <div className="flex justify-between font-semibold"><span>{tr('Total')}</span><span className="font-mono text-fig">₪8,415</span></div>
          </CardContent>
        </Card>
      </Demo>
    </Grid>
  );
}

/* ───────── Layout ───────── */
function Layout() {
  return (
    <Grid>
      <Demo id="tabs" title={tr('Tabs')}>
        <Tabs defaultValue="salary">
          <TabsList>
            <TabsTrigger value="salary">{tr('Salary')}</TabsTrigger>
            <TabsTrigger value="billing">{tr('Billing')}</TabsTrigger>
            <TabsTrigger value="approvals" count={3}>{tr('Approvals')}</TabsTrigger>
            <TabsTrigger value="alerts" count={2}>{tr('Alerts')}</TabsTrigger>
          </TabsList>
          <TabsContent value="salary"><Plate title="Avi Cohen" sub="182h · 22 days" right="₪8,415" /></TabsContent>
          <TabsContent value="billing"><Plate title="Haifa Port" sub="3 workers · ₪62/h" right="₪33,852" color="var(--accent)" /></TabsContent>
          <TabsContent value="approvals"><Plate title="Dana L. · 14.10" sub="Haifa Port" chips={<Badge variant="warn">{tr('Waiting')}</Badge>} color="var(--amber)" /></TabsContent>
          <TabsContent value="alerts"><Plate title={tr('Open shift — no OUT')} sub="Ion Rusu · 12.10" color="var(--red)" icon={<IconAlertTriangle />} /></TabsContent>
        </Tabs>
      </Demo>

      <Demo id="accordion" title={tr('Accordion (editor sections)')}>
        <Accordion type="single" collapsible defaultValue="person">
          <AccordionItem value="person" color="var(--accent)">
            <AccordionTrigger icon={<IconUser />} summary="Avi Cohen · 050-1234567">{tr('Person')}</AccordionTrigger>
            <AccordionContent><FieldRow><Input aria-label={tr('First name')} defaultValue="Avi" /><Input aria-label={tr('Last name')} defaultValue="Cohen" /></FieldRow></AccordionContent>
          </AccordionItem>
          <AccordionItem value="docs" color="var(--amber)">
            <AccordionTrigger icon={<IconFileText />} summary={tr('Visa, Form 101')} badge={<Badge variant="warn">{tr('1 missing')}</Badge>}>{tr('Documents')}</AccordionTrigger>
            <AccordionContent><Plate size="sm" title={tr('Visa')} sub="31/12/2026" color="var(--green)" icon={<IconFileText />} /></AccordionContent>
          </AccordionItem>
          <AccordionItem value="pay" color="var(--green)">
            <AccordionTrigger icon={<IconCoins />} summary="₪45/h">{tr('Pay')}</AccordionTrigger>
            <AccordionContent><ToggleGroup type="single" defaultValue="hour"><ToggleGroupItem value="hour">₪/h</ToggleGroupItem><ToggleGroupItem value="day">₪/day</ToggleGroupItem></ToggleGroup></AccordionContent>
          </AccordionItem>
        </Accordion>
      </Demo>

      <Demo id="collapsible" title={tr('Collapsible and Scroll Area')}>
        <Collapsible>
          <CollapsibleTrigger asChild><Button size="sm">{tr('Show the days')}</Button></CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 grid gap-1.5">{['Sun 12', 'Mon 13', 'Tue 14'].map(d => (
              <div key={d} className="flex justify-between rounded-xl bg-white/5 px-3 py-2 text-[13px]"><span>{d}</span><span className="font-mono text-fig">07:00–15:00</span></div>
            ))}</div>
          </CollapsibleContent>
        </Collapsible>
        <ScrollArea className="h-40 rounded-lg border border-border">
          <div className="grid gap-1 p-2">{WORKERS.map(w => <div key={w.id} className="rounded-lg px-2 py-1.5 text-sm hover:bg-white/5">{w.name}</div>)}</div>
        </ScrollArea>
      </Demo>
    </Grid>
  );
}

/* ───────── The manager app's frame (V7) ───────── */
// The Shell with `app`: the side menu, the breadcrumb, the date / greeting /
// weather in the middle, the Workers / Filter-by-client panel only on Workers
// and Schedule, a Today-like page (tiles, panels in two columns, pull to refresh).
const FRAME_SECTIONS: ShellSection[] = [
  { key: 'dashboard', label: 'Today', icon: <IconHome />, color: '#22d3ee' },
  { key: 'schedule', label: 'Schedule', icon: <IconCalendar />, color: '#818cf8' },
  { key: 'workers', label: 'Workers', icon: <IconUsersGroup />, color: '#6dd6a0' },
  { key: 'clients', label: 'Clients', icon: <IconUsers />, color: '#60a5fa' },
  { key: 'suppliers', label: 'Suppliers', icon: <IconTruckDelivery />, color: '#c084fc' },
  { key: 'admin', label: 'Admin', icon: <IconLock />, color: '#ff8a95' },
  { key: 'accounting', label: 'Accounting', icon: <IconCash />, color: '#f7c062', count: 2 },
];
const FRAME_CRUMB: Record<string, { count?: number; sub?: string }> = {
  schedule: { sub: tr('All sites') }, workers: { count: 12 }, clients: { count: 4 }, accounting: { sub: tr('Salary') }, admin: { sub: tr('Users') },
};
function Frame({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = React.useState('dashboard');
  const [pick, setPick] = React.useState<string | null>(null);
  const sections = FRAME_SECTIONS.map(s => ({ ...s, label: tr(s.label) }));
  const aside = tab === 'workers' || tab === 'schedule' ? (
    <div className="grid gap-1 px-3">
      <div className="og-label px-1 pb-1">{tr('Filter by Client')}</div>
      {['All clients', 'Haifa Port', 'Tel Aviv Mall'].map((c, i) => <div key={c} className={cn('rounded-xl px-3 py-2 text-[15px]', i === 0 && 'bg-white/8')}>{i === 0 ? tr(c) : c}</div>)}
    </div>
  ) : undefined;
  return (
    <Shell
      app
      brand={<AppBrand save="saved" />}
      tools={<>
        <ShellBell count={2} onClick={() => toast(tr('Notifications'))} />
        <LanguageButton />
        <AccountMenu name="Owner" firm="Firm One" sub="Firm One · owner" onSignOut={() => toast(tr('Sign out'))}>
          <DropdownMenuItem onSelect={onBack}>{tr('Back to the gallery')}</DropdownMenuItem>
        </AccountMenu>
      </>}
      sections={sections}
      active={tab}
      onSelect={setTab}
      crumb={FRAME_CRUMB[tab]}
      center={<ShellGreeting name="Owner" wx={{ kind: 'rain', temp: 14 }} />}
      aside={aside}
    >
      <PullRefresh onRefresh={() => new Promise(r => setTimeout(r, 600))}>
        <div data-testid="page-frame">
          <p className="mb-3 text-[15px] text-ink-2">{tr('Real-time attendance overview')}</p>
          <Figures active={pick} onPick={k => setPick(p => (p === k ? null : k))} className="min-[701px]:max-w-[680px]" items={[
            { key: 'on', label: tr('On shift'), value: 3, color: 'var(--green)' },
            { key: 'late', label: tr('Late'), value: 1, color: 'var(--amber)' },
            { key: 'none', label: tr('No punch'), value: 0, color: 'var(--ink-2)' },
            { key: 'notices', label: tr('Notices'), value: 2, color: 'var(--amber)' },
          ]} />
          <div className="grid items-start gap-x-4 min-[901px]:grid-cols-2">
            <div className="min-w-0">
              <Section panel icon={<IconUsers className="text-ok" />} label={tr('On shift')} count={3} onFold={() => {}}>
                {WORKERS.slice(0, 3).map(w => <Plate key={w.id} title={w.name} sub={w.site} right="6.5h" className="mb-1.5" />)}
              </Section>
            </div>
            <div className="min-w-0">
              <Section panel icon={<IconBell className="text-ink-2" />} label={tr("Today's Log")} onFold={() => {}}>
                <div className="rounded-[14px] border border-dashed border-white/20 px-3 py-3.5 text-center text-[13px] text-ink-2">{tr('No punches today')}</div>
              </Section>
            </div>
          </div>
          <Section label={tr('Plates in three columns')} count={WORKERS.length}>
            <PagedList columns items={WORKERS} render={w => <Plate key={w.id} title={w.name} sub={w.site} right="182h" className="mb-1.5" />} />
          </Section>
        </div>
      </PullRefresh>
    </Shell>
  );
}

const PAGES: Record<string, () => React.ReactElement> = { controls: Controls, lists: Lists, windows: Windows, feedback: Feedback, data: Data, layout: Layout };

export function App() {
  const [page, setPage] = React.useState(() => {
    const h = location.hash.slice(1);
    return PAGES[h] || h === 'frame' ? h : 'controls';
  });
  React.useEffect(() => { history.replaceState(null, '', '#' + page); window.scrollTo(0, 0); }, [page]);
  const sections: ShellSection[] = [
    { key: 'controls', label: tr('Controls'), icon: <IconLayoutGrid />, color: '#22d3ee' },
    { key: 'lists', label: tr('Lists'), icon: <IconUsers />, color: '#6dd6a0' },
    { key: 'windows', label: tr('Windows'), icon: <IconListDetails />, color: '#818cf8' },
    { key: 'feedback', label: tr('Feedback'), icon: <IconBell />, color: '#f7c062', count: 2 },
    { key: 'data', label: tr('Data'), icon: <IconChartBar />, color: '#4f8ef7' },
    { key: 'layout', label: tr('Layout'), icon: <IconCalendarEvent />, color: '#a78bfa' },
    { key: 'frame', label: tr('Frame (V7)'), icon: <IconLayoutSidebar />, color: '#f472b6' },
  ];
  if (page === 'frame') return <Frame onBack={() => setPage('controls')} />;
  const Page = PAGES[page];
  return (
    <Shell
      brand={<Brand name={tr('Interactive Manager')} />}
      tools={<LanguageButton />}
      sections={sections}
      active={page}
      onSelect={setPage}
    >
      <div className="mx-auto w-full max-w-6xl px-[max(16px,env(safe-area-inset-left,0px))] py-4" data-testid={`page-${page}`}>
        <PageHead title={tr('Components')}><Badge variant="info">{sections.find(s => s.key === page)?.label}</Badge></PageHead>
        <Page />
      </div>
    </Shell>
  );
}

// A one-page PDF for the Documents to sign block.
const SAMPLE_PDF = 'JVBERi0xLjcKJcK1wrYKJSBXcml0dGVuIGJ5IE11UERGIDEuMjguNQoKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFIvSW5mbzw8L1Byb2R1Y2VyKE11UERGIDEuMjguNSk+Pj4+CmVuZG9iagoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0NvdW50IDEvS2lkc1s0IDAgUl0+PgplbmRvYmoKCjMgMCBvYmoKPDwvRm9udDw8L2hlbHYgNSAwIFI+Pj4+CmVuZG9iagoKNCAwIG9iago8PC9UeXBlL1BhZ2UvTWVkaWFCb3hbMCAwIDMwMCAyMDBdL1JvdGF0ZSAwL1Jlc291cmNlcyAzIDAgUi9QYXJlbnQgMiAwIFIvQ29udGVudHNbNiAwIFIgNyAwIFJdPj4KZW5kb2JqCgo1IDAgb2JqCjw8L1R5cGUvRm9udC9TdWJ0eXBlL1R5cGUxL0Jhc2VGb250L0hlbHZldGljYS9FbmNvZGluZy9XaW5BbnNpRW5jb2Rpbmc+PgplbmRvYmoKCjYgMCBvYmoKPDwvTGVuZ3RoIDgzL0ZpbHRlci9GbGF0ZURlY29kZT4+CnN0cmVhbQp4nOMq5HIK4TJUMABCQwUjIGFmoBCSy6WfkZpTpmBoohCSphBtY2psZmiWYm5glmxmamRgZmKWZmZsbmqWYmZqlmpuYhcb4sXlGsIVyAUAox4RvQplbmRzdHJlYW0KZW5kb2JqCgo3IDAgb2JqCjw8L0xlbmd0aCA5OC9GaWx0ZXIvRmxhdGVEZWNvZGU+PgpzdHJlYW0KeNoVijEKhEAQBPN5xfzAmXG3lwO5QDAxEzYTw10MzsDE919LQ1EULbfMVVyNcw1iNK2XDGf7Per0rvuUPKwYHAWZltDJQGZJYXgN6G9hH/Hhr5ENJdr3qKssVTb5A/DkF9kKZW5kc3RyZWFtCmVuZG9iagoKeHJlZgowIDgKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDQyIDAwMDAwIG4gCjAwMDAwMDAxMjAgMDAwMDAgbiAKMDAwMDAwMDE3MiAwMDAwMCBuIAowMDAwMDAwMjEzIDAwMDAwIG4gCjAwMDAwMDAzMjYgMDAwMDAgbiAKMDAwMDAwMDQxNSAwMDAwMCBuIAowMDAwMDAwNTY2IDAwMDAwIG4gCgp0cmFpbGVyCjw8L1NpemUgOC9Sb290IDEgMCBSL0lEWzxDM0E3QzI4RUMyODU1QTQwQzM5RUMyODA3QzAxMEJDMz48QzA3RTU1NDBCMUU0NUUwMjZCMTQ1Q0ZGQzA4NkEwNjA+XT4+CnN0YXJ0eHJlZgo3MzIKJSVFT0YK';
