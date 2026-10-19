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
// The light theme (docs/redesign.md → Light theme): every token with a "light"
// value has it, under its own name, in og.css's :root[data-theme="light"] block.
const light = [...t.color.tokens, ...t.shadow.tokens].filter(x => 'light' in x).map(x => [x.name, x.light]);
const lroot = (css.match(/:root\[data-theme="light"\]\{([^}]*)\}/) || [])[1] || '';
if(!light.length) errs.push('tokens.json: no token carries a light value');
for(const [n, v] of light){
  const m = lroot.match(new RegExp('--' + n.replace(/[-]/g, '\\-') + '\\s*:\\s*([^;]+);'));
  if(!m) errs.push(`og.css: light token --${n} missing`);
  else if(norm(m[1]) !== norm(v)) errs.push(`og.css: light --${n} is ${m[1].trim()}, tokens.json says ${v}`);
}
for(const [n, v] of toks){
  const m = root.match(new RegExp('--' + n.replace(/[-]/g, '\\-') + '\\s*:\\s*([^;]+);'));
  if(!m) errs.push(`og.css: token --${n} missing`);
  else if(norm(m[1]) !== norm(v)) errs.push(`og.css: --${n} is ${m[1].trim()}, tokens.json says ${v}`);
}
// Every page that draws links og.css (client-portal.html and supplier-portal.html
// only send to the manager app and draw nothing): a new page's HTML entry
// (next/index.html) links /og.css and Vite bundles it; the manager page links
// it as it is (vite-ignore), so its own styles keep their place before it.
for(const f of ['schedule-manager.html', 'worker-punch.html']){
  const s = read(f);
  if(!/<link rel="stylesheet" href="\/?og\.css"( vite-ignore)?>/.test(s)) errs.push(`${f}: does not link og.css`);
  for(const [n] of toks) if(new RegExp('(^|[^\\w-])--' + n + '\\s*:').test(s)) errs.push(`${f}: defines --${n} (it lives in og.css)`);
}
// The theme (docs/redesign.md → Light theme): every page puts the chosen look on
// <html data-theme> in a <head> script before the first draw (no dark flash).
for(const f of ['schedule-manager.html', 'worker-punch.html', 'next/index.html']){
  const head = (read(f).split('</head>')[0]) || '';
  if(!/localStorage\.getItem\('uiTheme'\)/.test(head) || !/data-theme/.test(head)) errs.push(`${f}: no theme script in <head> (localStorage.uiTheme → <html data-theme>)`);
}
// The new stack (docs/build.md) points at the tokens and never defines one.
const walk = d => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];
for(const f of [...walk(path.join(ROOT, 'src')), path.join(ROOT, 'next', 'index.html')].filter(f => /\.(css|tsx?|html)$/.test(f) && fs.existsSync(f))){
  const s = fs.readFileSync(f, 'utf8'), rel = path.relative(ROOT, f);
  for(const [n] of toks) if(new RegExp('(^|[^\\w-])--' + n + '\\s*:').test(s)) errs.push(`${rel}: defines --${n} (it lives in og.css)`);
}
if(!/href="\/og\.css"/.test(fs.existsSync(path.join(ROOT, 'next', 'index.html')) ? read('next/index.html') : 'href="/og.css"')) errs.push('next/index.html: does not link /og.css');
console.log(`${toks.length} tokens (${light.length} light), ${errs.length} problems`);
errs.forEach(e => console.log('  ' + e));
process.exit(errs.length ? 1 : 0);
