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

import { QUEUE_EXTRACTION, getJobConnection, type ExtractionJobData } from './queues.js';

type StatementStatus = NonNullable<typeof statements.$inferInsert.status>;

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

export const processExtraction = async (data: ExtractionJobData): Promise<void> => {
  const stmtId = data.statementId;
  await setStatus(stmtId, 'preprocessing');

  // Look up the account up front so TRNTYPE inference can apply the
  // credit-card sign convention (Phase 17 — `isCreditCard` flag).
  const acctRows = await db.select().from(accounts).where(eq(accounts.id, data.accountId));
  const isCreditCard = acctRows[0]?.accountType === 'CREDITCARD';

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
  const analysis = await analyzePdfFromBuffer(await readFile(data.sourcePdfPath));

  // Phase 14: when this statement is a per-account slice (page_range
  // set), filter pages to that range BEFORE handing markdown to the LLM.
  // The LLM sees one account's slice as if it were the whole PDF.
  const pageRange = stmtRows[0]?.pageRange ?? null;
  const inRange = (pageIndex0: number): boolean => {
    if (!pageRange) return true;
    const page1 = pageIndex0 + 1;
    return page1 >= pageRange.start && page1 <= pageRange.end;
  };

  // PDF processing strategy resolves the per-statement override against
  // the firm default. Strategy decides which extraction method to try
  // first (text-layer vs OCR) and whether to fall back to OCR when the
  // LLM stack rejects the text-layer input.
  const strategy = await resolvePdfStrategy(db, stmtRows[0]?.processingStrategyOverride);
  let method: ExtractionMethod;
  if (strategy === 'force-ocr') {
    method = 'ocr';
  } else if (strategy === 'force-text') {
    if (!analysis.hasTextLayer) {
      throw new Error(
        'force-text strategy requested but this PDF has no text layer — ' +
          'switch to auto / force-ocr / auto-ocr-fallback',
      );
    }
    method = 'text';
  } else {
    method = routePdf(analysis);
  }

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
    // DB-backed URL falls back to GLM_OCR_URL env. Resolved per call so
    // an admin tweak via /admin/engines doesn't require a restart.
    const ocrConfig = await getEngineConfig(db, 'glm-ocr');
    const ocr = await ocrPdfPages(images, {
      cache: redisOcrCache,
      ...(ocrConfig.url ? { baseUrl: ocrConfig.url } : {}),
      ...(ocrConfig.timeoutMs ? { timeoutMs: ocrConfig.timeoutMs } : {}),
      ...(ocrConfig.concurrency ? { concurrency: ocrConfig.concurrency } : {}),
    });
    return ocr.pages
      .map((p, i) => `# Page ${(scopedRasters[i]?.index ?? p.index) + 1}\n\n${p.markdown}`)
      .join('\n\n');
  };

  let markdown = method === 'text' ? await produceTextMarkdown() : await produceOcrMarkdown();

  await checkCancelled(stmtId);
  await setStatus(stmtId, 'extracting');

  // Two-provider orchestration. Each attempt runs the LLM call + repair
  // pass in memory without persisting anything; the orchestrator picks
  // the better outcome and commits it once at the end.
  const policy = await resolveProviderPolicy(db);
  const { primary, secondary } = providerOrderFor(policy);
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
  const runProviderFallback = async (ctx: AttemptContext): Promise<AttemptOutcome> => {
    const first = await attemptExtraction(primary, ctx);
    if (first.dateFormat === 'AMBIGUOUS' && !ctx.dateFormatOverride) return first;
    if (first.rejection === null || secondary === null) return first;
    await writeAudit(db, {
      entityType: 'statement',
      entityId: stmtId,
      action: 'statement.extraction-fallback',
      payload: {
        from: first.providerId,
        to: secondary,
        reason: first.rejection,
        ...(first.error ? { primaryError: first.error.message } : {}),
      },
    });
    logger.info(
      { stmtId, from: first.providerId, to: secondary, reason: first.rejection },
      'falling back to secondary provider',
    );
    await setStatus(stmtId, 'extracting');
    const second = await attemptExtraction(secondary, ctx);
    if (second.dateFormat === 'AMBIGUOUS' && !ctx.dateFormatOverride) return second;
    return pickBetterAttempt(first, second);
  };

  let chosen = await runProviderFallback(attemptCtx);

  if (chosen.dateFormat === 'AMBIGUOUS' && !dateFormatOverride) {
    await persistAmbiguousHalt(chosen);
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
      'text-layer extraction rejected — retrying with GLM-OCR',
    );
    await setStatus(stmtId, 'ocr', { extractionMethod: 'hybrid' });
    markdown = await produceOcrMarkdown();
    attemptCtx = { ...attemptCtx, markdown };
    await setStatus(stmtId, 'extracting');
    const ocrChosen = await runProviderFallback(attemptCtx);
    if (ocrChosen.dateFormat === 'AMBIGUOUS' && !dateFormatOverride) {
      await persistAmbiguousHalt(ocrChosen);
      return;
    }
    chosen = pickBetterAttempt(chosen, ocrChosen);
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

  await writeAudit(db, {
    entityType: 'statement',
    entityId: stmtId,
    action: 'statement.extracted',
    payload: {
      method,
      provider: chosen.providerId,
      reconciliation: reconciled.status,
      txCount: effectiveTxs.length,
      llmEmittedTxCount: chosen.llmEmittedTxCount,
      policy,
      strategy,
      ...(repairApplied ? { repairApplied } : {}),
    },
  });
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

        // Forensic capture: write a `statement.extraction-failed` row to
        // audit_log carrying the error class, message, and (when the
        // failure was a malformed LLM response) the raw payload so the
        // operator can read it back via /api/audit?entityId=<stmtId>.
        // Truncated to 8KB so a runaway model doesn't blow up the row.
        const e = err as Error;
        const diagnostic: Record<string, unknown> = {
          errorClass: e?.constructor?.name ?? 'Error',
          message: e?.message ?? String(err),
        };
        if (err instanceof ExtractionResponseError) {
          diagnostic.summary = err.summary;
          if (err.issues !== undefined) diagnostic.issues = err.issues;
          const RAW_LIMIT = 8000;
          diagnostic.rawResponseSnippet = err.rawResponse.slice(0, RAW_LIMIT);
          if (err.rawResponse.length > RAW_LIMIT) {
            diagnostic.rawResponseTruncated = true;
            diagnostic.rawResponseLength = err.rawResponse.length;
          }
        }
        try {
          await writeAudit(db, {
            entityType: 'statement',
            entityId: job.data.statementId,
            action: 'statement.extraction-failed',
            payload: diagnostic,
          });
        } catch (auditErr) {
          // Don't let an audit write failure mask the real error.
          logger.warn({ auditErr }, 'failed to write extraction-failed audit row');
        }

        // Don't ship the raw payload through the structured logger — it
        // may carry PII from the source PDF. The audit_log row is the
        // forensic store. Keep summary + issues for the on-disk log.
        const { rawResponseSnippet: _rs, ...logDiagnostic } = diagnostic;
        logger.error({ err, jobId: job.id, ...logDiagnostic }, 'extraction job failed');

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
      // while the worker is still processing. OCR + LLM can take
      // several minutes, so default 30s is too tight.
      lockDuration: Number(process.env.VIBETC_EXTRACTION_TIMEOUT_MS ?? 600_000) + 60_000,
      concurrency: Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 1)),
    },
  );
};
