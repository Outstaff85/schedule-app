// Every mark a contract template may carry, by what fills it (owner, 2026-10-31): Admin → Contract templates, the { }
// button: a search, the groups as tabs, plain lines. A tap copies the mark, to paste it in the contract in Word. The groups follow docs/contracts.md → The marks;
// every entry of MARKS (contracts.ts) stands here once, a browser check holds the two equal.
import * as React from 'react';
import { IconSearch } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { Window } from '@/components/shared/window';
import { FormSection } from '@/components/ui/form';
import type { MARKS } from './contracts';

type Mark = (typeof MARKS)[number];

/** The groups in the contract's reading order; the texts go through tr() when drawn. */
export const MARK_GROUPS: { title: string; note?: string; marks: [Mark, string][] }[] = [
  { title: 'Worker', marks: [
    ['given', 'Given name'], ['surname', 'Surname'], ['full_name', 'Given name and surname'], ['id', 'ID or passport number'],
    ['id_type', 'ID or passport, as a word'], ['id_expiry', 'ID or passport expiry date'], ['dob', 'Date of birth'], ['sex', 'Sex'],
    ['marital', 'Marital status'], ['phone', 'Phone'], ['address', 'Street and house number'], ['city', 'City'],
    ['full_address', 'Street, house number and city'], ['health_fund', 'Health fund'],
  ] },
  { title: 'Work', marks: [
    ['start_date', 'Start date'], ['end_date', 'Contract end date, when set'], ['contract_months', 'Contract length in months, when set'],
    ['site', 'Client or site'], ['supplier', 'Supplier, when there is one'], ['schedule', 'Weekly hours'],
  ] },
  { title: 'Pay', note: 'Filled only when the login sending it may see pay', marks: [
    ['rate', 'Rate per hour or day'], ['pay_mode', 'Hourly or daily pay'], ['ot_rate', 'Overtime rate'], ['shabbat_rate', 'Shabbat rate'],
    ['travel', 'Travel allowance'], ['bank', 'Bank, branch and account number'],
  ] },
  { title: 'Firm', marks: [
    ['company', 'Firm name'], ['company_address', 'Firm address'], ['company_phone', 'Firm phone'], ['deductions_file', 'Deductions file number'],
    ['company_signature', "Firm's signature (a picture)"], ['stamp', "Firm's stamp (a picture)"],
  ] },
  { title: "The worker's own terms", marks: [
    ['terms_1', 'Own term 1'], ['terms_2', 'Own term 2'], ['terms_3', 'Own term 3'], ['terms_4', 'Own term 4'], ['terms_5', 'Own term 5'],
  ] },
  { title: 'Signing', marks: [
    ['signature', "Worker's signature (a picture)"], ['sign_date', 'Signing date'], ['today', 'Date the document is built'],
  ] },
  { title: 'Client', marks: [
    ['client_name', 'Client name'], ['client_company_no', 'Client company number'], ['client_address', 'Client address'],
    ['client_phone', 'Client contact phone'], ['client_email', 'Client email'], ['client_signer', 'Who signs for the client'],
    ['client_signer_role', "The signer's role"], ['client_signature', "Client's signature (a picture)"], ['client_sign_date', 'Client signing date'],
  ] },
  { title: 'Client billing', note: 'Filled only when the login sending it may see client billing', marks: [
    ['client_rate', 'What the client pays, per hour or day'], ['client_pay_mode', 'Client billing mode'], ['client_ot_rate', 'Client overtime rate'],
    ['client_shabbat_rate', 'Client Shabbat rate'],
  ] },
];

export function MarksWindow({ toast, onClose }: { toast: (m: string) => void; onClose: () => void }) {
  const [query, setQuery] = React.useState('');
  const [group, setGroup] = React.useState('');
  const copy = (text: string) => {
    const done = () => toast(tr('Copied {0}', { 0: text }));
    if (!navigator.clipboard) { toast(text); return; }
    navigator.clipboard.writeText(text).then(done, () => toast(text));
  };
  // a search looks in the mark and in its text, in the language shown
  const q = query.trim().toLowerCase();
  const shown = MARK_GROUPS.filter(g => !group || g.title === group)
    .map(g => ({ ...g, marks: g.marks.filter(([mark, text]) => !q || mark.includes(q) || tr(text).toLowerCase().includes(q)) }))
    .filter(g => g.marks.length);
  return (
    <Window open wide onOpenChange={o => { if (!o) onClose(); }} title={tr('Marks for a contract')} description={tr('Type a mark in the contract in Latin letters, with the two braces. Tap one to copy it.')}>
      <div className="lang-search !mb-0">
        <IconSearch aria-hidden className="size-4 text-ink-2" />
        <input id="contract-marks-search" data-testid="contract-marks-search" value={query} onChange={e => setQuery(e.target.value)} placeholder={tr('Search marks')} aria-label={tr('Search marks')} />
      </div>
      <div className="og-tabs" data-testid="contract-marks-groups">
        <button type="button" className={group ? '' : 'on'} onClick={() => setGroup('')}>{tr('All')}</button>
        {MARK_GROUPS.map(g => <button type="button" key={g.title} className={group === g.title ? 'on' : ''} onClick={() => setGroup(g.title)}>{tr(g.title)}</button>)}
      </div>
      <div data-testid="contract-marks" className="grid max-h-[55vh] gap-0 overflow-y-auto">
        {shown.map(g => (
          <React.Fragment key={g.title}>
            <FormSection>{tr(g.title)}</FormSection>
            {g.note && <p className="m-0 mb-1 text-[12.5px] text-ink-2">{tr(g.note)}</p>}
            {g.marks.map(([mark, text]) => (
              <button type="button" key={mark} data-testid="contract-mark" data-mark={mark} onClick={() => copy('{{' + mark + '}}')}
                className="flex min-w-0 items-baseline justify-between gap-3 border-0 border-b border-solid border-border bg-transparent px-1.5 py-2 text-left text-ink hover:bg-white/10">
                <span className="min-w-0 text-[13.5px]">{tr(text)}</span>
                <code dir="ltr" className="min-w-0 break-all text-right font-mono text-[12.5px] text-info">{'{{' + mark + '}}'}</code>
              </button>
            ))}
          </React.Fragment>
        ))}
        {!shown.length && <p className="m-0 py-8 text-center text-[13px] text-ink-2">{tr('No marks found')}</p>}
      </div>
    </Window>
  );
}
