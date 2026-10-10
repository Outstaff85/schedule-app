// Translation check (docs/translations.md): collects every UI text the pages
// hand to the dictionary — tr('…') literals and data-i18n / data-i18n-placeholder
// / data-i18n-title in the HTML — and compares them with i18n/<lang>.json.
//   node tests/i18n/check.js          → every language; fails when a language
//                                       marked complete (COMPLETE) lacks a text
//   node tests/i18n/check.js he       → one language
// Texts handed over through a variable (tr(h), tr(h.title)) can't be seen
// here: the help texts, period labels and export headers. Dictionary keys the
// code never names as a literal are listed as "not found in the code" — check
// those by hand before deleting them.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const PAGES = ['schedule-manager.html', 'supplier-portal.html', 'worker-punch.html'];
const COMPLETE = ['he']; // languages that must have every text; the others may be partial
const unq = s => s.replace(/\\(['"`\\])/g, '$1');
const keys = new Map(); // text → first page:line
const add = (k, where) => { if(k && !keys.has(k)) keys.set(k, where); };
let source = '';
for (const page of PAGES) {
  const file = path.join(ROOT, page);
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  source += text;
  const lineOf = i => page + ':' + (text.slice(0, i).split('\n').length);
  for (const m of text.matchAll(/\btr\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) add(unq(m[2]), lineOf(m.index));
  for (const m of text.matchAll(/data-i18n(?:-placeholder|-title)?="([^"]+)"/g)) add(m[1], lineOf(m.index));
  for (const m of text.matchAll(/<[^>]*\bdata-i18n(?=[\s>])[^>]*>([^<]+)</g)) add(m[1].trim(), lineOf(m.index));
}
const langs = process.argv[2] ? [process.argv[2]] : fs.readdirSync(path.join(ROOT, 'i18n')).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
let failed = false;
for (const lang of langs) {
  const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', lang + '.json'), 'utf8'));
  const missing = [...keys].filter(([k]) => !(k in dict));
  const unknown = Object.keys(dict).filter(k => !keys.has(k) && !source.includes(k.replace(/'/g, "\\'")) && !source.includes(k));
  const empty = Object.entries(dict).filter(([, v]) => !String(v).trim()).map(([k]) => k);
  console.log(`\n${lang}: ${Object.keys(dict).length} texts, ${missing.length} missing, ${empty.length} empty, ${unknown.length} not found in the code`);
  // A partial language lists its gaps only when asked for by name.
  if (COMPLETE.includes(lang) || process.argv[2]) missing.forEach(([k, where]) => console.log(`  missing  ${JSON.stringify(k)}  (${where})`));
  empty.forEach(k => console.log(`  empty    ${JSON.stringify(k)}`));
  unknown.forEach(k => console.log(`  unused?  ${JSON.stringify(k)}`));
  if (COMPLETE.includes(lang) && (missing.length || empty.length)) failed = true;
}
console.log(`\n${keys.size} texts in the code.`);
process.exit(failed ? 1 : 0);
