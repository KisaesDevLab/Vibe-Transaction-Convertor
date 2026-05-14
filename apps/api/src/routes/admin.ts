import { Router } from 'express';
import { eq, lt, sql } from 'drizzle-orm';
import { createReadStream } from 'node:fs';
import { rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { db } from '../db/client.js';
import { businessCategories, statements, sessions, systemSettings } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { unwrapSecret, wrapSecret } from '../lib/secrets.js';
import { requireAdmin } from '../middleware/auth.js';
import { writeAudit } from '../services/audit.js';
import { backupFilePath, createBackup, deleteBackup, listBackups } from '../services/backup.js';
import { getFidirStatus, seedFidir } from '../services/fidir-seeder.js';
import {
  clearEngineConfig,
  getAllEngineConfigs,
  getEngineConfig,
  maskEngineConfig,
  setEngineConfig,
  type EngineKey,
} from '../services/engines.js';
import {
  buildProvider,
  invalidateProviderCache,
  providerOrderFor,
  resolveProviderPolicy,
  type LlmProviderPolicy,
} from '../services/llm-provider.js';
import {
  enrichmentPromptStatus,
  enrichmentToggleStatus,
  setEnrichmentPrompt,
  setEnrichmentToggle,
} from '../services/enrichment.js';
import {
  getFirmDefaultPdfStrategy,
  isPdfProcessingStrategy,
  setFirmDefaultPdfStrategy,
} from '../services/pdf-strategy.js';
import {
  getLastSweepAt,
  getRetentionDays,
  runRetentionSweep,
  setRetentionDays,
} from '../services/pdf-retention.js';
import { clearPricing, listPricings, setPricing } from '../services/pricing.js';
import {
  AnthropicProvider,
  type EnrichmentPromptMode,
  probeGlmOcrHealth,
} from '@vibe-tx-converter/extractor';
import { extractionQueue } from '../jobs/queues.js';
import { logger } from '../lib/logger.js';

const PROVIDER_KEY = 'llm.provider';
const ANTHROPIC_KEY = 'llm.anthropic.api_key';
const ANTHROPIC_MODEL = 'llm.anthropic.model';
const MONTHLY_CAP_KEY = 'llm.anthropic.monthly_cap_usd';

// Phase 26 #29: curated Claude family with known pricing in the
// extractor's price table. Anything matching CLAUDE_PATTERN is also
// accepted server-side so operators can use newer models that haven't
// landed in our pricing table yet — cost calculation falls back to
// "0 micros" for unknown models, so operators see usage but no cost
// estimate until we update the table.
const CURATED_ANTHROPIC_MODELS = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
] as const;
const CLAUDE_PATTERN = /^claude-[a-z0-9-]+$/i;

