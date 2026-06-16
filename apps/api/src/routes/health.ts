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

export const healthRouter = (): Router => {
  const router = Router();

  router.get('/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/ready', async (_req, res) => {
    // Resolve engine URLs through the DB-backed config so an admin
    // editing /admin/engines flips the probe target without a restart.
    const [shieldCfg, llmGwCfg] = await Promise.all([
      getEngineConfig(db, 'vibe-shield').catch(() => null),
      getEngineConfig(db, 'llm-gateway').catch(() => null),
    ]);
    const [postgres, redis, vibeShield, llmGateway] = await Promise.all([
      checkPostgres(),
      checkRedis(),
      checkHttpHealth(
        'vibe-shield',
        shieldCfg?.url ?? process.env.VIBE_SHIELD_URL,
        shieldCfg?.healthPath ?? process.env.VIBE_SHIELD_HEALTH_PATH ?? '/health',
      ),
      checkHttpHealth('llm-gateway', llmGwCfg?.url ?? process.env.LLM_GATEWAY_URL),
    ]);
    const dependencies = { postgres, redis, vibeShield, llmGateway };
    const failing = Object.values(dependencies).some((d) => d.status === 'fail');
    if (failing) {
      logger.warn({ dependencies }, 'readiness check failed');
    }
    res.status(failing ? 503 : 200).json({
      status: failing ? 'degraded' : 'ok',
      dependencies,
    });
  });

  return router;
};
