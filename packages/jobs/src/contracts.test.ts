import { describe, expect, it } from 'vitest';

import { jobIdFor } from './contracts';

describe('jobIdFor', () => {
  it('collapses a duplicate review card creation for one submitted application', () => {
    expect(jobIdFor('discord.review.post', { submissionId: 'submission-1' })).toBe(
      'discord.review.post~submission-1',
    );
  });

  it('allows every later canonical application state to refresh the review card', () => {
    expect(jobIdFor('discord.review.update', { submissionId: 'submission-1' })).toBeUndefined();
  });

  it('allows an explicit guild membership check to bypass an older completed lookup', () => {
    expect(
      jobIdFor('discord.membership.sync', { userId: 'xenon-user', reason: 'portal.manual_resync' }),
    ).toBeUndefined();
  });

  it('keeps direct-message delivery idempotent per canonical notification', () => {
    expect(jobIdFor('discord.dm', { notificationId: 'notification-1' })).toBe(
      'discord.dm~notification-1',
    );
  });
});
