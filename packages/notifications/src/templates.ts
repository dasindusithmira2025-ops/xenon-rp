import type { NotificationType } from '@xenon/database';

/**
 * Notification copy.
 *
 * Centralised so the wording is identical whether the trigger came from the
 * website, a Discord button or a scheduled sweep, and so a change to how the
 * platform speaks is one edit rather than a search across three apps.
 */

export interface NotificationCopy {
  readonly type: NotificationType;
  readonly title: string;
  readonly body: string;
  readonly href: string | null;
}

function applicationHref(publicId: string): string {
  return `/portal/applications/${publicId}`;
}

export const notificationCopy = {
  applicationSubmitted: (publicId: string, templateName: string): NotificationCopy => ({
    type: 'APPLICATION_SUBMITTED',
    title: 'Application received',
    body: `Your ${templateName} application ${publicId} is in the queue. We will let you know as soon as a reviewer picks it up.`,
    href: applicationHref(publicId),
  }),

  reviewStarted: (publicId: string): NotificationCopy => ({
    type: 'APPLICATION_REVIEW_STARTED',
    title: 'Your application is being reviewed',
    body: `A reviewer has started looking at ${publicId}.`,
    href: applicationHref(publicId),
  }),

  changesRequested: (publicId: string, note: string): NotificationCopy => ({
    type: 'APPLICATION_CHANGES_REQUESTED',
    title: 'Changes requested',
    body: `${publicId} needs a few edits before it can be decided.\n\n${note}`,
    href: applicationHref(publicId),
  }),

  interviewRequested: (publicId: string): NotificationCopy => ({
    type: 'APPLICATION_INTERVIEW_REQUESTED',
    title: 'Interview required',
    body: `${publicId} has moved to the interview stage. Staff will be in touch to arrange a time.`,
    href: applicationHref(publicId),
  }),

  interviewScheduled: (
    publicId: string,
    when: Date,
    location: string | null,
  ): NotificationCopy => ({
    type: 'APPLICATION_INTERVIEW_SCHEDULED',
    title: 'Interview scheduled',
    body:
      `Your interview for ${publicId} is set for ${when.toUTCString()}.` +
      (location === null ? '' : `\nWhere: ${location}`),
    href: applicationHref(publicId),
  }),

  approved: (publicId: string, templateName: string, note: string | null): NotificationCopy => ({
    type: 'APPLICATION_APPROVED',
    title: 'Application approved',
    body:
      `Your ${templateName} application ${publicId} has been approved. Welcome to the city.` +
      (note === null ? '' : `\n\n${note}`),
    href: applicationHref(publicId),
  }),

  rejected: (publicId: string, note: string): NotificationCopy => ({
    type: 'APPLICATION_REJECTED',
    title: 'Application decision',
    body: `${publicId} was not successful this time.\n\n${note}`,
    href: applicationHref(publicId),
  }),

  expired: (publicId: string): NotificationCopy => ({
    type: 'APPLICATION_EXPIRED',
    title: 'Application expired',
    body: `${publicId} sat without activity for too long and has been closed. You are welcome to start a new one.`,
    href: applicationHref(publicId),
  }),

  whitelistGranted: (): NotificationCopy => ({
    type: 'WHITELIST_GRANTED',
    title: 'Whitelist approved',
    body: 'Your whitelist is active. Connect to the city and your story begins.',
    href: '/portal',
  }),

  whitelistRevoked: (reason: string | null): NotificationCopy => ({
    type: 'WHITELIST_REVOKED',
    title: 'Whitelist revoked',
    body:
      'Your whitelist access has been removed.' +
      (reason === null ? '' : `\n\nReason: ${reason}`) +
      '\n\nYou can appeal this from your portal.',
    href: '/portal/appeals',
  }),

  ticketReply: (publicId: string, subject: string): NotificationCopy => ({
    type: 'TICKET_REPLY',
    title: 'New reply on your ticket',
    body: `${publicId} — ${subject}`,
    href: `/portal/tickets/${publicId}`,
  }),

  ticketResolved: (publicId: string): NotificationCopy => ({
    type: 'TICKET_RESOLVED',
    title: 'Ticket resolved',
    body: `${publicId} has been marked resolved. Reply if it is not sorted.`,
    href: `/portal/tickets/${publicId}`,
  }),

  reportUpdate: (publicId: string, status: string): NotificationCopy => ({
    type: 'REPORT_UPDATE',
    title: 'Report updated',
    body: `${publicId} is now ${status.toLowerCase().replace(/_/g, ' ')}.`,
    href: `/portal/tickets`,
  }),

  appealDecision: (publicId: string, accepted: boolean, decision: string): NotificationCopy => ({
    type: 'APPEAL_DECISION',
    title: accepted ? 'Appeal accepted' : 'Appeal decided',
    body: `${publicId}\n\n${decision}`,
    href: `/portal/appeals/${publicId}`,
  }),

  accountLinked: (label: string): NotificationCopy => ({
    type: 'ACCOUNT_LINKED',
    title: 'Game account linked',
    body: `Your FiveM identity (${label}) is now linked to your Xenon account.`,
    href: '/portal/account',
  }),

  announcement: (title: string, body: string): NotificationCopy => ({
    type: 'SYSTEM_ANNOUNCEMENT',
    title,
    body,
    href: '/news',
  }),
} as const;
