import { describe, expect, it } from 'vitest';

import { DEV_DISCORD_FIXTURES, isDevFixtureDiscordId } from './dev-fixtures';

describe('development Discord identities', () => {
  it('uses opaque non-snowflake keys for local sign-in fixtures', () => {
    for (const fixture of Object.values(DEV_DISCORD_FIXTURES)) {
      expect(fixture.discordId).not.toMatch(/^\d{17,20}$/);
      expect(isDevFixtureDiscordId(fixture.discordId)).toBe(true);
    }
  });

  it('does not accept numeric Discord snowflakes or legacy seed IDs', () => {
    expect(isDevFixtureDiscordId('123456789012345678')).toBe(false);
    expect(isDevFixtureDiscordId('900000000000000001')).toBe(false);
    expect(isDevFixtureDiscordId('xenon-dev-fixture-unknown')).toBe(false);
  });
});
