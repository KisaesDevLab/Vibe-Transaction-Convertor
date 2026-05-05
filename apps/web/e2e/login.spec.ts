import { expect, test } from '@playwright/test';

import { readReachability } from './_reachability';

const reachability = readReachability();

// Deterministic-ish per-run identity; survives a single playwright run but
// fresh per invocation so re-running this spec against a long-lived API
// doesn't trip the "first admin already exists" branch on the second run.
const TEST_EMAIL = `playwright-${Date.now()}@vibetc.test`;
const TEST_PASSWORD = 'PlaywrightTest1234!';
const TEST_DISPLAY_NAME = 'Playwright Tester';

test.describe('login flow', () => {
  test.skip(!reachability.reachable, 'Live API not running on 4400 — skipping E2E');

  test('register-or-sign-in lands on /companies', async ({ page }) => {
    // Start at the root. The SPA's <Routes> redirects:
    //   - /  → /companies (when authed)
    //   - /  → /login    (when not authed and users exist)
    //   - /login → /register (when no users exist yet)
    await page.goto('/');

    // Wait for the SPA to settle on whichever auth route applies.
    await page.waitForURL(/\/(login|register|companies)/, { timeout: 10_000 });
    const url = new URL(page.url());

    if (url.pathname === '/register') {
      // First-admin bootstrap path. RegisterFirstAdminPage logs in
      // automatically after creating the user, then navigates to /.
      await page.fill('#dn', TEST_DISPLAY_NAME);
      await page.fill('#email', TEST_EMAIL);
      await page.fill('#password', TEST_PASSWORD);
      await page.click('button[type="submit"]');
    } else if (url.pathname === '/login') {
      // Users already exist on this API instance — typical when running
      // E2E against a long-lived dev box. The bootstrap path isn't
      // reachable so we skip rather than guess at credentials.
      // Re-running against a freshly-reset API will exercise the full
      // flow.
      test.skip(
        true,
        'Existing users on /login — bootstrap path unavailable; rerun against a fresh API to exercise.',
      );
      return;
    }

    // Either path should now resolve to /companies.
    await page.waitForURL(/\/companies(\?|$|\/)/, { timeout: 10_000 });
    await expect(page.getByRole('heading', { name: 'Companies' })).toBeVisible();
  });
});
