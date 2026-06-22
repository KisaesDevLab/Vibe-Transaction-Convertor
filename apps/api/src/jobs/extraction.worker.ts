import { Worker } from 'bullmq';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';

import {
  ExtractionResponseError,
  OCR_TRANSCRIBE_SYSTEM_PROMPT,
  OCR_TRANSCRIBE_USER_PROMPT,
  analyzePdfFromBuffer,
  detectMultiAccount,
  extractTextLayerFromBuffer,
  rasterizePdf,
  repairPromptFor,
  routePdf,
  type ExtractionMethod,
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
import {
  buildProviderForId,
  invalidateProviderCache,
  providerOrderFor,
  resolveProviderPolicy,
  type ProviderId,
} from '../services/llm-provider.js';
import { resolvePdfStrategy } from '../services/pdf-strategy.js';
import { resolveCheckPayees } from '../services/check-resolver.js';
import { resolveAiSettings } from '../services/ai-settings.js';
import { writeAudit } from '../services/audit.js';

import { QUEUE_EXTRACTION, getJobConnection, type ExtractionJobData } from './queues.js';

type StatementStatus = NonNullable<typeof statements.$inferInsert.status>;

// Hard page cap for the scanned/vision extraction path. All page image buffers
// are held resident at once (and expand as base64 per batch), so this bounds
// worst-case worker memory on a pathological upload. Mirrors check-resolver's
// MAX_PAGES. Operators split larger statements.
const MAX_OCR_PAGES = 100;

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

export class CancelledError extends Error {
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
  payee: string | null;
  trntypeHint: schemas.extraction.Trntype | undefined;
  sourcePage: number;
  confidence: number;
  sourceLine: number;
}

type AttemptRejection = 'http' | 'malformed' | 'empty-txs' | 'discrepancy' | null;

// A rasterized page image bound for local OCR (stage 1 of two-stage extraction).
type VisionImage = {
  data: Buffer;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
};

// A rasterized page plus its original 0-based PDF page index, so OCR output can
// be page-marked (`# Page N`) and fed to text-based multi-account detection.
type OcrPage = VisionImage & { pageIndex: number };

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
  // Statement content as markdown. For text-layer PDFs this is the extracted
  // text; for scanned PDFs it's the stage-1 OCR transcription. Either way,
  // extraction (stage 2) reads markdown — no images reach this stage.
  markdown: string;
  dateFormatOverride?: 'MDY' | 'DMY' | 'YMD';
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
    payee: t.payee ?? null,
    trntypeHint: t.trntype,
    sourcePage: t.source_page,
    confidence: t.confidence ?? 1,
    sourceLine: idx,
  }));

