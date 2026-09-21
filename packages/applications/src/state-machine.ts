import { ConflictError } from '@xenon/core';
import type { ApplicationStatus } from '@xenon/database';

/**
 * The application lifecycle.
 *
 * Declared as data rather than as scattered `if` statements so that the legal
 * moves are readable in one place, testable without a database, and impossible
 * to widen by accident. Every mutation in the review service passes through
 * `assertTransition`, which is what makes "approve an application that was
 * already rejected" a refused request instead of a second decision.
 */

export const applicationStatuses = [
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'CHANGES_REQUESTED',
  'RESUBMITTED',
  'INTERVIEW_REQUIRED',
  'INTERVIEW_SCHEDULED',
  'INTERVIEW_COMPLETED',
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
  'EXPIRED',
  'ARCHIVED',
] as const satisfies readonly ApplicationStatus[];

/**
 * Legal transitions.
 *
 * Notes on the shape of this table:
 *  - Terminal decisions (APPROVED, REJECTED) lead only to ARCHIVED. A decision
 *    is reversed by a new application or an appeal, never by editing history.
 *  - RESUBMITTED is its own state rather than a return to SUBMITTED, so the
 *    queue can show reviewers what has already been through a round of changes.
 *  - Every non-terminal state can reach EXPIRED, because the sweep must be able
 *    to close anything that has been abandoned.
 */
export const allowedTransitions: Readonly<Record<ApplicationStatus, readonly ApplicationStatus[]>> =
  {
    DRAFT: ['SUBMITTED', 'WITHDRAWN', 'EXPIRED'],
    SUBMITTED: [
      'UNDER_REVIEW',
      'CHANGES_REQUESTED',
      'INTERVIEW_REQUIRED',
      'APPROVED',
      'REJECTED',
      'WITHDRAWN',
      'EXPIRED',
    ],
    UNDER_REVIEW: [
      'CHANGES_REQUESTED',
      'INTERVIEW_REQUIRED',
      'APPROVED',
      'REJECTED',
      'SUBMITTED',
      'WITHDRAWN',
      'EXPIRED',
    ],
    CHANGES_REQUESTED: ['RESUBMITTED', 'WITHDRAWN', 'EXPIRED', 'REJECTED'],
    RESUBMITTED: [
      'UNDER_REVIEW',
      'CHANGES_REQUESTED',
      'INTERVIEW_REQUIRED',
      'APPROVED',
      'REJECTED',
      'WITHDRAWN',
      'EXPIRED',
    ],
    INTERVIEW_REQUIRED: ['INTERVIEW_SCHEDULED', 'UNDER_REVIEW', 'REJECTED', 'WITHDRAWN', 'EXPIRED'],
    INTERVIEW_SCHEDULED: [
      'INTERVIEW_COMPLETED',
      'INTERVIEW_REQUIRED',
      'REJECTED',
      'WITHDRAWN',
      'EXPIRED',
    ],
    INTERVIEW_COMPLETED: [
      'APPROVED',
      'REJECTED',
      'CHANGES_REQUESTED',
      'UNDER_REVIEW',
      'WITHDRAWN',
      'EXPIRED',
    ],
    APPROVED: ['ARCHIVED'],
    REJECTED: ['ARCHIVED'],
    WITHDRAWN: ['ARCHIVED'],
    EXPIRED: ['ARCHIVED'],
    ARCHIVED: [],
  };

/** States where the application is waiting on staff. Drives the review queue. */
export const staffQueueStatuses: readonly ApplicationStatus[] = [
  'SUBMITTED',
  'RESUBMITTED',
  'UNDER_REVIEW',
  'INTERVIEW_REQUIRED',
  'INTERVIEW_SCHEDULED',
  'INTERVIEW_COMPLETED',
];

/** States where the application is waiting on the applicant. */
export const applicantActionStatuses: readonly ApplicationStatus[] = ['DRAFT', 'CHANGES_REQUESTED'];

/** States that are finished and will not change again. */
export const terminalStatuses: readonly ApplicationStatus[] = [
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
  'EXPIRED',
  'ARCHIVED',
];

export function isTerminal(status: ApplicationStatus): boolean {
  return terminalStatuses.includes(status);
}

/** True when the applicant may still edit answers. */
export function isEditableByApplicant(status: ApplicationStatus): boolean {
  return status === 'DRAFT' || status === 'CHANGES_REQUESTED';
}

/** True when the application is somewhere in the staff pipeline. */
export function isInStaffQueue(status: ApplicationStatus): boolean {
  return staffQueueStatuses.includes(status);
}

export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return allowedTransitions[from].includes(to);
}

/**
 * Throw unless the move is legal.
 *
 * The user-facing message never names the target state: to an applicant,
 * "cannot move from APPROVED to REJECTED" is noise, and to an attacker probing
 * the API it is a map of the workflow.
 */
export function assertTransition(from: ApplicationStatus, to: ApplicationStatus): void {
  if (from === to) {
    throw new ConflictError(
      `Application is already ${from}`,
      'That has already happened. Refresh to see the current state.',
    );
  }
  if (!canTransition(from, to)) {
    throw new ConflictError(
      `Illegal application transition ${from} -> ${to}`,
      'This application has moved on since the page loaded. Refresh and try again.',
    );
  }
}

/** Human label for a status, used by both the portal and the control centre. */
export const statusLabels: Readonly<Record<ApplicationStatus, string>> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under review',
  CHANGES_REQUESTED: 'Changes requested',
  RESUBMITTED: 'Resubmitted',
  INTERVIEW_REQUIRED: 'Interview required',
  INTERVIEW_SCHEDULED: 'Interview scheduled',
  INTERVIEW_COMPLETED: 'Interview completed',
  APPROVED: 'Approved',
  REJECTED: 'Not successful',
  WITHDRAWN: 'Withdrawn',
  EXPIRED: 'Expired',
  ARCHIVED: 'Archived',
};

export type StatusTone = 'neutral' | 'progress' | 'attention' | 'success' | 'danger';

/** Visual tone for a status badge. Kept beside the labels so they cannot drift. */
export const statusTones: Readonly<Record<ApplicationStatus, StatusTone>> = {
  DRAFT: 'neutral',
  SUBMITTED: 'progress',
  UNDER_REVIEW: 'progress',
  CHANGES_REQUESTED: 'attention',
  RESUBMITTED: 'progress',
  INTERVIEW_REQUIRED: 'attention',
  INTERVIEW_SCHEDULED: 'progress',
  INTERVIEW_COMPLETED: 'progress',
  APPROVED: 'success',
  REJECTED: 'danger',
  WITHDRAWN: 'neutral',
  EXPIRED: 'neutral',
  ARCHIVED: 'neutral',
};
