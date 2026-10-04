// Check-payee resolution service. Given a statement, finds every
// transaction whose check_number was extracted, rasterizes the source
// PDF pages, reads any cancelled-check images, and writes the resolved payee
// onto matching transactions' `payee` column (the OFX <NAME> source). Page
// images are processed locally and never egress (ADR-023/ADR-025).
//
// Reading path (ADR-025): PRIMARY = local GLM-OCR transcribes the page, then
// the local text model parses the structured check fields from that text.
// FALLBACK = the local vision model (qwen3-vl:30b) reads the images directly
// for the batches GLM-OCR could not handle, or for every batch when the
// primary finds no payees at all.
//
// Why a separate service from enrichment.ts: the enrichment pipeline is
// text-only (cleansed descriptions + categories through a text LLM call).
// Check resolution needs page IMAGES. Text-layer statements are the key
// beneficiary: their main extraction never sees check images, so this
// rasterize→read pass is the only way to read those payees.

import { and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';

import {
  CHECK_RESOLVE_JSON_SCHEMA,
  CHECK_RESOLVE_SYSTEM_PROMPT,
  CHECK_RESOLVE_USER_PROMPT,
  batchPageImages,
  rasterizePdf,
  removeRasterDir,
} from '@vibe-tx-converter/extractor';
import { schemas } from '@vibe-tx-converter/shared';
import { readFile } from 'node:fs/promises';

import type { Db } from '../db/client.js';
import { statements, transactions } from '../db/schema.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { buildProviderForId, buildProviderForProcess } from './llm-provider.js';
import { addStatementLlmCost, anthropicCapStatus } from './llm-spend.js';

export interface CheckResolveResult {
  txCount: number; // total transactions on the statement
  candidateCount: number; // transactions with a check_number set
  llmExtractedCount: number; // checks the model claimed to see
  matchedCount: number; // payees written onto a transaction matched by check_number
  updatedTxIds: string[]; // the transactions whose payee was written (matchedCount of them)
  skippedUserEditedCount: number; // matched, but kept the operator's edited payee
  unmatchedCheckNumbers: string[]; // model saw these but no tx had them
  pageCount: number; // pages sent to the vision call
  costMicros: bigint; // whole run: text-parse + vision fallback
  model: string | null; // every model used, joined
  // Text-parse leg (GLM-OCR transcription → text model). textProviderId is the
  // provider those calls went to ('local' | 'anthropic' | 'vibe_router'), or
  // null when none was made; Anthropic receives transcription text only.
  textProviderId: string | null;
  textParseCalls: number;
  textParseCostMicros: bigint;
}

export class CheckResolveUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckResolveUnavailableError';
  }
}

export class NoCheckTransactionsError extends Error {
  constructor() {
    super('this statement has no transactions with a check number — nothing to resolve');
    this.name = 'NoCheckTransactionsError';
  }
}

// Total-page safety guard. Pages are batched (1–3 per vision call) so memory
// stays bounded; this caps the whole statement so a pathological upload can't
// fan out into hundreds of vision calls. Statements this large are vanishingly
// rare; fail loud and tell the operator to split.
const MAX_PAGES = 60;

