// Check-payee resolution service. Given a statement, finds every
// transaction whose check_number was extracted, rasterizes the source
// PDF pages, reads any cancelled-check images, and writes the resolved payee
// onto matching transactions' `payee` column (the OFX <NAME> source). Page
// images are processed locally and never egress (ADR-023/ADR-025).
//
// Reading path (ADR-025): PRIMARY = local GLM-OCR transcribes the page, then
// the local text model parses the structured check fields from that text.
// FALLBACK = the local vision model (qwen3-vl:30b) reads the images directly
// when GLM-OCR fails or the primary finds no payees.
//
// Why a separate service from enrichment.ts: the enrichment pipeline is
// text-only (cleansed descriptions + categories through a text LLM call).
// Check resolution needs page IMAGES. Text-layer statements are the key
// beneficiary: their main extraction never sees check images, so this
// rasterize→read pass is the only way to read those payees.

import { and, eq, isNotNull, sql } from 'drizzle-orm';

import {
  CHECK_RESOLVE_JSON_SCHEMA,
  CHECK_RESOLVE_SYSTEM_PROMPT,
  CHECK_RESOLVE_USER_PROMPT,
  batchPageImages,
  rasterizePdf,
} from '@vibe-tx-converter/extractor';
import { schemas } from '@vibe-tx-converter/shared';
import { readFile } from 'node:fs/promises';

import type { Db } from '../db/client.js';
import { statements, transactions } from '../db/schema.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { buildProviderForId, buildProviderForProcess } from './llm-provider.js';

export interface CheckResolveResult {
  txCount: number; // total transactions on the statement
  candidateCount: number; // transactions with a check_number set
  llmExtractedCount: number; // checks the model claimed to see
  matchedCount: number; // checks matched to a transaction by check_number
  unmatchedCheckNumbers: string[]; // model saw these but no tx had them
  pageCount: number; // pages sent to the vision call
  costMicros: bigint;
  model: string | null;
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
  let textProviderId: 'local' | 'anthropic' = 'local';
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
    logger.info({ stmtId }, 'check payee text-parse routed to Anthropic (transcription text only)');
  }

  // Rasterize the PDF at 300 DPI PNG (small check thumbnails need the fidelity)
  // and read them into buffers, then batch (1–3 pages per vision call).
  const rasters = await rasterizePdf(stmt.sourcePdfPath, { dpi: 300 });
  if (rasters.length === 0) {
    throw new ValidationError('PDF rasterization produced no pages');
  }
  if (rasters.length > MAX_PAGES) {
    throw new ValidationError(
      `statement has ${rasters.length} pages, exceeding the cap of ${MAX_PAGES}; ` +
        'split the statement first or contact support to raise the cap',
    );
  }
  const images: Array<{ data: Buffer; mediaType: 'image/png' }> = [];
  for (const r of rasters) {
    images.push({ data: await readFile(r.pngPath), mediaType: 'image/png' as const });
  }

  // A check appears on a single page, so concatenating per-batch results is
  // correct. One bad/illegible batch must not sink the whole run — collect
  // what parses and log the rest.
  //
  // PRIMARY (ADR-025): GLM-OCR transcribes the check region, then the local
  // text model parses the structured check fields from that transcription —
  // GLM-OCR is a transcription engine, not a JSON-adherent extractor.
  // FALLBACK: when GLM-OCR fails (server down / empty transcription) or the
  // primary finds no usable payee despite candidate check rows, re-read the
  // images directly on the vision model (qwen3-vl:30b). Both paths are local.
  const startedAt = Date.now();
  const batches = batchPageImages(images);
  const hasUsablePayee = (checks: schemas.checkResolve.CheckResolveResult['checks']): boolean =>
    checks.some((c) => typeof c.payee === 'string' && c.payee.trim().length > 0);

  const extracted: schemas.checkResolve.CheckResolveResult['checks'] = [];
  let costMicros = 0n;
  let model: string | null = null;
  let primaryFailedHard = false;

  for (const batch of batches) {
    try {
      const ocr = await provider.ocrImagesToText(batch.images);
      if (ocr.text.trim().length === 0) {
        // GLM-OCR returned nothing for a batch with check images present —
        // treat as a hard miss and let the vision fallback re-read everything.
        primaryFailedHard = true;
        break;
      }
      const result = await textProvider.complete({
        systemPrompt: CHECK_RESOLVE_SYSTEM_PROMPT,
        userPrompt: `${CHECK_RESOLVE_USER_PROMPT}\n\nTranscribed check text:\n${ocr.text}`,
        schema: CHECK_RESOLVE_JSON_SCHEMA,
        schemaName: 'emit_checks',
        maxOutputTokens: 4096,
      });
      costMicros += result.telemetry.costMicros;
      model = `${ocr.model}+${result.telemetry.model}`;
      const parsed = schemas.checkResolve.CheckResolveResult.safeParse(result.data);
      if (!parsed.success) {
        logger.warn(
          { stmtId, startPage: batch.startPage, issues: parsed.error.issues.slice(0, 3) },
          'check-resolve (GLM) batch did not match schema; skipping',
        );
        continue;
      }
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

  if (primaryFailedHard || (!hasUsablePayee(extracted) && candidates.length > 0)) {
    logger.info(
      { stmtId, reason: primaryFailedHard ? 'glm-error' : 'no-payees', batches: batches.length },
      'check-resolve falling back to vision model (qwen3-vl)',
    );
    extracted.length = 0;
    costMicros = 0n;
    let fallbackModel: string | null = null;
    for (const batch of batches) {
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
        fallbackModel = result.telemetry.model;
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
    model = fallbackModel;
  }
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
    // Amount tiebreak: pick the candidate whose |amount| matches the check's
    // amount within a cent; else the sole candidate; else skip (ambiguous).
    let hit: (typeof cands)[number] | undefined;
    if (cands.length === 1) {
      hit = cands[0];
    } else if (c.amount_cents != null) {
      const want = BigInt(Math.abs(c.amount_cents));
      hit = cands.find((t) => absBig(absBig(t.amountCents) - want) <= 1n);
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
    await db
      .update(transactions)
      .set({ payee: c.payee.trim().slice(0, 200), updatedAt: sql`now()` })
      .where(and(eq(transactions.id, hit.id), isNotNull(transactions.checkNumber)));
    matchedCount += 1;
  }

  return {
    txCount: allTxs.length,
    candidateCount: candidates.length,
    llmExtractedCount,
    matchedCount,
    unmatchedCheckNumbers: unmatched,
    pageCount: images.length,
    costMicros,
    model,
  };
};
