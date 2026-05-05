import { Router } from 'express';
import { eq, lt, sql } from 'drizzle-orm';
import { rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { db } from '../db/client.js';
import { sessions, systemSettings } from '../db/schema.js';
import { ValidationError } from '../lib/errors.js';
import { wrapSecret } from '../lib/secrets.js';
import { requireAdmin } from '../middleware/auth.js';
import { writeAudit } from '../services/audit.js';
import { getFidirStatus, seedFidir } from '../services/fidir-seeder.js';
import { extractionQueue } from '../jobs/queues.js';
import { logger } from '../lib/logger.js';

const PROVIDER_KEY = 'llm.provider';
const ANTHROPIC_KEY = 'llm.anthropic.api_key';
const ANTHROPIC_MODEL = 'llm.anthropic.model';

export const adminRouter = (): Router => {
  const router = Router();
  router.use(requireAdmin);

  router.get('/llm-provider', async (_req, res, next) => {
    try {
      const provRows = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, PROVIDER_KEY));
      const modelRows = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, ANTHROPIC_MODEL));
      const keyRows = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, ANTHROPIC_KEY));
      res.json({
        provider: provRows[0]?.valuePlaintext ?? 'local',
        anthropicModel: modelRows[0]?.valuePlaintext ?? null,
        anthropicKeyConfigured:
          keyRows[0]?.valueEncrypted !== null && keyRows[0]?.valueEncrypted !== undefined,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/llm-provider', async (req, res, next) => {
    try {
      const provider = req.body?.provider;
      if (provider !== 'local' && provider !== 'anthropic') {
        throw new ValidationError('provider must be "local" or "anthropic"');
      }
      await db
        .insert(systemSettings)
        .values({ key: PROVIDER_KEY, valuePlaintext: provider, isSecret: false })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { valuePlaintext: provider, updatedAt: sql`now()`, updatedByUserId: req.user!.id },
        });
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'system_settings',
        entityId: PROVIDER_KEY,
        action: 'llm-provider.change',
        payload: { provider },
      });
      res.json({ ok: true, provider });
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
      if (model.length === 0) throw new ValidationError('model is required');
      await db
        .insert(systemSettings)
        .values({ key: ANTHROPIC_MODEL, valuePlaintext: model, isSecret: false })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { valuePlaintext: model, updatedAt: sql`now()`, updatedByUserId: req.user!.id },
        });
      res.json({ ok: true, model });
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

  return router;
};