export const resolveCheckPayees = async (db: Db, stmtId: string): Promise<CheckResolveResult> => {
  const stmtRows = await db.select().from(statements).where(eq(statements.id, stmtId));
  const stmt = stmtRows[0];
  if (!stmt) throw new NotFoundError(`statement ${stmtId}`);
  if (stmt.sourcePdfDeleted) {
    throw new ValidationError(
      'source PDF has been removed for this statement — check resolution requires the original file',
    );
  }

  // Candidate transactions = anything with a check_number set. The
  // worker fills check_number whenever the LLM extractor pulled one
  // out of the markdown ("CHECK 1234" or "Check #1234"); the trntype
  // hint isn't reliable enough to filter on (some banks tag wires as
  // CHECK too).
  const allTxs = await db
    .select()
    .from(transactions)
    .where(eq(transactions.statementId, stmtId))
    .orderBy(transactions.postedDate, transactions.seqInDay);
  const candidates = allTxs.filter((t) => t.checkNumber !== null && t.checkNumber.length > 0);
  if (candidates.length === 0) {
    throw new NoCheckTransactionsError();
  }

  // Local provider. Check reading runs on-appliance: GLM-OCR (primary) +
  // Ollama qwen3-vl (fallback); page images never egress (ADR-025). This
  // provider ALWAYS reads the images locally regardless of the matrix.
  let provider;
  try {
    provider = await buildProviderForId(db, 'local');
  } catch (err) {
    throw new CheckResolveUnavailableError(
      `local provider not available: ${(err as Error).message}. ` +
        'Ensure GLM-OCR (GLM_OCR_URL) and Ollama (with qwen3-vl pulled) are reachable (see /admin/llm-provider).',
    );
  }

  // Text-parse provider from the per-process "check" matrix. Parses the
  // structured check fields from the LOCAL GLM-OCR transcription, so it may be
  // Anthropic (text-only — images never reach it). Falls back to the local
  // provider if the configured one can't be built (e.g. Anthropic without a key).
  let textProvider = provider;
  let textProviderId: 'local' | 'anthropic' | 'vibe_router' = 'local';
  try {
    const built = await buildProviderForProcess(db, 'check');
    textProvider = built.provider;
    textProviderId = built.providerId;
  } catch (err) {
    logger.warn(
      { stmtId, err: (err as Error).message },
      'check text-parse provider unavailable — using local',
    );
  }
  if (textProviderId === 'anthropic') {
    // Anthropic spend counts toward the monthly cap; once it's reached, parse
    // the transcription on the local text model instead of a billed call.
    const cap = await anthropicCapStatus(db);
    if (cap.blocked) {
      logger.info(
        { stmtId },
        'monthly Anthropic spend cap reached — check payee text-parse using the local provider',
      );
      textProvider = provider;
      textProviderId = 'local';
    } else {
      logger.info(
        { stmtId },
        'check payee text-parse routed to Anthropic (transcription text only)',
      );
    }
  }

  // Rasterize the PDF at 300 DPI PNG (small check thumbnails need the fidelity)
  // and read them into buffers, then batch (1–3 pages per vision call). A split
  // (multi-account) statement shares its PDF with sibling statements — render
  // only its own page slice so another account's checks can never be read
  // (or claim this statement's rows), nor count against the page cap.
  const range = stmt.pageRange;
  const rasters = await rasterizePdf(stmt.sourcePdfPath, {
    dpi: 300,
    ...(range ? { firstPage: range.start, lastPage: range.end } : {}),
  });
  const images: Array<{ data: Buffer; mediaType: 'image/png' }> = [];
  try {
    if (rasters.length === 0) {
      throw new ValidationError('PDF rasterization produced no pages');
    }
    if (rasters.length > MAX_PAGES) {
      throw new ValidationError(
        `statement has ${rasters.length} pages, exceeding the cap of ${MAX_PAGES}; ` +
          'split the statement first or contact support to raise the cap',
      );
    }
    for (const r of rasters) {
      images.push({ data: await readFile(r.pngPath), mediaType: 'image/png' as const });
    }
  } finally {
    // The rendered pages carry cancelled-check images (signatures, MICR account
    // numbers) — they're in memory now, so never leave them on disk.
    await removeRasterDir(rasters).catch((err: unknown) => {
      logger.warn(
        { stmtId, err: (err as Error).message },
        'could not remove check-resolve page images',
      );
    });
  }

  // A check appears on a single page, so concatenating per-batch results is
  // correct. One bad/illegible batch must not sink the whole run — collect
  // what parses and log the rest.
  //
  // PRIMARY (ADR-025): GLM-OCR transcribes the check region, then the text
  // model parses the structured check fields from that transcription —
  // GLM-OCR is a transcription engine, not a JSON-adherent extractor.
  // FALLBACK: the vision model (qwen3-vl:30b) re-reads the images directly for
  // every batch the primary did not parse (GLM-OCR error / empty transcription,
  // which also stops the primary for the batches after it; a reply that fails
  // the schema). When the primary found no usable payee anywhere it re-reads
  // every batch. Both paths are local.
  const startedAt = Date.now();
  const batches = batchPageImages(images);
  const hasUsablePayee = (checks: schemas.checkResolve.CheckResolveResult['checks']): boolean =>
    checks.some((c) => typeof c.payee === 'string' && c.payee.trim().length > 0);

  const extracted: schemas.checkResolve.CheckResolveResult['checks'] = [];
  let costMicros = 0n;
  const modelLabels: string[] = [];
  let textParseCalls = 0;
  let textParseCostMicros = 0n;
  let textProviderUsed: string | null = null;
  // Batches whose checks the primary parsed. They are never re-read by the
  // fallback while the primary's results are kept: a second read of a page with
  // a reused check number could claim another row via the sole-candidate rule.
  const primaryParsed = new Set<number>();
  let primaryFailedHard = false;

  for (const [i, batch] of batches.entries()) {
    try {
      const ocr = await provider.ocrImagesToText(batch.images);
      if (ocr.text.trim().length === 0) {
        // GLM-OCR returned nothing for a batch with check images present —
        // treat as a hard miss; this batch and the rest go to the fallback.
        primaryFailedHard = true;
        break;
      }
      // Counted before the await so a call that throws is still on record.
      textParseCalls += 1;
      textProviderUsed = textProviderId;
      const result = await textProvider.complete({
        systemPrompt: CHECK_RESOLVE_SYSTEM_PROMPT,
        userPrompt: `${CHECK_RESOLVE_USER_PROMPT}\n\nTranscribed check text:\n${ocr.text}`,
        schema: CHECK_RESOLVE_JSON_SCHEMA,
        schemaName: 'emit_checks',
        maxOutputTokens: 4096,
      });
      textParseCostMicros += result.telemetry.costMicros;
      costMicros += result.telemetry.costMicros;
      modelLabels.push(`${ocr.model}+${result.telemetry.model}`);
      const parsed = schemas.checkResolve.CheckResolveResult.safeParse(result.data);
      if (!parsed.success) {
        logger.warn(
          { stmtId, startPage: batch.startPage, issues: parsed.error.issues.slice(0, 3) },
          'check-resolve (GLM) batch did not match schema; leaving it to the vision fallback',
        );
        continue;
      }
      primaryParsed.add(i);
      extracted.push(...parsed.data.checks);
    } catch (err) {
      logger.warn(
        { stmtId, startPage: batch.startPage, err: (err as Error).message },
        'GLM-OCR check transcribe/parse failed — falling back to the vision model',
      );
      primaryFailedHard = true;
      break;
    }
  }

  // No usable payee from the primary → nothing it parsed can be double-claimed,
  // so the vision model re-reads every batch (replacing the payee-less primary
  // reads so they aren't counted twice). Otherwise only the unparsed batches.
  const rereadAll = !hasUsablePayee(extracted);
  const fallbackBatches = batches
    .map((batch, i) => ({ batch, i }))
    .filter(({ i }) => rereadAll || !primaryParsed.has(i));
  if (fallbackBatches.length > 0) {
    logger.info(
      {
        stmtId,
        reason: rereadAll ? 'no-payees' : 'unparsed-batches',
        glmError: primaryFailedHard,
        batches: fallbackBatches.length,
      },
      'check-resolve falling back to vision model (qwen3-vl)',
    );
    if (rereadAll) extracted.length = 0;
    for (const { batch } of fallbackBatches) {
      // One bad/illegible batch (vision timeout / HTTP error) must not sink the
      // whole run or discard payees already matched — mirror the primary loop.
      try {
        const result = await provider.completeWithImages({
          systemPrompt: CHECK_RESOLVE_SYSTEM_PROMPT,
          userPrompt: CHECK_RESOLVE_USER_PROMPT,
          schema: CHECK_RESOLVE_JSON_SCHEMA,
          schemaName: 'emit_checks',
          maxOutputTokens: 4096,
          images: batch.images,
        });
        costMicros += result.telemetry.costMicros;
        modelLabels.push(result.telemetry.model);
        const parsed = schemas.checkResolve.CheckResolveResult.safeParse(result.data);
        if (!parsed.success) {
          logger.warn(
            { stmtId, startPage: batch.startPage, issues: parsed.error.issues.slice(0, 3) },
            'check-resolve (vision fallback) batch did not match schema; skipping',
          );
          continue;
        }
        extracted.push(...parsed.data.checks);
      } catch (err) {
        logger.warn(
          { stmtId, startPage: batch.startPage, err: (err as Error).message },
          'check-resolve (vision fallback) batch failed; skipping',
        );
      }
    }
  }
  const model = modelLabels.length > 0 ? [...new Set(modelLabels)].join(' + ') : null;
  const llmExtractedCount = extracted.length;
  logger.info(
    {
      stmtId,
      pages: images.length,
      batches: batches.length,
      durationMs: Date.now() - startedAt,
      model,
    },
    'check-resolve vision pass complete',
  );

  // The spend is final here — record it before any row writes so a DB error
  // below can't lose it (the Anthropic monthly cap sums this ledger).
  await addStatementLlmCost(db, stmtId, costMicros);

  // Group candidate transactions by normalized check number (trim + lowercase).
  // A reused check number can have multiple candidate rows, so disambiguate by
  // amount (the check amount is positive; the tx amount is a signed debit).
  const norm = (s: string): string => s.trim().toLowerCase();
  const byCheckNumber = new Map<string, (typeof candidates)[number][]>();
  for (const t of candidates) {
    if (!t.checkNumber) continue;
    const k = norm(t.checkNumber);
    (byCheckNumber.get(k) ?? byCheckNumber.set(k, []).get(k)!).push(t);
  }
  const absBig = (n: bigint): bigint => (n < 0n ? -n : n);

  let matchedCount = 0;
  let skippedUserEditedCount = 0;
  const updatedTxIds: string[] = [];
  const unmatched: string[] = [];
  const usedTxIds = new Set<string>();
  for (const c of extracted) {
    if (!c.payee || c.payee.trim().length === 0) continue;
    const cands = (byCheckNumber.get(norm(c.check_number)) ?? []).filter(
      (t) => !usedTxIds.has(t.id),
    );
    if (cands.length === 0) {
      unmatched.push(c.check_number);
      continue;
    }
    // Amount check: the candidate's |amount| must match the check's amount
    // within a cent whenever the check shows one — that picks among reused
    // numbers, and keeps a sole candidate from being claimed by a check whose
    // number was misread or belongs to another account. No amount on the
    // check: only a sole candidate is taken; several are ambiguous (skip).
    const amountOk = (t: (typeof cands)[number]): boolean =>
      c.amount_cents == null ||
      absBig(absBig(t.amountCents) - BigInt(Math.abs(c.amount_cents))) <= 1n;
    let hit: (typeof cands)[number] | undefined;
    if (cands.length === 1) {
      hit = amountOk(cands[0]!) ? cands[0] : undefined;
    } else if (c.amount_cents != null) {
      hit = cands.find(amountOk);
    }
    if (!hit) {
      unmatched.push(c.check_number);
      continue;
    }
    usedTxIds.add(hit.id);
    // Write the payee onto the dedicated column — exports prefer it for the
    // OFX <NAME>. Leave cleansedDescription + enrichment flags untouched.
    // The write is scoped to this exact transaction id (a generation-specific
    // UUID), so if the statement was deleted or re-extracted during the (minutes-
    // long) vision pass, the row id no longer exists and this simply updates 0
    // rows — it can never stamp a payee onto a superseding extraction's rows.
    // A payee the operator corrected (PATCH sets user_edited) is never replaced.
    const written = await db
      .update(transactions)
      .set({ payee: c.payee.trim().slice(0, 200), updatedAt: sql`now()` })
      .where(
        and(
          eq(transactions.id, hit.id),
          isNotNull(transactions.checkNumber),
          or(isNull(transactions.payee), eq(transactions.userEdited, false)),
        ),
      )
      .returning({ id: transactions.id });
    if (written.length > 0) {
      matchedCount += 1;
      updatedTxIds.push(hit.id);
      continue;
    }
    // Nothing written: the operator edited the row (kept), or it vanished.
    const [row] = await db
      .select({ userEdited: transactions.userEdited })
      .from(transactions)
      .where(eq(transactions.id, hit.id));
    if (row?.userEdited) skippedUserEditedCount += 1;
  }

  return {
    txCount: allTxs.length,
    candidateCount: candidates.length,
    llmExtractedCount,
    matchedCount,
    updatedTxIds,
    skippedUserEditedCount,
    unmatchedCheckNumbers: unmatched,
    pageCount: images.length,
    costMicros,
    model,
    textProviderId: textProviderUsed,
    textParseCalls,
    textParseCostMicros,
  };
};
