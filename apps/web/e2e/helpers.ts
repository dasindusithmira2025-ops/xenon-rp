import { expect, type Page } from '@playwright/test';
import { DEV_DISCORD_FIXTURES } from '@xenon/database';

/**
 * Shared helpers for the E2E suite.
 *
 * The two fixture accounts come from `seed-dev.ts`. Their identity keys are
 * deliberately not numeric Discord snowflakes.
 */

export const FIXTURES = {
  player: { discordId: DEV_DISCORD_FIXTURES.player.discordId, name: 'Dev Player' },
  staff: { discordId: DEV_DISCORD_FIXTURES.staff.discordId, name: 'Dev Staff' },
} as const;

/** Sign in as a fixture account and land on `redirectTo`. */
export async function signIn(
  page: Page,
  who: keyof typeof FIXTURES,
  redirectTo = '/portal',
): Promise<void> {
  const { discordId } = FIXTURES[who];
  await page.goto(
    `/api/dev/session?discordId=${discordId}&redirectTo=${encodeURIComponent(redirectTo)}`,
  );
  await page.waitForURL((url) => !url.pathname.startsWith('/api/'));
}

/**
 * Collect console errors and uncaught exceptions for the life of the page.
 *
 * Returned rather than asserted immediately so a test can decide when to
 * check. Hydration mismatches surface here and nowhere else.
 */
export function watchForErrors(page: Page): string[] {
  const problems: string[] = [];

  page.on('console', (message) => {
    if (message.type() !== 'error') return;

    // The dev server's HMR websocket does not survive Playwright's proxy.
    // Production has no HMR, so this is noise from the harness rather than
    // anything the site does.
    if (message.text().includes('/_next/hmr')) return;

    problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    problems.push(`pageerror: ${error.message}`);
  });

  return problems;
}

/**
 * Wait until the route has actually rendered.
 *
 * `next dev` compiles a route on first request and shows the loading fallback
 * meanwhile, so a bare `goto` frequently returns with the spinner still on
 * screen. Waiting for the network to settle is what makes an assertion about
 * page content mean anything.
 */
export async function settled(page: Page): Promise<string> {
  await page.waitForLoadState('networkidle');
  return page.locator('body').innerText();
}

/**
 * Assert the page does not scroll sideways.
 *
 * The single most common responsive defect, and one that no amount of reading
 * CSS reliably catches. One pixel of slack for sub-pixel rounding.
 */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'page scrolls horizontally').toBeLessThanOrEqual(1);
}
