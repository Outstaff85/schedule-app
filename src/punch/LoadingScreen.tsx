// The worker page's first load (docs/punch.md): the link is checked with the server while nothing is kept on the
// phone yet. The shape of the punch screen waits under a moving glow, the logo inside the ring where the punch
// button will stand, so the page does not jump when it comes; the line under it moves on with the time (owner,
// 2026-10-31: the old satellite and "Verifying..." looked stuck).
import * as React from 'react';
import { tr } from '@/lib/i18n';
import { MARK_SVG } from './mark';

const STEPS: [number, () => string][] = [
  [0, () => tr('Checking your link…')],
  [2500, () => tr('Getting your day ready…')],
  [8000, () => tr('This is taking longer than usual — check your connection')],
];

export function LoadingScreen() {
  const [step, setStep] = React.useState(0);
  React.useEffect(() => {
    const ids = STEPS.slice(1).map(([ms], i) => window.setTimeout(() => setStep(i + 1), ms));
    return () => ids.forEach(id => window.clearTimeout(id));
  }, []);
  return (
    <div id="loadingScreen" data-testid="punch-loading" role="status" aria-live="polite">
      <div className="pl-top"><i className="pl-bone" /><i className="pl-bone pl-short" /></div>
      <i className="pl-bone pl-wide" />
      <div className="pl-ring">
        <span className="pl-mark" dangerouslySetInnerHTML={{ __html: MARK_SVG }} />
      </div>
      <p className="pl-step" key={step} data-step={step}>{STEPS[step][1]()}</p>
    </div>
  );
}
