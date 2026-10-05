/**
 * Structured custom ids for Xenon's persistent components.
 *
 * `xn:<namespace>:<action>[:<argument>]`. Every id the bot emits is built here
 * and every id it receives is parsed here, so a button minted by a panel three
 * months ago resolves the same way today, and a forged id with unexpected
 * characters is rejected before any handler sees it. The older review-card ids
 * (`app:…`) predate this and keep their own parser.
 */

const PATTERN = /^xn:([a-z]{1,16}):([a-z-]{1,24})(?::([A-Za-z0-9._-]{1,64}))?$/;

export const xenonIds = {
  roleToggle: (roleKey: string) => build('role', 'toggle', roleKey),
  supportCategory: () => build('support', 'category'),
  applicationOpen: () => build('application', 'open'),
  ticketClose: (publicId: string) => build('ticket', 'close', publicId),
  /** Discord-only ticket center category select. */
  ticketOpen: () => build('ticket', 'open'),
  /** Opens the confirmation modal for an approved plan. */
  setupApprove: (mode: 'apply' | 'repair', runId: string) => build('setup', mode, runId),
  setupConfirm: (mode: 'apply' | 'repair', runId: string) =>
    build('setup', `confirm-${mode}`, runId),
} as const;

function build(namespace: string, action: string, argument?: string): string {
  const id =
    argument === undefined ? `xn:${namespace}:${action}` : `xn:${namespace}:${action}:${argument}`;
  if (!PATTERN.test(id)) throw new Error(`Invalid Xenon component id ${id}`);
  return id;
}

export interface XenonId {
  readonly namespace: string;
  readonly action: string;
  readonly argument: string | null;
}

export function parseXenonId(customId: string): XenonId | null {
  const match = PATTERN.exec(customId);
  if (match === null) return null;
  const [, namespace, action, argument] = match;
  if (namespace === undefined || action === undefined) return null;
  return { namespace, action, argument: argument ?? null };
}
