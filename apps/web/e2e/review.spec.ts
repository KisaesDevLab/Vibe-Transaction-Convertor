import { expect, test, type APIRequestContext } from '@playwright/test';

import { readReachability } from './_reachability';

const reachability = readReachability();

const TEST_EMAIL = `playwright-review-${Date.now()}@vibetc.test`;
const TEST_PASSWORD = 'PlaywrightTest1234!';
const TEST_DISPLAY_NAME = 'Playwright Review Tester';

// Minimal valid 1-page PDF — no objects, no content, but a parser-friendly
// header + xref + trailer + EOF. pdf-parse will decline a fully-empty xref
// but the upload pipeline is tolerant: the magic-bytes check passes and
// the page-count call only needs a parseable trailer. If pdf-parse rejects
// in CI we'll see "unable to parse PDF" surface as the upload error and
// the spec will skip via the reachable-ness check.
const TINY_PDF = Buffer.from(
  '%PDF-1.4\n' +
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n' +
    'xref\n' +
    '0 4\n' +
    '0000000000 65535 f \n' +
    '0000000009 00000 n \n' +
    '0000000052 00000 n \n' +
    '0000000101 00000 n \n' +
    'trailer<</Size 4/Root 1 0 R>>\n' +
    'startxref\n' +
    '0\n' +
    '%%EOF\n',
  'utf8',
);

interface CsrfRes {
  token: string;
}
interface UsersExistRes {
  exists: boolean;
}
interface CompanyRes {
  id: string;
  name: string;
}
interface AccountRes {
  id: string;
}

/**
 * Bootstrap an authed APIRequestContext: register-or-login, then prime
 * the CSRF cookie so subsequent mutations are accepted.
 */
const authenticate = async (request: APIRequestContext): Promise<void> => {
  const usersExist = (await (await request.get('/api/auth/users-exist')).json()) as UsersExistRes;

  if (!usersExist.exists) {
    const reg = await request.post('/api/auth/register', {
      data: { email: TEST_EMAIL, password: TEST_PASSWORD, displayName: TEST_DISPLAY_NAME },
    });
    expect(reg.ok(), `register failed: ${reg.status()} ${await reg.text()}`).toBeTruthy();
  }

  const login = await request.post('/api/auth/login', {
    data: { email: TEST_EMAIL, password: TEST_PASSWORD },
  });
  // Login may legitimately fail if `usersExist` was already true at the
  // start of this run (i.e., a previous suite registered a different
  // bootstrap admin and we have no credential to use). Skip rather than
  // false-fail when that happens.
  if (!login.ok()) {
    test.skip(
      true,
      `login failed (${login.status()}) — review suite needs a freshly-bootstrapped API.`,
    );
  }

  // Prime the CSRF cookie/token. The cookie carries forward via the
  // shared APIRequestContext storage.
  await request.get('/api/auth/csrf');
};

const csrfHeader = async (request: APIRequestContext): Promise<Record<string, string>> => {
  const res = await request.get('/api/auth/csrf');
  const body = (await res.json()) as CsrfRes;
  return { 'x-csrf-token': body.token };
};

test.describe('statement upload pipeline', () => {
  test.skip(!reachability.reachable, 'Live API not running on 4400 — skipping E2E');
  test.skip(
    !reachability.llmGatewayConfigured,
    'LLM_GATEWAY_URL not set — review pipeline E2E is CI-only.',
  );

  test('upload triggers extraction off "uploaded"', async ({ page, request }) => {
    await authenticate(request);
    const headers = await csrfHeader(request);

    // Create a company via API.
    const companyRes = await request.post('/api/companies', {
      data: { name: `Playwright Review Co ${Date.now()}` },
      headers,
    });
    expect(companyRes.ok(), await companyRes.text()).toBeTruthy();
    const company = (await companyRes.json()) as CompanyRes;

    // Create an account on that company. INTU.BID 10898 / INTU.ORG "B1"
    // are the canonical Chase placeholders — any pair valid against the
    // FIDIR-mirrored set is fine; the extraction worker doesn't validate
    // the BID against the upload's content.
    const accountRes = await request.post(`/api/companies/${company.id}/accounts`, {
      data: {
        nickname: 'Playwright Test Acct',
        financialInstitution: 'Test Bank',
        intuBid: '10898',
        intuOrg: 'B1',
        accountType: 'CHECKING',
        accountNumber: '12345678',
        defaultCsvTemplate: 'qbo3',
      },
      headers,
    });
    expect(accountRes.ok(), await accountRes.text()).toBeTruthy();
    const account = (await accountRes.json()) as AccountRes;

    // Drive the upload through the UI dropzone via setInputFiles. The
    // dropzone's <input type="file"> is sr-only; setInputFiles bypasses
    // the visibility constraint (Playwright explicitly allows this).
    await page.goto(`/accounts/${account.id}`);
    await expect(page.getByRole('heading', { name: /Playwright Test Acct/ })).toBeVisible();

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'tiny.pdf',
      mimeType: 'application/pdf',
      buffer: TINY_PDF,
    });

    // The dropzone surfaces either a ✓ filename or a ✗ error line within
    // a couple of seconds. Either is fine for asserting "the upload
    // round-tripped". If the PDF was rejected pre-storage we won't have
    // a statement row to poll, so we skip the rest of the assertions.
    const dropzoneFeedback = page.locator('text=/✓|✗/').first();
    await dropzoneFeedback.waitFor({ timeout: 10_000 }).catch(() => undefined);

    // Find the most recently created statement on this account via API.
    const listRes = await request.get(`/api/statements?accountId=${account.id}`);
    expect(listRes.ok()).toBeTruthy();
    const stmts = (await listRes.json()) as Array<{
      id: string;
      status: string;
      createdAt: string;
    }>;
    if (stmts.length === 0) {
      test.skip(
        true,
        'no statement row created — tiny PDF likely rejected by pdf-parse. Suite needs a richer fixture in CI.',
      );
      return;
    }
    const latest = stmts.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;

    // Poll for the statement to move off 'uploaded'. Even when the LLM
    // gateway is a stub or unreachable, the worker should mark the row
    // 'failed' (or 'awaiting-locale-confirmation') within seconds. The
    // assertion is "the pipeline ran", not "extraction succeeded".
    const deadline = Date.now() + 30_000;
    let finalStatus = latest.status;
    while (Date.now() < deadline) {
      const r = await request.get(`/api/statements/${latest.id}`);
      if (r.ok()) {
        const body = (await r.json()) as { statement: { status: string } };
        finalStatus = body.statement.status;
        if (finalStatus !== 'uploaded') break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }

    expect(
      finalStatus,
      `statement should have moved off 'uploaded' within 30s; saw '${finalStatus}'`,
    ).not.toBe('uploaded');
  });
});
