// Live smoke test for the OCR-via-Vibe-Shield path. Run after deploying
// so an operator can confirm the end-to-end prerequisites in one command:
//
//   pnpm --filter @vibe-tx-converter/api run shield:smoke      (or: just shield-smoke)
//
// It resolves the SAME Shield connection the app uses (the operator-set
// engine config in /admin/engines, falling back to VIBE_SHIELD_* env),
// then runs cheap live probes that each pinpoint one prerequisite:
//
//   1. gateway /health        — reachable
//   2. session create (30d)   — key valid AND appId='converter' (only the
//                               converter policy raises the TTL ceiling to
//                               30 days; a wrong appId caps at 24h → 400)
//   3. materialize gate       — active policy is cpa-converter-output
//                               (the only policy that permits materialize)
//   4. /v1/messages probe     — ZDR enabled + policy + Anthropic reachable
//                               (cpa-converter-output sets zdr_required;
//                               the gateway rejects the call if ZDR is off).
//                               Skip with --no-llm (leaves ZDR unverified).
//
// Exits 0 only when every required check passes; non-zero otherwise, with
// a remediation line per failure. The token-overlay image masker itself is
// verified against the Shield source (ADR-022) — this probe confirms the
// deployment-config prerequisites that source review can't.

/* eslint-disable no-console */

import { db, closeDb } from '../db/client.js';
import {
  createSession,
  deleteSession,
  materialize,
  resolveShieldConn,
  ShieldError,
  type ShieldConn,
} from '../services/shield.js';

const CONVERTER_POLICY = 'cpa-converter-output';
const skipLlm = process.argv.includes('--no-llm');

interface Step {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

const resolveConn = async (): Promise<ShieldConn> => {
  // In-container: read the operator-set config from the DB (the real key).
  // Standalone (no DB): fall back to VIBE_SHIELD_* env directly.
  if (process.env.DATABASE_URL) return resolveShieldConn(db);
  const baseUrl = (process.env.VIBE_SHIELD_URL ?? '').replace(/\/$/, '');
  const apiKey = process.env.VIBE_SHIELD_API_KEY ?? '';
  if (!baseUrl || !apiKey) {
    throw new Error(
      'no Shield config — set VIBE_SHIELD_URL + VIBE_SHIELD_API_KEY (or DATABASE_URL to read /admin/engines)',
    );
  }
  return { baseUrl, apiKey };
};

const main = async (): Promise<void> => {
  let conn: ShieldConn;
  try {
    conn = await resolveConn();
  } catch (err) {
    console.error(`✗ Vibe Shield not configured: ${(err as Error).message}`);
    process.exit(2);
  }

  const steps: Step[] = [];

  // 1. gateway reachability (health is unauthenticated)
  try {
    const res = await fetch(`${conn.baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
    steps.push({
      name: 'gateway /health',
      ok: res.ok,
      detail: res.ok ? `200 · ${conn.baseUrl}` : `HTTP ${res.status}`,
      ...(res.ok ? {} : { fix: 'Is the Shield gateway running and VIBE_SHIELD_URL correct?' }),
    });
  } catch (err) {
    steps.push({
      name: 'gateway /health',
      ok: false,
      detail: (err as Error).message,
      fix: 'Gateway unreachable — check VIBE_SHIELD_URL and network reachability.',
    });
  }

  // 2. session create with the 30-day TTL — proves auth + appId='converter'
  let sessionId: string | null = null;
  try {
    sessionId = await createSession(conn, { userId: 'shield-smoke' });
    steps.push({
      name: 'session create (30-day TTL)',
      ok: true,
      detail: `id=${sessionId.slice(0, 8)}…`,
    });
  } catch (err) {
    const msg = (err as Error).message;
    const ttlCeiling = err instanceof ShieldError && /exceeds the maximum/i.test(msg);
    const unauthorized = err instanceof ShieldError && err.status === 401;
    steps.push({
      name: 'session create (30-day TTL)',
      ok: false,
      detail: msg,
      fix: ttlCeiling
        ? "Key's appId is not 'converter' (its policy caps TTL at 24h). Reissue a vs_live_ key with appId=converter."
        : unauthorized
          ? 'Invalid/missing Shield API key — set it in /admin/engines or VIBE_SHIELD_API_KEY.'
          : 'Check the Shield key and gateway.',
    });
  }

  // 3. materialize gate — cheap (no Claude call); proves cpa-converter-output
  if (sessionId) {
    try {
      await materialize(conn, sessionId, { probe: '<PERSON_999>' }, 'shield-smoke');
      steps.push({
        name: 'materialize gate (cpa-converter-output)',
        ok: true,
        detail: 'allowed (200)',
      });
    } catch (err) {
      const forbidden = err instanceof ShieldError && err.status === 403;
      steps.push({
        name: 'materialize gate (cpa-converter-output)',
        ok: false,
        detail: (err as Error).message,
        fix: forbidden
          ? "Active policy is not cpa-converter-output — the key's appId must be 'converter'."
          : 'Materialize failed — check the session and policy.',
      });
    }
  }

  // 4. ZDR + policy + Anthropic reachability via a tiny /v1/messages call.
  //    The gateway enforces zdr_required BEFORE calling Anthropic, so a
  //    ZDR-off deployment fails here cheaply (no tokens spent).
  if (sessionId && !skipLlm) {
    try {
      const res = await fetch(`${conn.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${conn.apiKey}` },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 8,
          messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
          session_id: sessionId,
          policy_name: CONVERTER_POLICY,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = await res.text();
      if (res.ok) {
        steps.push({
          name: 'messages probe (ZDR + policy + Anthropic)',
          ok: true,
          detail: 'gateway accepted a cpa-converter-output request',
        });
      } else {
        const zdr = /zdr/i.test(body);
        steps.push({
          name: 'messages probe (ZDR + policy + Anthropic)',
          ok: false,
          detail: `HTTP ${res.status} · ${body.slice(0, 200)}`,
          fix: zdr
            ? 'Set VIBE_SHIELD_ZDR_ENABLED=true on the Shield gateway — cpa-converter-output requires ZDR.'
            : "Check the gateway error (model allowed by policy? Anthropic key set in Shield? appId='converter'?).",
        });
      }
    } catch (err) {
      steps.push({
        name: 'messages probe (ZDR + policy + Anthropic)',
        ok: false,
        detail: (err as Error).message,
        fix: 'Gateway timed out / unreachable on /v1/messages.',
      });
    }
  } else if (sessionId && skipLlm) {
    steps.push({
      name: 'messages probe (ZDR + policy + Anthropic)',
      ok: true,
      detail: 'skipped (--no-llm) — ZDR was NOT verified',
    });
  }

  // cleanup — best-effort
  if (sessionId) {
    await deleteSession(conn, sessionId).catch(() => undefined);
  }

  const failed = steps.filter((s) => !s.ok);
  console.log('\nVibe Shield smoke test');
  console.log('──────────────────────');
  for (const s of steps) {
    console.log(`${s.ok ? '✓' : '✗'} ${s.name}: ${s.detail}`);
    if (!s.ok && s.fix) console.log(`    → ${s.fix}`);
  }
  console.log('──────────────────────');
  console.log(
    failed.length === 0
      ? 'PASS — OCR-via-Shield prerequisites are satisfied.'
      : `FAIL — ${failed.length} check(s) failed; fix the items above.`,
  );

  await closeDb().catch(() => undefined);
  process.exit(failed.length === 0 ? 0 : 1);
};

main().catch(async (err) => {
  console.error(err);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
