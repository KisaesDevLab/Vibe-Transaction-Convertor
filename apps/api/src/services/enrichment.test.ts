// Enrichment service — rows the model omits, cache keying, per-pass audit and
// the statement spend ledger. Mocks the per-process LLM providers and swaps the
// Redis cache for an in-memory map, so no Ollama/Anthropic/Redis is needed.
// Live-Postgres only.

import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, getPool } from '../db/client.js';
import {
  accounts,
  auditLog,
  businessCategories,
  companies,
  statements,
  systemSettings,
  transactions,
} from '../db/schema.js';
import { MonthlyCapReachedError, enrichStatement } from './enrichment.js';

const databaseUrl = process.env.DATABASE_URL;
const live = describe.skipIf(!databaseUrl);

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(__dirname, '..', 'db', 'migrations');

type Proc = 'cleanse' | 'category';
type PromptTx = { index: number; raw_description: string; payee?: string };

// Per-test provider matrix + canned responses, and what the mocks saw.
let providerFor: Record<Proc, 'local' | 'anthropic'>;
let modelFor: Record<Proc, string>;
let costFor: Record<Proc, bigint>;
let respond: Record<Proc, (txs: PromptTx[]) => unknown>;
let llmCalls: Array<{ proc: Proc; txs: PromptTx[] }> = [];
const cacheStore = new Map<string, string>();
let cacheSets: Array<{ rawDescription: string; value: unknown }> = [];

const promptTxs = (userPrompt: string): PromptTx[] => {
  const m = /=== INPUT ===\n([\s\S]*)\n=== END ===/.exec(userPrompt);
  return (JSON.parse(m![1]!) as { transactions: PromptTx[] }).transactions;
};

vi.mock('./llm-provider.js', () => ({
  buildProviderForProcess: vi.fn(async (_db: unknown, proc: Proc) => ({
    providerId: providerFor[proc],
    provider: {
      complete: async (opts: { userPrompt: string }) => {
        const txs = promptTxs(opts.userPrompt);
        llmCalls.push({ proc, txs });
        return {
          data: respond[proc](txs),
          rawJson: '',
          telemetry: {
            inputTokens: 1,
            outputTokens: 1,
            ms: 1,
            model: modelFor[proc],
            costMicros: costFor[proc],
          },
        };
      },
    },
  })),
  resolveProcessLabel: vi.fn(async (_db: unknown, proc: Proc) => ({
    provider: providerFor[proc],
    model: modelFor[proc],
  })),
  resolveAiMode: vi.fn(async () => 'direct'),
}));

vi.mock('./enrichment-cache.js', async (orig) => {
  const actual = await orig<typeof import('./enrichment-cache.js')>();
  return {
    ...actual,
    enrichmentCache: {
      get: async (k: object) => {
        const raw = cacheStore.get(JSON.stringify(k));
        return raw === undefined ? null : JSON.parse(raw);
      },
      set: async (k: { rawDescription: string }, value: unknown) => {
        cacheSets.push({ rawDescription: k.rawDescription, value });
        cacheStore.set(JSON.stringify(k), JSON.stringify(value));
      },
    },
  };
});

const cleanseAll = (txs: PromptTx[]) => ({
  transactions: txs.map((t) => ({
    index: t.index,
    cleansed_description: `Clean ${t.raw_description}`,
    merchant_name: null,
    processor: null,
    transaction_type: 'purchase',
    is_opaque: false,
    confidence: 'high',
    payee_confidence: t.payee ? 0.9 : null,
  })),
});
const categorizeAll = (name: string) => (txs: PromptTx[]) => ({
  transactions: txs.map((t) => ({ index: t.index, category: name })),
});

