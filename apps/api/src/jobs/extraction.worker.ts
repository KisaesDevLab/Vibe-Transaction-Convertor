import { Worker } from 'bullmq';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';

import {
  ExtractionResponseError,
  analyzePdfFromBuffer,
  detectMultiAccount,
  extractTextLayerFromBuffer,
  ocrPdfPages,
  rasterizePdf,
  repairPromptFor,
  routePdf,
  type ExtractionMethod,
  type OcrResponse,
} from '@vibe-tx-converter/extractor';
import { findSuspectRows, reconcileGoldenRule, repairPass } from '@vibe-tx-converter/reconciler';
import {
  assignSeqInDay,
  computeFitid,
  inferTrntype,
  normalizeDescription,
} from '@vibe-tx-converter/exporters';
import { schemas } from '@vibe-tx-converter/shared';

import { db } from '../db/client.js';
import { accounts, statements, systemSettings, transactions } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { getEngineConfig } from '../services/engines.js';
import {
  buildProviderForId,
  providerOrderFor,
  resolveProviderPolicy,
  type ProviderId,
} from '../services/llm-provider.js';
import { redisOcrCache } from '../services/ocr-cache.js';
import { resolvePdfStrategy } from '../services/pdf-strategy.js';
import { writeAudit } from '../services/audit.js';
import { materialize, resolveShieldConn } from '../services/shield.js';

import { QUEUE_EXTRACTION, getJobConnection, type ExtractionJobData } from './queues.js';

type StatementStatus = NonNullable<typeof statements.$inferInsert.status>;

// ADR-022 #4 — FITID/seq stability across re-uploads. Under the
// cpa-converter-output policy, persisted descriptions are session-scoped
// Shield tokens (<ENTITY_N>), which renumber on every re-OCR (a new
// Shield session) and would change the derived FITID — breaking the
// idempotent re-import QuickBooks/Quicken rely on. We derive FITID + seq
// from the MATERIALIZED cleartext so they stay stable across re-uploads;
// only the tokenized form is persisted at rest, and the FITID itself is a
// non-PII hash (date | amount | normalized_desc | seq).
const SHIELD_TOKEN_RE = /<[A-Z][A-Z0-9_]*_\d+>/;

const materializeDescriptionsForFitid = async (
  shieldSessionId: string | null,
  descriptions: string[],
): Promise<string[]> => {
  if (!shieldSessionId) return descriptions;
  if (!descriptions.some((d) => SHIELD_TOKEN_RE.test(d))) return descriptions;
  try {
    const conn = await resolveShieldConn(db);
    const { materialized } = await materialize(
      conn,
      shieldSessionId,
      { descriptions },
      'fitid-derivation',
    );
    const arr = (materialized as { descriptions?: unknown }).descriptions;
    if (Array.isArray(arr) && arr.length === descriptions.length) {
      return descriptions.map((d, i) => (typeof arr[i] === 'string' ? (arr[i] as string) : d));
    }
  } catch (err) {
    // Best-effort: if Shield is unreachable at extraction time, fall back
    // to the tokenized form. FITIDs stay unique within the statement; only
    // cross-re-upload stability degrades, and this warning flags it.
    logger.warn(
      { err: (err as Error).message },
      'fitid materialize failed; FITIDs derived from tokens (re-upload stability degraded)',
    );
  }
  return descriptions;
};

const setStatus = async (
  statementId: string,
  status: StatementStatus,
  patch: Record<string, unknown> = {},
): Promise<void> => {
  await db
    .update(statements)
    .set({ status, updatedAt: sql`now()`, ...patch })
    .where(eq(statements.id, statementId));
};

class CancelledError extends Error {
  constructor() {
    super('extraction cancelled by operator');
    this.name = 'CancelledError';
  }
}

// Cooperative cancellation. Any of the following is treated as
// "the operator pulled the plug, stop touching this statement":
//   1. /cancel set status='failed' with errorMessage 'cancelled by
//      operator' (Phase 15 #17).
//   2. /statements/:id DELETE removed the row entirely while we were
//      mid-extraction — the row lookup returns empty and a downstream
//      transactions INSERT would FK-violate.
//   3. /split superseded this row with N child statements (parent's
//      `pageRange` stays null but status flips to `failed` with a
//      different errorMessage). Same intent — don't keep extracting
//      a row whose transactions are about to be replaced by children.
// In short: a `failed` row never has more work to do. We bail at the
// next phase boundary so the worker doesn't charge through a doomed
// extraction.
const checkCancelled = async (statementId: string): Promise<void> => {
  const rows = await db
    .select({ status: statements.status })
    .from(statements)
    .where(eq(statements.id, statementId));
  const row = rows[0];
  if (!row) {
    throw new CancelledError();
  }
  if (row.status === 'failed') {
    throw new CancelledError();
  }
};

// In-memory result of a single provider's extraction attempt: the LLM
// call plus any same-provider repair passes. The orchestrator inspects
// `rejection` to decide whether to fall back to the secondary provider.
interface ProcessedTx {
  postedDate: string;
  description: string;
  amountCents: bigint;
  runningBalanceCents: bigint | null;
  checkNumber: string | null;
  trntypeHint: schemas.extraction.Trntype | undefined;
  sourcePage: number;
  confidence: number;
  sourceLine: number;
}

type AttemptRejection = 'http' | 'malformed' | 'empty-txs' | 'discrepancy' | null;

interface AttemptOutcome {
  providerId: ProviderId;
  rejection: AttemptRejection;
  // Raw error from a thrown attempt; non-null only for 'http' or
  // 'malformed' rejections. The orchestrator re-throws it when no
  // fallback rescues the call.
  error: Error | null;
  // Pre-repair LLM result count (kept for the audit payload).
  llmEmittedTxCount: number;
  effectiveTxs: ProcessedTx[];
  reconciled: ReturnType<typeof reconcileGoldenRule> | null;
  repairApplied: string | null;
  // Telemetry roll-up across the extraction call + any in-attempt repair calls.
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCallCount: number;
  totalCostMicros: bigint;
  modelVersion: string | null;
  // Schema-typed source-date metadata. Pulled out so the orchestrator
  // can halt on AMBIGUOUS without inspecting `effectiveTxs`.
  dateFormat: schemas.extraction.ExtractionResult['source_date_format']['format'] | null;
  dateFormatConfidence: number;
  periodStart: string | null;
  periodEnd: string | null;
  openingBalanceCents: bigint | null;
  closingBalanceCents: bigint | null;
}

interface AttemptContext {
  stmtId: string;
  markdown: string;
  dateFormatOverride?: 'MDY' | 'DMY' | 'YMD';
  // The statement's Vibe Shield session, quoted on the extraction call so
  // its PII tokens share the vault used by the OCR step. null when Shield
  // is unconfigured (legacy / local-only).
  sessionId?: string | undefined;
}

