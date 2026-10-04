import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDb, getDb, getPool } from '../db/client.js';
import { createApp } from '../server.js';

const databaseUrl = process.env.DATABASE_URL;
const live = describe.skipIf(!databaseUrl);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsFolder = join(__dirname, '..', 'db', 'migrations');

live('Accounts CRUD + masking + ABA validation (live Postgres)', () => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = 'test-secret-must-be-at-least-32-bytes-long-XXXX';
  }
  let app: ReturnType<typeof createApp>;
  let agent: request.Agent;
  let csrfToken: string;
  let companyId: string;

  beforeAll(async () => {
    const pool = getPool();
    await pool.query('DROP SCHEMA IF EXISTS vibetc CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await migrate(getDb(), { migrationsFolder });

    app = createApp();
    agent = request.agent(app);
    csrfToken = (await agent.get('/api/auth/csrf').expect(200)).body.token;
    await agent
      .post('/api/auth/register')
      .set('x-csrf-token', csrfToken)
      .send({
        email: 'admin@example.com',
        password: 'correcthorsebatterystaple',
        displayName: 'Admin',
      })
      .expect(201);
    await agent
      .post('/api/auth/login')
      .send({ email: 'admin@example.com', password: 'correcthorsebatterystaple' })
      .expect(200);

    const company = await agent
      .post('/api/companies')
      .set('x-csrf-token', csrfToken)
      .send({ name: 'Acme LLC' })
      .expect(201);
    companyId = company.body.id;
  }, 60_000);

  afterAll(async () => {
    await closeDb();
  });

  let accountId: string;

  it('POST /api/companies/:id/accounts creates a checking account; ABA pass marks valid', async () => {
    const res = await agent
      .post(`/api/companies/${companyId}/accounts`)
      .set('x-csrf-token', csrfToken)
      .send({
        nickname: 'Operating',
        financialInstitution: 'Wells Fargo',
        intuBid: '3000',
        intuOrg: 'Wells Fargo',
        accountType: 'CHECKING',
        accountNumber: '1234567890',
        routingNumber: '121000248',
      });
    expect(res.status).toBe(201);
    expect(res.body.routingNumberAbaValid).toBe(true);
    expect(res.body.accountNumberMasked).toBe('••••7890');
    expect(res.body.accountNumber).toBe('••••7890'); // masked by default
    accountId = res.body.id;
  });

  it('GET list returns the account masked', async () => {
    const res = await agent.get(`/api/companies/${companyId}/accounts`).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].accountNumber).toBe('••••7890');
  });

  it('GET ?reveal=true returns the full account number for an admin', async () => {
    const res = await agent.get(`/api/accounts/${accountId}?reveal=true`).expect(200);
    expect(res.body.accountNumber).toBe('1234567890');
    expect(res.body.accountNumberMasked).toBe('••••7890');
  });

  it('CC accounts must not have a routing number (Zod superRefine)', async () => {
    const res = await agent
      .post(`/api/companies/${companyId}/accounts`)
      .set('x-csrf-token', csrfToken)
      .send({
        nickname: 'AmEx',
        financialInstitution: 'American Express',
        intuBid: '06024',
        intuOrg: 'American Express',
        accountType: 'CREDITCARD',
        accountNumber: '4111111111111111',
        routingNumber: '021000021',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION');
  });

  it('save proceeds with an invalid routing number (warn only, ABA flag false)', async () => {
    const res = await agent
      .post(`/api/companies/${companyId}/accounts`)
      .set('x-csrf-token', csrfToken)
      .send({
        nickname: 'Savings',
        financialInstitution: 'Wells Fargo',
        intuBid: '3000',
        intuOrg: 'Wells Fargo',
        accountType: 'SAVINGS',
        accountNumber: '0987654321',
        routingNumber: '121000249', // bad checksum
      });
    expect(res.status).toBe(201);
    expect(res.body.routingNumberAbaValid).toBe(false);
  });

  it('PATCH updates nickname; routing change re-validates ABA', async () => {
    const res = await agent
      .patch(`/api/accounts/${accountId}`)
      .set('x-csrf-token', csrfToken)
      .send({ nickname: 'Operating Account', routingNumber: '021000021' });
    expect(res.status).toBe(200);
    expect(res.body.nickname).toBe('Operating Account');
    expect(res.body.routingNumberAbaValid).toBe(true);
  });

  it('PATCH routingNumber null (or blank) clears it', async () => {
    const cleared = await agent
      .patch(`/api/accounts/${accountId}`)
      .set('x-csrf-token', csrfToken)
      .send({ routingNumber: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.routingNumber).toBeNull();
    expect(cleared.body.routingNumberAbaValid).toBeNull();

    const blank = await agent
      .patch(`/api/accounts/${accountId}`)
      .set('x-csrf-token', csrfToken)
      .send({ routingNumber: '' });
    expect(blank.status).toBe(200);
    expect(blank.body.routingNumber).toBeNull();
  });

  const createAccount = async (overrides: Record<string, unknown>): Promise<string> => {
    const res = await agent
      .post(`/api/companies/${companyId}/accounts`)
      .set('x-csrf-token', csrfToken)
      .send({
        nickname: 'Extra',
        financialInstitution: 'Wells Fargo',
        intuBid: '3000',
        intuOrg: 'Wells Fargo',
        accountType: 'CHECKING',
        accountNumber: '1111222233',
        ...overrides,
      })
      .expect(201);
    return res.body.id as string;
  };

  it("the edit form's payload (routingNumber: null) saves a credit card", async () => {
    const cardId = await createAccount({
      nickname: 'Visa',
      accountType: 'CREDITCARD',
      accountNumber: '4111111111111111',
    });
    const res = await agent
      .patch(`/api/accounts/${cardId}`)
      .set('x-csrf-token', csrfToken)
      .send({ nickname: 'Visa Biz', defaultCsvTemplate: 'qbo3', routingNumber: null });
    expect(res.status).toBe(200);
    expect(res.body.nickname).toBe('Visa Biz');

    const routed = await agent
      .patch(`/api/accounts/${cardId}`)
      .set('x-csrf-token', csrfToken)
      .send({ routingNumber: '021000021' });
    expect(routed.status).toBe(400);
    expect(routed.body.code).toBe('VALIDATION');
  });

  it('switching an account that has a routing number to CREDITCARD is a 400, not a 500', async () => {
    const routedId = await createAccount({ routingNumber: '121000248' });
    const res = await agent
      .patch(`/api/accounts/${routedId}`)
      .set('x-csrf-token', csrfToken)
      .send({ accountType: 'CREDITCARD' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION');

    const ok = await agent
      .patch(`/api/accounts/${routedId}`)
      .set('x-csrf-token', csrfToken)
      .send({ accountType: 'CREDITCARD', routingNumber: null });
    expect(ok.status).toBe(200);
    expect(ok.body.accountType).toBe('CREDITCARD');
  });

  it('PATCH rejects an account number without 4 digits', async () => {
    const res = await agent
      .patch(`/api/accounts/${accountId}`)
      .set('x-csrf-token', csrfToken)
      .send({ accountNumber: '----' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION');
  });

  it('the account.update audit row never carries a full account or routing number', async () => {
    const res = await agent
      .patch(`/api/accounts/${accountId}`)
      .set('x-csrf-token', csrfToken)
      .send({ accountNumber: '5555666677778888', routingNumber: '121000248' });
    expect(res.status).toBe(200);

    const audit = await getPool().query(
      `SELECT payload FROM vibetc.audit_log
        WHERE action = 'account.update' AND entity_id = $1
        ORDER BY id DESC LIMIT 1`,
      [accountId],
    );
    const payload = audit.rows[0].payload as Record<string, unknown>;
    expect(payload).toEqual({
      accountNumberMasked: '••••8888',
      routingNumberChanged: true,
      routingNumberAbaValid: true,
    });
    expect(JSON.stringify(payload)).not.toMatch(/5555666677778888|121000248/);
  });

  it('staff is forbidden from ?reveal=true', async () => {
    // Create a staff user via admin
    const r = await agent
      .post('/api/users')
      .set('x-csrf-token', csrfToken)
      .send({ email: 'staff@example.com', password: 'staffpassword12345', displayName: 'Staff' })
      .expect(201);
    expect(r.body.role).toBe('staff');

    const staffAgent = request.agent(app);
    await staffAgent.get('/api/auth/csrf').expect(200);
    await staffAgent
      .post('/api/auth/login')
      .send({ email: 'staff@example.com', password: 'staffpassword12345' })
      .expect(200);
    const reveal = await staffAgent.get(`/api/accounts/${accountId}?reveal=true`);
    expect(reveal.status).toBe(403);
  });
});