live('enrichStatement (live Postgres, mocked providers + cache)', () => {
  let stmtId: string;
  let mealsId: string;
  let travelId: string;

  const seedTx = async (
    over: Partial<typeof transactions.$inferInsert> & { description: string },
    seq: number,
  ) => {
    const [row] = await getDb()
      .insert(transactions)
      .values({
        statementId: stmtId,
        seqInDay: seq,
        postedDate: '2026-03-08',
        normalizedDescription: over.description.toLowerCase(),
        amountCents: -12_34n,
        trntype: 'DEBIT',
        fitid: `VTC-${seq}${'0'.repeat(15)}`,
        sourcePage: 1,
        confidence: 1,
        ...over,
      })
      .returning();
    return row!;
  };

  const txById = async (id: string) =>
    (await getDb().select().from(transactions).where(eq(transactions.id, id)))[0]!;

  const auditRows = (action: string) =>
    getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, stmtId), eq(auditLog.action, action)));

  const ledger = async () =>
    (await getDb().select().from(statements).where(eq(statements.id, stmtId)))[0]!.llmCostMicros;

  const run = (cleanse: boolean, categorize: boolean) =>
    enrichStatement(getDb(), stmtId, { cleanse, categorize, actorUserId: null });

  beforeAll(async () => {
    if (!process.env.SESSION_SECRET) {
      process.env.SESSION_SECRET = 'test-secret-must-be-at-least-32-bytes-long-XXXX';
    }
    const pool = getPool();
    await pool.query('DROP SCHEMA IF EXISTS vibetc CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await migrate(getDb(), { migrationsFolder });
  }, 60_000);

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(async () => {
    providerFor = { cleanse: 'local', category: 'local' };
    modelFor = { cleanse: 'qwen2.5:32b-instruct', category: 'qwen2.5:32b-instruct' };
    costFor = { cleanse: 0n, category: 0n };
    respond = { cleanse: cleanseAll, category: categorizeAll('Meals') };
    llmCalls = [];
    cacheStore.clear();
    cacheSets = [];
    // audit_log is append-only (no TRUNCATE) — assertions filter by statement id.
    await getPool().query(
      'TRUNCATE TABLE vibetc.transactions, vibetc.statements, vibetc.accounts, vibetc.companies, vibetc.business_categories, vibetc.system_settings RESTART IDENTITY CASCADE',
    );
    const db = getDb();
    const [c] = await db.insert(companies).values({ name: 'C' }).returning();
    const [a] = await db
      .insert(accounts)
      .values({
        companyId: c!.id,
        nickname: 'op',
        financialInstitution: 'WF',
        intuBid: '3000',
        intuOrg: 'WF',
        accountType: 'CHECKING',
        accountNumber: '1234567890',
      })
      .returning();
    const [s] = await db
      .insert(statements)
      .values({
        accountId: a!.id,
        sourcePdfHash: 'b'.repeat(64),
        sourcePdfPath: '/nonexistent/stmt.pdf',
        sourcePdfPages: 1,
        status: 'review',
      })
      .returning();
    stmtId = s!.id;
    const cats = await db
      .insert(businessCategories)
      .values([
        { name: 'Meals', sortOrder: 1 },
        { name: 'Travel', sortOrder: 2 },
      ])
      .returning();
    mealsId = cats.find((x) => x.name === 'Meals')!.id;
    travelId = cats.find((x) => x.name === 'Travel')!.id;
  });

  it('leaves a row the model omitted untouched and uncached', async () => {
    const kept = await seedTx({ description: 'COFFEE SHOP 1' }, 0);
    const omitted = await seedTx(
      {
        description: 'HARDWARE 22',
        cleansedDescription: 'Prior Name',
        businessCategoryId: travelId,
      },
      1,
    );
    // The cleanse pass drops HARDWARE 22 from its response.
    respond.cleanse = (txs) => cleanseAll(txs.filter((t) => t.raw_description !== 'HARDWARE 22'));

    const res = await run(true, true);

    expect(res.omittedCount).toBe(1);
    expect(res.enrichedCount).toBe(1);
    const after = await txById(omitted.id);
    expect(after.cleansedDescription).toBe('Prior Name');
    expect(after.businessCategoryId).toBe(travelId);
    expect(after.enrichmentRunAt).toBeNull();
    const enriched = await txById(kept.id);
    expect(enriched.cleansedDescription).toBe('Clean COFFEE SHOP 1');
    expect(enriched.businessCategoryId).toBe(mealsId);
    expect(cacheSets.map((s) => s.rawDescription)).toEqual(['COFFEE SHOP 1']);
    const [audit] = await auditRows('statement.enriched');
    expect(audit?.payload).toMatchObject({ omittedCount: 1, enrichedCount: 1 });
  });

  it('treats an empty cached entry as a miss', async () => {
    await seedTx({ description: 'COFFEE SHOP 1' }, 0);
    await run(true, false);
    expect(cacheStore.size).toBe(1);
    // An older build cached `{}` for omitted rows.
    for (const k of cacheStore.keys()) cacheStore.set(k, '{}');
    llmCalls = [];

    const res = await run(true, false);

    expect(res.cacheHits).toBe(0);
    expect(llmCalls).toHaveLength(1);
  });

  it('replays cached answers only for the same category list and models', async () => {
    const tx = await seedTx({ description: 'COFFEE SHOP 1' }, 0);
    await run(false, true);
    expect(llmCalls).toHaveLength(1);
    // Same inputs → served from the cache.
    expect((await run(false, true)).cacheHits).toBe(1);
    expect(llmCalls).toHaveLength(1);

    // Renaming a category must not replay the old (now unresolvable) name.
    await getDb()
      .update(businessCategories)
      .set({ name: 'Dining' })
      .where(eq(businessCategories.id, mealsId));
    respond.category = categorizeAll('Dining');
    const renamed = await run(false, true);
    expect(renamed.cacheHits).toBe(0);
    expect(llmCalls).toHaveLength(2);
    expect((await txById(tx.id)).businessCategoryId).toBe(mealsId);

    // Switching the category model must not replay the previous model's answers.
    modelFor.category = 'claude-sonnet-4-6';
    expect((await run(false, true)).cacheHits).toBe(0);
    expect(llmCalls).toHaveLength(3);
  });

  it('never reads or writes a payee row through the description cache', async () => {
    await seedTx({ description: 'CHECK 1042' }, 0);
    await seedTx({ description: 'CHECK 1042', payee: 'Bob Smith' }, 1);

    await run(false, true);
    // Only the payee-less row is cached.
    expect(cacheSets).toHaveLength(1);

    llmCalls = [];
    const res = await run(false, true);
    expect(res.cacheHits).toBe(1);
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]!.txs).toEqual([expect.objectContaining({ payee: 'Bob Smith' })]);
  });

  it('audits each pass and adds Anthropic spend to the statement ledger', async () => {
    await seedTx({ description: 'COFFEE SHOP 1' }, 0);
    providerFor.cleanse = 'anthropic';
    costFor.cleanse = 500n;

    const res = await run(true, true);

    expect(res.provider).toBe('anthropic');
    expect(res.costMicros).toBe(500n);
    const [audit] = await auditRows('statement.enriched');
    expect(audit?.payload).toMatchObject({
      provider: 'anthropic',
      costMicros: '500',
      passes: [
        { proc: 'cleanse', provider: 'anthropic', ok: true },
        { proc: 'category', provider: 'local', ok: true },
      ],
    });
    expect(await ledger()).toBe(500n);
  });

  it('audits and records spend when a later pass fails after a billed one', async () => {
    const tx = await seedTx({ description: 'COFFEE SHOP 1' }, 0);
    providerFor.cleanse = 'anthropic';
    costFor.cleanse = 700n;
    respond.category = () => ({ transactions: 'not-an-array' });

    await expect(run(true, true)).rejects.toThrow();

    const [failed] = await auditRows('statement.enrich-failed');
    expect(failed?.payload).toMatchObject({
      llmCalls: 2,
      costMicros: '700',
      errorClass: 'ZodError',
      passes: [
        { proc: 'cleanse', provider: 'anthropic', ok: true },
        { proc: 'category', provider: 'local', ok: false },
      ],
    });
    expect(await auditRows('statement.enriched')).toHaveLength(0);
    expect(await ledger()).toBe(700n);
    expect((await txById(tx.id)).enrichmentRunAt).toBeNull();
  });

  it('blocks an Anthropic pass once the monthly cap is reached', async () => {
    await seedTx({ description: 'COFFEE SHOP 1' }, 0);
    await getDb()
      .update(statements)
      .set({ llmCostMicros: 2_000_000n })
      .where(eq(statements.id, stmtId));
    await getDb()
      .insert(systemSettings)
      .values({ key: 'llm.anthropic.monthly_cap_usd', valuePlaintext: '1', isSecret: false });
    providerFor.cleanse = 'anthropic';

    await expect(run(true, false)).rejects.toBeInstanceOf(MonthlyCapReachedError);

    expect(llmCalls).toHaveLength(0);
    const [failed] = await auditRows('statement.enrich-failed');
    expect(failed?.payload).toMatchObject({
      llmCalls: 0,
      costMicros: '0',
      errorClass: 'MonthlyCapReachedError',
      passes: [{ proc: 'cleanse', provider: 'anthropic', ok: false }],
    });
    expect(await ledger()).toBe(2_000_000n);
  });
});
