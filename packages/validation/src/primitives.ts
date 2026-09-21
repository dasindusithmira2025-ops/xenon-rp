import { z } from 'zod';

import { isPublicId, normalisePublicId } from '@xenon/core';

import { stripHtml } from './sanitize';

/** A trimmed, tag-free string. The default shape for any player-typed field. */
export const plainText = (min: number, max: number) =>
  z
    .string()
    .transform((value) => stripHtml(value).trim())
    .pipe(z.string().min(min).max(max));

/** Optional plain text that normalises an empty string to undefined. */
export const optionalPlainText = (max: number) =>
  z
    .string()
    .transform((value) => stripHtml(value).trim())
    .pipe(z.string().max(max))
    .transform((value) => (value.length === 0 ? undefined : value))
    .optional();

/** URL-safe slug: lowercase, hyphen separated, no leading or trailing hyphen. */
export const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be lowercase words separated by hyphens')
  .min(2)
  .max(64);

/** A cuid2 database id. Accepted only where an id genuinely crosses the wire. */
export const cuid = z.string().regex(/^[a-z0-9]{24,32}$/i, 'must be a valid id');

/** A public identifier such as XN-WL-1842, already normalised. */
export const publicId = z
  .string()
  .transform((value) => normalisePublicId(value) ?? value)
  .refine(isPublicId, 'must be a Xenon identifier, e.g. XN-WL-1842');

export const hexColour = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'must be a hex colour, e.g. #2AFD23');

export const discordSnowflake = z
  .string()
  .regex(/^\d{17,20}$/, 'must be a Discord ID (17-20 digits)');

/** Cursor-free page/size pagination, bounded so a client cannot ask for everything. */
export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type Pagination = z.infer<typeof pagination>;

/** Convert validated pagination into Prisma's skip/take. */
export function toSkipTake({ page, pageSize }: Pagination): { skip: number; take: number } {
  return { skip: (page - 1) * pageSize, take: pageSize };
}

/**
 * Free-text search input.
 *
 * Bounded and trimmed because the value reaches Postgres `ILIKE`; a very long
 * pattern is a cheap way to make the database do expensive work.
 */
export const searchQuery = z.string().trim().max(120).optional();

/** An ISO date string from a `<input type="date">`, as a UTC Date. */
export const isoDate = z.iso
  .date()
  .transform((value) => new Date(`${value}T00:00:00.000Z`))
  .or(z.date());
