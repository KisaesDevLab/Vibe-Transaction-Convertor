// Extraction-prompt override: DB round-trip, append vs full mode, and
// reset-to-default. Live-Postgres only.

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, getPool } from '../db/client.js';
import { users } from '../db/schema.js';
import {
  extractionPromptStatus,
  resolveExtractionSystemPrompt,
  setExtractionPrompt,
} from './extraction-prompt.js';

const databaseUrl = process.env.DATABASE_URL;
const live = describe.skipIf(!databaseUrl);
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

live('extraction-prompt (live Postgres)', () => {
  let actor = '';

  beforeAll(async () => {
    const pool = getPool();
    await pool.query('DROP SCHEMA IF EXISTS vibetc CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await migrate(getDb(), { migrationsFolder });
    const [u] = await getDb()
      .insert(users)
      .values({ email: 'a@a.a', passwordHash: 'argon2id$x', displayName: 'a', role: 'admin' })
      .returning();
    actor = u!.id;
  }, 60_000);

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(async () => {
    await getPool().query('TRUNCATE TABLE vibetc.system_settings RESTART IDENTITY CASCADE');
  });

  it('defaults to the built-in prompt (rules mode, no override)', async () => {
    const s = await extractionPromptStatus(getDb());
    expect(s.mode).toBe('rules');
    expect(s.extraInstructions).toMatchObject({ isOverride: false, current: '' });
    expect(s.fullSystemPrompt.isOverride).toBe(false);
    expect(s.effectivePreview).toContain('bank-statement extractor');
    expect(await resolveExtractionSystemPrompt(getDb())).toBe(s.fullSystemPrompt.defaultValue);
  });

  it('appends extra instructions in rules mode', async () => {
    await setExtractionPrompt(getDb(), { mode: 'rules', extraInstructions: 'BANK_X_RULE' }, actor);
    const s = await extractionPromptStatus(getDb());
    expect(s.extraInstructions.isOverride).toBe(true);
    expect(s.effectivePreview).toContain('ADDITIONAL OPERATOR INSTRUCTIONS');
    const resolved = await resolveExtractionSystemPrompt(getDb());
    expect(resolved).toContain('BANK_X_RULE');
    expect(resolved.startsWith(s.fullSystemPrompt.defaultValue)).toBe(true);
  });

  it('uses the full override verbatim in full mode', async () => {
    await setExtractionPrompt(
      getDb(),
      { mode: 'full', fullSystemPrompt: 'ONLY THIS PROMPT' },
      actor,
    );
    expect(await resolveExtractionSystemPrompt(getDb())).toBe('ONLY THIS PROMPT');
  });

  it('clearing an override reverts to the default', async () => {
    await setExtractionPrompt(getDb(), { extraInstructions: 'TEMP' }, actor);
    expect((await extractionPromptStatus(getDb())).extraInstructions.isOverride).toBe(true);
    await setExtractionPrompt(getDb(), { extraInstructions: '' }, actor);
    const s = await extractionPromptStatus(getDb());
    expect(s.extraInstructions.isOverride).toBe(false);
    expect(await resolveExtractionSystemPrompt(getDb())).toBe(s.fullSystemPrompt.defaultValue);
  });
});
