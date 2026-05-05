import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';

import { db } from '../db/client.js';
import { systemSettings } from '../db/schema.js';
import { ValidationError } from '../lib/errors.js';
import { wrapSecret } from '../lib/secrets.js';
import { requireAdmin } from '../middleware/auth.js';
import { writeAudit } from '../services/audit.js';
import { getFidirStatus, seedFidir } from '../services/fidir-seeder.js';

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

  return router;
};
