'use client';

/**
 * The Xenon motion system.
 *
 * One import for every animated primitive in the product, so a new screen
 * reaches for the same vocabulary the last one used instead of inventing a
 * duration. The rules the set is built on are written up in
 * `docs/MOTION_SYSTEM.md`; the short version:
 *
 *  - Transform and opacity only. Nothing animates width, height, blur or a
 *    box shadow in a loop.
 *  - Entrances play once. Exits are faster than entrances.
 *  - Every primitive has a real reduced-motion branch, not a shorter duration.
 *  - A progress indicator states something true, or it is indeterminate.
 *
 * Split across four files purely for navigability - `tokens` for the numbers,
 * `reveal` for entrances and media, `progress` for the loading and progress
 * language, `feedback` for state changes.
 */

export * from './tokens';
export * from './reveal';
export * from './progress';
export * from './feedback';

export { motion, useReducedMotion } from 'motion/react';