export const adminRouter = (): Router => {
  const router = Router();
  router.use(requireAdmin);

  router.get('/llm-provider', async (_req, res, next) => {
    try {
      const modelRows = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, ANTHROPIC_MODEL));
      const keyRows = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, ANTHROPIC_KEY));
      const capRows = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, MONTHLY_CAP_KEY));

      // Phase 26 #29: surface the last 4 chars of the stored key for a
      // visual sanity check ("am I looking at the right key?") without
      // exposing the rest. We unwrap, slice, then drop the plaintext.
      let lastFour: string | null = null;
      const keyBlob = keyRows[0]?.valueEncrypted;
      if (keyBlob) {
        try {
          const plain = unwrapSecret(keyBlob);
          lastFour = plain.slice(-4);
        } catch {
          // wrapped value is corrupt — surface as no-key.
        }
      }
      const policy = await resolveProviderPolicy(db);
      const { primary } = providerOrderFor(policy);
      res.json({
        // Primary provider — what runs first when extraction starts.
        // Pre-policy clients read this field; new clients read `policy`.
        provider: primary,
        policy,
        anthropicModel: modelRows[0]?.valuePlaintext ?? null,
        anthropicKeyConfigured: lastFour !== null,
        anthropicKeyLastFour: lastFour,
        allowedModels: CURATED_ANTHROPIC_MODELS,
        monthlyCapUsd: capRows[0]?.valuePlaintext
          ? Number.parseFloat(capRows[0].valuePlaintext)
          : null,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/llm-provider', async (req, res, next) => {
    try {
      // Accept either `policy` (4-mode) or legacy `provider` (2-mode).
      // Legacy values map to their *-only counterparts so old clients
      // can keep posting `{provider: "local"}` indefinitely.
      const POLICIES: LlmProviderPolicy[] = [
        'local-only',
        'anthropic-only',
        'local-first',
        'anthropic-first',
      ];
      const raw = req.body?.policy ?? req.body?.provider;
      let policy: LlmProviderPolicy;
      if (raw === 'local') policy = 'local-only';
      else if (raw === 'anthropic') policy = 'anthropic-only';
      else if (typeof raw === 'string' && POLICIES.includes(raw as LlmProviderPolicy))
        policy = raw as LlmProviderPolicy;
      else
        throw new ValidationError(
          `policy must be one of ${POLICIES.join(', ')} (or legacy "local"/"anthropic")`,
        );
      await db
        .insert(systemSettings)
        .values({ key: PROVIDER_KEY, valuePlaintext: policy, isSecret: false })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { valuePlaintext: policy, updatedAt: sql`now()`, updatedByUserId: req.user!.id },
        });
      invalidateProviderCache();
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'system_settings',
        entityId: PROVIDER_KEY,
        action: 'llm-provider.change',
        payload: { policy },
      });
      const { primary } = providerOrderFor(policy);
      res.json({ ok: true, policy, provider: primary });
    } catch (err) {
      next(err);
    }
  });

  router.post('/llm-provider/anthropic-key', async (req, res, next) => {
    try {
      const key = String(req.body?.apiKey ?? '').trim();
      if (key.length < 20) throw new ValidationError('API key looks invalid');
      const wrapped = wrapSecret(key);
      await db
        .insert(systemSettings)
        .values({ key: ANTHROPIC_KEY, valueEncrypted: wrapped, isSecret: true })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { valueEncrypted: wrapped, updatedAt: sql`now()`, updatedByUserId: req.user!.id },
        });
      invalidateProviderCache();
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'system_settings',
        entityId: ANTHROPIC_KEY,
        action: 'anthropic-key.set',
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/llm-provider/anthropic-model', async (req, res, next) => {
    try {
      const model = String(req.body?.model ?? '').trim();
      if (!CLAUDE_PATTERN.test(model)) {
        throw new ValidationError(
          `model must look like 'claude-...' (got: ${JSON.stringify(model)})`,
        );
      }
      await db
        .insert(systemSettings)
        .values({ key: ANTHROPIC_MODEL, valuePlaintext: model, isSecret: false })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { valuePlaintext: model, updatedAt: sql`now()`, updatedByUserId: req.user!.id },
        });
      invalidateProviderCache();
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'system_settings',
        entityId: ANTHROPIC_MODEL,
        action: 'anthropic-model.change',
        payload: { model },
      });
      res.json({ ok: true, model });
    } catch (err) {
      next(err);
    }
  });

  // Phase 26 #29: clear the stored Anthropic API key. Used when the
  // operator rotates keys (revoke old → DELETE here → POST new).
  router.delete('/llm-provider/anthropic-key', async (req, res, next) => {
    try {
      await db.delete(systemSettings).where(eq(systemSettings.key, ANTHROPIC_KEY));
      invalidateProviderCache();
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'system_settings',
        entityId: ANTHROPIC_KEY,
        action: 'anthropic-key.clear',
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Phase 26 #34: monthly USD cost cap on the Anthropic provider. The
  // worker checks this before every extract call and refuses if the
  // current calendar-month spend would exceed the cap. NULL = no cap.
  router.post('/llm-provider/monthly-cap', async (req, res, next) => {
    try {
      const raw = req.body?.usd;
      let value: string | null = null;
      if (raw === null || raw === undefined || raw === '') {
        await db.delete(systemSettings).where(eq(systemSettings.key, MONTHLY_CAP_KEY));
      } else {
        const parsed = Number.parseFloat(String(raw));
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new ValidationError('usd must be a non-negative number, or null to clear');
        }
        value = parsed.toFixed(2);
        await db
          .insert(systemSettings)
          .values({ key: MONTHLY_CAP_KEY, valuePlaintext: value, isSecret: false })
          .onConflictDoUpdate({
            target: systemSettings.key,
            set: {
              valuePlaintext: value,
              updatedAt: sql`now()`,
              updatedByUserId: req.user!.id,
            },
          });
      }
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'system_settings',
        entityId: MONTHLY_CAP_KEY,
        action: 'monthly-cap.set',
        payload: { usd: value },
      });
      res.json({ ok: true, monthlyCapUsd: value === null ? null : Number.parseFloat(value) });
    } catch (err) {
      next(err);
    }
  });

  // Phase 26 #32: test-connection. Pings the configured provider's
  // health() and returns a structured result. Doesn't consume tokens
  // for Anthropic (presence-of-key check); does hit /health for the
  // local gateway.
  // Phase 26 #29: live model catalog. Hits Anthropic's /v1/models with
  // the configured key; returns the union of (curated list) + (live
  // list) so operators see both well-priced models and any new arrivals.
  // Returns the curated list alone when no key is configured.
  router.get('/llm-provider/anthropic-models', async (_req, res, next) => {
    try {
      const provider = await buildProvider(db).catch(() => null);
      const live: string[] = [];
      if (provider && provider.id === 'anthropic') {
        const result = await (provider as AnthropicProvider).listModels();
        if (result.ok) live.push(...result.models);
      }
      const merged = Array.from(new Set([...CURATED_ANTHROPIC_MODELS, ...live])).sort();
      res.json({
        models: merged,
        curated: CURATED_ANTHROPIC_MODELS,
        liveCount: live.length,
        // null when key is unset or the listing failed; operators can
        // still type any claude-* string into the custom-id input.
        hasLiveCatalog: live.length > 0,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/llm-provider/test', async (_req, res, next) => {
    try {
      // buildProvider throws when provider=anthropic and there's no
      // API key in DB or env. Catch it so the UI gets a structured
      // {ok:false} instead of a confusing 500.
      let provider: Awaited<ReturnType<typeof buildProvider>>;
      try {
        provider = await buildProvider(db);
      } catch (err) {
        res.json({
          provider: 'unknown',
          ok: false,
          detail: (err as Error).message,
        });
        return;
      }
      const health = await provider.health();
      res.json({
        provider: provider.id,
        ok: health.ok,
        detail: health.detail ?? null,
      });
    } catch (err) {
      next(err);
    }
  });

  // Operator-managed Anthropic pricing. Per-million-token USD figures
  // get converted to micros server-side (1 USD = 1_000_000 micros) so
  // the cost-calc path stays integer-clean.
  router.get('/llm-provider/pricing', async (_req, res, next) => {
    try {
      const rows = await listPricings(db);
      res.json({
        rows: rows.map((r) => ({
          model: r.model,
          source: r.source,
          inputPerMTokenMicros: r.inputPerMTokenMicros.toString(),
          outputPerMTokenMicros: r.outputPerMTokenMicros.toString(),
          inputPerMTokenUsd: Number(r.inputPerMTokenMicros) / 1_000_000,
          outputPerMTokenUsd: Number(r.outputPerMTokenMicros) / 1_000_000,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/llm-provider/pricing', async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const model = String(body.model ?? '').trim();
      const inputUsd = Number.parseFloat(String(body.inputPerMTokenUsd ?? ''));
      const outputUsd = Number.parseFloat(String(body.outputPerMTokenUsd ?? ''));
      if (!Number.isFinite(inputUsd) || !Number.isFinite(outputUsd)) {
        throw new ValidationError('inputPerMTokenUsd and outputPerMTokenUsd must be numbers');
      }
      if (inputUsd < 0 || outputUsd < 0) {
        throw new ValidationError('prices must be non-negative');
      }
      // 1 USD = 1_000_000 micros. Round to int micros to keep storage
      // BigInt-clean.
      const inputMicros = BigInt(Math.round(inputUsd * 1_000_000));
      const outputMicros = BigInt(Math.round(outputUsd * 1_000_000));
      try {
        await setPricing(db, model, inputMicros, outputMicros, req.user!.id);
      } catch (err) {
        throw new ValidationError((err as Error).message);
      }
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'system_settings',
        entityId: `llm.pricing.anthropic.${model}`,
        action: 'pricing.set',
        payload: { model, inputUsd, outputUsd },
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/llm-provider/pricing/:model', async (req, res, next) => {
    try {
      const model = String(req.params.model);
      if (!/^claude-[a-z0-9-]+$/i.test(model)) {
        throw new ValidationError(`unsafe model id: ${model}`);
      }
      await clearPricing(db, model);
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'system_settings',
        entityId: `llm.pricing.anthropic.${model}`,
        action: 'pricing.clear',
        payload: { model },
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Phase 26 #36: rolling cost summary for the dashboard widget. Sums
  // statements.llm_cost_micros across three windows + per-statement
  // average for the 30d window.
  router.get('/llm-provider/cost-summary', async (_req, res, next) => {
    try {
      const sumExpr = sql<string>`coalesce(sum(${statements.llmCostMicros}), 0)`;
      const countExpr = sql<string>`count(*)`;
      const window = async (
        days: number,
      ): Promise<{ totalMicros: bigint; statementCount: number }> => {
        const rows = await db
          .select({ total: sumExpr, count: countExpr })
          .from(statements)
          .where(sql`${statements.createdAt} >= now() - (${days} || ' days')::interval`);
        return {
          totalMicros: BigInt(rows[0]?.total ?? '0'),
          statementCount: Number.parseInt(rows[0]?.count ?? '0', 10),
        };
      };
      const [d7, d30, d90] = await Promise.all([window(7), window(30), window(90)]);
      const microsToUsd = (micros: bigint): number => Number(micros) / 1_000_000;
      res.json({
        days7: { totalUsd: microsToUsd(d7.totalMicros), statements: d7.statementCount },
        days30: {
          totalUsd: microsToUsd(d30.totalMicros),
          statements: d30.statementCount,
          avgUsdPerStatement:
            d30.statementCount === 0 ? 0 : microsToUsd(d30.totalMicros) / d30.statementCount,
        },
        days90: { totalUsd: microsToUsd(d90.totalMicros), statements: d90.statementCount },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/fidir/refresh', async (req, res, next) => {
    try {
      const result = await seedFidir(db);
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'fidir',
        entityId: 'refresh',
        action: 'fidir.refresh',
        payload: { imported: result.imported, skipped: result.skipped },
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get('/fidir/status', async (_req, res, next) => {
    try {
      res.json(await getFidirStatus(db));
    } catch (err) {
      next(err);
    }
  });

  // Queue stats for the maintenance page.
  router.get('/maintenance/queue-stats', async (_req, res, next) => {
    try {
      if (!process.env.REDIS_URL) {
        res.json({ redis: 'unconfigured' });
        return;
      }
      const q = extractionQueue();
      const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed');
      res.json({ redis: 'configured', extraction: counts });
    } catch (err) {
      next(err);
    }
  });

  // Prune expired sessions on demand.
  router.post('/maintenance/prune-sessions', async (req, res, next) => {
    try {
      const result = await db
        .delete(sessions)
        .where(lt(sessions.expiresAt, new Date()))
        .returning({ id: sessions.id });
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'system',
        entityId: 'sessions',
        action: 'maintenance.prune-sessions',
        payload: { deleted: result.length },
      });
      res.json({ deleted: result.length });
    } catch (err) {
      next(err);
    }
  });

  // Clean ${DATA_DIR}/tmp older than 6 hours (Phase 9 item 21 / Phase 15
  // item 11). Recursive delete of any subdirectory whose mtime is older
  // than the cutoff.
  router.post('/maintenance/clean-tmp', async (req, res, next) => {
    try {
      const dataDir = process.env.DATA_DIR ?? './data';
      const tmpDir = join(dataDir, 'tmp');
      const cutoff = Date.now() - 6 * 60 * 60 * 1000;
      let removed = 0;
      let kept = 0;
      try {
        const entries = await readdir(tmpDir, { withFileTypes: true });
        for (const entry of entries) {
          const full = join(tmpDir, entry.name);
          try {
            const s = await stat(full);
            if (s.mtimeMs < cutoff) {
              await rm(full, { recursive: true, force: true });
              removed += 1;
            } else {
              kept += 1;
            }
          } catch (err) {
            logger.warn({ err, full }, 'tmp clean skipped entry');
          }
        }
      } catch {
        // tmp dir doesn't exist; nothing to clean
      }
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'system',
        entityId: 'tmp',
        action: 'maintenance.clean-tmp',
        payload: { removed, kept },
      });
      res.json({ removed, kept, tmpDir });
    } catch (err) {
      next(err);
    }
  });

  // Phase 26 #6/#7/#8/#9: backup endpoints. Trigger pg_dump, list,
  // download, delete. Files live under $DATA_DIR/backups; admin-only.
  router.post('/backup', async (req, res, next) => {
    try {
      const summary = await createBackup();
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'system',
        entityId: 'backup',
        action: 'backup.create',
        payload: { filename: summary.filename, sizeBytes: summary.sizeBytes },
      });
      res.status(201).json(summary);
    } catch (err) {
      next(err);
    }
  });

  router.get('/backups', async (_req, res, next) => {
    try {
      const list = await listBackups();
      const retentionDays = Number.parseInt(process.env.BACKUP_RETENTION_DAYS ?? '90', 10);
      res.json({
        backups: list,
        retentionDays: Number.isFinite(retentionDays) ? retentionDays : 90,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/backups/:filename/file', async (req, res, next) => {
    try {
      const filename = String(req.params.filename);
      let path: string;
      try {
        path = backupFilePath(filename);
      } catch (err) {
        throw new ValidationError((err as Error).message);
      }
      try {
        await stat(path);
      } catch {
        throw new NotFoundError(`backup ${filename} not found`);
      }
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'system',
        entityId: 'backup',
        action: 'backup.download',
        payload: { filename },
      });
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-disposition', `attachment; filename="${filename}"`);
      createReadStream(path).pipe(res);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/backups/:filename', async (req, res, next) => {
    try {
      const filename = String(req.params.filename);
      try {
        await deleteBackup(filename);
      } catch (err) {
        throw new ValidationError((err as Error).message);
      }
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'system',
        entityId: 'backup',
        action: 'backup.delete',
        payload: { filename },
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // DB-backed engine configuration (GLM-OCR + LLM Gateway). Reads
  // system_settings → falls back to env. Editable from the
  // /admin/engines UI without a worker restart.
  const ENGINE_KEYS: readonly EngineKey[] = ['glm-ocr', 'llm-gateway'];
  const isEngineKey = (s: string): s is EngineKey => (ENGINE_KEYS as readonly string[]).includes(s);

  router.get('/engines', async (_req, res, next) => {
    try {
      const configs = await getAllEngineConfigs(db);
      // Strip the plaintext apiKey before returning — replace with a
      // `hasApiKey` boolean + last-four mask. Same pattern the LLM
      // provider page uses for the Anthropic key.
      const masked = Object.fromEntries(
        Object.entries(configs).map(([k, v]) => [k, maskEngineConfig(v)]),
      );
      res.json({ configs: masked });
    } catch (err) {
      next(err);
    }
  });

  router.post('/engines/:engine', async (req, res, next) => {
    try {
      const engine = String(req.params.engine);
      if (!isEngineKey(engine)) throw new ValidationError(`unknown engine: ${engine}`);
      const body = req.body ?? {};
      const input: {
        url?: string | null;
        timeoutMs?: number | null;
        concurrency?: number | null;
        ocrPath?: string | null;
        healthPath?: string | null;
        versionPath?: string | null;
        apiKey?: string | null;
      } = {};
      if (body.url !== undefined) {
        input.url = body.url === null || body.url === '' ? null : String(body.url).trim();
      }
      if (body.timeoutMs !== undefined) {
        input.timeoutMs =
          body.timeoutMs === null ? null : Number.parseInt(String(body.timeoutMs), 10) || null;
      }
      if (body.concurrency !== undefined) {
        input.concurrency =
          body.concurrency === null ? null : Number.parseInt(String(body.concurrency), 10) || null;
      }
      // Path overrides — glm-ocr only. Service-layer normalisation
      // throws on bad shapes (must start with "/"); surface that as a
      // ValidationError so the admin UI gets a clean toast.
      const parsePath = (field: 'ocrPath' | 'healthPath' | 'versionPath'): void => {
        const raw = body[field];
        if (raw === undefined) return;
        input[field] = raw === null || raw === '' ? null : String(raw).trim();
      };
      parsePath('ocrPath');
      parsePath('healthPath');
      parsePath('versionPath');
      if (body.apiKey !== undefined) {
        const raw = body.apiKey;
        input.apiKey = raw === null || raw === '' ? null : String(raw).trim();
      }
      let nextConfig;
      try {
        nextConfig = await setEngineConfig(db, engine, input, req.user!.id);
      } catch (err) {
        throw new ValidationError((err as Error).message);
      }
      const next = maskEngineConfig(nextConfig);
      // Strip the plaintext apiKey from the audit row. The audit_log
      // is INSERT-only and viewable by admins; the key would otherwise
      // sit there in cleartext forever. Replace with a
      // {set:true|cleared:true} marker so the trail still records
      // that the credential changed and when.
      const { apiKey: _apiKey, ...auditableInput } = input;
      const auditPayload: Record<string, unknown> = {
        engine,
        input: {
          ...auditableInput,
          ...(input.apiKey !== undefined
            ? input.apiKey === null
              ? { apiKey: 'cleared' }
              : { apiKey: `set:${input.apiKey.slice(-4)}` }
            : {}),
        },
      };
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'system_settings',
        entityId: `engine.${engine}`,
        action: 'engine.update',
        payload: auditPayload,
      });
      res.json(next);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/engines/:engine', async (req, res, next) => {
    try {
      const engine = String(req.params.engine);
      if (!isEngineKey(engine)) throw new ValidationError(`unknown engine: ${engine}`);
      const cleared = await clearEngineConfig(db, engine, req.user!.id);
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'system_settings',
        entityId: `engine.${engine}`,
        action: 'engine.clear',
      });
      res.json(maskEngineConfig(cleared));
    } catch (err) {
      next(err);
    }
  });

  // Phase 26 #4: live test-connection probe per engine. Uses the
  // currently-resolved URL (DB or env). Doesn't burn LLM tokens for
  // llm-gateway — just hits /health like the readiness probe.
  router.post('/engines/:engine/test', async (req, res, next) => {
    try {
      const engine = String(req.params.engine);
      if (!isEngineKey(engine)) throw new ValidationError(`unknown engine: ${engine}`);
      const cfg = await getEngineConfig(db, engine);
      if (!cfg.url) {
        res.json({ ok: false, source: cfg.source, detail: 'no URL configured' });
        return;
      }
      if (engine === 'glm-ocr') {
        const result = await probeGlmOcrHealth({
          baseUrl: cfg.url,
          ...(cfg.healthPath ? { healthPath: cfg.healthPath } : {}),
          ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
        });
        res.json({ ok: result.ok, source: cfg.source, detail: result.detail ?? null });
        return;
      }
      // llm-gateway: hit /health directly with a 1.5s timeout.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const start = Date.now();
      try {
        const probe = await fetch(`${cfg.url.replace(/\/$/, '')}/health`, {
          signal: controller.signal,
        });
        res.json({
          ok: probe.ok,
          source: cfg.source,
          latencyMs: Date.now() - start,
          detail: probe.ok ? null : `HTTP ${probe.status}`,
        });
      } catch (err) {
        res.json({
          ok: false,
          source: cfg.source,
          detail: (err as Error).message,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      next(err);
    }
  });

  // Aggregate diagnostics — used by the /admin/diagnostics page.
  router.get('/diagnostics', async (_req, res, next) => {
    try {
      const counts = await Promise.all([
        db.execute(sql`select count(*)::int as c from vibetc.users`),
        db.execute(sql`select count(*)::int as c from vibetc.companies`),
        db.execute(sql`select count(*)::int as c from vibetc.accounts`),
        db.execute(sql`select count(*)::int as c from vibetc.statements`),
        db.execute(sql`select count(*)::int as c from vibetc.transactions`),
        db.execute(sql`select count(*)::int as c from vibetc.fidir_entries`),
        db.execute(sql`select count(*)::int as c from vibetc.audit_log`),
      ]);
      const [users, companies, accounts, statements, transactions, fidirEntries, auditLog] =
        counts.map((r) => Number((r.rows[0] as { c: number }).c));
      const memory = process.memoryUsage();
      res.json({
        env: {
          nodeVersion: process.version,
          platform: process.platform,
          buildSha: process.env.BUILD_SHA ?? 'unknown',
          appliance: process.env.APPLIANCE_MODE === 'true',
          // BuildPlan §29.21 — surface the appliance manifest version the
          // installer injected so operators can verify the running app
          // matches what the orchestrator expected.
          applianceVersion: process.env.APPLIANCE_VERSION ?? null,
          workerInline: process.env.WORKER_INLINE !== 'false',
        },
        rss: { rssMb: Math.round(memory.rss / (1024 * 1024)) },
        services: {
          databaseUrl: process.env.DATABASE_URL ? 'configured' : 'unconfigured',
          redisUrl: process.env.REDIS_URL ? 'configured' : 'unconfigured',
          glmOcrUrl: process.env.GLM_OCR_URL ? 'configured' : 'unconfigured',
          llmGatewayUrl: process.env.LLM_GATEWAY_URL ? 'configured' : 'unconfigured',
          anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
        },
        counts: {
          users,
          companies,
          accounts,
          statements,
          transactions,
          fidirEntries,
          auditLog,
        },
        uptime: { seconds: Math.round(process.uptime()) },
      });
    } catch (err) {
      next(err);
    }
  });

  // Firm-wide default PDF processing strategy. Per-upload overrides
  // are written directly to the statements row at ingest time.
  router.get('/pdf-strategy', async (_req, res, next) => {
    try {
      const strategy = await getFirmDefaultPdfStrategy(db);
      res.json({ strategy });
    } catch (err) {
      next(err);
    }
  });

  router.post('/pdf-strategy', async (req, res, next) => {
    try {
      const v = req.body?.strategy;
      if (!isPdfProcessingStrategy(v)) {
        throw new ValidationError(
          'strategy must be one of: auto, force-text, force-ocr, auto-ocr-fallback, auto-text-fallback',
        );
      }
      await setFirmDefaultPdfStrategy(db, v, req.user!.id);
      res.json({ strategy: v });
    } catch (err) {
      next(err);
    }
  });

  // PDF retention configuration. `days` is a positive integer or null
  // (null disables the sweep). lastSweepAt is updated by both the daily
  // BullMQ cron and the manual "Run now" trigger below.
  router.get('/pdf-retention', async (_req, res, next) => {
    try {
      const [days, lastSweepAt] = await Promise.all([getRetentionDays(db), getLastSweepAt(db)]);
      res.json({ days, lastSweepAt });
    } catch (err) {
      next(err);
    }
  });

  router.post('/pdf-retention', async (req, res, next) => {
    try {
      const raw = req.body?.days;
      let days: number | null;
      if (raw === null || raw === undefined || raw === '') {
        days = null;
      } else {
        const n = Number.parseInt(String(raw), 10);
        if (!Number.isFinite(n) || n < 1) {
          throw new ValidationError('days must be a positive integer, or null to disable');
        }
        days = n;
      }
      await setRetentionDays(db, days, req.user!.id);
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'system_settings',
        entityId: 'pdf.retention.days',
        action: 'pdf-retention.set',
        payload: { days },
      });
      res.json({ days });
    } catch (err) {
      next(err);
    }
  });

  // Manual sweep trigger — runs synchronously and returns the result.
  // The daily cron also calls runRetentionSweep with actor=null; this
  // endpoint stamps the calling admin so the audit row attributes the
  // run correctly.
  router.post('/pdf-retention/sweep', async (req, res, next) => {
    try {
      const result = await runRetentionSweep(db, req.user!.id);
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'system_settings',
        entityId: 'pdf.retention.days',
        action: 'pdf-retention.sweep',
        payload: result as unknown as Record<string, unknown>,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get('/enrichment', async (_req, res, next) => {
    try {
      const status = await enrichmentToggleStatus(db);
      res.json(status);
    } catch (err) {
      next(err);
    }
  });

  router.post('/enrichment', async (req, res, next) => {
    try {
      const which = req.body?.which;
      const enabled = req.body?.enabled;
      if (which !== 'cleanse' && which !== 'category') {
        throw new ValidationError("which must be 'cleanse' or 'category'");
      }
      if (typeof enabled !== 'boolean') {
        throw new ValidationError('enabled must be a boolean');
      }
      await setEnrichmentToggle(db, which, enabled, req.user!.id);
      const status = await enrichmentToggleStatus(db);
      res.json(status);
    } catch (err) {
      next(err);
    }
  });

  // Operator-tunable enrichment system prompt. GET returns the live
  // configuration alongside the built-in defaults so the SPA can show
  // "current" vs. "default" without duplicating the strings. PUT
  // accepts a partial update — fields left undefined are unchanged;
  // empty-string or null clears that override and reverts to default.
  router.get('/enrichment-prompt', async (_req, res, next) => {
    try {
      res.json(await enrichmentPromptStatus(db));
    } catch (err) {
      next(err);
    }
  });

  router.put('/enrichment-prompt', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as {
        mode?: unknown;
        cleanseRules?: unknown;
        categorizeRules?: unknown;
        fullSystemPrompt?: unknown;
      };

      const validateText = (v: unknown, label: string): string | null | undefined => {
        if (v === undefined) return undefined;
        if (v === null) return null;
        if (typeof v !== 'string') {
          throw new ValidationError(`${label} must be a string, null, or omitted`);
        }
        return v;
      };

      let mode: EnrichmentPromptMode | undefined;
      if (body.mode !== undefined) {
        if (body.mode !== 'rules' && body.mode !== 'full') {
          throw new ValidationError("mode must be 'rules' or 'full'");
        }
        mode = body.mode;
      }

      const status = await setEnrichmentPrompt(
        db,
        {
          ...(mode !== undefined ? { mode } : {}),
          ...(body.cleanseRules !== undefined
            ? { cleanseRules: validateText(body.cleanseRules, 'cleanseRules') }
            : {}),
          ...(body.categorizeRules !== undefined
            ? { categorizeRules: validateText(body.categorizeRules, 'categorizeRules') }
            : {}),
          ...(body.fullSystemPrompt !== undefined
            ? { fullSystemPrompt: validateText(body.fullSystemPrompt, 'fullSystemPrompt') }
            : {}),
        },
        req.user!.id,
      );
      res.json(status);
    } catch (err) {
      next(err);
    }
  });

  // ----- Phase 33: business-categories CRUD -----

  router.get('/categories', async (req, res, next) => {
    try {
      const includeArchived = req.query.includeArchived === 'true';
      const rows = await db
        .select()
        .from(businessCategories)
        .orderBy(businessCategories.sortOrder, businessCategories.name);
      res.json(includeArchived ? rows : rows.filter((r) => !r.archived));
    } catch (err) {
      next(err);
    }
  });

  router.post('/categories', async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const name = String(body.name ?? '').trim();
      if (name.length === 0) throw new ValidationError('name is required');
      if (name.length > 80) throw new ValidationError('name must be at most 80 characters');
      const description =
        typeof body.description === 'string' && body.description.trim().length > 0
          ? body.description.trim().slice(0, 500)
          : null;
      const sortOrder =
        Number.isFinite(body.sort_order) && body.sort_order >= 0
          ? Math.floor(body.sort_order)
          : 100;
      // Case-insensitive duplicate check before INSERT to give a clean
      // 409 instead of letting the unique-index constraint surface as
      // a 500.
      const existing = await db
        .select()
        .from(businessCategories)
        .where(sql`lower(${businessCategories.name}) = lower(${name})`);
      if (existing.length > 0) {
        throw new ConflictError(`category already exists: ${existing[0]!.name}`);
      }
      const [created] = await db
        .insert(businessCategories)
        .values({ name, description, sortOrder })
        .returning();
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'business_category',
        entityId: created!.id,
        action: 'business_category.create',
        payload: { name, description, sortOrder },
      });
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  router.patch('/categories/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const rows = await db.select().from(businessCategories).where(eq(businessCategories.id, id));
      const cat = rows[0];
      if (!cat) throw new NotFoundError(`category ${id}`);
      const body = req.body ?? {};
      const next: Record<string, unknown> = { updatedAt: sql`now()` };
      if (typeof body.name === 'string') {
        const name = body.name.trim();
        if (name.length === 0) throw new ValidationError('name must be non-empty');
        if (name.length > 80) throw new ValidationError('name must be at most 80 characters');
        if (name.toLowerCase() !== cat.name.toLowerCase()) {
          const dup = await db
            .select()
            .from(businessCategories)
            .where(sql`lower(${businessCategories.name}) = lower(${name})`);
          if (dup.length > 0 && dup[0]!.id !== id) {
            throw new ConflictError(`category already exists: ${dup[0]!.name}`);
          }
        }
        if (name !== cat.name) next.name = name;
      }
      if ('description' in body) {
        const raw = body.description;
        if (raw === null || (typeof raw === 'string' && raw.trim().length === 0)) {
          if (cat.description !== null) next.description = null;
        } else if (typeof raw === 'string') {
          const desc = raw.trim().slice(0, 500);
          if (desc !== cat.description) next.description = desc;
        }
      }
      if (Number.isFinite(body.sort_order) && body.sort_order >= 0) {
        const so = Math.floor(body.sort_order);
        if (so !== cat.sortOrder) next.sortOrder = so;
      }
      if (typeof body.archived === 'boolean' && body.archived !== cat.archived) {
        next.archived = body.archived;
      }
      // updatedAt only → caller asked for an idempotent change.
      if (Object.keys(next).length === 1) {
        res.json(cat);
        return;
      }
      const [updated] = await db
        .update(businessCategories)
        .set(next)
        .where(eq(businessCategories.id, id))
        .returning();
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'business_category',
        entityId: id,
        action: 'business_category.update',
        payload: next,
      });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/categories/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const rows = await db.select().from(businessCategories).where(eq(businessCategories.id, id));
      const cat = rows[0];
      if (!cat) throw new NotFoundError(`category ${id}`);
      // Soft-delete: archive instead of hard-delete so transactions
      // already assigned to this category keep their FK valid.
      await db
        .update(businessCategories)
        .set({ archived: true, updatedAt: sql`now()` })
        .where(eq(businessCategories.id, id));
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'business_category',
        entityId: id,
        action: 'business_category.archive',
        payload: { name: cat.name },
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
};
