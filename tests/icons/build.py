"""Builds the self-hosted Tabler icon subset: icons/tabler-icons.css and
icons/tabler-icons.woff2, holding only the icons the pages use.

    python tests/icons/build.py <path to @tabler/icons-webfont package dir>

Get the package with: npm pack @tabler/icons-webfont@3.31.0 && tar xzf *.tgz
(the dir is ./package). Needs fonttools and brotli (pip install fonttools brotli).
Run it again after adding an icon to a page; tests/icons/check.js tells you when.

Which icons: every `ti-<name>` in the pages and the two lazy scripts, every
quoted string that is an icon name (for class names built in code, e.g.
`ti-${ok ? 'search' : 'alert-triangle'}`), and EXTRA below for names glued
from pieces that are not themselves icon names.
"""
import os, re, sys
from fontTools import subset

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
FILES = ['schedule-manager.html', 'supplier-portal.html', 'worker-punch.html', 'client-portal.html', 'scan-pipeline.js', 'firestore-backend.js']
# Built from pieces in code: 'ti ti-map-pin' + (hasGeo ? '' : '-off') (worker-punch.html),
# 'ti ti-chevron-' + (open ? 'up' : 'down') (schedule-manager.html).
EXTRA = ['map-pin-off', 'chevron-up', 'chevron-down']
VERSION = '3.31.0'

pkg = sys.argv[1] if len(sys.argv) > 1 else 'package'
dist = os.path.join(pkg, 'dist')
css = open(os.path.join(dist, 'tabler-icons.min.css'), encoding='utf-8').read()
codes = dict(re.findall(r'\.ti-([a-z0-9-]+):before\{content:"\\([0-9a-f]+)"\}', css))

src = ''.join(open(os.path.join(ROOT, f), encoding='utf-8').read() for f in FILES)
used = set(re.findall(r'\bti-([a-z0-9]+(?:-[a-z0-9]+)*)(?![a-z0-9-])', src))
used |= {s for s in re.findall(r"""['"`]([a-z0-9]+(?:-[a-z0-9]+)*)['"`]""", src) if s in codes}
used |= set(EXTRA)
used = sorted(n for n in used if n in codes)

out = os.path.join(ROOT, 'icons')
os.makedirs(out, exist_ok=True)
opts = subset.Options()
opts.flavor = 'woff2'
opts.layout_features = []
opts.name_IDs = ['*']
font = subset.load_font(os.path.join(dist, 'fonts', 'tabler-icons.woff2'), opts)
sub = subset.Subsetter(opts)
sub.populate(unicodes=[int(codes[n], 16) for n in used])
sub.subset(font)
subset.save_font(font, os.path.join(out, 'tabler-icons.woff2'), opts)

rules = ''.join('.ti-%s:before{content:"\\%s"}' % (n, codes[n]) for n in used)
with open(os.path.join(out, 'tabler-icons.css'), 'w', encoding='utf-8') as f:
    f.write('/* Tabler Icons %s (MIT, https://tabler.io) — subset of the %d icons the pages use; built by tests/icons/build.py */\n' % (VERSION, len(used)))
    f.write('@font-face{font-family:"tabler-icons";font-style:normal;font-weight:400;font-display:block;src:url("tabler-icons.woff2?v%s-%d") format("woff2")}' % (VERSION, len(used)))
    f.write('.ti{font-family:"tabler-icons"!important;speak:none;font-style:normal;font-weight:normal;font-variant:normal;text-transform:none;line-height:1;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}')
    f.write(rules + '\n')
print(len(used), 'icons;', os.path.getsize(os.path.join(out, 'tabler-icons.woff2')), 'bytes woff2')
