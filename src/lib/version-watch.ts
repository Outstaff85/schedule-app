// The new version check for the new pages (the old pages' startVersionWatch /
// showNewVersionBar): an app left open keeps running the code it loaded, even
// after a deploy. When the page comes back to the screen, and every 30 min
// while it is shown, the files it runs are asked for their ETag (HEAD, no
// cache); the first answer is the baseline, a changed one later means a
// deploy, and a toast offers to reload. Nothing reloads on its own.
// The page's HTML names its hashed bundle, so it changes with every build.
import { useEffect } from 'react';
import { toast } from 'sonner';
import { tr } from '@/lib/i18n';

export function useVersionWatch(files: () => string[]) {
  useEffect(() => {
    let base: Record<string, string> | null = null, shown = false;
    const tags = async () => {
      const out: Record<string, string> = {};
      for (const f of files()) {
        const r = await fetch(f, { method: 'HEAD', cache: 'no-store' });
        if (!r.ok) return null;
        out[f] = r.headers.get('etag') || r.headers.get('last-modified') || '';
      }
      return out;
    };
    const check = async () => {
      if (shown || document.visibilityState !== 'visible' || navigator.onLine === false) return;
      try {
        const t = await tags();
        if (!t) return;
        if (!base) { base = t; return; }
        for (const f in t) {
          if (!(f in base)) { base[f] = t[f]; continue; }
          if (t[f] && base[f] && t[f] !== base[f]) {
            shown = true;
            toast.info(tr('A new version is available'), { duration: Infinity, position: 'top-center', action: { label: tr('Update'), onClick: () => location.reload() } });
            return;
          }
        }
      } catch { /* offline */ }
    };
    document.addEventListener('visibilitychange', check);
    const id = window.setInterval(check, 30 * 60 * 1000);
    void check();
    return () => { document.removeEventListener('visibilitychange', check); window.clearInterval(id); };
  }, [files]);
}
