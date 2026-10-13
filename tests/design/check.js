// The design system in the codebase (docs/redesign.md → stage 13): og.css
// carries every token of docs/design/system/tokens.json as a CSS custom
// property with the same value, every page links og.css, and no page
// defines a token of its own (the one copy lives in og.css).
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const t = JSON.parse(read('docs/design/system/tokens.json'));
const toks = [...t.color.tokens, ...t.spacing.tokens, ...t.radius.tokens, ...t.shadow.tokens].map(x => [x.name, x.value]);
const css = read('og.css'), root = (css.match(/:root\{([^}]*)\}/) || [])[1] || '';
const norm = v => String(v).replace(/\s+/g, '').toLowerCase();
const errs = [];
for(const [n, v] of toks){
  const m = root.match(new RegExp('--' + n.replace(/[-]/g, '\\-') + '\\s*:\\s*([^;]+);'));
  if(!m) errs.push(`og.css: token --${n} missing`);
  else if(norm(m[1]) !== norm(v)) errs.push(`og.css: --${n} is ${m[1].trim()}, tokens.json says ${v}`);
}
for(const f of ['schedule-manager.html', 'supplier-portal.html', 'client-portal.html', 'worker-punch.html']){
  const s = read(f);
  if(!/<link rel="stylesheet" href="og\.css">/.test(s)) errs.push(`${f}: does not link og.css`);
  for(const [n] of toks) if(new RegExp('(^|[^\\w-])--' + n + '\\s*:').test(s)) errs.push(`${f}: defines --${n} (it lives in og.css)`);
}
console.log(`${toks.length} tokens, ${errs.length} problems`);
errs.forEach(e => console.log('  ' + e));
process.exit(errs.length ? 1 : 0);
