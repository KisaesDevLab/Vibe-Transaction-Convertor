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
import { reconcileGoldenRule } from '@vibe-tx-converter/reconciler';
import { assignSeqInDay, computeFitid, inferTrntype } from '@vibe-tx-converter/exporters';

import { db } from '../db/client.js';
import { statements, transactions } from '../db/schema.js';
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

  const buffer = await readFile(data.sourcePdfPath);
  const analysis = await analyzePdfFromBuffer(buffer);
  const method: ExtractionMethod = routePdf(analysis);
  await setStatus(stmtId, method === 'ocr' ? 'ocr' : 'extracting', {
    extractionMethod: method,
    sourcePdfPages: analysis.pageCount,
  });

  let markdown: string;

  if (method === 'text') {
    const pages = await extractTextLayerFromBuffer(buffer);
    markdown = pages.map((p) => `# Page ${p.index + 1}\n\n${p.text}`).join('\n\n');
    // Multi-account detection runs only on the text-layer path here;
    // for OCR the same call lands in the future after text is recovered.
    const splitInfo = detectMultiAccount(pages);
    if (splitInfo.multiAccount) {
      logger.warn(
        { stmtId, splits: splitInfo.splits },
        'multi-account PDF detected; UI confirmation flow lands in Phase 18',
      );
    }
  } else {
    // OCR path. rasterizePdf throws today (Q-006) until poppler is wired
    // in the container; this code path is exercised end-to-end once the
    // extraction worker runs in Docker.
    const rasters = await rasterizePdf(data.sourcePdfPath, { dpi: 300 });
    const images = await Promise.all(rasters.map(async (r) => readFile(r.pngPath)));
    const ocr = await ocrPdfPages(images);
    markdown = ocr.pages.map((p) => `# Page ${p.index + 1}\n\n${p.markdown}`).join('\n\n');
  }

  // LLM extraction
  await setStatus(stmtId, 'extracting');
  const provider = await buildProvider(db);
  const result = await provider.extract(markdown);

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

  // Compute seqInDay + FITID + TRNTYPE per row.
  await setStatus(stmtId, 'reconciling');
  const seqAssigned = assignSeqInDay(
    result.data.transactions.map((t, idx) => ({
      postedDate: t.posted_date,
      amountCents: t.amount_cents,
      description: t.description,
      sourceLine: idx,
    })),
  );

  const reconciled = reconcileGoldenRule({
    openingBalanceCents: BigInt(result.data.opening_balance_cents),
    closingBalanceCents: BigInt(result.data.closing_balance_cents),
    transactions: result.data.transactions.map((t) => ({ amountCents: BigInt(t.amount_cents) })),
    periodStart: result.data.period_start,
    periodEnd: result.data.period_end,
    transactionDates: result.data.transactions.map((t) => t.posted_date),
  });

  // Bulk insert transactions (idempotent on (statement_id, fitid)).
  for (let i = 0; i < result.data.transactions.length; i += 1) {
    const tx = result.data.transactions[i]!;
    const seq = seqAssigned[i]!.seqInDay;
    const fitid = computeFitid({
      postedDate: tx.posted_date,
      amountCents: tx.amount_cents,
      description: tx.description,
      seqInDay: seq,
    });
    const trntype = inferTrntype({
      description: tx.description,
      amountCents: tx.amount_cents,
      ...(tx.trntype ? { llmHint: tx.trntype } : {}),
    });
    await db
      .insert(transactions)
      .values({
        statementId: stmtId,
        seqInDay: seq,
        postedDate: tx.posted_date,
        description: tx.description,
        normalizedDescription: tx.description.toLowerCase().replace(/\s+/g, ' ').trim(),
        amountCents: BigInt(tx.amount_cents),
        runningBalanceCents:
          tx.running_balance_cents !== undefined && tx.running_balance_cents !== null
            ? BigInt(tx.running_balance_cents)
            : null,
        checkNumber: tx.check_number ?? null,
        trntype,
        fitid,
        sourcePage: tx.source_page,
        sourceBboxJson: null,
        confidence: tx.confidence ?? 1,
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
      txCount: result.data.transactions.length,
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
    { connection: getJobConnection() },
  );
};
