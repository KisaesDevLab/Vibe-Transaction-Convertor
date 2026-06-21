// Phase 29 #15 — `pnpm tsx apps/api/src/scripts/appliance-self-check.ts`
// prints a JSON summary of appliance integration status and exits
// non-zero if any required dependency is missing or unreachable.
//
// The output shape is stable on purpose: the Vibe appliance installer
// pipes it into its own diagnostics aggregator, and operators paste
// it into bug reports. Don't change field names without bumping
// the schemaVersion.
//
// Run with the same env this app would in production — DATABASE_URL,
// REDIS_URL, OLLAMA_BASE_URL — to get a useful answer.
// Missing/unset shared services come back as {configured: false}; the
// exit code is governed only by the things that MUST work for boot
// to succeed (db + session secret).

/* eslint-disable no-console */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

import { performHandshake } from '../lib/manifest.js';

interface CheckResult {
  ok: boolean;
  detail?: string;
  latencyMs?: number;
}

const SCHEMA_VERSION = 1;

const checkDb = async (): Promise<{ configured: boolean } & Partial<CheckResult>> => {
  const url = process.env.DATABASE_URL;
  if (!url) return { configured: false };
  const t0 = Date.now();
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    const r = await pool.query<{ schema: string | null }>(
      `select schema_name as schema from information_schema.schemata where schema_name = 'vibetc'`,
    );
    const hasSchema = r.rowCount !== null && r.rowCount > 0;
    return {
      configured: true,
      ok: hasSchema,
      latencyMs: Date.now() - t0,
      detail: hasSchema ? 'schema vibetc present' : 'schema vibetc missing — run db:migrate',
    };
  } catch (err) {
    return {
      configured: true,
      ok: false,
      detail: (err as Error).message,
      latencyMs: Date.now() - t0,
    };
  } finally {
    await pool.end().catch(() => undefined);
  }
};

const checkRedis = async (): Promise<{ configured: boolean } & Partial<CheckResult>> => {
  const url = process.env.REDIS_URL;
  if (!url) return { configured: false };
  // Redis lib doesn't ship with a top-level "ping a URL" helper, so
  // poke the host:port from the URL via a TCP connect. Keeps this
  // script free of an ioredis import that would fight tsx's ESM
  // resolution in some workspaces.
  const { createConnection } = await import('node:net');
  const u = new URL(url);
  const host = u.hostname;
  const port = Number.parseInt(u.port || '6379', 10);
  const t0 = Date.now();
  return await new Promise((resolve) => {
    const sock = createConnection({ host, port, timeout: 2000 });
    sock.on('connect', () => {
      sock.end();
      resolve({ configured: true, ok: true, latencyMs: Date.now() - t0 });
    });
    sock.on('error', (err) =>
      resolve({ configured: true, ok: false, detail: err.message, latencyMs: Date.now() - t0 }),
    );
    sock.on('timeout', () => {
      sock.destroy();
      resolve({
        configured: true,
        ok: false,
        detail: 'connect timeout',
        latencyMs: Date.now() - t0,
      });
    });
  });
};

const checkHttpHealth = async (
  url: string | undefined,
  paths: string[],
): Promise<{ configured: boolean } & Partial<CheckResult>> => {
  if (!url) return { configured: false };
  // Try each candidate path until one returns 2xx — different
  // services use different conventions (/health, /version).
  const t0 = Date.now();
  for (const path of paths) {
    try {
      const ctl = new AbortController();
      const id = setTimeout(() => ctl.abort(), 2500);
      const res = await fetch(`${url.replace(/\/$/, '')}${path}`, { signal: ctl.signal });
      clearTimeout(id);
      if (res.ok) {
        return { configured: true, ok: true, latencyMs: Date.now() - t0, detail: `via ${path}` };
      }
    } catch {
      // try next path
    }
  }
  return {
    configured: true,
    ok: false,
    latencyMs: Date.now() - t0,
    detail: `no probe path returned 2xx`,
  };
};

const checkDataDir = async (): Promise<CheckResult> => {
  const dataDir = process.env.DATA_DIR ?? '/var/lib/vibetc';
  try {
    const s = await stat(dataDir);
    if (!s.isDirectory()) return { ok: false, detail: `${dataDir} is not a directory` };
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: `${dataDir}: ${(err as Error).message}` };
  }
};

const checkFidirMirror = async (): Promise<CheckResult> => {
  // The vendored mirror lives in the repo at data/fidir/fidir-us.txt
  // and is bundled into the runtime image. Look in cwd-relative,
  // script-relative (monorepo dev), and the container layout. The
  // appliance never refetches — operators trigger refresh via UI.
  const { fileURLToPath } = await import('node:url');
  const { dirname } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), 'data', 'fidir', 'fidir-us.txt'),
    join(here, '..', '..', '..', '..', 'data', 'fidir', 'fidir-us.txt'),
    join(here, '..', '..', 'data', 'fidir', 'fidir-us.txt'),
    '/app/data/fidir/fidir-us.txt',
  ];
  for (const p of candidates) {
    try {
      const s = await stat(p);
      if (s.isFile()) return { ok: true, detail: `${p} (${s.size} bytes)` };
    } catch {
      // continue
    }
  }
  return { ok: false, detail: 'fidir-us.txt not found in known locations' };
};

const main = async (): Promise<void> => {
  const summary = {
    schemaVersion: SCHEMA_VERSION,
    app: 'vibe-tx-converter',
    runningVersion: '0.0.0', // set below from package.json
    buildSha: process.env.BUILD_SHA ?? 'unknown',
    appliance: {
      mode: process.env.APPLIANCE_MODE === 'true',
      version: process.env.APPLIANCE_VERSION ?? null,
      availableVersion: process.env.VIBE_APPLIANCE_AVAILABLE_VERSION ?? null,
      // BuildPlan §29.12 — manifest-version handshake result.
      handshake: performHandshake(),
    },
    env: {
      sessionSecretSet: Boolean(process.env.SESSION_SECRET),
      sessionSecretLengthOk:
        Boolean(process.env.SESSION_SECRET) && (process.env.SESSION_SECRET ?? '').length >= 32,
      llmProvider: process.env.LLM_PROVIDER ?? 'local',
      llmModelId: process.env.LLM_MODEL_ID ?? null,
      anthropicKeySet: Boolean(process.env.ANTHROPIC_API_KEY),
    },
    deps: {
      database: await checkDb(),
      redis: await checkRedis(),
      ollama: await checkHttpHealth(process.env.OLLAMA_BASE_URL ?? process.env.LLM_GATEWAY_URL, [
        '/api/tags',
      ]),
    },
    storage: {
      dataDir: await checkDataDir(),
      fidirMirror: await checkFidirMirror(),
    },
  };

  // Resolve running version from the api package.json. Missing file is
  // not a blocker — the script still runs.
  try {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join: pj } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = await readFile(pj(here, '..', '..', 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    if (pkg.version) summary.runningVersion = pkg.version;
  } catch {
    // leave default
  }

  // Required-for-boot rollup. SESSION_SECRET + DATABASE_URL are the
  // only hard preconditions runBootChecks enforces, so we mirror that.
  const required = [
    summary.env.sessionSecretSet && summary.env.sessionSecretLengthOk,
    summary.deps.database.configured && (summary.deps.database.ok ?? false),
  ];
  const allRequiredOk = required.every(Boolean);

  console.log(JSON.stringify(summary, null, 2));
  process.exit(allRequiredOk ? 0 : 1);
};

main().catch((err) => {
  console.error(JSON.stringify({ error: (err as Error).message }, null, 2));
  process.exit(2);
});
