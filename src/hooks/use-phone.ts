import { useEffect, useState } from 'react';

// A phone is a screen up to 700px wide (docs/design/system/Screens.md): the
// bottom bar instead of the top tabs, windows from the bottom.
const QUERY = '(max-width: 700px)';

export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia(QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}
