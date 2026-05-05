import { expect, test, type Page } from '@playwright/test';

import { readReachability } from './_reachability';

const reachability = readReachability();

const COMPANY_NAME = `Playwright Co ${Date.now()}`;
const TEST_EMAIL = `playwright-cos-${Date.now()}@vibetc.test`;
const TEST_PASSWORD = 'PlaywrightTest1234!';
const TEST_DISPLAY_NAME = 'Playwright Cos Tester';

/**
 * Land on /companies, registering the first admin if no user exists yet.
 * Made local rather than imported so each spec is self-contained and the
 * runner can be told to start at any spec without surprise dependencies.
 */
const ensureSignedIn = async (page: Page): Promise<void> => {
  await page.goto('/');
  await page.waitForURL(/\/(login|register|companies)/, { timeout: 10_000 });
  const url = new URL(page.url());

  if (url.pathname === '/register') {
    await page.fill('#dn', TEST_DISPLAY_NAME);
    await page.fill('#email', TEST_EMAIL);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/companies/, { timeout: 10_000 });
    return;
  }

  if (url.pathname === '/login') {
    // Try the credential login.spec.ts would have created. If it doesn't
    // work, skip — this spec needs an authed session and the only one we
    // can derive deterministically is the bootstrap admin.
    await page.fill('#email', TEST_EMAIL);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await page
      .waitForURL(/\/companies/, { timeout: 5_000 })
      .catch(() =>
        test.skip(true, 'No known credential to log in with — companies suite skipped.'),
      );
  }
};

test.describe('companies CRUD', () => {
  test.skip(!reachability.reachable, 'Live API not running on 4400 — skipping E2E');

  test('create → view → delete via typed-confirm', async ({ page }) => {
    await ensureSignedIn(page);
    await expect(page.getByRole('heading', { name: 'Companies' })).toBeVisible();

    // Create. The "New company" form uses id="newCompany" → submit button
    // labelled "Create" — see CompaniesPage.tsx.
    await page.fill('#newCompany', COMPANY_NAME);
    await page.click('button[type="submit"]:has-text("Create")');

    // Row should appear in the listing — the created company shows as a
    // <Link> with the company name as visible text.
    const row = page.getByRole('link', { name: COMPANY_NAME }).first();
    await expect(row).toBeVisible({ timeout: 5_000 });

    // Drill in: clicking the link navigates to /companies/:id.
    await row.click();
    await page.waitForURL(/\/companies\/[0-9a-f-]+$/, { timeout: 5_000 });
    await expect(page.getByRole('heading', { name: COMPANY_NAME })).toBeVisible();

    // Back to the list and delete via the typed-confirm prompt. The web UI
    // uses window.prompt() for the confirm; intercept and reply with the
    // exact company name (matches CompaniesPage.tsx onDelete).
    await page.goto('/companies');
    await expect(page.getByRole('link', { name: COMPANY_NAME }).first()).toBeVisible();

    page.once('dialog', (dialog) => {
      // Sanity-check it's the delete prompt, not some other modal.
      expect(dialog.type()).toBe('prompt');
      void dialog.accept(COMPANY_NAME);
    });

    // The delete button sits in the same row as the company link. Scope
    // the locator to the row containing the link to avoid clicking a
    // sibling row's button when previous test runs left rows behind.
    const targetRow = page.locator('li', { has: page.getByRole('link', { name: COMPANY_NAME }) });
    await targetRow.getByRole('button', { name: /Delete/ }).click();

    // Row should disappear. Use `not.toBeVisible` with a timeout to give
    // TanStack Query's invalidate-and-refetch cycle room to land.
    await expect(page.getByRole('link', { name: COMPANY_NAME })).not.toBeVisible({
      timeout: 5_000,
    });
  });
});
