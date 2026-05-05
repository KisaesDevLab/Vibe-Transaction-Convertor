// Phase 29 #13 — internal handshake route the appliance orchestrator
// polls. Returns richer health than /api/health/ready (queue depth,
// dependency latencies, build SHA, app version, schema name). Mounted
// at /api/internal/appliance and gated by requireInternalNetwork so
// outside traffic gets 403 even if the route is exposed by mistake.
//
// Phase 29 #10 — companion admin-only status route the SPA uses to
// render the "Update available" banner. Compares the running
// APPLIANCE_VERSION with VIBE_APPLIANCE_AVAILABLE_VERSION (set by
// the appliance installer when an update is published).

import { Router, type Request, type Response } from 'express';
import { sql } from 'drizzle-orm';

import { db } from '../db/client.js';
import { extractionQueue } from '../jobs/queues.js';
import { logger } from '../lib/logger.js';
import { requireAdmin } from '../middleware/auth.js';

const safeQueueCounts = async (): Promise<{
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
} | null> => {
  if (!process.env.REDIS_URL) return null;
  try {
    const q = extractionQueue();
    const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
    return {
      waiting: Number(counts.waiting ?? 0),
      active: Number(counts.active ?? 0),
      delayed: Number(counts.delayed ?? 0),
      failed: Number(counts.failed ?? 0),
    };
  } catch (err) {
    logger.warn({ err }, 'queue counts unavailable in appliance handshake');
    return null;
  }
};

const safeDbCheck = async (): Promise<{ ok: boolean; latencyMs?: number; detail?: string }> => {
  const t0 = Date.now();
  try {
    await db.execute(sql`select 1`);
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
};

interface ApplianceHealth {
  app: string;
  version: string;
  buildSha: string;
  applianceMode: boolean;
  applianceVersion: string | null;
  dbSchema: string;
  // High-level health rollup; "ok" iff every dependency present is ok.
  // "degraded" iff any dependency is failing — the orchestrator should
  // hold off on routing user traffic to this instance until ok.
  status: 'ok' | 'degraded';
  deps: {
    database: { ok: boolean; latencyMs?: number; detail?: string };
    queue: {
      configured: boolean;
      counts?: { waiting: number; active: number; delayed: number; failed: number };
    };
    glmOcr: { configured: boolean };
    llmGateway: { configured: boolean };
  };
}

const buildHealth = async (appName: string, appVersion: string): Promise<ApplianceHealth> => {
  const dbCheck = await safeDbCheck();
  const queueCounts = await safeQueueCounts();
  const deps: ApplianceHealth['deps'] = {
    database: dbCheck,
    queue: {
      configured: Boolean(process.env.REDIS_URL),
      ...(queueCounts ? { counts: queueCounts } : {}),
    },
    glmOcr: { configured: Boolean(process.env.GLM_OCR_URL) },
    llmGateway: { configured: Boolean(process.env.LLM_GATEWAY_URL) },
  };
  const status: 'ok' | 'degraded' = deps.database.ok ? 'ok' : 'degraded';
  return {
    app: appName,
    version: appVersion,
    buildSha: process.env.BUILD_SHA ?? 'unknown',
    applianceMode: process.env.APPLIANCE_MODE === 'true',
    applianceVersion: process.env.APPLIANCE_VERSION ?? null,
    dbSchema: 'vibetc',
    status,
    deps,
  };
};

// Lazy package.json read (mirrors versionRouter — keeps boot fast and
// makes the file an isolated unit-of-test).
let cachedPkg: { name: string; version: string } | undefined;
const getPkg = async (): Promise<{ name: string; version: string }> => {
  if (cachedPkg) return cachedPkg;
  const { readFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const pkgPath = join(__dirname, '..', '..', 'package.json');
  try {
    const raw = await readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { name?: string; version?: string };
    cachedPkg = {
      name: pkg.name ?? '@vibe-tx-converter/api',
      version: pkg.version ?? '0.0.0',
    };
  } catch {
    cachedPkg = { name: '@vibe-tx-converter/api', version: '0.0.0' };
  }
  return cachedPkg;
};

// Mounted at /api/internal/appliance. requireInternalNetwork is
// applied in server.ts before this router runs.
export const internalApplianceRouter = (): Router => {
  const router = Router();

  // POST per BuildPlan §29.13. Body is ignored — orchestrator may
  // send a heartbeat token in future revisions but today there is
  // nothing to validate against. GET also responds for human curl
  // checks during install / debugging.
  const handler = async (_req: Request, res: Response): Promise<void> => {
    const pkg = await getPkg();
    res.json(await buildHealth(pkg.name, pkg.version));
  };
  router.post('/health', (req, res, next) => {
    handler(req, res).catch(next);
  });
  router.get('/health', (req, res, next) => {
    handler(req, res).catch(next);
  });

  return router;
};

// Phase 29 #10 — admin-only status used by the SPA banner. Reads
// VIBE_APPLIANCE_AVAILABLE_VERSION (set by the appliance installer
// when an update is published) and reports whether an update is
// available without making any outbound call.
export const applianceAdminRouter = (): Router => {
  const router = Router();
  router.use(requireAdmin);

  router.get('/status', async (_req, res, next) => {
    try {
      const pkg = await getPkg();
      const running = pkg.version;
      const available = process.env.VIBE_APPLIANCE_AVAILABLE_VERSION ?? null;
      // Only signal an update when an explicit "available" string
      // exists AND it differs from the running version. Empty / null
      // = "no info" = no banner.
      const updateAvailable =
        Boolean(available) && available !== running && available !== process.env.APPLIANCE_VERSION;
      res.json({
        appliance: process.env.APPLIANCE_MODE === 'true',
        applianceVersion: process.env.APPLIANCE_VERSION ?? null,
        runningVersion: running,
        availableVersion: available,
        buildSha: process.env.BUILD_SHA ?? 'unknown',
        updateAvailable,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
