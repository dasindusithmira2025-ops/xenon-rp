/**
 * Restart schedules.
 *
 * Game servers restart on a fixed daily pattern, and three different places
 * need to know when the next one is: the status page, the homepage strip and
 * the bot's `/status`. The parser lives in core, with no dependencies, so the
 * poller that writes the snapshot and the reader that renders a fallback cannot
 * disagree about what `0 4,10,16,22 * * *` means.
 *
 * Supports the minute and hour fields only - lists, steps and `*`. That is the
 * whole of what a restart schedule uses, and a full cron implementation would
 * be a dependency and a parser surface for a feature nobody has asked to be
 * more expressive.
 *
 * ponytail: minute/hour fields only; reach for a cron library if day-of-week
 * restart schedules are ever configured.
 */

function expandField(field: string, min: number, max: number): number[] {
  if (field === '*') return Array.from({ length: max - min + 1 }, (_, index) => min + index);

  const values = new Set<number>();
  for (const part of field.split(',')) {
    const step = /^\*\/(\d+)$/.exec(part);
    if (step?.[1] !== undefined) {
      const interval = Number.parseInt(step[1], 10);
      if (interval > 0) {
        for (let value = min; value <= max; value += interval) values.add(value);
      }
      continue;
    }

    const value = Number.parseInt(part, 10);
    if (Number.isInteger(value) && value >= min && value <= max) values.add(value);
  }

  return [...values].sort((a, b) => a - b);
}

/**
 * The next occurrence of a restart schedule after `from`.
 *
 * Returns null for an absent or unreadable expression, which callers render as
 * "not scheduled" rather than guessing.
 */
export function nextRestartAt(cron: string | null, from: Date = new Date()): Date | null {
  if (cron === null || cron.trim().length === 0) return null;

  const parts = cron.trim().split(/\s+/);
  const [minuteField, hourField] = parts;
  if (parts.length < 5 || minuteField === undefined || hourField === undefined) return null;

  const minutes = expandField(minuteField, 0, 59);
  const hours = expandField(hourField, 0, 23);
  if (minutes.length === 0 || hours.length === 0) return null;

  // Today then tomorrow is enough: any schedule with at least one slot a day
  // has its next occurrence inside that window.
  for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
    for (const hour of hours) {
      for (const minute of minutes) {
        const candidate = new Date(from);
        candidate.setUTCDate(candidate.getUTCDate() + dayOffset);
        candidate.setUTCHours(hour, minute, 0, 0);
        if (candidate > from) return candidate;
      }
    }
  }

  return null;
}
