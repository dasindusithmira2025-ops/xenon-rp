import { expect, test } from '@playwright/test';

import { expectNoHorizontalOverflow, watchForErrors } from './helpers';

/**
 * The public site, signed out.
 *
 * Every page is checked for three things at once: it renders its own heading,
 * the browser console stays clean, and nothing scrolls sideways. The last one
 * runs on both projects, so the mobile run is a real responsive check rather
 * than a desktop layout in a narrow window.
 */

/*
 * Page titles are editorial and change with the copy, so the check is
 * structural: exactly one h1, visible and not empty. A page that renders its
 * shell but not its content fails this; a page whose headline was reworded
 * does not.
 */
const PAGES = [
  '/',
  '/city',
  '/departments',
  '/rules',
  '/applications',
  '/news',
  '/gallery',
  '/community',
  '/status',
  '/support',
  '/privacy',
  '/terms',
] as const;

for (const path of PAGES) {
  test(`${path} renders cleanly`, async ({ page }) => {
    const problems = watchForErrors(page);

    const response = await page.goto(path);
    expect(response?.status(), `${path} returned ${String(response?.status())}`).toBeLessThan(400);

    const h1 = page.locator('h1');
    await expect(h1, `${path} has no h1`).toHaveCount(1);
    await expect(h1).toBeVisible();
    expect((await h1.innerText()).trim().length, `${path} has an empty h1`).toBeGreaterThan(0);

    // The tab title is metadata, not layout, so it is checked separately.
    expect(await page.title(), `${path} has no document title`).not.toBe('');

    await expectNoHorizontalOverflow(page);

    expect(problems, `${path} logged errors`).toEqual([]);
  });
}

test('an unknown URL returns a real 404 page', async ({ page }) => {
  const response = await page.goto('/this-page-does-not-exist');

  expect(response?.status()).toBe(404);

  // A written page with a way out, not the framework default. The site chrome
  // is deliberately absent: a root not-found renders outside the site layout.
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.getByRole('link', { name: /back to the city/i })).toBeVisible();
});

test('the rulebook shows published rules and their version', async ({ page }) => {
  await page.goto('/rules');

  // Seeded fixtures publish version 1 with four categories.
  await expect(page.getByText(/version\s*1/i).first()).toBeVisible();
  await expect(page.getByText(/metagaming/i).first()).toBeVisible();
});

test('applications are listed with what they lead to', async ({ page }) => {
  await page.goto('/applications');

  await expect(page.getByText('General Whitelist').first()).toBeVisible();
  await expect(page.getByText('Police Department').first()).toBeVisible();
});

test('server status reports only what the snapshot actually said', async ({ page }) => {
  await page.goto('/status');

  // The fixture snapshot is online with zero players. The page must show the
  // zero rather than dress it up: an invented player count is the single most
  // tempting lie a status page can tell.
  await expect(page.getByText('Xenon City').first()).toBeVisible();
  await expect(page.getByText(/of 128/i).first()).toBeVisible();

  const body = await page.locator('main').innerText();
  expect(body).toMatch(/\b0\b/);
});

test('the site navigation reaches the rulebook', async ({ page, isMobile }) => {
  await page.goto('/');

  if (isMobile) {
    await page.getByRole('button', { name: /menu/i }).click();
  }

  await page
    .getByRole('link', { name: /^rules$/i })
    .first()
    .click();
  await page.waitForURL('**/rules');

  await expect(page.locator('h1')).toBeVisible();
});

test('robots and the sitemap are served', async ({ page }) => {
  const robots = await page.goto('/robots.txt');
  expect(robots?.status()).toBe(200);

  const sitemap = await page.goto('/sitemap.xml');
  expect(sitemap?.status()).toBe(200);
  expect(await sitemap?.text()).toContain('<urlset');
});
