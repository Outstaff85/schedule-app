import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// shadcn/ui's class helper: joins classes, the later Tailwind class wins.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * One CSV cell, quoted. Text that a spreadsheet would run as a formula (it
 * starts with = + - @, a tab or a CR) gets a leading apostrophe; a plain
 * number (also a negative one) stays a number.
 */
export function csvCell(v: unknown): string {
  let s = String(v == null ? '' : v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !/^[-+]?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
/** A CSV file's text: the rows of csvCell cells, after a UTF-8 BOM so Excel reads Hebrew (and ₪) right. */
export function csvText(rows: unknown[][]): string {
  return '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\n');
}

/** Escapes text put into HTML by hand (a print page) — the old pages' esc(), the same rule (CLAUDE.md → XSS). */
export function esc(s: unknown): string {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
