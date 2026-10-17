import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// shadcn/ui's class helper: joins classes, the later Tailwind class wins.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
