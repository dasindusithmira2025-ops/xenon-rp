import { createHash } from 'node:crypto';

/**
 * Stable content hash.
 *
 * Keys are sorted and bigints become strings, so the same configuration hashes
 * identically on every run and in every process - which is what lets a second
 * apply recognise that nothing changed.
 */
export function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 32);
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === 'bigint') return entry.toString();
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, record[key]]),
      );
    }
    return entry;
  });
}
