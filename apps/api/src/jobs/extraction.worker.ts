import { Worker } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';

import {
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
import { buildProvider } from '../services/llm-provider.js';
import { redisOcrCache } from '../services/ocr-cache.js';
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

// Phase 15 #17 cooperative cancellation. The /cancel route flips
// status='failed' with errorMessage 'cancelled by operator'; this
// helper polls between phases and bails before doing more LLM/DB work
// that would race the route's transaction wipe.
const checkCancelled = async (statementId: string): Promise<void> => {
  const rows = await db
    .select({ status: statements.status, errorMessage: statements.errorMessage })
    .from(statements)
    .where(eq(statements.id, statementId));
  const row = rows[0];
  if (
    row &&
    row.status === 'failed' &&
    typeof row.errorMessage === 'string' &&
    row.errorMessage.startsWith('cancelled')
  ) {
    throw new CancelledError();
  }
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
  const method: ExtractionMethod = routePdf(analysis);
  await setStatus(stmtId, method === 'ocr' ? 'ocr' : 'extracting', {
    extractionMethod: method,
    sourcePdfPages: analysis.pageCount,
  });

  // Phase 14: when this statement is a per-account slice (page_range
  // set), filter pages to that range BEFORE handing markdown to the LLM.
  // The LLM sees one account's slice as if it were the whole PDF.
  const pageRange = stmtRows[0]?.pageRange ?? null;
  const inRange = (pageIndex0: number): boolean => {
    if (!pageRange) return true;
    const page1 = pageIndex0 + 1;
    return page1 >= pageRange.start && page1 <= pageRange.end;
  };

  let markdown: string;

  if (method === 'text') {
    const pages = await extractTextLayerFromBuffer(await readFile(data.sourcePdfPath));
    const scoped = pages.filter((p) => inRange(p.index));
    markdown = scoped.map((p) => `# Page ${p.index + 1}\n\n${p.text}`).join('\n\n');
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
  } else {
    // OCR path. rasterizePdf shells out to pdftoppm (poppler-utils).
    // The standalone Dockerfile installs poppler; on host machines the
    // operator needs `brew install poppler` (or apt/choco equivalent).
    const rasters = await rasterizePdf(data.sourcePdfPath, { dpi: 300 });
    const scopedRasters = rasters.filter((r) => inRange(r.index));
    const images = await Promise.all(scopedRasters.map(async (r) => readFile(r.pngPath)));
    const ocr = await ocrPdfPages(images, { cache: redisOcrCache });
    markdown = ocr.pages
      .map((p, i) => `# Page ${(scopedRasters[i]?.index ?? p.index) + 1}\n\n${p.markdown}`)
      .join('\n\n');
  }

  // LLM extraction. Pass the JSON Schema explicitly so the local Vibe
  // Gateway uses guided_json mode (ADR-004); the Anthropic provider
  // gets the same schema via its tool_use input_schema (ADR-020).
  await checkCancelled(stmtId);
  await setStatus(stmtId, 'extracting');
  const provider = await buildProvider(db);

  // Phase 26 #34: enforce monthly cost cap before calling Anthropic.
  // The cap is a soft USD ceiling — checked against current calendar-
  // month accrued spend. Local provider is free, so we don't bother.
  if (provider.id === 'anthropic') {
    const capRows = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, 'llm.anthropic.monthly_cap_usd'));
    const capUsd = capRows[0]?.valuePlaintext ? Number.parseFloat(capRows[0].valuePlaintext) : null;
    if (capUsd !== null && Number.isFinite(capUsd)) {
      const spentRows = await db
        .select({
          total: sql<string>`coalesce(sum(${statements.llmCostMicros}), 0)`,
        })
        .from(statements)
        .where(sql`date_trunc('month', ${statements.createdAt}) = date_trunc('month', now())`);
      const spentUsd = Number(BigInt(spentRows[0]?.total ?? '0')) / 1_000_000;
      if (spentUsd >= capUsd) {
        const msg = `monthly Anthropic spend cap reached: $${spentUsd.toFixed(2)} ≥ $${capUsd.toFixed(2)}`;
        await db
          .update(statements)
          .set({ status: 'failed', errorMessage: msg, updatedAt: sql`now()` })
          .where(eq(statements.id, stmtId));
        logger.warn({ stmtId, spentUsd, capUsd }, 'extraction blocked by monthly cap');
        return;
      }
    }
  }

  const result = await provider.extract(markdown, {
    schema: schemas.extraction.ExtractionJsonSchema,
    ...(dateFormatOverride ? { dateFormatOverride } : {}),
  });

  // Phase 15 item 4a: when the LLM returns AMBIGUOUS, halt and ask the
  // operator. The /confirm-date-format endpoint flips the status back to
  // 'uploaded' and re-enqueues with the operator-chosen format. Skip
  // this gate when the operator has already confirmed (the worker is
  // running with dateFormatOverride set).
  // Phase 12 #1 nested shape: pull out the bits the worker needs.
  const dateFormat = result.data.source_date_format.format;
  const dateFormatConfidence = result.data.source_date_format.confidence;
  const periodStart = result.data.period.start;
  const periodEnd = result.data.period.end;
  const openingCentsNumber = result.data.balances.opening_cents;
  const closingCentsNumber = result.data.balances.closing_cents;

  if (!dateFormatOverride && dateFormat === 'AMBIGUOUS') {
    await db
      .update(statements)
      .set({
        status: 'awaiting-locale-confirmation',
        sourceDateFormat: 'AMBIGUOUS',
        sourceDateFormatConfidence: dateFormatConfidence,
        llmProvider: provider.id,
        llmInputTokens: result.telemetry.inputTokens,
        llmOutputTokens: result.telemetry.outputTokens,
        llmCallCount: 1,
        llmCostMicros: result.telemetry.costMicros,
        llmModelVersion: result.telemetry.model,
        updatedAt: sql`now()`,
      })
      .where(eq(statements.id, stmtId));
    logger.info(
      { stmtId },
      'extraction halted: ambiguous source date format — awaiting operator confirmation',
    );
    return;
  }

  await db
    .update(statements)
    .set({
      llmProvider: provider.id,
      llmInputTokens: result.telemetry.inputTokens,
      llmOutputTokens: result.telemetry.outputTokens,
      llmCallCount: 1,
      llmCostMicros: result.telemetry.costMicros,
      llmModelVersion: result.telemetry.model,
      sourceDateFormat: dateFormat,
      sourceDateFormatConfidence: dateFormatConfidence,
      periodStart,
      periodEnd,
      openingBalanceCents: BigInt(openingCentsNumber),
      closingBalanceCents: BigInt(closingCentsNumber),
      updatedAt: sql`now()`,
    })
    .where(eq(statements.id, stmtId));

  await checkCancelled(stmtId);
  await setStatus(stmtId, 'reconciling');

  // Reconcile, then attempt the repair pass (ADR-010 + Phase 16) when
  // the Golden Rule fails. Repair tries sign-flip and drop-duplicate;
  // when it succeeds we mutate `effectiveTxs` in-place so all downstream
  // FITID + insert logic uses the corrected list.
  const openingCents = BigInt(openingCentsNumber);
  const closingCents = BigInt(closingCentsNumber);
  let effectiveTxs = result.data.transactions.map((t, idx) => ({
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

  let reconciled = reconcileGoldenRule({
    openingBalanceCents: openingCents,
    closingBalanceCents: closingCents,
    transactions: effectiveTxs.map((t) => ({
      amountCents: t.amountCents,
      runningBalanceCents: t.runningBalanceCents,
    })),
    periodStart: periodStart,
    periodEnd: periodEnd,
    transactionDates: effectiveTxs.map((t) => t.postedDate),
  });

  let repairApplied: string | null = null;

  // Phase 16 #6: LLM-driven repair pass FIRST. When reconcile fails, send
  // the markdown back to the LLM with the failed transaction list and the
  // delta. The LLM re-reads the markdown and returns a corrected list. We
  // commit it only if the second reconcile actually verifies. Falls
  // through to the heuristic repair below on failure.
  if (reconciled.status === 'discrepancy') {
    const suspects = findSuspectRows(
      openingCents,
      effectiveTxs.map((t) => ({
        amountCents: t.amountCents,
        runningBalanceCents: t.runningBalanceCents,
      })),
    );
    const repairPrompt = repairPromptFor({
      markdown,
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
        ...(dateFormatOverride ? { dateFormatOverride } : {}),
      });
      const repairedTxs = repairResult.data.transactions.map((t, idx) => ({
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
      const verifyAfterLlmRepair = reconcileGoldenRule({
        openingBalanceCents: openingCents,
        closingBalanceCents: closingCents,
        transactions: repairedTxs.map((t) => ({
          amountCents: t.amountCents,
          runningBalanceCents: t.runningBalanceCents,
        })),
        periodStart: periodStart,
        periodEnd: periodEnd,
        transactionDates: repairedTxs.map((t) => t.postedDate),
      });
      if (verifyAfterLlmRepair.status === 'verified') {
        effectiveTxs = repairedTxs;
        reconciled = verifyAfterLlmRepair;
        repairApplied = `llm-repair (${repairedTxs.length} rows)`;
        logger.info(
          {
            stmtId,
            originalCount: result.data.transactions.length,
            repairedCount: repairedTxs.length,
          },
          'reconcile repair applied via LLM second pass',
        );
        // Roll up the second-call telemetry.
        await db
          .update(statements)
          .set({
            llmInputTokens:
              (result.telemetry.inputTokens ?? 0) + (repairResult.telemetry.inputTokens ?? 0),
            llmOutputTokens:
              (result.telemetry.outputTokens ?? 0) + (repairResult.telemetry.outputTokens ?? 0),
            llmCallCount: 2,
            llmCostMicros: result.telemetry.costMicros + repairResult.telemetry.costMicros,
            updatedAt: sql`now()`,
          })
          .where(eq(statements.id, stmtId));
      } else {
        logger.info(
          { stmtId, deltaAfterRepair: verifyAfterLlmRepair.deltaCents.toString() },
          'LLM repair did not verify — falling through to heuristic repair',
        );
      }
    } catch (err) {
      logger.warn(
        { stmtId, err: (err as Error).message },
        'LLM repair pass threw — falling through',
      );
    }
  }

  // Heuristic repair (sign-flip / drop-row) as a last resort if the LLM
  // pass also failed. Cheaper than escalating to the user but only fixes
  // a narrow class of discrepancies.
  if (reconciled.status === 'discrepancy') {
    const candidate = repairPass(
      effectiveTxs.map((t) => ({ amountCents: t.amountCents, description: t.description })),
      reconciled.deltaCents,
    );
    if (candidate) {
      // Compute the repaired list in a temp variable; only commit it
      // back to effectiveTxs if the second reconcile actually verifies.
      // Otherwise we'd corrupt the user's row data with no reward.
      const repairedAmounts = candidate.transactions;
      let candidateTxs: typeof effectiveTxs;
      if (repairedAmounts.length === effectiveTxs.length) {
        candidateTxs = effectiveTxs.map((t, i) => ({
          ...t,
          amountCents: repairedAmounts[i]!.amountCents,
        }));
      } else {
        // length differs → a row was dropped; rebuild by matching position.
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
        periodStart: periodStart,
        periodEnd: periodEnd,
        transactionDates: candidateTxs.map((t) => t.postedDate),
      });
      if (verifyAfterRepair.status === 'verified') {
        effectiveTxs = candidateTxs;
        reconciled = verifyAfterRepair;
        repairApplied = candidate.fixDescription;
        logger.info({ stmtId, fix: candidate.fixDescription }, 'reconcile repair applied');
      } else {
        logger.info(
          { stmtId, fix: candidate.fixDescription },
          'reconcile repair candidate rejected — still discrepant after fix',
        );
      }
    }
  }

  const seqAssigned = assignSeqInDay(
    effectiveTxs.map((t) => ({
      postedDate: t.postedDate,
      amountCents: t.amountCents,
      description: t.description,
      sourceLine: t.sourceLine,
    })),
  );

  // Bulk insert transactions (idempotent on (statement_id, fitid)).
  // Iterate effectiveTxs (post-repair) so insertions reflect the
  // reconciled, repaired state — never the pre-repair LLM output.
  for (let i = 0; i < effectiveTxs.length; i += 1) {
    const tx = effectiveTxs[i]!;
    const seq = seqAssigned[i]!.seqInDay;
    const fitid = computeFitid({
      postedDate: tx.postedDate,
      amountCents: tx.amountCents,
      description: tx.description,
      seqInDay: seq,
    });
    const trntype = inferTrntype({
      description: tx.description,
      amountCents: tx.amountCents,
      isCreditCard,
      ...(tx.checkNumber ? { checkNumber: tx.checkNumber } : {}),
      ...(tx.trntypeHint ? { llmHint: tx.trntypeHint } : {}),
    });
    await db
      .insert(transactions)
      .values({
        statementId: stmtId,
        seqInDay: seq,
        postedDate: tx.postedDate,
        description: tx.description,
        normalizedDescription: normalizeDescription(tx.description),
        amountCents: tx.amountCents,
        runningBalanceCents: tx.runningBalanceCents,
        checkNumber: tx.checkNumber,
        trntype,
        fitid,
        sourcePage: tx.sourcePage,
        sourceBboxJson: null,
        confidence: tx.confidence,
      })
      .onConflictDoNothing();
  }

  await db
    .update(statements)
    .set({
      reconciliationStatus: reconciled.status === 'verified' ? 'verified' : 'discrepancy',
      periodBoundsViolations: reconciled.periodBoundsViolations,
      status: 'review',
      updatedAt: sql`now()`,
    })
    .where(eq(statements.id, stmtId));

  await writeAudit(db, {
    entityType: 'statement',
    entityId: stmtId,
    action: 'statement.extracted',
    payload: {
      method,
      provider: provider.id,
      reconciliation: reconciled.status,
      txCount: effectiveTxs.length,
      llmEmittedTxCount: result.data.transactions.length,
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
        logger.error({ err, jobId: job.id }, 'extraction job failed');
        await db
          .update(statements)
          .set({
            status: 'failed',
            errorMessage: (err as Error).message,
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
