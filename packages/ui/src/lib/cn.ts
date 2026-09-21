import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Conditional class names with conflict resolution.
 *
 * `clsx` handles the conditionals; `twMerge` makes the last conflicting
 * utility win, which is what lets a caller pass `className="px-8"` to a
 * component whose base style says `px-4` and actually get 8.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
