// A plain tr() in place of src/lib/i18n.tsx (React) when compare.test.mjs bundles src/supplier/money.ts.
export const tr = (s, p) => String(s).replace(/\{(\w+)\}/g, (m, k) => (p && k in p ? String(p[k]) : m));
export const uiLocale = () => 'en';
