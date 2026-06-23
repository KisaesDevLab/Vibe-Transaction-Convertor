// AI settings registry — DB → env → default resolution, validation, and the
// provenance the admin UI renders. Live-Postgres only.

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, getPool } from '../db/client.js';
import { listAiSettings, resolveAiSettings, setAiSetting } from './ai-settings.js';

const databaseUrl = process.env.DATABASE_URL;
const live = describe.skipIf(!databaseUrl);

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const ACTOR = '00000000-0000-0000-0000-000000000000';

live('ai-settings (live Postgres)', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'OLLAMA_VISION_TIMEOUT_MS',
    'OLLAMA_VISION_MAX_TOKENS',
    'OLLAMA_VISION_THINK',
    'OLLAMA_NUM_CTX',
    'VIBETC_OCR_RASTER_DPI',
    'VIBETC_REVIEW_CONFIDENCE_THRESHOLD',
    'VIBETC_CHECK_PAYEE_AUTO',
  ];

  beforeAll(async () => {
    const pool = getPool();
    await pool.query('DROP SCHEMA IF EXISTS vibetc CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await migrate(getDb(), { migrationsFolder });
  }, 60_000);

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(async () => {
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    await getPool().query('TRUNCATE TABLE vibetc.system_settings RESTART IDENTITY CASCADE');
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('returns built-in defaults when DB + env are unset', async () => {
    const s = await resolveAiSettings(getDb());
    expect(s.visionTimeoutMs).toBe(300_000);
    expect(s.visionMaxTokens).toBe(8_192);
    expect(s.visionThink).toBeUndefined();
    expect(s.keepAlive).toBe('30m');
    expect(s.numCtx).toBeUndefined();
    expect(s.ocrDpi).toBe(200);
    expect(s.ocrJpegQuality).toBe(80);
    expect(s.reviewConfidence).toBeCloseTo(0.7);
    expect(s.checkPayeeAuto).toBe(true);
    expect(s.localStructuredOutput).toBe('grammar');
    // GLM-OCR engine defaults (ADR-025).
    expect(s.glmOcrModel).toBe('GLM-OCR');
    expect(s.glmOcrTimeoutMs).toBe(120_000);
    expect(s.glmOcrConcurrency).toBe(2);
  });

  it('localStructuredOutput: accepts json_object, rejects anything else', async () => {
    await setAiSetting(getDb(), 'localStructuredOutput', 'json_object', ACTOR);
    expect((await resolveAiSettings(getDb())).localStructuredOutput).toBe('json_object');
    await expect(setAiSetting(getDb(), 'localStructuredOutput', 'nope', ACTOR)).rejects.toThrow(
      /one of/,
    );
  });

  it('falls back to the env var when the DB has no override', async () => {
    process.env.OLLAMA_VISION_TIMEOUT_MS = '123000';
    process.env.VIBETC_CHECK_PAYEE_AUTO = 'false';
    const s = await resolveAiSettings(getDb());
    expect(s.visionTimeoutMs).toBe(123_000);
    expect(s.checkPayeeAuto).toBe(false);
  });

  it('DB override wins over the env var', async () => {
    process.env.OLLAMA_VISION_TIMEOUT_MS = '123000';
    await setAiSetting(getDb(), 'visionTimeoutMs', '150000', ACTOR);
    const s = await resolveAiSettings(getDb());
    expect(s.visionTimeoutMs).toBe(150_000);
  });

  it('clearing a setting (empty value) deletes the override', async () => {
    await setAiSetting(getDb(), 'ocrDpi', '300', ACTOR);
    expect((await resolveAiSettings(getDb())).ocrDpi).toBe(300);
    await setAiSetting(getDb(), 'ocrDpi', '', ACTOR);
    expect((await resolveAiSettings(getDb())).ocrDpi).toBe(200); // back to default
  });

  it('validates kind + bounds', async () => {
    await expect(setAiSetting(getDb(), 'visionTimeoutMs', '999', ACTOR)).rejects.toThrow(/≥ 1000/);
    await expect(setAiSetting(getDb(), 'reviewConfidence', '2', ACTOR)).rejects.toThrow(/≤ 1/);
    await expect(setAiSetting(getDb(), 'visionThink', 'maybe', ACTOR)).rejects.toThrow(/one of/);
    await expect(setAiSetting(getDb(), 'checkPayeeAuto', 'yes', ACTOR)).rejects.toThrow(
      /true or false/,
    );
    await expect(setAiSetting(getDb(), 'nope', '1', ACTOR)).rejects.toThrow(/unknown setting/);
  });

  it('listAiSettings reports the effective value + source', async () => {
    const before = await listAiSettings(getDb());
    expect(before.find((s) => s.id === 'ocrDpi')).toMatchObject({
      value: '200',
      source: 'default',
    });
    await setAiSetting(getDb(), 'ocrDpi', '150', ACTOR);
    const after = await listAiSettings(getDb());
    expect(after.find((s) => s.id === 'ocrDpi')).toMatchObject({ value: '150', source: 'db' });
  });
});
