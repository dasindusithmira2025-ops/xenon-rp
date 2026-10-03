import { expect, test } from '@playwright/test';

import { expectNoHorizontalOverflow, signIn, watchForErrors } from './helpers';

/**
 * The acceptance scenario, end to end in a browser.
 *
 * A player signs in, accepts the rules, starts the whitelist application,
 * writes an answer, watches it save, reloads the page and finds the answer
 * still there, submits; staff review it and approve; the player sees the
 * decision.
 *
 * The reload is the point. An applicant is asked for thirty to sixty minutes
 * of writing, and losing it is the failure this platform most has to avoid -
 * so it is proved in a real browser with a real navigation, not by asserting
 * that a function was called.
 *
 * ---
 *
 * One project only, and the reason is structural rather than a preference.
 *
 * This journey ends with the fixture player whitelisted, and a whitelisted
 * player cannot apply for the whitelist again - correctly, because that is the
 * rule the product enforces. The database is seeded once for the whole run, so
 * whichever browser project goes second arrives to find the application closed
 * with "You already hold this" and no way to start. The suite cannot run this
 * file twice against one database no matter which browser it uses.
 *
 * Splitting by viewport would not help either: a second project would need its
 * own fixture account, and two accounts walking the same path proves nothing
 * the first one did not. What is genuinely viewport-dependent - touch targets,
 * hover-only affordances, the mobile navigation - is covered by
 * `public-site.spec.ts`, which runs on both and is stateless.
 */

test.describe.configure({ mode: 'serial' });

// `test.info()` rather than a `testInfo` parameter: the skip predicate is
// handed the test's fixtures, not its info, and reaching for the running test's
// info is the supported way to ask which project is executing.
test.skip(
  () => test.info().project.name !== 'desktop',
  'The journey approves the fixture player, so it can only run once per seeded database.',
);

const ANSWER =
  'I have played roleplay servers for about three years, mostly in long-form civilian ' +
  'stories rather than combat. What I want from Xenon is somewhere consequences stick: ' +
  'where a bad decision on Tuesday is still being talked about on Friday.';

test('a player can reach the portal and accept the rules', async ({ page }) => {
  const problems = watchForErrors(page);

  await signIn(page, 'player', '/portal');
  await expect(page.getByText(/Dev Player/i).first()).toBeVisible();

  const accept = page.getByRole('button', { name: /^accept$/i });
  if (await accept.isVisible().catch(() => false)) {
    await accept.click();
    await expect(accept).toBeHidden({ timeout: 15_000 });
  }

  await expectNoHorizontalOverflow(page);
  expect(problems).toEqual([]);
});

test('autosave survives a full page reload', async ({ page }) => {
  // The index links to the application's own page; the control that actually
  // opens a draft lives there, next to the requirements it is gated on.
  await signIn(page, 'player', '/applications/whitelist');

  /*
   * Start a draft, or open the one that is already there.
   *
   * `globalSetup` reseeds before every run, so this normally finds "Start
   * application". Accepting "Continue your application" too means the file can
   * be re-run against a database that was not reset - which is what anyone
   * debugging a single test actually does - without failing on a difference
   * that has nothing to do with whether an answer survives a reload.
   */
  const start = page.getByRole('button', { name: /start application/i });
  const resume = page.getByRole('link', { name: /continue your application/i });
  // `or` rather than checking one and falling back to the other: `isVisible()`
  // answers immediately and would report false while the dev server is still
  // compiling the route, sending the test off to wait sixty seconds for a
  // control that was never going to appear. A combined locator keeps
  // Playwright's auto-waiting, which is the whole point of using it.
  await start.or(resume).first().click();

  await page.waitForURL('**/portal/applications/**');
  const url = page.url();

  // The long-form question the whole autosave design exists for.
  const field = page.getByLabel(/previous servers|tell us|why|about/i).first();
  await field.click();
  await field.fill(ANSWER);

  // The indicator is the promise the form makes to the applicant. Waiting for
  // it - rather than for a fixed delay - is also what proves the server
  // confirmed the write before the reload.
  //
  // Anchored to the start of the text, which is what separates the state that
  // matters from the two that read similarly: "Unsaved changes" (queued, not
  // yet sent) and "Your progress saves automatically" (nothing written yet).
  // The confirmed state reads "Saved", then "Saved 12s ago", then "Saved at
  // 14:32" once it is more than a minute old.
  await expect(page.getByRole('status').filter({ hasText: /^saved\b/i })).toBeVisible({
    timeout: 20_000,
  });

  await page.reload();

  const restored = page.getByLabel(/previous servers|tell us|why|about/i).first();
  await expect(restored).toHaveValue(ANSWER);
  expect(page.url()).toBe(url);
});