// Stage 1 of two-stage scanned extraction: OCR each page image to markdown on
// the LOCAL vision model (MiniCPM-V — page images never egress, ADR-023), ONE
// page per call for reliable per-page text. The resulting page-marked markdown
// then goes through the normal text extract() path (stage 2, qwen3.5), which
// reliably enforces our schema field names + integer cents. MiniCPM-V is a
// strong reader but an unreliable structured extractor, so it never emits the
// extraction JSON directly. Returns the markdown, the per-page texts (for
// text-based multi-account detection), and summed OCR telemetry (cost 0, local).
const ocrImagesToMarkdown = async (
  provider: Awaited<ReturnType<typeof buildProviderForId>>,
  pages: OcrPage[],
): Promise<{
  markdown: string;
  pages: Array<{ index: number; text: string }>;
  telemetry: {
    inputTokens: number;
    outputTokens: number;
    ms: number;
    model: string;
    costMicros: bigint;
  };
}> => {
  const out: Array<{ index: number; text: string }> = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let ms = 0;
  let model = '';
  for (const p of pages) {
    const r = await provider.ocrToMarkdown({
      images: [{ data: p.data, mediaType: p.mediaType }],
      systemPrompt: OCR_TRANSCRIBE_SYSTEM_PROMPT,
      userPrompt: OCR_TRANSCRIBE_USER_PROMPT,
    });
    out.push({ index: p.pageIndex, text: r.markdown });
    inputTokens += r.telemetry.inputTokens ?? 0;
    outputTokens += r.telemetry.outputTokens ?? 0;
    ms += r.telemetry.ms;
    model = r.telemetry.model;
  }
  const markdown = out.map((p) => `# Page ${p.index + 1}\n\n${p.text}`).join('\n\n');
  return {
    markdown,
    pages: out,
    telemetry: { inputTokens, outputTokens, ms, model, costMicros: 0n },
  };
};

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

  const baseExtractOpts = {
    schema: schemas.extraction.ExtractionJsonSchema,
    ...(ctx.dateFormatOverride ? { dateFormatOverride: ctx.dateFormatOverride } : {}),
  };

  let result: Awaited<ReturnType<typeof provider.extract>>;
  try {
    // Extraction always runs on markdown now. Scanned PDFs are OCR'd to markdown
    // in stage 1 (local MiniCPM-V) before reaching here, so this stage honors
    // the provider policy and only ever sees cleartext text — never images.
    result = await provider.extract(ctx.markdown, baseExtractOpts);
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
  // The repair pass re-reads the markdown with a "your sum is off" hint. It
  // only applies to the text path — the vision path has no markdown to
  // re-read (ctx.markdown is ''), and an image re-extract repair is a
  // separate follow-on. A vision discrepancy falls through to the
  // discrepancy outcome and surfaces in review.
  if (reconciled.status === 'discrepancy' && ctx.markdown.length > 0) {
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
  | 'ocr-images'
  | 'extracting'
  | 'ocr-fallback-markdown'
  | 'ocr-fallback-images'
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

    // Drop any cached provider before each job. The provider cache lives in this
    // (worker) process and never sees the API process's invalidateProviderCache()
    // call, so without this an operator's just-saved settings change (vision
    // model, timeout, num_predict, base URL) wouldn't reach a freshly-resubmitted
    // extraction. Rebuilding reads a handful of settings rows — negligible.
    invalidateProviderCache();

    // Look up the account up front so TRNTYPE inference can apply the
    // credit-card sign convention (Phase 17 — `isCreditCard` flag).
    const acctRows = await db.select().from(accounts).where(eq(accounts.id, data.accountId));
    const isCreditCard = acctRows[0]?.accountType === 'CREDITCARD';

    // Operator-tunable OCR + safety-net settings (DB → env → default), edited
    // live from /admin/llm-provider.
    const aiSettings = await resolveAiSettings(db);

    // Phase 15 item 4b: if the operator already confirmed a date format
    // (after a previous AMBIGUOUS extraction), pass that through to the
    // LLM so it interprets the statement consistently.
    const stmtRows = await db.select().from(statements).where(eq(statements.id, stmtId));
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

    // Vision/OCR extraction. For scanned/image statements we rasterize the
    // pages and send the IMAGES to the local Ollama Qwen-VL provider, which
    // OCRs + extracts in one call (ADR-023). Page images are processed
    // locally and never egress. rasterizePdf shells out to pdftoppm
    // (poppler-utils): the standalone Dockerfile installs it; on host
    // machines the operator needs `brew install poppler` (or apt/choco).
    // Rasterize to JPEG: there's no gateway body cap anymore, but JPEG at
    // ~200 dpi keeps statement text legible while staying small enough to
    // batch and fit Ollama's context. DPI/quality are operator-tunable.
    const produceOcrImages = async (): Promise<OcrPage[]> => {
      const rasters = await rasterizePdf(data.sourcePdfPath, {
        dpi: aiSettings.ocrDpi,
        format: 'jpeg',
        jpegQuality: aiSettings.ocrJpegQuality,
      });
      const scopedRasters = rasters.filter((r) => inRange(r.index));
      // Hard page cap. All page buffers are held resident at once here, so at
      // operator-tunable DPI a pathological upload could otherwise OOM the
      // worker. Statements this large are vanishingly rare; fail loud and tell
      // the operator to split.
      if (scopedRasters.length > MAX_OCR_PAGES) {
        throw new ExtractionResponseError({
          summary: `scanned statement has ${scopedRasters.length} pages, exceeding the OCR cap of ${MAX_OCR_PAGES}; split it into smaller statements`,
          rawResponse: '',
        });
      }
      return Promise.all(
        scopedRasters.map(async (r) => ({
          data: await readFile(r.path),
          mediaType: r.mediaType,
          pageIndex: r.index,
        })),
      );
    };

    // Stage 1 of the scanned path: rasterize → OCR to markdown on the LOCAL
    // vision model (page images never egress), then run text-based multi-account
    // detection on the transcription (mirrors produceTextMarkdown). Returns the
    // page-marked markdown for the normal stage-2 extraction below.
    const produceOcrMarkdown = async (): Promise<string> => {
      const pages = await produceOcrImages();
      const localProvider = await buildProviderForId(db, 'local');
      const ocr = await ocrImagesToMarkdown(localProvider, pages);
      if (!pageRange) {
        const splitInfo = detectMultiAccount(ocr.pages);
        if (splitInfo.multiAccount) {
          await db
            .update(statements)
            .set({ detectedSplits: splitInfo, updatedAt: sql`now()` })
            .where(eq(statements.id, stmtId));
          logger.warn(
            { stmtId, splits: splitInfo.splits },
            'multi-account scanned PDF detected; persisted splits for UI confirmation',
          );
        }
      }
      return ocr.markdown;
    };

    currentPhase = method === 'text' ? 'text-markdown' : 'ocr-images';
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
      // Stage 2 always operates on markdown (text-layer text, or stage-1 OCR
      // transcription), so it honors the operator's provider policy for BOTH
      // inputs — page images were already consumed locally in stage 1 and never
      // reach here, so Anthropic-on-OCR'd-markdown is allowed (ADR-023).
      const resolvedPrimary: ProviderId = primary;
      const resolvedSecondary: ProviderId | null = secondary;
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
        'text-layer extraction rejected — retrying via local OCR (MiniCPM-V) → markdown',
      );
      await setStatus(stmtId, 'ocr', { extractionMethod: 'hybrid' });
      currentPhase = 'ocr-fallback-images';
      const ocrMarkdownStart = Date.now();
      // OCR fallback (stage 1): transcribe the page images to markdown locally,
      // then re-extract from that markdown via the normal policy-respecting path.
      const fallbackMarkdown = await produceOcrMarkdown();
      timing.ocrFallbackMarkdownMs = Date.now() - ocrMarkdownStart;
      attemptCtx = { ...attemptCtx, markdown: fallbackMarkdown };
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

    // OCR runs in the same local Ollama vision call as extraction, so its
    // tokens/cost are already in the chosen attempt's telemetry — no separate
    // OCR usage to roll up.
    await db
      .update(statements)
      .set({
        llmProvider: chosen.providerId,
        llmInputTokens: chosen.totalInputTokens,
        llmOutputTokens: chosen.totalOutputTokens,
        llmCallCount: chosen.totalCallCount,
        llmCostMicros: chosen.totalCostMicros,
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

    // Descriptions arrive in cleartext (no Shield tokenization), so seq +
    // FITID derive directly from them — stable across re-uploads of the same
    // PDF (the FITID is a non-PII hash of date | amount | normalized_desc | seq).
    const seqAssigned = assignSeqInDay(
      effectiveTxs.map((t) => ({
        postedDate: t.postedDate,
        amountCents: t.amountCents,
        description: t.description,
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

    // Multi-account detection now runs in produceTextMarkdown (text path) and
    // produceOcrMarkdown (scanned path) — both detect on the page text and
    // persist detectedSplits there, so there's nothing to do here.

    // OCR-error safety net (production). The Golden Rule catches balance-level
    // misreads, but a row whose amount happens to tie while its date or
    // description was misread (common on scanned pages) would otherwise export
    // silently. Flag any extraction carrying low-confidence rows for human
    // review before export — reusing the review-hold gate
    // (assertNotHeldForReview) + acknowledge endpoint. Operator-tunable via
    // the review-confidence-threshold setting; 0 disables the hold.
    const reviewConfidenceThreshold = aiSettings.reviewConfidence;
    const lowConfidenceCount =
      reviewConfidenceThreshold > 0
        ? effectiveTxs.filter((t) => t.confidence < reviewConfidenceThreshold).length
        : 0;
    const reviewHoldReason =
      lowConfidenceCount > 0
        ? `${lowConfidenceCount} of ${effectiveTxs.length} transaction(s) were extracted with ` +
          `low confidence (< ${reviewConfidenceThreshold}` +
          `${method === 'ocr' || method === 'hybrid' ? ', via OCR' : ''}). Verify their dates and ` +
          `amounts against the source statement before exporting.`
        : null;

    await db.transaction(async (tx) => {
      for (let i = 0; i < effectiveTxs.length; i += 1) {
        const txn = effectiveTxs[i]!;
        const seq = seqAssigned[i]!.seqInDay;
        const fitid = computeFitid({
          postedDate: txn.postedDate,
          amountCents: txn.amountCents,
          description: txn.description,
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
            payee: txn.payee,
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
          // Local OCR emits no per-page classification (Shield removed).
          pageClassifications: null,
          // Low-confidence rows hold the statement for human review before
          // export; reset (cleared/re-armed) on every (re-)extraction.
          reviewHoldReason,
          reviewHoldAcknowledged: false,
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

    // Auto-resolve check payees (best-effort). The text-layer path never sees
    // cancelled-check images, and a scanned run may have missed some — so for
    // any check-numbered row left without a payee, read the check images on the
    // local vision model and stamp the payee (drives the OFX <NAME>). Gated by
    // the auto-check-payee setting (default on); never fails the extraction.
    const autoCheckPayee = aiSettings.checkPayeeAuto;
    if (autoCheckPayee && effectiveTxs.some((t) => t.checkNumber && !t.payee)) {
      try {
        const res = await resolveCheckPayees(db, stmtId);
        logger.info(
          { stmtId, matched: res.matchedCount, candidates: res.candidateCount },
          'auto check-payee resolution complete',
        );
      } catch (err) {
        logger.warn(
          { stmtId, err: (err as Error).message },
          'auto check-payee resolution failed (continuing)',
        );
      }
    }

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
        ...(lowConfidenceCount > 0
          ? { reviewHold: { lowConfidenceCount, threshold: reviewConfidenceThreshold } }
          : {}),
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
    // sees "phase: ocr-images" + "ollama vision POST .../api/chat
    // timed out after 120000 ms" instead of bare DOMException.
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

// Job-wrapper failure handling, factored out of the Worker closure so it can
// be unit-tested without a live BullMQ runtime. A CancelledError keeps the
// /cancel verdict already written by the route (returns 'cancelled', no row
// write). Any other error marks the statement `failed` with a user-facing
// message and returns 'failed' — the caller then rethrows so BullMQ records
// the failure and applies its retry/backoff. The rich diagnostic audit row was
// already written inside processExtraction's own catch.
export const finalizeJobFailure = async (
  jobData: ExtractionJobData,
  err: unknown,
  jobId?: string | undefined,
): Promise<'cancelled' | 'failed'> => {
  if (err instanceof CancelledError) {
    logger.info({ jobId }, 'extraction cancelled cooperatively');
    return 'cancelled';
  }
  const e = err as Error;
  logger.error(
    {
      err,
      jobId,
      errorClass: e?.constructor?.name ?? 'Error',
      message: e?.message ?? String(err),
    },
    'extraction job failed',
  );
  // ExtractionResponseError carries a clean summary + issue list with no raw
  // payload; other errors fall through to the message text.
  const userMessage =
    err instanceof ExtractionResponseError
      ? `${err.message} — full LLM response captured in audit_log`
      : (e?.message ?? 'extraction failed');
  await db
    .update(statements)
    .set({ status: 'failed', errorMessage: userMessage, updatedAt: sql`now()` })
    .where(eq(statements.id, jobData.statementId));
  return 'failed';
};

export const startExtractionWorker = (): Worker<ExtractionJobData> => {
  return new Worker<ExtractionJobData>(
    QUEUE_EXTRACTION,
    async (job) => {
      try {
        await processExtraction(job.data);
      } catch (err) {
        const verdict = await finalizeJobFailure(job.data, err, job.id);
        // Rethrow non-cancelled failures so BullMQ records them and retries.
        if (verdict === 'failed') throw err;
      }
    },
    {
      connection: getJobConnection(),
      // lockDuration must comfortably exceed the longest expected job;
      // otherwise BullMQ marks the job as orphaned and re-queues it
      // while the worker is still processing → duplicate work + the
      // statements row gets stomped. Worst-case scenario:
      //   * 50-page OCR run (local Ollama Qwen-VL vision)
      //   * ~50s per page worst case on CPU
      //   * batched → many sequential rounds → ~21 min
      // Default 30 min (with the historical 60s buffer) covers that
      // and a noisy retry; GPU operators waste nothing because the
      // job finishes in seconds and releases the lock immediately.
      lockDuration: Number(process.env.VIBETC_EXTRACTION_TIMEOUT_MS ?? 1_800_000) + 60_000,
      concurrency: Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 1)),
    },
  );
};