const checkAnthropicMonthlyCap = async (stmtId: string): Promise<string | null> => {
  const capRows = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, 'llm.anthropic.monthly_cap_usd'));
  const capUsd = capRows[0]?.valuePlaintext ? Number.parseFloat(capRows[0].valuePlaintext) : null;
  if (capUsd === null || !Number.isFinite(capUsd)) return null;
  const spentRows = await db
    .select({ total: sql<string>`coalesce(sum(${statements.llmCostMicros}), 0)` })
    .from(statements)
    .where(sql`date_trunc('month', ${statements.createdAt}) = date_trunc('month', now())`);
  const spentUsd = Number(BigInt(spentRows[0]?.total ?? '0')) / 1_000_000;
  if (spentUsd >= capUsd) {
    const msg = `monthly Anthropic spend cap reached: $${spentUsd.toFixed(2)} ≥ $${capUsd.toFixed(2)}`;
    logger.warn({ stmtId, spentUsd, capUsd }, 'extraction blocked by monthly cap');
    return msg;
  }
  return null;
};

const mapLlmTxs = (txs: schemas.extraction.ExtractionResult['transactions']): ProcessedTx[] =>
  txs.map((t, idx) => ({
    postedDate: t.posted_date,
    description: t.description,
    amountCents: BigInt(t.amount_cents),
    runningBalanceCents:
      t.running_balance_cents !== undefined && t.running_balance_cents !== null
        ? BigInt(t.running_balance_cents)
        : null,
    checkNumber: t.check_number ?? null,
    trntypeHint: t.trntype,
    sourcePage: t.source_page,
    confidence: t.confidence ?? 1,
    sourceLine: idx,
  }));

// Run extraction + reconciliation + repair using a single provider. The
// LLM call (and any same-provider repair calls) accumulate into the
// telemetry roll-up. Errors are caught and converted into a rejection
// reason so the orchestrator can decide whether to fall back; nothing
// is persisted to the DB here.
const attemptExtraction = async (
  providerId: ProviderId,
  ctx: AttemptContext,
): Promise<AttemptOutcome> => {
  const empty: Omit<AttemptOutcome, 'providerId' | 'rejection' | 'error'> = {
    llmEmittedTxCount: 0,
    effectiveTxs: [],
    reconciled: null,
    repairApplied: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCallCount: 0,
    totalCostMicros: 0n,
    modelVersion: null,
    dateFormat: null,
    dateFormatConfidence: 0,
    periodStart: null,
    periodEnd: null,
    openingBalanceCents: null,
    closingBalanceCents: null,
  };

  let provider;
  try {
    provider = await buildProviderForId(db, providerId);
  } catch (err) {
    return { providerId, rejection: 'http', error: err as Error, ...empty };
  }

  if (provider.id === 'anthropic') {
    const blocked = await checkAnthropicMonthlyCap(ctx.stmtId);
    if (blocked !== null) {
      return { providerId, rejection: 'http', error: new Error(blocked), ...empty };
    }
  }

  let result: Awaited<ReturnType<typeof provider.extract>>;
  try {
    result = await provider.extract(ctx.markdown, {
      schema: schemas.extraction.ExtractionJsonSchema,
      ...(ctx.dateFormatOverride ? { dateFormatOverride: ctx.dateFormatOverride } : {}),
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    });
  } catch (err) {
    const rejection: AttemptRejection =
      err instanceof ExtractionResponseError ? 'malformed' : 'http';
    return { providerId, rejection, error: err as Error, ...empty };
  }

  const dateFormat = result.data.source_date_format.format;
  const dateFormatConfidence = result.data.source_date_format.confidence;
  const periodStart = result.data.period.start;
  const periodEnd = result.data.period.end;
  const openingCentsNumber = result.data.balances.opening_cents;
  const closingCentsNumber = result.data.balances.closing_cents;
  const openingCents = BigInt(openingCentsNumber);
  const closingCents = BigInt(closingCentsNumber);
  const llmEmittedTxCount = result.data.transactions.length;

  // Carry telemetry from the first call so AMBIGUOUS halts and empty
  // returns still record what the LLM spent.
  let totalInputTokens = result.telemetry.inputTokens ?? 0;
  let totalOutputTokens = result.telemetry.outputTokens ?? 0;
  let totalCallCount = 1;
  let totalCostMicros = result.telemetry.costMicros;

  const halfResult = {
    providerId,
    error: null,
    llmEmittedTxCount,
    totalInputTokens,
    totalOutputTokens,
    totalCallCount,
    totalCostMicros,
    modelVersion: result.telemetry.model,
    dateFormat,
    dateFormatConfidence,
    periodStart,
    periodEnd,
    openingBalanceCents: openingCents,
    closingBalanceCents: closingCents,
    repairApplied: null,
  } as const;

  // AMBIGUOUS halts the worker regardless of fallback — secondary would
  // see the same ambiguous PDF. Return with rejection=null so
  // orchestrator's halt path uses this attempt's telemetry/period.
  if (dateFormat === 'AMBIGUOUS' && !ctx.dateFormatOverride) {
    return {
      ...halfResult,
      rejection: null,
      effectiveTxs: [],
      reconciled: null,
    };
  }

  if (llmEmittedTxCount === 0) {
    return {
      ...halfResult,
      rejection: 'empty-txs',
      effectiveTxs: [],
      reconciled: null,
    };
  }

  let effectiveTxs = mapLlmTxs(result.data.transactions);

  let reconciled = reconcileGoldenRule({
    openingBalanceCents: openingCents,
    closingBalanceCents: closingCents,
    transactions: effectiveTxs.map((t) => ({
      amountCents: t.amountCents,
      runningBalanceCents: t.runningBalanceCents,
    })),
    periodStart,
    periodEnd,
    transactionDates: effectiveTxs.map((t) => t.postedDate),
  });

  let repairApplied: string | null = null;

  // Same-provider LLM repair pass (ADR-010, Phase 16 #6). When the
  // discrepancy is upstream of the provider switch, this repair has a
  // better chance to converge than a second cold extraction.
  if (reconciled.status === 'discrepancy') {
    const suspects = findSuspectRows(
      openingCents,
      effectiveTxs.map((t) => ({
        amountCents: t.amountCents,
        runningBalanceCents: t.runningBalanceCents,
      })),
    );
    const repairPrompt = repairPromptFor({
      markdown: ctx.markdown,
      attemptedTransactions: effectiveTxs.map((t) => ({
        posted_date: t.postedDate,
        description: t.description,
        amount_cents: t.amountCents,
        running_balance_cents: t.runningBalanceCents,
      })),
      deltaCents: reconciled.deltaCents,
      suspectRowIndices: suspects.map((s) => s.index),
      openingBalanceCents: openingCents,
      closingBalanceCents: closingCents,
    });
    try {
      const repairResult = await provider.extract(repairPrompt, {
        schema: schemas.extraction.ExtractionJsonSchema,
        ...(ctx.dateFormatOverride ? { dateFormatOverride: ctx.dateFormatOverride } : {}),
      });
      const repairedTxs = mapLlmTxs(repairResult.data.transactions);
      const verifyAfterLlmRepair = reconcileGoldenRule({
        openingBalanceCents: openingCents,
        closingBalanceCents: closingCents,
        transactions: repairedTxs.map((t) => ({
          amountCents: t.amountCents,
          runningBalanceCents: t.runningBalanceCents,
        })),
        periodStart,
        periodEnd,
        transactionDates: repairedTxs.map((t) => t.postedDate),
      });
      // Roll telemetry in regardless of whether the repair verified.
      totalInputTokens += repairResult.telemetry.inputTokens ?? 0;
      totalOutputTokens += repairResult.telemetry.outputTokens ?? 0;
      totalCallCount += 1;
      totalCostMicros += repairResult.telemetry.costMicros;
      if (verifyAfterLlmRepair.status === 'verified') {
        effectiveTxs = repairedTxs;
        reconciled = verifyAfterLlmRepair;
        repairApplied = `llm-repair (${repairedTxs.length} rows)`;
        logger.info(
          {
            stmtId: ctx.stmtId,
            providerId,
            originalCount: llmEmittedTxCount,
            repairedCount: repairedTxs.length,
          },
          'reconcile repair applied via LLM second pass',
        );
      } else {
        logger.info(
          {
            stmtId: ctx.stmtId,
            providerId,
            deltaAfterRepair: verifyAfterLlmRepair.deltaCents.toString(),
          },
          'LLM repair did not verify — falling through to heuristic repair',
        );
      }
    } catch (err) {
      logger.warn(
        { stmtId: ctx.stmtId, providerId, err: (err as Error).message },
        'LLM repair pass threw — falling through',
      );
    }
  }

  // Heuristic repair (sign-flip / drop-row) — cheap last resort before
  // giving up and letting the orchestrator try the secondary provider.
  if (reconciled.status === 'discrepancy') {
    const candidate = repairPass(
      effectiveTxs.map((t) => ({ amountCents: t.amountCents, description: t.description })),
      reconciled.deltaCents,
    );
    if (candidate) {
      const repairedAmounts = candidate.transactions;
      let candidateTxs: typeof effectiveTxs;
      if (repairedAmounts.length === effectiveTxs.length) {
        candidateTxs = effectiveTxs.map((t, i) => ({
          ...t,
          amountCents: repairedAmounts[i]!.amountCents,
        }));
      } else {
        const out: typeof effectiveTxs = [];
        let r = 0;
        for (const original of effectiveTxs) {
          if (
            r < repairedAmounts.length &&
            repairedAmounts[r]!.amountCents === original.amountCents &&
            repairedAmounts[r]!.description === original.description
          ) {
            out.push(original);
            r += 1;
          }
        }
        candidateTxs = out;
      }
      const verifyAfterRepair = reconcileGoldenRule({
        openingBalanceCents: openingCents,
        closingBalanceCents: closingCents,
        transactions: candidateTxs.map((t) => ({ amountCents: t.amountCents })),
        periodStart,
        periodEnd,
        transactionDates: candidateTxs.map((t) => t.postedDate),
      });
      if (verifyAfterRepair.status === 'verified') {
        effectiveTxs = candidateTxs;
        reconciled = verifyAfterRepair;
        repairApplied = candidate.fixDescription;
        logger.info(
          { stmtId: ctx.stmtId, providerId, fix: candidate.fixDescription },
          'reconcile repair applied',
        );
      } else {
        logger.info(
          { stmtId: ctx.stmtId, providerId, fix: candidate.fixDescription },
          'reconcile repair candidate rejected — still discrepant after fix',
        );
      }
    }
  }

  return {
    providerId,
    rejection: reconciled.status === 'verified' ? null : 'discrepancy',
    error: null,
    llmEmittedTxCount,
    effectiveTxs,
    reconciled,
    repairApplied,
    totalInputTokens,
    totalOutputTokens,
    totalCallCount,
    totalCostMicros,
    modelVersion: result.telemetry.model,
    dateFormat,
    dateFormatConfidence,
    periodStart,
    periodEnd,
    openingBalanceCents: openingCents,
    closingBalanceCents: closingCents,
  };
};

