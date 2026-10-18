"""Writes the tokens of docs/design/system/tokens.json into og.css.

    python tests/design/build.py

og.css part 1 (the first :root{...} block, between the markers below) is
rewritten from tokens.json: every colour, spacing, radius and shadow token as
a CSS custom property with the same name, plus --font-sans / --font-mono; then
the light theme: every token that carries a "light" value, again under its own
name, in :root[data-theme="light"]{...} (the page's <html data-theme> is set by
the theme switch — docs/redesign.md → Light theme).
The rest of og.css is left as it is. Run it after changing tokens.json;
tests/design/check.js fails until og.css matches (docs/redesign.md → stage 13).
"""
import json, os, re

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
TOKENS = os.path.join(ROOT, 'docs', 'design', 'system', 'tokens.json')
CSS = os.path.join(ROOT, 'og.css')
BEGIN, END = '/* tokens:begin — written by tests/design/build.py from tokens.json */', '/* tokens:end */'

t = json.load(open(TOKENS, encoding='utf-8'))
toks = [(x['name'], x['value']) for g in (t['color'], t['spacing'], t['radius'], t['shadow']) for x in g['tokens']]
fam = t['type']['families']
light = [(x['name'], x['light']) for g in (t['color'], t['shadow']) for x in g['tokens'] if 'light' in x]
block = BEGIN + '\n:root{\n' + ''.join(f'  --{n}:{v};\n' for n, v in toks) \
    + f"  --font-sans:{fam['sans']};\n  --font-mono:{fam['mono']};\n}}\n" \
    + ':root[data-theme="light"]{\n' + ''.join(f'  --{n}:{v};\n' for n, v in light) + '}\n' + END

css = open(CSS, encoding='utf-8').read()
if BEGIN in css:
    css = re.sub(re.escape(BEGIN) + r'.*?' + re.escape(END), lambda m: block, css, count=1, flags=re.S)
else:  # the first run: the first :root{...} block is the tokens
    css = re.sub(r':root\{[^}]*\}', lambda m: block, css, count=1)
open(CSS, 'w', encoding='utf-8').write(css)
print(f'{len(toks)} tokens ({len(light)} with a light value) written to og.css')
