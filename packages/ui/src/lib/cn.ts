import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * Custom font-size names, registered with tailwind-merge.
 *
 * Without this, `cn('text-headline', 'text-ink')` silently drops the size.
 * tailwind-merge cannot tell a custom `text-*` size from a custom `text-*`
 * colour, assumes colour, and keeps only the last one - so every heading that
 * set both a scale step and a colour in one call rendered at the body size.
 *
 * Any new `--text-*` token added to the theme belongs in this list too.
 */
const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['hero', 'display', 'headline', 'title', 'lead', 'eyebrow'] }],
    },
  },
});

/**
 * Conditional class names with conflict resolution.
 *
 * `clsx` handles the conditionals; tailwind-merge makes the last conflicting
 * utility win, which is what lets a caller pass `className="px-8"` to a
 * component whose base style says `px-4` and actually get 8.
 */
export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
