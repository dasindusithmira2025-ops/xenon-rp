import { describe, expect, it } from 'vitest';

import {
  applicationCommentInput,
  assignReviewerInput,
  rejectApplicationInput,
  reviewDecisionInput,
  scheduleInterviewInput,
} from './forms';
import { cuid, publicId, reference } from './primitives';

/**
 * Input schemas for the staff review actions.
 *
 * These exist because of a defect worth remembering: `submissionId` was
 * validated as a cuid, while every control-centre screen addresses a
 * submission by the identifier printed on the page - XN-WL-1842. The result
 * was that approve, reject and request-changes all failed validation before
 * reaching the service, and the applicant's own screens were unaffected, so
 * nothing looked broken until somebody tried to decide an application.
 *
 * The lesson the tests encode: a schema is a contract with its call sites, and
 * "is this a well-formed id" has two right answers here.
 */

const CUID = 'ygiwv3i4eu9wcgxgut46vlnw';
const PUBLIC_ID = 'XN-WL-1842';

describe('reference', () => {
  it('accepts a database id', () => {
    expect(reference.safeParse(CUID).success).toBe(true);
  });

  it('accepts the public identifier staff actually see', () => {
    expect(reference.safeParse(PUBLIC_ID).success).toBe(true);
  });

  it('normalises a public identifier that was typed loosely', () => {
    expect(reference.parse(' xn-wl-1842 ')).toBe(PUBLIC_ID);
  });

  it('rejects something that is neither', () => {
    for (const value of ['', 'not an id', '../../etc/passwd', '1842', '<script>']) {
      expect(reference.safeParse(value).success, value).toBe(false);
    }
  });

  it('still rejects a bare number, which could mean anything', () => {
    // The whole point of the public-id scheme: 1842 is not enough context to
    // identify a record, and guessing would resolve it to the wrong one.
    expect(publicId.safeParse('1842').success).toBe(false);
    expect(cuid.safeParse('1842').success).toBe(false);
  });
});

describe('review decisions', () => {
  it('accepts a decision addressed by public id', () => {
    const parsed = reviewDecisionInput.safeParse({
      submissionId: PUBLIC_ID,
      publicNote: 'Welcome in.',
      staffNote: '',
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts a decision with no notes at all', () => {
    const parsed = reviewDecisionInput.safeParse({
      submissionId: CUID,
      publicNote: '',
      staffNote: '',
    });

    expect(parsed.success).toBe(true);
  });

  it('requires a real reason on a rejection', () => {
    const parsed = rejectApplicationInput.safeParse({
      submissionId: PUBLIC_ID,
      publicNote: 'no',
      staffNote: '',
    });

    // A rejection the applicant cannot understand becomes a support ticket.
    expect(parsed.success).toBe(false);
  });

  it('accepts assignment, scheduling and comments by public id too', () => {
    expect(
      assignReviewerInput.safeParse({ submissionId: PUBLIC_ID, assigneeId: null }).success,
    ).toBe(true);

    expect(
      scheduleInterviewInput.safeParse({
        submissionId: PUBLIC_ID,
        scheduledFor: '2026-10-01T18:00:00.000Z',
        location: 'Discord',
      }).success,
    ).toBe(true);

    expect(
      applicationCommentInput.safeParse({
        submissionId: PUBLIC_ID,
        body: 'Looks solid to me.',
        visibility: 'INTERNAL',
      }).success,
    ).toBe(true);
  });
});
