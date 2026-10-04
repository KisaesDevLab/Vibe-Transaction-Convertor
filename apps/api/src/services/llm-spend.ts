// Shared LLM spend ledger + Anthropic monthly-cap check.
//
// The Anthropic monthly cap (system setting 'llm.anthropic.monthly_cap_usd')
// sums statements.llm_cost_micros over statements created this month. Every
// billed LLM pass tied to a statement (extraction, enrichment, check-payee
// text-parse) must ADD its cost to that statement's ledger, or the cap
// under-counts the spend it is meant to bound.

import { eq, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { statements, systemSettings } from '../db/schema.js';

const KEY_ANTHROPIC_MONTHLY_CAP = 'llm.anthropic.monthly_cap_usd';

export interface AnthropicCapStatus {
  blocked: boolean;
  // Operator-facing reason, set when blocked.
  message?: string;
  // Present whenever a numeric cap is configured.
  spentUsd?: number;
  capUsd?: number;
}

// No cap configured (missing / unparseable setting) → never blocked. Otherwise
// blocked once this month's recorded spend reaches the cap. Callers only consult
// this before an Anthropic call — local passes are free and never capped.
export const anthropicCapStatus = async (db: Db): Promise<AnthropicCapStatus> => {
  const capRows = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, KEY_ANTHROPIC_MONTHLY_CAP));
  const capUsd = capRows[0]?.valuePlaintext ? Number.parseFloat(capRows[0].valuePlaintext) : null;
  if (capUsd === null || !Number.isFinite(capUsd)) return { blocked: false };
  const spentRows = await db
    .select({
      total: sql<string>`coalesce(sum(${statements.llmCostMicros}), 0)`,
    })
    .from(statements)
    .where(sql`date_trunc('month', ${statements.createdAt}) = date_trunc('month', now())`);
  const spentUsd = Number(BigInt(spentRows[0]?.total ?? '0')) / 1_000_000;
  if (spentUsd >= capUsd) {
    return {
      blocked: true,
      message: `monthly Anthropic spend cap reached: $${spentUsd.toFixed(2)} >= $${capUsd.toFixed(2)}`,
      spentUsd,
      capUsd,
    };
  }
  return { blocked: false, spentUsd, capUsd };
};

// Either the pool-backed Db or the handle a db.transaction() callback receives —
// both expose the same update builder.
export type DbOrTx = Pick<Db, 'update'>;

// Adds `micros` to the statement's LLM cost ledger (never overwrites). No-op for
// 0n (local passes). A statement deleted mid-run simply updates 0 rows.
export const addStatementLlmCost = async (
  dbOrTx: DbOrTx,
  statementId: string,
  micros: bigint,
): Promise<void> => {
  if (micros === 0n) return;
  await dbOrTx
    .update(statements)
    .set({
      llmCostMicros: sql`coalesce(${statements.llmCostMicros}, 0) + ${micros.toString()}::bigint`,
    })
    .where(eq(statements.id, statementId));
};
