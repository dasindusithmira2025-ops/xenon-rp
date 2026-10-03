import { expect, test } from '@playwright/test';

import { settled, signIn } from './helpers';

/**
 * Who gets in.
 *
 * Authorization is checked on the server, so these tests navigate directly to
 * URLs rather than looking for buttons. A screen that is merely not linked is
 * not protected, and a test that only clicks visible links would never notice
 * the difference.
 */

const PORTAL_ROUTES = [
  '/portal',
  '/portal/applications',
  '/portal/characters',
  '/portal/tickets',
  '/portal/appeals',
  '/portal/notifications',
  '/portal/account',
];

const CONTROL_ROUTES = [
  '/control',
  '/control/applications',
  '/control/players',
  '/control/tickets',
  '/control/reports',
  '/control/appeals',
  '/control/departments',
  '/control/staff',
  '/control/news',
  '/control/gallery',
  '/control/rules',
  '/control/discord',
  '/control/fivem',
  '/control/audit',
  '/control/health',
  '/control/settings',
  '/control/flags',
];

test.describe('signed out', () => {
  for (const path of [...PORTAL_ROUTES, ...CONTROL_ROUTES]) {
    test(`${path} is not reachable`, async ({ page }) => {
      await page.goto(path);
      const bodyText = await settled(page);

      // Either a redirect to sign-in or a refusal. What must not happen is the
      // page rendering someone's data.
      const url = new URL(page.url());
      const refused = /sign|login|unauthorized|forbidden/i.test(url.pathname);

      expect(
        refused || /\b40[13]\b|sign in|not authorised|not authorized|forbidden/i.test(bodyText),
        `${path} rendered without a session: ${bodyText.slice(0, 200)}`,
      ).toBe(true);
    });
  }
});

test.describe('signed in as a player', () => {
  for (const path of CONTROL_ROUTES) {
    test(`${path} is refused`, async ({ page }) => {
      await signIn(page, 'player', '/portal');
      await page.goto(path);
      const bodyText = await settled(page);

      expect(
        /\b403\b|forbidden|not authorised|not authorized|does not have access/i.test(bodyText),
        `${path} was served to a player: ${bodyText.slice(0, 200)}`,
      ).toBe(true);
    });
  }

  test('the portal is reachable', async ({ page }) => {
    await signIn(page, 'player', '/portal');
    await expect(page.getByRole('heading').first()).toBeVisible();
  });

  test('another player’s application is not readable', async ({ page }) => {
    await signIn(page, 'player', '/portal');

    // A plausible id that does not belong to this account. The public id is
    // deliberately not a guessable database key, but guessing one must still
    // fail closed rather than leak.
    await page.goto('/portal/applications/XN-WL-99999');
    const bodyText = await settled(page);

    expect(/\b40[34]\b|not found|forbidden|not authorised|not authorized/i.test(bodyText)).toBe(
      true,
    );
  });
});

test.describe('signed in as staff', () => {
  test('the control centre is reachable and says the data is fixtures', async ({ page }) => {
    await signIn(page, 'staff', '/control');

    await expect(page.getByRole('heading').first()).toBeVisible();
    // seed-dev sets dev.fixturesLoaded, and the control centre must say so on
    // every screen: nobody should mistake seeded fiction for real community
    // data.
    await expect(page.getByText(/fixture|development data|not real/i).first()).toBeVisible();
  });
});

test('the development sign-in route refuses non-fixture Discord IDs', async ({ request }) => {
  for (const discordId of ['123456789012345678', '900000000000000001']) {
    const response = await request.get(`/api/dev/session?discordId=${discordId}`, {
      maxRedirects: 0,
    });

    expect(response.status()).toBe(400);
  }
});

test('the FiveM bridge refuses an unsigned request', async ({ request }) => {
  const response = await request.post('/api/bridge/whitelist', {
    data: { identifiers: [{ kind: 'LICENSE', value: 'anything' }] },
  });

  // 401 when the bridge is configured, 503 when it is not. Either way it did
  // not answer the question.
  expect([401, 503]).toContain(response.status());
});

test('security headers are set on a public page', async ({ request }) => {
  const response = await request.get('/');
  const headers = response.headers();

  expect(headers['content-security-policy']).toBeTruthy();
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBeTruthy();
});
