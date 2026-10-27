// /client-sign — a client's contract to sign (docs/contracts.md → Client contracts): opened by the link the firm
// sends (…/client-sign?t=<token>), without any login. The title bar carries the firm's name and the Language
// button; the page reads its one request (`mine`) and draws the flow (ClientSignFlow): the details, the contract
// with the firm's signature and stamp, one signature, the signed PDF to download. A link that is no longer valid
// (wrong, replaced, withdrawn, past its time) shows an empty state and nothing of the firm.
import * as React from 'react';
import { IconLinkOff, IconLoader2 } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { useVersionWatch } from '@/lib/version-watch';
import { Shell } from '@/components/shared/shell';
import { LanguageButton } from '@/components/shared/language';
import { LogoMark } from '@/components/shared/app-brand';
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { ClientSignFlow, type ClientSignCall } from './ClientSignFlow';
import { clientSignFn, linkToken, type Mine } from './api';

const watched = () => [location.pathname, '/og.css'];

export function App() {
  useVersionWatch(watched);
  const [mine, setMine] = React.useState<Mine | null>(null);
  const [bad, setBad] = React.useState(!linkToken());
  React.useEffect(() => {
    if (!linkToken()) return;
    clientSignFn<{ request: Mine }>({ action: 'mine' }).then(r => {
      setMine(r.request);
      // signed but its PDF not built yet (the page was closed in between): built now, once
      if (r.request.status === 'signing') void clientSignFn({ action: 'build' }).then(() => setMine(m => (m ? { ...m, status: 'signed' } : m)), () => {});
    }, () => setBad(true));
  }, []);
  const call: ClientSignCall = (action, body) => clientSignFn({ action, ...body }) as any;
  const brand = (
    <div className="og-brand" data-testid="client-sign-brand">
      <LogoMark />
      <div className="og-name"><b>{mine?.firm || tr('Contract to sign')}</b>{mine?.firm && <small>{tr('Contract to sign')}</small>}</div>
    </div>
  );
  return (
    <Shell brand={brand} tools={<LanguageButton />}>
      <div className="mx-auto grid w-full max-w-3xl gap-3 px-4 py-4" data-testid="client-sign" data-state={bad ? 'invalid' : mine ? mine.status : 'loading'}>
        {bad ? <Empty data-testid="client-sign-invalid"><EmptyMedia><IconLinkOff /></EmptyMedia><EmptyTitle>{tr('This link is no longer valid')}</EmptyTitle>
          <EmptyDescription>{tr('Ask the firm that sent it for a new link.')}</EmptyDescription></Empty>
          : !mine ? <p className="inline-flex items-center gap-2 text-sm text-ink-2"><IconLoader2 className="size-4 animate-spin" />{tr('Loading…')}</p>
          : <>
            <h1 className="text-lg font-bold text-ink" data-testid="client-sign-title">{mine.templateName || tr('Contract')}</h1>
            <ClientSignFlow call={call} details={mine.details} title={mine.templateName || tr('Contract')} signed={mine.status !== 'sent'}
              onSigned={() => setMine(m => (m ? { ...m, status: 'signed' } : m))} />
          </>}
      </div>
    </Shell>
  );
}
