// The files of the old pages that Hosting serves (docs/build.md): every file
// tracked by git, minus what never goes to Hosting. Until 2026-10 Hosting
// served the repo root with the ignore list of firebase.json; `npm run build`
// now copies these files into dist/ next to what Vite builds, so the live
// site keeps every old page exactly as it was. Used by scripts/copy-static.mjs
// and checked by tests/build/check.js.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Top-level entries that are never served: the old ignore list of firebase.json,
// the new stack's own sources and config, and every dot entry.
const EXCLUDED_TOP = new Set([
  'firebase.json', 'firestore.rules', 'firestore.indexes.json', 'storage.rules',
  'docs', 'functions', 'functions-auth', 'tests', 'Tokens', 'node_modules',
  'dist', 'src', 'next', 'scripts',
  'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'components.json',
]);
// Any path whose file name matches one of these is never served.
const EXCLUDED_NAME = [/\.md$/i, /^Screenshot_.*\.(jpg|png)$/, /-local\.html$/, /\.log$/, /\.pyc$/];

export function isStatic(rel) {
  const parts = rel.split('/');
  if (EXCLUDED_TOP.has(parts[0])) return false;
  if (parts.some(p => p.startsWith('.') || p === '__pycache__' || p === 'node_modules')) return false;
  return !EXCLUDED_NAME.some(re => re.test(parts[parts.length - 1]));
}

function walk(root, dir = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) { if (isStatic(rel + '/x')) out.push(...walk(root, rel)); }
    else out.push(rel);
  }
  return out;
}

// The tracked files (git ls-files); without git, every file on disk.
export function staticFiles(root) {
  let files;
  try {
    files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch {
    files = walk(root);
  }
  return files.filter(isStatic).filter(f => fs.existsSync(path.join(root, f))).sort();
}
