// Check-payee resolution service. Given a statement, finds every
// transaction whose check_number was extracted, rasterizes the source
// PDF pages, sends them as images to an Anthropic vision call with a
// structured-output tool, and writes the resolved payee back into
// `cleansedDescription` on matching transactions.
//
// Why a separate service from enrichment.ts: the existing enrichment
// pipeline is text-only (sends cleansed descriptions + business
// categories through a normal LLM completion). Check resolution
// requires page IMAGES and only works with the Anthropic provider —
// the local Qwen3-8B has no vision input. Keeping it isolated avoids
// muddling the enrichment cache and prompt-override surface.

import { and, eq, isNotNull, sql } from 'drizzle-orm';

import {
  CHECK_RESOLVE_JSON_SCHEMA,
  CHECK_RESOLVE_SYSTEM_PROMPT,
  CHECK_RESOLVE_USER_PROMPT,
  rasterizePdf,
} from '@vibe-tx-converter/extractor';
import { schemas } from '@vibe-tx-converter/shared';
import { readFile } from 'node:fs/promises';

import type { Db } from '../db/client.js';
import { statements, transactions } from '../db/schema.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { buildProviderForId } from './llm-provider.js';

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

// Cap on how many page images we send in a single call. Anthropic's
// vision API accepts up to 100 per message, but bank statements over
// ~50 pages are vanishingly rare and we'd rather fail loud than blow
// past the cap silently.
const MAX_PAGES_PER_CALL = 60;

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

  // Provider gate. Vision-only feature; the local gateway has no
  // image input so we refuse cleanly with a guidance message.
  let provider;
  try {
    provider = await buildProviderForId(db, 'anthropic');
  } catch (err) {
    throw new CheckResolveUnavailableError(
      `Anthropic provider not configured: ${(err as Error).message}. ` +
        'Add an API key on /admin/llm-provider before running check resolution.',
    );
  }
  if (provider.id !== 'anthropic') {
    throw new CheckResolveUnavailableError(
      'check resolution requires the Anthropic vision API; local provider does not support image inputs',
    );
  }

  // Rasterize the PDF. We reuse the same poppler-based rasterizer the
  // extraction worker uses — same DPI (300) so the model sees the
  // image at the same fidelity it would during a force-ocr run.
  const rasters = await rasterizePdf(stmt.sourcePdfPath, { dpi: 300 });
  if (rasters.length === 0) {
    throw new ValidationError('PDF rasterization produced no pages');
  }
  if (rasters.length > MAX_PAGES_PER_CALL) {
    throw new ValidationError(
      `statement has ${rasters.length} pages, exceeding the per-call cap of ${MAX_PAGES_PER_CALL}; ` +
        'split the statement first or contact support to raise the cap',
    );
  }
  const images: Array<{ data: Buffer; mediaType: 'image/png' }> = [];
  for (const r of rasters) {
    images.push({ data: await readFile(r.pngPath), mediaType: 'image/png' as const });
  }

  const startedAt = Date.now();
  const result = await provider.complete({
    systemPrompt: CHECK_RESOLVE_SYSTEM_PROMPT,
    userPrompt: CHECK_RESOLVE_USER_PROMPT,
    schema: CHECK_RESOLVE_JSON_SCHEMA,
    schemaName: 'emit_checks',
    maxOutputTokens: 4096,
    images,
  });
  logger.info(
    {
      stmtId,
      pages: images.length,
      durationMs: Date.now() - startedAt,
      model: result.telemetry.model,
      inputTokens: result.telemetry.inputTokens,
      outputTokens: result.telemetry.outputTokens,
    },
    'check-resolve LLM call complete',
  );

  // Validate the model's output. Bad schema → surface a clean error
  // rather than persisting half-baked data.
  const parsed = schemas.checkResolve.CheckResolveResult.safeParse(result.data);
  if (!parsed.success) {
    throw new ValidationError(
      `check-resolve response did not match schema: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  const extracted = parsed.data.checks;
  const llmExtractedCount = extracted.length;

  // Build a lookup of candidate transactions by normalized check
  // number (trim + lowercase) so '1234' and ' 1234 ' both match.
  const norm = (s: string): string => s.trim().toLowerCase();
  const byCheckNumber = new Map<string, (typeof candidates)[number]>();
  for (const t of candidates) {
    if (t.checkNumber) byCheckNumber.set(norm(t.checkNumber), t);
  }

  let matchedCount = 0;
  const unmatched: string[] = [];
  for (const c of extracted) {
    if (!c.payee || c.payee.trim().length === 0) continue;
    const hit = byCheckNumber.get(norm(c.check_number));
    if (!hit) {
      unmatched.push(c.check_number);
      continue;
    }
    // Format: `Check #1234 → John Doe` with an optional memo suffix.
    // The arrow is intentionally non-ASCII so a downstream cleanse
    // pass can detect "already resolved by check-resolve" if needed.
    const memo = c.memo && c.memo.trim().length > 0 ? ` (${c.memo.trim()})` : '';
    const enriched = `Check #${c.check_number.trim()} → ${c.payee.trim()}${memo}`;
    await db
      .update(transactions)
      .set({
        cleansedDescription: enriched,
        // Flip userEdited so a later batch enrich() doesn't clobber
        // the payee with a vanilla cleanse of "CHECK". The semantic
        // is "this row's cleansed description was set by an out-of-
        // band process; leave it alone".
        enrichmentUserEdited: true,
        enrichmentRunAt: sql`now()`,
        updatedAt: sql`now()`,
      })
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
    costMicros: result.telemetry.costMicros,
    model: result.telemetry.model,
  };
};