test('a half-finished application cannot be submitted', async ({ page }) => {
  await signIn(page, 'player', '/portal/applications');

  await page
    .getByRole('link', { name: /XN-WL-\d+|general whitelist/i })
    .first()
    .click();
  await page.waitForURL('**/portal/applications/**');

  await page.getByRole('button', { name: /submit application/i }).click();

  // No confirmation dialog: the form refuses and points at what is missing.
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByText(/required|needs an answer|before you submit/i).first()).toBeVisible();
});

test('a completed application can be submitted and then reviewed and approved', async ({
  page,
  context,
}) => {
  await signIn(page, 'player', '/portal/applications');
  await page
    .getByRole('link', { name: /XN-WL-\d+|general whitelist/i })
    .first()
    .click();
  await page.waitForURL('**/portal/applications/**');

  /*
   * Fill whatever the template asks for, without hard-coding its questions -
   * the fixtures are development content and are expected to change, and a
   * test that listed them by key would break every time somebody reworded one.
   *
   * Disabled controls are skipped deliberately: a multi-select that has
   * reached its limit disables the rest of its options, and clicking one is
   * the test fighting correct behaviour.
   */
  const fillable = async (locator: ReturnType<typeof page.locator>): Promise<boolean> =>
    (await locator.isVisible()) && (await locator.isEnabled());

  // Long-form questions carry real minimum lengths, so the filler has to be
  // long enough to pass them rather than a token string.
  const LONG = `${ANSWER} ${ANSWER} ${ANSWER} ${ANSWER}`;

  for (const area of await page.locator('textarea').all()) {
    if (!(await fillable(area))) continue;
    if ((await area.inputValue()) !== '') continue;
    await area.fill(LONG);
  }
  // `input:not([type])` too: the Input primitive leaves the attribute off for
  // plain text, which is valid HTML and easy to miss from a selector.
  for (const input of await page.locator('input[type="text"], input:not([type])').all()) {
    if (!(await fillable(input))) continue;
    if ((await input.inputValue()) !== '') continue;
    await input.fill('Fixture Answer');
  }
  for (const number of await page.locator('input[type="number"]').all()) {
    if (!(await fillable(number))) continue;
    if ((await number.inputValue()) !== '') continue;
    await number.fill('24');
  }
  for (const radio of await page.getByRole('radio').all()) {
    if (!(await fillable(radio))) continue;
    const group = await radio.getAttribute('name');
    if (group === null) continue;
    if ((await page.locator(`input[name="${group}"]:checked`).count()) === 0) await radio.check();
  }
  for (const select of await page.locator('select').all()) {
    if (!(await fillable(select))) continue;
    const second = (await select.locator('option').all())[1];
    if (second !== undefined) await select.selectOption(await second.getAttribute('value'));
  }
  for (const checkbox of await page.getByRole('checkbox').all()) {
    if (!(await fillable(checkbox))) continue;
    if (await checkbox.isChecked()) continue;
    await checkbox.check();
  }

  // Same anchored match as the reload test: the confirmed state reads "Saved",
  // then "Saved 12s ago", and only becomes "Saved at 14:32" after a minute.
  await expect(page.getByRole('status').filter({ hasText: /^saved\b/i })).toBeVisible({
    timeout: 20_000,
  });

  const publicId = /XN-WL-\d+/.exec(await page.locator('body').innerText())?.[0];
  expect(publicId, 'no application id on the page').toBeDefined();

  await page.getByRole('button', { name: /submit application/i }).click();
  await page.getByRole('button', { name: /^submit$/i }).click();

  await expect(page.getByText(/submitted|under review|with the review team/i).first()).toBeVisible({
    timeout: 20_000,
  });

  // --- Staff, in a separate browser context so both sessions stay valid ----
  const staffPage = await context.browser()!.newPage();
  await signIn(staffPage, 'staff', '/control/applications');

  await expect(staffPage.getByText(publicId!).first()).toBeVisible({ timeout: 20_000 });
  await staffPage.getByText(publicId!).first().click();
  await staffPage.waitForURL('**/control/applications/**');

  // The applicant's answer is legible to the reviewer.
  await expect(staffPage.getByText(/consequences stick/i).first()).toBeVisible();

  // Approving is a two-step action on purpose: the button opens a
  // confirmation naming what the approval grants, and only the dialog commits.
  await staffPage
    .getByRole('button', { name: /^approve$/i })
    .first()
    .click();

  const dialog = staffPage.getByRole('alertdialog').or(staffPage.getByRole('dialog')).first();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /^approve$/i }).click();

  await expect(staffPage.getByText(/approved/i).first()).toBeVisible({ timeout: 20_000 });

  // --- And the player is told ---------------------------------------------
  await page.goto('/portal/notifications');
  await expect(page.getByText(new RegExp(publicId!, 'i')).first()).toBeVisible({ timeout: 20_000 });

  await page.goto('/portal');
  await expect(page.getByText(/whitelist/i).first()).toBeVisible();

  await staffPage.close();
});