// Choose between the primary attempt (which triggered fallback) and the
// secondary attempt. "Usable" = produced data we could potentially
// commit; HTTP/malformed errors yield no data. Among usable outcomes
// prefer the verified one; otherwise prefer the fallback (operator
// opted in, secondary is the explicit second opinion).
const pickBetterAttempt = (primary: AttemptOutcome, secondary: AttemptOutcome): AttemptOutcome => {
  const usable = (a: AttemptOutcome): boolean =>
    a.rejection !== 'http' && a.rejection !== 'malformed';
  if (usable(secondary) && !usable(primary)) return secondary;
  if (usable(primary) && !usable(secondary)) return primary;
  if (secondary.rejection === null && primary.rejection !== null) return secondary;
  if (primary.rejection === null && secondary.rejection !== null) return primary;
  return secondary;
};

// Diagnostic record persisted to audit_log on every extraction
// outcome. Operators read this via the per-statement audit panel
// when an extraction misbehaves — it's structured enough to answer
// "which provider, which input method, how long, what reconciled,
// what rejected" without grepping pino logs.
interface AttemptTraceEntry {
  providerId: ProviderId;
  inputMethod: 'text-layer' | 'ocr';
  rejection: AttemptRejection;
  durationMs: number;
  llmCallCount: number;
  inputTokens: number;
  outputTokens: number;
  // bigint serializes to string in JSONB.
  costMicros: string;
  modelVersion: string | null;
  txCount: number;
  llmEmittedTxCount: number;
  reconciliation: 'verified' | 'discrepancy' | null;
  deltaCents: string | null;
  repairApplied: string | null;
  dateFormat: schemas.extraction.ExtractionResult['source_date_format']['format'] | null;
  error: { class: string; message: string } | null;
}

const traceEntryFor = (
  outcome: AttemptOutcome,
  inputMethod: 'text-layer' | 'ocr',
  durationMs: number,
): AttemptTraceEntry => ({
  providerId: outcome.providerId,
  inputMethod,
  rejection: outcome.rejection,
  durationMs,
  llmCallCount: outcome.totalCallCount,
  inputTokens: outcome.totalInputTokens,
  outputTokens: outcome.totalOutputTokens,
  costMicros: outcome.totalCostMicros.toString(),
  modelVersion: outcome.modelVersion,
  txCount: outcome.effectiveTxs.length,
  llmEmittedTxCount: outcome.llmEmittedTxCount,
  reconciliation: outcome.reconciled
    ? outcome.reconciled.status === 'verified'
      ? 'verified'
      : 'discrepancy'
    : null,
  deltaCents: outcome.reconciled?.deltaCents.toString() ?? null,
  repairApplied: outcome.repairApplied,
  dateFormat: outcome.dateFormat,
  error: outcome.error
    ? { class: outcome.error.constructor?.name ?? 'Error', message: outcome.error.message }
    : null,
});

