import { describe, expect, it } from 'vitest';

import { ConflictError } from '@xenon/core';
import type { ApplicationStatus } from '@xenon/database';

import {
  allowedTransitions,
  applicationStatuses,
  assertTransition,
  canTransition,
  isEditableByApplicant,
  isInStaffQueue,
  isTerminal,
  statusLabels,
  statusTones,
} from './state-machine';

describe('application state machine', () => {
  it('declares a transition list and a label for every status', () => {
    for (const status of applicationStatuses) {
      expect(allowedTransitions[status]).toBeDefined();
      expect(statusLabels[status]).toBeTruthy();
      expect(statusTones[status]).toBeTruthy();
    }
  });

  it('never lists a status as a transition to itself', () => {
    for (const status of applicationStatuses) {
      expect(allowedTransitions[status]).not.toContain(status);
    }
  });

  it('only names statuses that exist', () => {
    const known = new Set<string>(applicationStatuses);
    for (const targets of Object.values(allowedTransitions)) {
      for (const target of targets) expect(known.has(target)).toBe(true);
    }
  });

  describe('the happy path', () => {
    const path: readonly [ApplicationStatus, ApplicationStatus][] = [
      ['DRAFT', 'SUBMITTED'],
      ['SUBMITTED', 'UNDER_REVIEW'],
      ['UNDER_REVIEW', 'CHANGES_REQUESTED'],
      ['CHANGES_REQUESTED', 'RESUBMITTED'],
      ['RESUBMITTED', 'UNDER_REVIEW'],
      ['UNDER_REVIEW', 'APPROVED'],
    ];

    it.each(path)('allows %s -> %s', (from, to) => {
      expect(canTransition(from, to)).toBe(true);
    });
  });

  describe('illegal moves', () => {
    /**
     * These are the ones that matter. A decided application must not be
     * re-decided by a stale Discord button, and a draft must not skip review.
     */
    const illegal: readonly [ApplicationStatus, ApplicationStatus][] = [
      ['APPROVED', 'REJECTED'],
      ['REJECTED', 'APPROVED'],
      ['APPROVED', 'UNDER_REVIEW'],
      ['DRAFT', 'APPROVED'],
      ['DRAFT', 'UNDER_REVIEW'],
      ['WITHDRAWN', 'SUBMITTED'],
      ['EXPIRED', 'APPROVED'],
      ['ARCHIVED', 'DRAFT'],
    ];

    it.each(illegal)('refuses %s -> %s', (from, to) => {
      expect(canTransition(from, to)).toBe(false);
      expect(() => {
        assertTransition(from, to);
      }).toThrow(ConflictError);
    });
  });

  it('refuses a transition to the same status with a distinct message', () => {
    expect(() => {
      assertTransition('APPROVED', 'APPROVED');
    }).toThrow(/already APPROVED/);
  });

  it('never leaks the workflow shape in the user-facing message', () => {
    try {
      assertTransition('APPROVED', 'REJECTED');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictError);
      const safe = (error as ConflictError).safeMessage;
      expect(safe).not.toContain('APPROVED');
      expect(safe).not.toContain('REJECTED');
    }
  });

  it('lets every live status reach EXPIRED so the sweep can always close it', () => {
    for (const status of applicationStatuses) {
      if (isTerminal(status)) continue;
      expect(canTransition(status, 'EXPIRED')).toBe(true);
    }
  });

  it('treats only decided states as terminal', () => {
    expect(isTerminal('APPROVED')).toBe(true);
    expect(isTerminal('REJECTED')).toBe(true);
    expect(isTerminal('UNDER_REVIEW')).toBe(false);
  });

  it('lets the applicant edit only a draft or a change request', () => {
    expect(isEditableByApplicant('DRAFT')).toBe(true);
    expect(isEditableByApplicant('CHANGES_REQUESTED')).toBe(true);
    expect(isEditableByApplicant('SUBMITTED')).toBe(false);
    expect(isEditableByApplicant('APPROVED')).toBe(false);
  });

  it('keeps the staff queue free of applicant-owned and finished work', () => {
    expect(isInStaffQueue('SUBMITTED')).toBe(true);
    expect(isInStaffQueue('RESUBMITTED')).toBe(true);
    expect(isInStaffQueue('DRAFT')).toBe(false);
    expect(isInStaffQueue('CHANGES_REQUESTED')).toBe(false);
    expect(isInStaffQueue('APPROVED')).toBe(false);
  });

  it('allows only archiving out of a terminal state', () => {
    for (const status of ['APPROVED', 'REJECTED', 'WITHDRAWN', 'EXPIRED'] as const) {
      expect(allowedTransitions[status]).toEqual(['ARCHIVED']);
    }
    expect(allowedTransitions.ARCHIVED).toEqual([]);
  });
});
