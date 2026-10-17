import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// shadcn/ui's class helper: joins classes, the later Tailwind class wins.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Escapes text put into HTML by hand (a print page) — the old pages' esc(), the same rule (CLAUDE.md → XSS). */
export function esc(s: unknown): string {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