const summarizeOcrDiagnostics = (ocr: OcrResponse): Record<string, unknown> => {
  const variants: Record<string, number> = {};
  let assumedConfidencePages = 0;
  let emptyPages = 0;
  const keySets = new Set<string>();
  for (const d of ocr.parseDiagnostics) {
    variants[d.variant] = (variants[d.variant] ?? 0) + 1;
    if (d.confidenceSource === 'assumed-default') assumedConfidencePages += 1;
    if (d.emptyText) emptyPages += 1;
    if (d.bodyTopLevelKeys.length > 0) {
      keySets.add([...d.bodyTopLevelKeys].sort().join(','));
    }
  }
  return {
    engineVersion: ocr.engineVersion,
    pages: ocr.pages.length,
    variants,
    assumedConfidencePages,
    emptyPages,
    unknownKeySets: Array.from(keySets).slice(0, 5),
  };
};

// Walk the error.cause chain (Node 20+) flattening into a small array
// of {class, message} entries so the audit log captures the original
// DOMException / undici / network error along with whatever we wrapped
// it in. Capped at 4 levels so a pathological cycle can't blow up the
// row. Stack traces are kept separate (and truncated) so a multi-MB
// trace doesn't dwarf the rest of the payload.
const describeError = (err: Error): Record<string, unknown> => {
  const chain: Array<{ class: string; message: string; name: string }> = [];
  let cursor: unknown = err;
  for (let i = 0; i < 4 && cursor instanceof Error; i += 1) {
    chain.push({
      class: cursor.constructor?.name ?? 'Error',
      name: cursor.name,
      message: cursor.message,
    });
    cursor = (cursor as Error & { cause?: unknown }).cause;
  }
  const stack = typeof err.stack === 'string' ? err.stack.split('\n').slice(0, 8).join('\n') : null;
  const out: Record<string, unknown> = {
    class: err.constructor?.name ?? 'Error',
    name: err.name,
    message: err.message,
  };
  if (chain.length > 1) out.causeChain = chain.slice(1);
  if (stack) out.stack = stack;
  return out;
};

// Coarse-grained extraction phases. Tracked so the outer failure-audit
// row can name the call that blew up rather than just reporting
// `errorClass: 'DOMException'`. Phase names match the audit payload
// `phase` field; keep them stable so operators can grep historical
// rows. `init` is the slot before `preprocessing` proper (DB lookups,
// PDF analysis); `done` only appears on the success-path trace.
type ExtractionPhase =
  | 'init'
  | 'preprocessing'
  | 'text-markdown'
  | 'ocr-markdown'
  | 'extracting'
  | 'ocr-fallback-markdown'
  | 'text-fallback-markdown'
  | 'reconciling'
  | 'persisting'
  | 'done';

