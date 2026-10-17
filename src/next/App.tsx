import { useState } from 'react';
import { cn } from '@/lib/utils';

const CHECKS = [
  { label: 'React', value: 'running' },
  { label: 'Tailwind', value: 'Odinson Glass tokens' },
  { label: 'Build', value: __BUILD_TIME__ },
];

export function App() {
  const [taps, setTaps] = useState(0);
  return (
    <main className="mx-auto grid max-w-xl gap-4 px-4 py-8">
      <h1 className="text-2xl font-bold">Interactive Manager · next</h1>
      <p className="text-muted-foreground">The new stack works. The app itself is still at <a className="text-info underline" href="/">/</a>.</p>
      <section className="grid gap-2" data-testid="checks">
        {CHECKS.map(c => (
          <div key={c.label} className="flex items-center justify-between rounded-lg bg-plate py-3 pl-4 pr-3 shadow-[inset_4px_0_0_var(--green)]">
            <b>{c.label}</b>
            <span className="font-mono text-sm text-fig">{c.value}</span>
          </div>
        ))}
      </section>
      <button
        type="button"
        data-testid="tap"
        onClick={() => setTaps(t => t + 1)}
        className={cn('gbtn justify-self-start', taps > 0 && 'primary')}
      >
        Taps: {taps}
      </button>
    </main>
  );
}
