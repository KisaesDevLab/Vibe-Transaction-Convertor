// Vibe Shield gateway client for the session lifecycle that wraps a
// conversion: open a session at upload (so OCR + extraction tokens share
// one vault), materialize tokens back to cleartext at export, and delete
// the session when the statement is removed / retention expires.
//
// The OCR + extraction *content* calls go through the extractor package
// (shield-ocr-client / AnthropicProvider pointed at the gateway). This
// service covers only the session-management endpoints.

import type { Db } from '../db/client.js';
import { getEngineConfig } from './engines.js';

export interface ShieldConn {
  baseUrl: string;
  apiKey: string;
}

export class ShieldError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ShieldError';
    this.status = status;
  }
}

// Resolve the gateway URL + tenant key from the DB-backed engine config
// (operator-set via /admin/engines), falling back to env. Throws when
// unconfigured so callers fail closed rather than silently skipping
// redaction.
export const resolveShieldConn = async (db: Db): Promise<ShieldConn> => {
  const cfg = await getEngineConfig(db, 'vibe-shield');
  const baseUrl = (cfg.url ?? process.env.VIBE_SHIELD_URL ?? '').replace(/\/$/, '');
  const apiKey = cfg.apiKey ?? process.env.VIBE_SHIELD_API_KEY ?? '';
  if (!baseUrl) throw new ShieldError('Vibe Shield URL is not configured');
  if (!apiKey) throw new ShieldError('Vibe Shield API key is not configured');
  return { baseUrl, apiKey };
};

// Shield caps session TTL at 24h (1440 min); the create schema rejects
// anything larger. Use the max so an export within a day of upload can
// still materialize. Exports after the TTL must re-OCR (see the QA notes
// in ADR-022 — this is a hard Shield-side constraint, not a default we
// can raise).
const MAX_TTL_MINUTES = 1440;

const fetchJson = async (
  conn: ShieldConn,
  path: string,
  init: { method: string; body?: unknown },
  timeoutMs = 15_000,
): Promise<unknown> => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${conn.baseUrl}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${conn.apiKey}`,
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: ctl.signal,
    });
    if (res.status === 204) return undefined;
    const text = await res.text();
    const json = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) {
      const msg =
        json &&
        typeof json === 'object' &&
        'error' in json &&
        json.error &&
        typeof json.error === 'object' &&
        'message' in (json.error as Record<string, unknown>)
          ? String((json.error as Record<string, unknown>).message)
          : `Shield ${init.method} ${path} → HTTP ${res.status}`;
      throw new ShieldError(msg, res.status);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
};

// Open a per-conversion session. NOTE: the policy is NOT chosen here — it
// is bound to the Shield API key's appId (must be `converter`, which maps
// to the cpa-converter-output policy). The create body only carries
// user_id + ttl_minutes; sending a `policy` field is silently ignored by
// the gateway. The policy is (re)applied per-request via policy_name on
// /v1/messages and per-key appId on materialize.
export const createSession = async (
  conn: ShieldConn,
  opts: { userId?: string; ttlMinutes?: number } = {},
): Promise<string> => {
  const body = await fetchJson(conn, '/v1/sessions', {
    method: 'POST',
    body: {
      user_id: opts.userId && opts.userId.length > 0 ? opts.userId : 'converter',
      ttl_minutes: Math.min(opts.ttlMinutes ?? MAX_TTL_MINUTES, MAX_TTL_MINUTES),
    },
  });
  const id = body && typeof body === 'object' ? (body as Record<string, unknown>).id : undefined;
  if (typeof id !== 'string' || id.length === 0) {
    throw new ShieldError('Shield session create returned no id');
  }
  return id;
};

// Resolve every <ENTITY_N> token in `payload` back to cleartext via the
// session vault. Gated server-side to cpa-converter-output. Returns the
// materialized JSON plus an output hash (the auditable record). Caller
// MUST hold the result in memory only — never log it.
export const materialize = async (
  conn: ShieldConn,
  sessionId: string,
  payload: unknown,
  outputFilename?: string,
): Promise<{ materialized: unknown; outputHash: string | null }> => {
  const body = await fetchJson(conn, `/v1/sessions/${sessionId}/materialize`, {
    method: 'POST',
    body: { payload, ...(outputFilename ? { output_filename: outputFilename } : {}) },
  });
  const obj = (body ?? {}) as Record<string, unknown>;
  return {
    materialized: obj.materialized ?? {},
    // Shield returns `output_sha256` (NOT `output_hash`).
    outputHash: typeof obj.output_sha256 === 'string' ? obj.output_sha256 : null,
  };
};

// Deletes a session's vault. NOTE: Shield is NOT idempotent here — a
// second DELETE (or a never-existed id) returns 404. We treat 404 as
// success since "already gone" is the desired end state for a retention
// sweep. After deletion the session's tokens are permanently unresolvable.
export const deleteSession = async (conn: ShieldConn, sessionId: string): Promise<void> => {
  try {
    await fetchJson(conn, `/v1/sessions/${sessionId}`, { method: 'DELETE' });
  } catch (err) {
    if (err instanceof ShieldError && err.status === 404) return;
    throw err;
  }
};
