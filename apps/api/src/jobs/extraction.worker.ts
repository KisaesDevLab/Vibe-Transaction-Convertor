import { Worker } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';

import {
  analyzePdfFromBuffer,
  detectMultiAccount,
  extractTextLayerFromBuffer,
  ocrPdfPages,
  rasterizePdf,
  routePdf,
  type ExtractionMethod,
} from '@vibe-tx-converter/extractor';
import { reconcileGoldenRule, repairPass } from '@vibe-tx-converter/reconciler';
import {
  assignSeqInDay,
  computeFitid,
  inferTrntype,
  normalizeDescription,
} from '@vibe-tx-converter/exporters';
import { schemas } from '@vibe-tx-converter/shared';

import { db } from '../db/client.js';
import { accounts, statements, transactions } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { buildProvider } from '../services/llm-provider.js';
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

export const processExtraction = async (data: ExtractionJobData): Promise<void> => {
  const stmtId = data.statementId;
  await setStatus(stmtId, 'preprocessing');

  // Look up the account up front so TRNTYPE inference can apply the
  // credit-card sign convention (Phase 17 — `isCreditCard` flag).
  const acctRows = await db.select().from(accounts).where(eq(accounts.id, data.accountId));
  const isCreditCard = acctRows[0]?.accountType === 'CREDITCARD';

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

  let markdown: string;

  if (method === 'text') {
    const pages = await extractTextLayerFromBuffer(await readFile(data.sourcePdfPath));
    markdown = pages.map((p) => `# Page ${p.index + 1}\n\n${p.text}`).join('\n\n');
    // Persist detected splits so the UI can offer a confirmation flow.
    // The user can either acknowledge ('whole PDF is one account, proceed')
    // or upload pages separately. Phase 14.
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
  } else {
    // OCR path. rasterizePdf shells out to pdftoppm (poppler-utils).
    // The standalone Dockerfile installs poppler; on host machines the
    // operator needs `brew install poppler` (or apt/choco equivalent).
    const rasters = await rasterizePdf(data.sourcePdfPath, { dpi: 300 });
    const images = await Promise.all(rasters.map(async (r) => readFile(r.pngPath)));
    const ocr = await ocrPdfPages(images);
    markdown = ocr.pages.map((p) => `# Page ${p.index + 1}\n\n${p.markdown}`).join('\n\n');
  }

  // LLM extraction. Pass the JSON Schema explicitly so the local Vibe
  // Gateway uses guided_json mode (ADR-004); the Anthropic provider
  // gets the same schema via its tool_use input_schema (ADR-020).
  await setStatus(stmtId, 'extracting');
  const provider = await buildProvider(db);
  const result = await provider.extract(markdown, schemas.extraction.ExtractionJsonSchema);

  await db
    .update(statements)
    .set({
      llmProvider: provider.id,
      llmInputTokens: result.telemetry.inputTokens,
      llmOutputTokens: result.telemetry.outputTokens,
      llmCallCount: 1,
      llmCostMicros: result.telemetry.costMicros,
      llmModelVersion: result.telemetry.model,
      sourceDateFormat: result.data.source_date_format,
      sourceDateFormatConfidence: result.data.source_date_format_confidence,
      periodStart: result.data.period_start,
      periodEnd: result.data.period_end,
      openingBalanceCents: BigInt(result.data.opening_balance_cents),
      closingBalanceCents: BigInt(result.data.closing_balance_cents),
      updatedAt: sql`now()`,
    })
    .where(eq(statements.id, stmtId));

  await setStatus(stmtId, 'reconciling');

  // Reconcile, then attempt the repair pass (ADR-010 + Phase 16) when
  // the Golden Rule fails. Repair tries sign-flip and drop-duplicate;
  // when it succeeds we mutate `effectiveTxs` in-place so all downstream
  // FITID + insert logic uses the corrected list.
  const openingCents = BigInt(result.data.opening_balance_cents);
  const closingCents = BigInt(result.data.closing_balance_cents);
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
    transactions: effectiveTxs.map((t) => ({ amountCents: t.amountCents })),
    periodStart: result.data.period_start,
    periodEnd: result.data.period_end,
    transactionDates: effectiveTxs.map((t) => t.postedDate),
  });

  let repairApplied: string | null = null;
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
        periodStart: result.data.period_start,
        periodEnd: result.data.period_end,
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