export const processExtraction = async (data: ExtractionJobData): Promise<void> => {
  const stmtId = data.statementId;
  const workerStartedAt = Date.now();

  // Diagnostic trace accumulators. Persisted to audit_log on every
  // outcome (success, failure, AMBIGUOUS halt) so operators can read
  // the full processing breakdown — per-attempt durations + tokens +
  // costs, phase timings, fallback decisions — without grepping
  // pino logs.
  const attempts: AttemptTraceEntry[] = [];
  const timing = {
    preprocessMs: 0,
    markdownMs: 0,
    llmMs: 0,
    ocrFallbackMarkdownMs: 0,
    persistMs: 0,
  };
  let providerFallbackFired = false;
  let ocrFallbackFired = false;
  let textFallbackFired = false;
  let lastOcrResponse: OcrResponse | null = null;
  let phaseStart = Date.now();
  // Phase tracker — updated at each transition so the failure audit
  // can say "we were in `ocr-markdown` when this fired".
  let currentPhase: ExtractionPhase = 'init';
  // Hoisted so the outer catch can include them in the failure trace
  // even when an error fires mid-extraction. Each starts undefined
  // and gets populated as the corresponding phase begins.
  let analysis: Awaited<ReturnType<typeof analyzePdfFromBuffer>> | undefined;
  let strategy: Awaited<ReturnType<typeof resolvePdfStrategy>> | undefined;
  let method: ExtractionMethod | undefined;
  let pageRange: { start: number; end: number } | null = null;
  let markdown: string = '';
  let policy: Awaited<ReturnType<typeof resolveProviderPolicy>> | undefined;
  let primary: ProviderId | undefined;
  let secondary: ProviderId | null | undefined;

  // Build the trace payload that every termination point writes to
  // audit_log. The payload is the operator's "what just happened"
  // forensic record: PDF analysis, configured + effective routing,
  // per-attempt detail (durations, tokens, cost, rejection, repair),
  // and phase timings. Markdown text itself is NOT included — only
  // its size — to keep the audit row under JSONB's practical
  // payload limit and avoid PII leakage to audit-viewer roles.
  // Hoisted above the try/catch so the failure-path can call it with
  // whatever state has been populated so far.
  const buildTrace = (
    outcome: 'success' | 'failed' | 'halted-ambiguous',
    finalAttempt?: AttemptOutcome,
    finalError?: Error | null,
  ): Record<string, unknown> => ({
    outcome,
    phase: currentPhase,
    pdf: analysis
      ? {
          hash: data.sourcePdfHash.slice(0, 12),
          pages: analysis.pageCount,
          hasTextLayer: analysis.hasTextLayer,
          textLayerCoverage: Number(analysis.textLayerCoverage.toFixed(3)),
          avgCharsPerPage: Math.round(analysis.avgCharsPerPage),
          suspectedScan: analysis.suspectedScan,
          pageRange: pageRange ? { start: pageRange.start, end: pageRange.end } : null,
        }
      : { hash: data.sourcePdfHash.slice(0, 12), pageRange: null },
    strategy: {
      configured: strategy ?? null,
      effectiveMethod: method ?? null,
      ocrFallbackFired,
      textFallbackFired,
    },
    providerPolicy: {
      policy: policy ?? null,
      primary: primary ?? null,
      secondary: secondary ?? null,
      providerFallbackFired,
    },
    markdown: {
      chars: markdown.length,
    },
    ...(lastOcrResponse ? { ocr: summarizeOcrDiagnostics(lastOcrResponse) } : {}),
    attempts,
    timing: {
      totalMs: Date.now() - workerStartedAt,
      preprocessMs: timing.preprocessMs,
      markdownMs: timing.markdownMs,
      llmMs: timing.llmMs,
      ocrFallbackMarkdownMs: timing.ocrFallbackMarkdownMs,
      persistMs: timing.persistMs,
    },
    ...(finalAttempt
      ? {
          chosen: {
            providerId: finalAttempt.providerId,
            txCount: finalAttempt.effectiveTxs.length,
            reconciliation: finalAttempt.reconciled?.status ?? null,
            deltaCents: finalAttempt.reconciled?.deltaCents.toString() ?? null,
            repairApplied: finalAttempt.repairApplied,
          },
        }
      : {}),
    ...(finalError ? { error: describeError(finalError) } : {}),
  });

  try {
    await setStatus(stmtId, 'preprocessing');
    currentPhase = 'preprocessing';

    // Look up the account up front so TRNTYPE inference can apply the
    // credit-card sign convention (Phase 17 — `isCreditCard` flag).
    const acctRows = await db.select().from(accounts).where(eq(accounts.id, data.accountId));
    const isCreditCard = acctRows[0]?.accountType === 'CREDITCARD';

    // Phase 15 item 4b: if the operator already confirmed a date format
    // (after a previous AMBIGUOUS extraction), pass that through to the
    // LLM so it interprets the statement consistently.
    const stmtRows = await db.select().from(statements).where(eq(statements.id, stmtId));
    // The Vibe Shield session opened at upload; quoted on OCR + extraction
    // so their PII tokens share one vault.
    const shieldSessionId = stmtRows[0]?.shieldSessionId ?? null;
    const dateFormatOverride =
      stmtRows[0]?.sourceDateFormatUserConfirmed === true &&
      (stmtRows[0]?.sourceDateFormat === 'MDY' ||
        stmtRows[0]?.sourceDateFormat === 'DMY' ||
        stmtRows[0]?.sourceDateFormat === 'YMD')
        ? stmtRows[0].sourceDateFormat
        : undefined;

    // pdfjs-dist takes ownership of the underlying ArrayBuffer per call,
    // so we re-read the file before each pdfjs call rather than passing
    // the same Buffer twice (which would detach the ArrayBuffer and
    // throw "Cannot perform Construct on a detached ArrayBuffer").
    analysis = await analyzePdfFromBuffer(await readFile(data.sourcePdfPath));

    // Phase 14: when this statement is a per-account slice (page_range
    // set), filter pages to that range BEFORE handing markdown to the LLM.
    // The LLM sees one account's slice as if it were the whole PDF.
    pageRange = stmtRows[0]?.pageRange ?? null;
    const inRange = (pageIndex0: number): boolean => {
      if (!pageRange) return true;
      const page1 = pageIndex0 + 1;
      return page1 >= pageRange.start && page1 <= pageRange.end;
    };

    // PDF processing strategy resolves the per-statement override against
    // the firm default. Strategy decides which extraction method to try
    // first (text-layer vs OCR) and whether to fall back to OCR when the
    // LLM stack rejects the text-layer input.
    strategy = await resolvePdfStrategy(db, stmtRows[0]?.processingStrategyOverride);
    if (strategy === 'force-ocr' || strategy === 'auto-text-fallback') {
      // auto-text-fallback starts with OCR and only falls back to the
      // text layer if the OCR-fed LLM call rejects. Treated as OCR-first
      // here; the fallback branch below handles the retry.
      method = 'ocr';
    } else if (strategy === 'force-text') {
      if (!analysis.hasTextLayer) {
        throw new Error(
          'force-text strategy requested but this PDF has no text layer — ' +
            'switch to auto / force-ocr / auto-ocr-fallback / auto-text-fallback',
        );
      }
      method = 'text';
    } else {
      method = routePdf(analysis);
    }

    timing.preprocessMs = Date.now() - phaseStart;
    phaseStart = Date.now();

    await setStatus(stmtId, method === 'ocr' ? 'ocr' : 'extracting', {
      extractionMethod: method,
      sourcePdfPages: analysis.pageCount,
    });

    const produceTextMarkdown = async (): Promise<string> => {
      const pages = await extractTextLayerFromBuffer(await readFile(data.sourcePdfPath));
      const scoped = pages.filter((p) => inRange(p.index));
      // Persist detected splits so the UI can offer a split-or-acknowledge
      // flow. Only run detection on un-split (whole-PDF) extractions —
      // sliced re-extractions are by definition single-account already.
      if (!pageRange) {
        const splitInfo = detectMultiAccount(pages);
        if (splitInfo.multiAccount) {
          await db
            .update(statements)
            .set({ detectedSplits: splitInfo, updatedAt: sql`now()` })
            .where(eq(statements.id, stmtId));
          logger.warn(
            { stmtId, splits: splitInfo.splits },
            'multi-account PDF detected; persisted splits for UI confirmation',
          );
        }
      }
      return scoped.map((p) => `# Page ${p.index + 1}\n\n${p.text}`).join('\n\n');
    };

    const produceOcrMarkdown = async (): Promise<string> => {
      // OCR path. rasterizePdf shells out to pdftoppm (poppler-utils).
      // The standalone Dockerfile installs poppler; on host machines the
      // operator needs `brew install poppler` (or apt/choco equivalent).
      const rasters = await rasterizePdf(data.sourcePdfPath, { dpi: 300 });
      const scopedRasters = rasters.filter((r) => inRange(r.index));
      const images = await Promise.all(scopedRasters.map(async (r) => readFile(r.pngPath)));
      // DB-backed config (URL/key/model) falls back to VIBE_SHIELD_* env.
      // Resolved per call so an admin tweak via /admin/engines doesn't
      // require a restart. The page images go to Shield→Claude; Shield
      // masks PII (token-overlay) before Claude sees them, so the markdown
      // comes back tokenized and is materialized at export.
      const ocrConfig = await getEngineConfig(db, 'vibe-shield');
      const ocr = await ocrPdfPages(images, {
        cache: redisOcrCache,
        ...(ocrConfig.url ? { baseUrl: ocrConfig.url } : {}),
        ...(ocrConfig.timeoutMs ? { timeoutMs: ocrConfig.timeoutMs } : {}),
        ...(ocrConfig.concurrency ? { concurrency: ocrConfig.concurrency } : {}),
        ...(ocrConfig.healthPath ? { healthPath: ocrConfig.healthPath } : {}),
        ...(ocrConfig.model ? { model: ocrConfig.model } : {}),
        ...(ocrConfig.prompt ? { prompt: ocrConfig.prompt } : {}),
        ...(ocrConfig.apiKey ? { apiKey: ocrConfig.apiKey } : {}),
        ...(shieldSessionId ? { sessionId: shieldSessionId } : {}),
      });
      lastOcrResponse = ocr;
      return ocr.pages
        .map((p, i) => `# Page ${(scopedRasters[i]?.index ?? p.index) + 1}\n\n${p.markdown}`)
        .join('\n\n');
    };

    currentPhase = method === 'text' ? 'text-markdown' : 'ocr-markdown';
    markdown = method === 'text' ? await produceTextMarkdown() : await produceOcrMarkdown();
    timing.markdownMs = Date.now() - phaseStart;

    await checkCancelled(stmtId);
    await setStatus(stmtId, 'extracting');

    // Two-provider orchestration. Each attempt runs the LLM call + repair
    // pass in memory without persisting anything; the orchestrator picks
    // the better outcome and commits it once at the end.
    currentPhase = 'extracting';
    policy = await resolveProviderPolicy(db);
    ({ primary, secondary } = providerOrderFor(policy));
    let attemptCtx: AttemptContext = {
      stmtId,
      markdown,
      ...(dateFormatOverride ? { dateFormatOverride } : {}),
      ...(shieldSessionId ? { sessionId: shieldSessionId } : {}),
    };

    const persistAmbiguousHalt = async (a: AttemptOutcome): Promise<void> => {
      await db
        .update(statements)
        .set({
          status: 'awaiting-locale-confirmation',
          sourceDateFormat: 'AMBIGUOUS',
          sourceDateFormatConfidence: a.dateFormatConfidence,
          llmProvider: a.providerId,
          llmInputTokens: a.totalInputTokens,
          llmOutputTokens: a.totalOutputTokens,
          llmCallCount: a.totalCallCount,
          llmCostMicros: a.totalCostMicros,
          llmModelVersion: a.modelVersion,
          updatedAt: sql`now()`,
        })
        .where(eq(statements.id, stmtId));
      logger.info(
        { stmtId, providerId: a.providerId },
        'extraction halted: ambiguous source date format — awaiting operator confirmation',
      );
    };

    // Provider-fallback orchestration. Returns the better of (primary,
    // secondary) outcomes, or just the primary when no secondary or no
    // rejection. AMBIGUOUS short-circuits — the caller persists halt
    // state and returns. Pure orchestration; no statement-row writes
    // besides the existing extraction-fallback audit log.
    const runProviderFallback = async (
      ctx: AttemptContext,
      inputMethod: 'text-layer' | 'ocr',
    ): Promise<AttemptOutcome> => {
      // primary / secondary are hoisted `let`s populated above before
      // this closure is ever invoked. Capture them locally so the type
      // narrows from `ProviderId | undefined` to `ProviderId`.
      if (primary === undefined || secondary === undefined) {
        throw new Error('provider order not resolved before runProviderFallback (bug)');
      }
      const resolvedPrimary = primary;
      const resolvedSecondary = secondary;
      const firstStart = Date.now();
      const first = await attemptExtraction(resolvedPrimary, ctx);
      attempts.push(traceEntryFor(first, inputMethod, Date.now() - firstStart));
      if (first.dateFormat === 'AMBIGUOUS' && !ctx.dateFormatOverride) return first;
      if (first.rejection === null || resolvedSecondary === null) return first;
      providerFallbackFired = true;
      await writeAudit(db, {
        entityType: 'statement',
        entityId: stmtId,
        action: 'statement.extraction-fallback',
        payload: {
          from: first.providerId,
          to: resolvedSecondary,
          reason: first.rejection,
          inputMethod,
          ...(first.error ? { primaryError: first.error.message } : {}),
        },
      });
      logger.info(
        {
          stmtId,
          from: first.providerId,
          to: resolvedSecondary,
          reason: first.rejection,
          inputMethod,
        },
        'falling back to secondary provider',
      );
      await setStatus(stmtId, 'extracting');
      const secondStart = Date.now();
      const second = await attemptExtraction(resolvedSecondary, ctx);
      attempts.push(traceEntryFor(second, inputMethod, Date.now() - secondStart));
      if (second.dateFormat === 'AMBIGUOUS' && !ctx.dateFormatOverride) return second;
      return pickBetterAttempt(first, second);
    };

    const llmStart = Date.now();
    let chosen = await runProviderFallback(attemptCtx, method === 'ocr' ? 'ocr' : 'text-layer');
    timing.llmMs = Date.now() - llmStart;

    if (chosen.dateFormat === 'AMBIGUOUS' && !dateFormatOverride) {
      await persistAmbiguousHalt(chosen);
      await writeAudit(db, {
        entityType: 'statement',
        entityId: stmtId,
        action: 'statement.extraction-trace',
        payload: buildTrace('halted-ambiguous', chosen),
      });
      return;
    }

    // OCR fallback. Only fires when:
    //   - strategy is `auto-ocr-fallback`, and
    //   - we tried text-layer first (otherwise there's nothing to fall
    //     back to), and
    //   - the provider stack rejected with any of the four triggers.
    // Provider fallback runs *inside* each input attempt — so the OCR
    // retry also exercises the secondary provider via runProviderFallback.
    // Worst case: 4 LLM calls (text×{primary,secondary} → ocr×{primary,secondary}).
    if (strategy === 'auto-ocr-fallback' && method === 'text' && chosen.rejection !== null) {
      ocrFallbackFired = true;
      await writeAudit(db, {
        entityType: 'statement',
        entityId: stmtId,
        action: 'statement.input-fallback',
        payload: {
          from: 'text-layer',
          to: 'ocr',
          reason: chosen.rejection,
          ...(chosen.error ? { primaryError: chosen.error.message } : {}),
        },
      });
      logger.info(
        { stmtId, reason: chosen.rejection },
        'text-layer extraction rejected — retrying with OCR (Vibe Shield)',
      );
      await setStatus(stmtId, 'ocr', { extractionMethod: 'hybrid' });
      currentPhase = 'ocr-fallback-markdown';
      const ocrMarkdownStart = Date.now();
      markdown = await produceOcrMarkdown();
      timing.ocrFallbackMarkdownMs = Date.now() - ocrMarkdownStart;
      attemptCtx = { ...attemptCtx, markdown };
      currentPhase = 'extracting';
      await setStatus(stmtId, 'extracting');
      const ocrLlmStart = Date.now();
      const ocrChosen = await runProviderFallback(attemptCtx, 'ocr');
      timing.llmMs += Date.now() - ocrLlmStart;
      if (ocrChosen.dateFormat === 'AMBIGUOUS' && !dateFormatOverride) {
        await persistAmbiguousHalt(ocrChosen);
        await writeAudit(db, {
          entityType: 'statement',
          entityId: stmtId,
          action: 'statement.extraction-trace',
          payload: buildTrace('halted-ambiguous', ocrChosen),
        });
        return;
      }
      chosen = pickBetterAttempt(chosen, ocrChosen);
      method = 'hybrid';
    }

    // Mirror fallback: auto-text-fallback starts with OCR; if the OCR-fed
    // LLM call rejected and the PDF has a text layer, retry using the
    // text layer. Skipped silently when no text layer exists — there's
    // nothing to fall back to. Worst case mirrors auto-ocr-fallback:
    // 4 LLM calls (ocr×{primary,secondary} → text×{primary,secondary}).
    if (
      strategy === 'auto-text-fallback' &&
      method === 'ocr' &&
      chosen.rejection !== null &&
      analysis.hasTextLayer
    ) {
      textFallbackFired = true;
      await writeAudit(db, {
        entityType: 'statement',
        entityId: stmtId,
        action: 'statement.input-fallback',
        payload: {
          from: 'ocr',
          to: 'text-layer',
          reason: chosen.rejection,
          ...(chosen.error ? { primaryError: chosen.error.message } : {}),
        },
      });
      logger.info(
        { stmtId, reason: chosen.rejection },
        'OCR extraction rejected — retrying with text-layer',
      );
      await setStatus(stmtId, 'extracting', { extractionMethod: 'hybrid' });
      currentPhase = 'text-fallback-markdown';
      const textMarkdownStart = Date.now();
      markdown = await produceTextMarkdown();
      timing.ocrFallbackMarkdownMs = Date.now() - textMarkdownStart;
      attemptCtx = { ...attemptCtx, markdown };
      currentPhase = 'extracting';
      const textLlmStart = Date.now();
      const textChosen = await runProviderFallback(attemptCtx, 'text-layer');
      timing.llmMs += Date.now() - textLlmStart;
      if (textChosen.dateFormat === 'AMBIGUOUS' && !dateFormatOverride) {
        await persistAmbiguousHalt(textChosen);
        await writeAudit(db, {
          entityType: 'statement',
          entityId: stmtId,
          action: 'statement.extraction-trace',
          payload: buildTrace('halted-ambiguous', textChosen),
        });
        return;
      }
      chosen = pickBetterAttempt(chosen, textChosen);
      method = 'hybrid';
    }

    // Hard failure path: neither attempt produced usable data. Re-throw
    // the chosen error so the worker's outer catch records it via the
    // diagnostic-capture path (statement.extraction-failed audit row,
    // user-friendly errorMessage on the statements row).
    if (chosen.rejection === 'http' || chosen.rejection === 'malformed') {
      throw chosen.error ?? new Error('extraction failed with no usable result');
    }

    await checkCancelled(stmtId);
    currentPhase = 'reconciling';
    await setStatus(stmtId, 'reconciling');

    // Empty-tx fallback path can still land here when no secondary was
    // available. Treat as an inserted-zero outcome — the operator sees
    // `review` status with zero transactions and reconciliation=verified
    // (no movement) or discrepancy if balances mismatch.
    if (chosen.periodStart === null || chosen.periodEnd === null) {
      throw new Error('extraction outcome missing period bounds');
    }
    if (chosen.openingBalanceCents === null || chosen.closingBalanceCents === null) {
      throw new Error('extraction outcome missing balance bounds');
    }
    if (!chosen.reconciled) {
      // Empty-txs path with no secondary: synthesize a reconciliation
      // result so the persistence block below can record status.
      chosen.reconciled = reconcileGoldenRule({
        openingBalanceCents: chosen.openingBalanceCents,
        closingBalanceCents: chosen.closingBalanceCents,
        transactions: [],
        periodStart: chosen.periodStart,
        periodEnd: chosen.periodEnd,
        transactionDates: [],
      });
    }

    // OCR now runs through Shield→Claude (vision), so its tokens/cost
    // count toward the statement's LLM rollup. Zero on the text-layer
    // path (no OCR) and when usage is absent. The cast re-widens the
    // type: lastOcrResponse is only assigned inside the produceOcrMarkdown
    // closure, which TS can't see, so it narrows the read to `null`.
    const ocrUsage = (lastOcrResponse as OcrResponse | null)?.usage;
    await db
      .update(statements)
      .set({
        llmProvider: chosen.providerId,
        llmInputTokens: chosen.totalInputTokens + (ocrUsage?.inputTokens ?? 0),
        llmOutputTokens: chosen.totalOutputTokens + (ocrUsage?.outputTokens ?? 0),
        llmCallCount: chosen.totalCallCount,
        llmCostMicros: chosen.totalCostMicros + (ocrUsage?.costMicros ?? 0n),
        llmModelVersion: chosen.modelVersion,
        sourceDateFormat: chosen.dateFormat,
        sourceDateFormatConfidence: chosen.dateFormatConfidence,
        periodStart: chosen.periodStart,
        periodEnd: chosen.periodEnd,
        openingBalanceCents: chosen.openingBalanceCents,
        closingBalanceCents: chosen.closingBalanceCents,
        updatedAt: sql`now()`,
      })
      .where(eq(statements.id, stmtId));

    const effectiveTxs = chosen.effectiveTxs;
    const reconciled = chosen.reconciled;
    const repairApplied = chosen.repairApplied;

    // ADR-022 #4: derive seq + FITID from the materialized cleartext so
    // they're stable across re-uploads (the stored description stays
    // tokenized). Falls back to the tokenized form if Shield is down.
    const fitidDescriptions = await materializeDescriptionsForFitid(
      shieldSessionId,
      effectiveTxs.map((t) => t.description),
    );

    const seqAssigned = assignSeqInDay(
      effectiveTxs.map((t, i) => ({
        postedDate: t.postedDate,
        amountCents: t.amountCents,
        description: fitidDescriptions[i] ?? t.description,
        sourceLine: t.sourceLine,
      })),
    );

    // Atomic finalize. checkCancelled fires immediately before so the
    // race window between status-check and DB-commit is minimized, then
    // the transaction inserts and final UPDATE happen in a single DB
    // transaction guarded by `WHERE status IN ('reconciling',
    // 'extracting')`. If /cancel, /split, DELETE, or another operator
    // action has flipped the status off those values (or removed the
    // row), the UPDATE matches 0 rows and we abort — the transaction
    // rolls back, undoing any inserts so the row's verdict from /cancel
    // (or its absence after DELETE) stands.
    await checkCancelled(stmtId);
    currentPhase = 'persisting';

    await db.transaction(async (tx) => {
      for (let i = 0; i < effectiveTxs.length; i += 1) {
        const txn = effectiveTxs[i]!;
        const seq = seqAssigned[i]!.seqInDay;
        const fitid = computeFitid({
          postedDate: txn.postedDate,
          amountCents: txn.amountCents,
          // Stable cleartext (ADR-022 #4), not the session-scoped token.
          description: fitidDescriptions[i] ?? txn.description,
          seqInDay: seq,
        });
        const trntype = inferTrntype({
          description: txn.description,
          amountCents: txn.amountCents,
          isCreditCard,
          ...(txn.checkNumber ? { checkNumber: txn.checkNumber } : {}),
          ...(txn.trntypeHint ? { llmHint: txn.trntypeHint } : {}),
        });
        await tx
          .insert(transactions)
          .values({
            statementId: stmtId,
            seqInDay: seq,
            postedDate: txn.postedDate,
            description: txn.description,
            normalizedDescription: normalizeDescription(txn.description),
            amountCents: txn.amountCents,
            runningBalanceCents: txn.runningBalanceCents,
            checkNumber: txn.checkNumber,
            trntype,
            fitid,
            sourcePage: txn.sourcePage,
            sourceBboxJson: null,
            confidence: txn.confidence,
          })
          .onConflictDoNothing();
      }

      const updated = await tx
        .update(statements)
        .set({
          reconciliationStatus: reconciled.status === 'verified' ? 'verified' : 'discrepancy',
          periodBoundsViolations: reconciled.periodBoundsViolations,
          status: 'review',
          updatedAt: sql`now()`,
        })
        .where(
          and(eq(statements.id, stmtId), inArray(statements.status, ['reconciling', 'extracting'])),
        )
        .returning({ id: statements.id });
      if (updated.length === 0) {
        // /cancel, /split, or DELETE landed first. Roll back so the
        // transactions we just inserted don't outlive their statement.
        throw new CancelledError();
      }
    });

    timing.persistMs = Date.now() - phaseStart;
    await writeAudit(db, {
      entityType: 'statement',
      entityId: stmtId,
      action: 'statement.extracted',
      payload: {
        // Existing concise summary (kept stable for any operator
        // tooling that grepped the old payload shape).
        method,
        provider: chosen.providerId,
        reconciliation: reconciled.status,
        txCount: effectiveTxs.length,
        llmEmittedTxCount: chosen.llmEmittedTxCount,
        policy,
        strategy,
        ...(repairApplied ? { repairApplied } : {}),
        // Full processing trace — operator reads this when a successful
        // extraction looks suspect (cost surprise, slow run, fallback
        // fired silently) without having to re-run the job.
        trace: buildTrace('success', chosen),
      },
    });
    currentPhase = 'done';
  } catch (err) {
    // CancelledError is the operator pulling the plug — the /cancel
    // route already wrote the reason, and the outer worker catch
    // swallows it without writing an audit row. Re-throw without
    // touching audit_log.
    if (err instanceof CancelledError) throw err;
    // Rich failure trace — same shape as the success / halted-ambiguous
    // traces, plus a fully described error (class, name, message,
    // cause chain, truncated stack). With this in place the operator
    // sees "phase: ocr-markdown" + "Shield POST .../v1/messages
    // timed out after 60000 ms" instead of bare DOMException.
    const e = err instanceof Error ? err : new Error(String(err));
    const failureDiagnostic: Record<string, unknown> = {
      errorClass: e.constructor?.name ?? 'Error',
      message: e.message,
      phase: currentPhase,
      trace: buildTrace('failed', undefined, e),
      error: describeError(e),
    };
    if (e instanceof ExtractionResponseError) {
      failureDiagnostic.summary = e.summary;
      if (e.issues !== undefined) failureDiagnostic.issues = e.issues;
      const RAW_LIMIT = 8000;
      failureDiagnostic.rawResponseSnippet = e.rawResponse.slice(0, RAW_LIMIT);
      if (e.rawResponse.length > RAW_LIMIT) {
        failureDiagnostic.rawResponseTruncated = true;
        failureDiagnostic.rawResponseLength = e.rawResponse.length;
      }
      if (e.missingTopLevelFields.length > 0) {
        failureDiagnostic.missingTopLevelFields = e.missingTopLevelFields;
        failureDiagnostic.gatewayEnforcementHint =
          'LLM emitted JSON missing required top-level field(s) twice in a row ' +
          '(initial call + reminder retry). The local gateway likely is not ' +
          'enforcing the JSON schema we sent in `response_format.json_schema`. ' +
          'Enable guided decoding on the gateway (vLLM ' +
          '`--guided-decoding-backend xgrammar`, llama.cpp grammars, or the ' +
          'equivalent for your stack) so the model cannot terminate without ' +
          'emitting every required field.';
      }
    }
    try {
      await writeAudit(db, {
        entityType: 'statement',
        entityId: stmtId,
        action: 'statement.extraction-failed',
        payload: failureDiagnostic,
      });
    } catch (auditErr) {
      // Don't let an audit write failure mask the real error.
      logger.warn({ auditErr }, 'failed to write extraction-failed audit row');
    }
    throw err;
  }
};

