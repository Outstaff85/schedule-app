// The Language button and its sheet (docs/design/system/components/
// LanguageButton; og.css .lang-btn, .lang-search, .lang-li): a bare globe at the
// top right; a tap opens the "Language" window — a search field and every
// language (its own name and its English name), the current one ticked; a tap
// switches at once and closes the window. The list comes from I18N_LANGS.
import * as React from 'react';
import { IconCheck, IconSearch, IconWorld } from '@tabler/icons-react';
import { I18N_LANG_EN, I18N_LANGS, tr, useI18n } from '@/lib/i18n';
import { Window } from '@/components/shared/window';

export function LanguageButton() {
  const { lang, setLanguage } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState('');
  const list = Object.keys(I18N_LANGS).filter(code => {
    const s = q.trim().toLowerCase();
    return !s || code.includes(s) || I18N_LANGS[code].toLowerCase().includes(s) || I18N_LANG_EN[code].toLowerCase().includes(s);
  });
  return (
    <>
      <button type="button" className="gbtn lang-btn" aria-label={tr('Language')} data-testid="lang-btn" onClick={() => { setQ(''); setOpen(true); }}>
        <IconWorld className="size-[23px]" stroke={1.8} />
      </button>
      <Window open={open} onOpenChange={setOpen} title={tr('Language')}>
        <div className="lang-search !mb-0">
          <IconSearch className="size-4 text-ink-2" />
          <input id="lang-search" value={q} onChange={e => setQ(e.target.value)} placeholder={tr('Search')} aria-label={tr('Search')} />
        </div>
        <div className="lang-list" data-testid="lang-list">
          {list.map(code => (
            <button
              key={code}
              type="button"
              className={code === lang ? 'lang-li on' : 'lang-li'}
              onClick={() => { setOpen(false); void setLanguage(code); }}
            >
              <b>{I18N_LANGS[code]}</b>
              <small>{I18N_LANG_EN[code]}</small>
              {code === lang && <span className="lang-tick"><IconCheck className="size-3.5" stroke={3} /></span>}
            </button>
          ))}
          {!list.length && <div className="lang-none">{tr('No language found')}</div>}
        </div>
      </Window>
    </>
  );
}
