import { Router } from 'express';
import pg from 'pg';
import Redis from 'ioredis';

import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { getEngineConfig } from '../services/engines.js';

interface DependencyStatus {
  status: 'ok' | 'fail' | 'unconfigured';
  detail?: string;
  latencyMs?: number;
}

const time = async (fn: () => Promise<void>): Promise<number> => {
  const start = Date.now();
  await fn();
  return Date.now() - start;
};

const checkPostgres = async (): Promise<DependencyStatus> => {
  const url = process.env.DATABASE_URL;
  if (!url) return { status: 'unconfigured' };
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 1500 });
  try {
    const latencyMs = await time(async () => {
      await pool.query('SELECT 1');
    });
    return { status: 'ok', latencyMs };
  } catch (err) {
    return { status: 'fail', detail: (err as Error).message };
  } finally {
    await pool.end().catch(() => undefined);
  }
};

const checkRedis = async (): Promise<DependencyStatus> => {
  const url = process.env.REDIS_URL;
  if (!url) return { status: 'unconfigured' };
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 1500,
  });
  try {
    const latencyMs = await time(async () => {
      await client.connect();
      await client.ping();
    });
    return { status: 'ok', latencyMs };
  } catch (err) {
    return { status: 'fail', detail: (err as Error).message };
  } finally {
    client.disconnect();
  }
};

const checkHttpHealth = async (
  label: string,
  base: string | undefined,
  healthPath: string = '/health',
): Promise<DependencyStatus> => {
  if (!base) return { status: 'unconfigured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  const path = healthPath.startsWith('/') ? healthPath : `/${healthPath}`;
  try {
    const latencyMs = await time(async () => {
      const res = await fetch(`${base.replace(/\/$/, '')}${path}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`${label} ${path} returned ${res.status}`);
    });
    return { status: 'ok', latencyMs };
  } catch (err) {
    return { status: 'fail', detail: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
};

interface Readiness {
  failing: boolean;
  dependencies: Record<'postgres' | 'redis' | 'llmGateway', DependencyStatus>;
}

const probeReadiness = async (): Promise<Readiness> => {
  // Resolve the local LLM gateway (Ollama) URL through the DB-backed config
  // so an admin editing /admin/engines flips the probe target without a
  // restart. Probe Ollama's native /api/tags (it has no /health).
  const llmGwCfg = await getEngineConfig(db, 'llm-gateway').catch(() => null);
  const ollamaBase = llmGwCfg?.url ?? process.env.OLLAMA_BASE_URL ?? process.env.LLM_GATEWAY_URL;
  const [postgres, redis, llmGateway] = await Promise.all([
    checkPostgres(),
    checkRedis(),
    checkHttpHealth(
      'ollama',
      ollamaBase ? ollamaBase.replace(/\/v1\/?$/, '') : undefined,
      '/api/tags',
    ),
  ]);
  const dependencies = { postgres, redis, llmGateway };
  const failing = Object.values(dependencies).some((d) => d.status === 'fail');
  if (failing) {
    logger.warn({ dependencies }, 'readiness check failed');
  }
  return { failing, dependencies };
};

// A probe opens its own Postgres and Redis connections, so concurrent
// callers share the one in flight and a result this fresh is reused.
const READY_REUSE_MS = 2_000;

// The failure text (host:port, the DB user in an auth failure) is for
// signed-in users; anonymous callers get the status and latency only.
const withoutDetail = (d: DependencyStatus): DependencyStatus => ({
  status: d.status,
  ...(d.latencyMs === undefined ? {} : { latencyMs: d.latencyMs }),
});

export const healthRouter = (): Router => {
  const router = Router();

  // Per router, so each createApp() probes its own configuration.
  let inFlight: Promise<Readiness> | null = null;
  let last: { at: number; result: Readiness } | null = null;

  const readiness = (): Promise<Readiness> => {
    if (last && Date.now() - last.at < READY_REUSE_MS) return Promise.resolve(last.result);
    if (!inFlight) {
      inFlight = probeReadiness()
        .then((result) => {
          last = { at: Date.now(), result };
          return result;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };

  router.get('/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/ready', async (req, res, next) => {
    try {
      const { failing, dependencies } = await readiness();
      res.status(failing ? 503 : 200).json({
        status: failing ? 'degraded' : 'ok',
        dependencies: req.user
          ? dependencies
          : {
              postgres: withoutDetail(dependencies.postgres),
              redis: withoutDetail(dependencies.redis),
              llmGateway: withoutDetail(dependencies.llmGateway),
            },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