export const startExtractionWorker = (): Worker<ExtractionJobData> => {
  return new Worker<ExtractionJobData>(
    QUEUE_EXTRACTION,
    async (job) => {
      try {
        await processExtraction(job.data);
      } catch (err) {
        if (err instanceof CancelledError) {
          // The /cancel route already wrote status=failed +
          // errorMessage; don't overwrite the cancel reason.
          logger.info({ jobId: job.id }, 'extraction cancelled cooperatively');
          return;
        }

        // The rich audit row was written by processExtraction's own
        // try/catch (it has access to the phase + attempts + timing
        // state we'd otherwise have to thread out here). All this
        // catch needs to do is log + update the statements row +
        // rethrow so BullMQ records the failure.
        const e = err as Error;
        logger.error(
          {
            err,
            jobId: job.id,
            errorClass: e?.constructor?.name ?? 'Error',
            message: e?.message ?? String(err),
          },
          'extraction job failed',
        );

        // User-facing message: ExtractionResponseError carries a clean
        // summary + issue list with no raw payload. Other errors fall
        // through to the message text.
        const userMessage =
          err instanceof ExtractionResponseError
            ? `${err.message} — full LLM response captured in audit_log`
            : (e?.message ?? 'extraction failed');

        await db
          .update(statements)
          .set({
            status: 'failed',
            errorMessage: userMessage,
            updatedAt: sql`now()`,
          })
          .where(eq(statements.id, job.data.statementId));
        throw err;
      }
    },
    {
      connection: getJobConnection(),
      // lockDuration must comfortably exceed the longest expected job;
      // otherwise BullMQ marks the job as orphaned and re-queues it
      // while the worker is still processing → duplicate work + the
      // statements row gets stomped. Worst-case scenario:
      //   * 50-page OCR run (Claude vision via Vibe Shield)
      //   * ~50s per page worst case
      //   * concurrency=2 → 25 sequential rounds → ~21 min
      // Default 30 min (with the historical 60s buffer) covers that
      // and a noisy retry; GPU operators waste nothing because the
      // job finishes in seconds and releases the lock immediately.
      lockDuration: Number(process.env.VIBETC_EXTRACTION_TIMEOUT_MS ?? 1_800_000) + 60_000,
      concurrency: Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 1)),
    },
  );
};
