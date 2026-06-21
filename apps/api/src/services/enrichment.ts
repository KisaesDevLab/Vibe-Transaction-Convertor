// Phase 33 — operator-triggered LLM enrichment for transactions.
// Cleanses the raw bank description into a normalized human-readable
// form and/or assigns a business category from the operator's editable
// category list. One batched LLM call per statement, with a Redis cache
// keyed by (raw_description, account_type, request_kind).
//
// Same provider abstraction as extraction: the new `provider.complete()`
// method takes the system + user prompts and a JSON Schema, and both
// the local Vibe Gateway and the Anthropic provider produce
// schema-validated JSON without caller-side branching.

import { schemas } from '@vibe-tx-converter/shared';
import {
  DEFAULT_CATEGORIZE_RULES,
  DEFAULT_CLEANSE_RULES,
  DEFAULT_FULL_SYSTEM_PROMPT,
  type EnrichmentPromptMode,
  enrichmentSystemPromptFor,
  enrichmentUserPromptFor,
} from '@vibe-tx-converter/extractor';
import { eq, inArray, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import {
  accounts,
  auditLog,
  businessCategories,
  statements,
  systemSettings,
  transactions,
} from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { createHash } from 'node:crypto';

import { writeAudit } from './audit.js';
import {
  ENRICHMENT_PROMPT_VERSION,
  enrichmentCache,
  type EnrichmentCacheKey,
} from './enrichment-cache.js';
import { buildProvider } from './llm-provider.js';
import { readSettingPlain, upsertSetting } from './system-settings.js';

export interface EnrichOptions {
  cleanse: boolean;
  categorize: boolean;
  actorUserId: string | null;
  // When set, only re-enrich transactions whose enrichmentUserEdited=false.
  // The button on the review page is the only intended caller; defaults to
  // true so a click never overwrites manual edits.
  skipUserEdited?: boolean;
}

export interface EnrichResult {
  txCount: number;
  enrichedCount: number;
  skippedUserEditedCount: number;
  cacheHits: number;
  llmCalls: number;
  costMicros: bigint;
  model: string | null;
  provider: 'local' | 'anthropic' | null;
}

export class EnrichmentDisabledError extends Error {
  constructor(which: 'cleanse' | 'category' | 'both') {
    super(`enrichment.${which}_enabled is false`);
    this.name = 'EnrichmentDisabledError';
  }
}

export class CategoriesEmptyError extends Error {
  constructor() {
    super('categorize=true but no active categories exist');
    this.name = 'CategoriesEmptyError';
  }
}

export class MonthlyCapReachedError extends Error {
  constructor(spent: number, cap: number) {
    super(`monthly Anthropic spend cap reached: $${spent.toFixed(2)} >= $${cap.toFixed(2)}`);
    this.name = 'MonthlyCapReachedError';
  }
}

// Defaults to true when the row is missing — the migration seeds the
// flags but a partial install (or a wiped DB) shouldn't silently
// disable the feature.
const isToggleEnabled = async (db: Db, key: string): Promise<boolean> => {
  const v = await readSettingPlain(db, key);
  if (v === null) return true;
  return v.toLowerCase() !== 'false' && v !== '0';
};

const PROMPT_KEY_MODE = 'enrichment.prompt.mode';
const PROMPT_KEY_CLEANSE_RULES = 'enrichment.prompt.cleanse_rules';
const PROMPT_KEY_CATEGORIZE_RULES = 'enrichment.prompt.categorize_rules';
const PROMPT_KEY_FULL = 'enrichment.prompt.full_system_prompt';

interface EnrichmentPromptOverrides {
  mode: EnrichmentPromptMode;
  cleanseRules: string | null;
  categorizeRules: string | null;
  fullSystemPrompt: string | null;
}

const readPromptOverrides = async (db: Db): Promise<EnrichmentPromptOverrides> => {
  const [modeRaw, cleanseRules, categorizeRules, fullSystemPrompt] = await Promise.all([
    readSettingPlain(db, PROMPT_KEY_MODE),
    readSettingPlain(db, PROMPT_KEY_CLEANSE_RULES),
    readSettingPlain(db, PROMPT_KEY_CATEGORIZE_RULES),
    readSettingPlain(db, PROMPT_KEY_FULL),
  ]);
  const mode: EnrichmentPromptMode = modeRaw === 'full' ? 'full' : 'rules';
  return { mode, cleanseRules, categorizeRules, fullSystemPrompt };
};

// Folds the operator's prompt customizations into the cache version
// string so saving an edit invalidates every prior cached entry — same
// merchant on the next statement re-runs through the LLM with the new
// rules instead of replaying the stale answer.
const promptVersionFor = (o: EnrichmentPromptOverrides): string => {
  if (
    o.mode === 'rules' &&
    o.cleanseRules === null &&
    o.categorizeRules === null &&
    o.fullSystemPrompt === null
  ) {
    return ENRICHMENT_PROMPT_VERSION;
  }
  const h = createHash('sha256');
  h.update(o.mode);
  h.update('|');
  h.update(o.cleanseRules ?? '');
  h.update('|');
  h.update(o.categorizeRules ?? '');
  h.update('|');
  h.update(o.fullSystemPrompt ?? '');
  return `${ENRICHMENT_PROMPT_VERSION}-${h.digest('hex').slice(0, 12)}`;
};

// Mirrors extraction.worker.ts cap-check (lines 166-193). When the
// caller is the local provider, this is a no-op — only Anthropic charges
// per call, so only Anthropic gets capped.
const checkMonthlyCap = async (db: Db, providerId: 'local' | 'anthropic'): Promise<void> => {
  if (providerId !== 'anthropic') return;
  const capRows = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, 'llm.anthropic.monthly_cap_usd'));
  const capUsd = capRows[0]?.valuePlaintext ? Number.parseFloat(capRows[0].valuePlaintext) : null;
  if (capUsd === null || !Number.isFinite(capUsd)) return;
  const spentRows = await db
    .select({
      total: sql<string>`coalesce(sum(${statements.llmCostMicros}), 0)`,
    })
    .from(statements)
    .where(sql`date_trunc('month', ${statements.createdAt}) = date_trunc('month', now())`);
  const spentUsd = Number(BigInt(spentRows[0]?.total ?? '0')) / 1_000_000;
  if (spentUsd >= capUsd) throw new MonthlyCapReachedError(spentUsd, capUsd);
};

const accountTypeForStatement = async (db: Db, stmtId: string): Promise<string | null> => {
  const rows = await db
    .select({ accountType: accounts.accountType })
    .from(statements)
    .innerJoin(accounts, eq(statements.accountId, accounts.id))
    .where(eq(statements.id, stmtId));
  return rows[0]?.accountType ?? null;
};

export const enrichStatement = async (
  db: Db,
  stmtId: string,
  opts: EnrichOptions,
): Promise<EnrichResult> => {
  if (!opts.cleanse && !opts.categorize) {
    throw new EnrichmentDisabledError('both');
  }
  const cleanseEnabled = await isToggleEnabled(db, 'enrichment.cleanse_enabled');
  const categoryEnabled = await isToggleEnabled(db, 'enrichment.category_enabled');
  if (opts.cleanse && !cleanseEnabled) throw new EnrichmentDisabledError('cleanse');
  if (opts.categorize && !categoryEnabled) throw new EnrichmentDisabledError('category');

  // Active category list (sorted) injected into the prompt + the LLM's
  // schema enum. Soft-archived categories never show up to the LLM but
  // historical assignments to them remain valid in the DB.
  const activeCategories = opts.categorize
    ? await db
        .select({
          id: businessCategories.id,
          name: businessCategories.name,
          description: businessCategories.description,
        })
        .from(businessCategories)
        .where(eq(businessCategories.archived, false))
        .orderBy(businessCategories.sortOrder, businessCategories.name)
    : [];
  if (opts.categorize && activeCategories.length === 0) throw new CategoriesEmptyError();

  const accountType = await accountTypeForStatement(db, stmtId);

  const allTxs = await db
    .select()
    .from(transactions)
    .where(eq(transactions.statementId, stmtId))
    .orderBy(transactions.postedDate, transactions.seqInDay);

  const skipUserEdited = opts.skipUserEdited !== false;
  const candidateTxs = skipUserEdited ? allTxs.filter((t) => !t.enrichmentUserEdited) : allTxs;
  const skippedUserEditedCount = allTxs.length - candidateTxs.length;

  if (candidateTxs.length === 0) {
    return {
      txCount: allTxs.length,
      enrichedCount: 0,
      skippedUserEditedCount,
      cacheHits: 0,
      llmCalls: 0,
      costMicros: 0n,
      model: null,
      provider: null,
    };
  }

  // Read operator prompt overrides up front so the cache key reflects
  // them — saving an edit invalidates every cached entry below without
  // a manual flush. Same overrides are passed to the LLM call later.
  const promptOverrides = await readPromptOverrides(db);
  const promptVersion = promptVersionFor(promptOverrides);

  // Cache pass — pull whatever's already cached and only send the misses
  // to the LLM. The cache key bakes in the prompt version so prompt
  // changes invalidate every entry without a manual flush.
  const cacheKeyFor = (rawDescription: string): EnrichmentCacheKey => ({
    rawDescription,
    accountType,
    promptVersion,
    cleanse: opts.cleanse,
    categorize: opts.categorize,
  });
  type Resolved = {
    txId: string;
    cleansedDescription: string | null;
    categoryName: string | null;
  };
  const resolved: Resolved[] = [];
  const missing: typeof candidateTxs = [];
  let cacheHits = 0;
  for (const tx of candidateTxs) {
    const hit = await enrichmentCache.get(cacheKeyFor(tx.description));
    if (hit) {
      cacheHits += 1;
      resolved.push({
        txId: tx.id,
        cleansedDescription: opts.cleanse ? (hit.cleansedDescription ?? null) : null,
        categoryName: opts.categorize ? (hit.category ?? null) : null,
      });
    } else {
      missing.push(tx);
    }
  }

  let llmCalls = 0;
  let costMicros = 0n;
  let model: string | null = null;
  let providerId: 'local' | 'anthropic' | null = null;

  if (missing.length > 0) {
    const provider = await buildProvider(db);
    providerId = provider.id;
    await checkMonthlyCap(db, provider.id);

    const systemPrompt = enrichmentSystemPromptFor({
      cleanse: opts.cleanse,
      categorize: opts.categorize,
      accountType,
      categories: activeCategories.map((c) => ({
        name: c.name,
        description: c.description ?? null,
      })),
      mode: promptOverrides.mode,
      cleanseRulesOverride: promptOverrides.cleanseRules,
      categorizeRulesOverride: promptOverrides.categorizeRules,
      fullSystemPromptOverride: promptOverrides.fullSystemPrompt,
    });
    const userPrompt = enrichmentUserPromptFor({
      transactions: missing.map((t, i) => ({
        index: i,
        raw_description: t.description,
        amount_cents: Number(t.amountCents),
        trntype: t.trntype,
      })),
    });
    const jsonSchema = schemas.enrichment.buildEnrichmentJsonSchema({
      cleanse: opts.cleanse,
      categorize: opts.categorize,
      categoryNames: activeCategories.map((c) => c.name),
    });

    const completion = await provider.complete({
      systemPrompt,
      userPrompt,
      schema: jsonSchema,
      schemaName: 'transaction_enrichment',
    });
    llmCalls = 1;
    costMicros = completion.telemetry.costMicros;
    model = completion.telemetry.model;

    const parsed = schemas.enrichment.EnrichmentResponse.parse(completion.data);
    // Re-attach LLM output to the matching missing-tx by index. Schema
    // requires every row to come back; if the LLM somehow emits fewer,
    // skip the unfilled tail.
    for (const out of parsed.transactions) {
      const tx = missing[out.index];
      if (!tx) continue;
      const cleansedDescription = opts.cleanse ? (out.cleansed_description ?? null) : null;
      const categoryName = opts.categorize ? (out.category ?? null) : null;
      resolved.push({ txId: tx.id, cleansedDescription, categoryName });
      // Best-effort cache write so the same merchant on the next
      // statement is a hit. A failing Redis silently no-ops.
      void enrichmentCache.set(cacheKeyFor(tx.description), {
        ...(cleansedDescription !== null ? { cleansedDescription } : {}),
        ...(categoryName !== null ? { category: categoryName } : {}),
      });
    }
  }

  // Map category names to ids in one pass — the schema enforced the LLM
  // to pick from the active set, but case differences or a removed
  // category between "list-fetch" and "row-update" would break the
  // FK if we trusted the name blindly.
  const categoryNameToId = new Map<string, string>(
    activeCategories.map((c) => [c.name.toLowerCase(), c.id]),
  );

  // Apply updates. One transaction per row keeps the trigger-based
  // audit-log immutability behaviour clean (we only INSERT to audit_log)
  // and avoids partial-row commits when the FK lookup fails.
  let enrichedCount = 0;
  await db.transaction(async (tx) => {
    for (const r of resolved) {
      const update: Record<string, unknown> = { enrichmentRunAt: sql`now()` };
      if (opts.cleanse) update.cleansedDescription = r.cleansedDescription;
      if (opts.categorize) {
        const categoryId = r.categoryName
          ? (categoryNameToId.get(r.categoryName.toLowerCase()) ?? null)
          : null;
        update.businessCategoryId = categoryId;
      }
      // Drizzle requires .set to be non-empty; the enrichmentRunAt
      // touch above guarantees it.
      await tx.update(transactions).set(update).where(eq(transactions.id, r.txId));
      enrichedCount += 1;
    }

    await tx.insert(auditLog).values({
      actorUserId: opts.actorUserId,
      entityType: 'statement',
      entityId: stmtId,
      action: 'statement.enriched',
      payload: {
        cleanse: opts.cleanse,
        categorize: opts.categorize,
        txCount: allTxs.length,
        enrichedCount,
        skippedUserEditedCount,
        cacheHits,
        llmCalls,
        costMicros: costMicros.toString(),
        model,
        provider: providerId,
      },
    });
  });

  logger.info(
    {
      stmtId,
      txCount: allTxs.length,
      enrichedCount,
      skippedUserEditedCount,
      cacheHits,
      llmCalls,
      costMicros: costMicros.toString(),
      provider: providerId,
    },
    'statement enriched',
  );

  return {
    txCount: allTxs.length,
    enrichedCount,
    skippedUserEditedCount,
    cacheHits,
    llmCalls,
    costMicros,
    model,
    provider: providerId,
  };
};

// Used by routes/admin.ts to filter requested transaction IDs to a
// single statement (defense against a body that names rows from a
// different statement).
export const enrichmentToggleStatus = async (
  db: Db,
): Promise<{ cleanseEnabled: boolean; categoryEnabled: boolean }> => ({
  cleanseEnabled: await isToggleEnabled(db, 'enrichment.cleanse_enabled'),
  categoryEnabled: await isToggleEnabled(db, 'enrichment.category_enabled'),
});

export interface EnrichmentPromptStatus {
  mode: EnrichmentPromptMode;
  cleanseRules: { current: string; isOverride: boolean; defaultValue: string };
  categorizeRules: { current: string; isOverride: boolean; defaultValue: string };
  fullSystemPrompt: { current: string; isOverride: boolean; defaultValue: string };
  promptVersion: string;
}

// Snapshot of the live enrichment-prompt configuration for the admin
// "edit prompt" page. `current` is what the LLM will see on the next
// run; `defaultValue` lets the SPA show a "reset to default" button
// without duplicating the strings on the SPA side.
export const enrichmentPromptStatus = async (db: Db): Promise<EnrichmentPromptStatus> => {
  const o = await readPromptOverrides(db);
  return {
    mode: o.mode,
    cleanseRules: {
      current: o.cleanseRules ?? DEFAULT_CLEANSE_RULES,
      isOverride: o.cleanseRules !== null,
      defaultValue: DEFAULT_CLEANSE_RULES,
    },
    categorizeRules: {
      current: o.categorizeRules ?? DEFAULT_CATEGORIZE_RULES,
      isOverride: o.categorizeRules !== null,
      defaultValue: DEFAULT_CATEGORIZE_RULES,
    },
    fullSystemPrompt: {
      current: o.fullSystemPrompt ?? DEFAULT_FULL_SYSTEM_PROMPT,
      isOverride: o.fullSystemPrompt !== null,
      defaultValue: DEFAULT_FULL_SYSTEM_PROMPT,
    },
    promptVersion: promptVersionFor(o),
  };
};

export interface EnrichmentPromptUpdate {
  mode?: EnrichmentPromptMode | undefined;
  // Pass an empty string or null to clear the override and fall back
  // to the built-in default. Pass undefined to leave the field
  // untouched.
  cleanseRules?: string | null | undefined;
  categorizeRules?: string | null | undefined;
  fullSystemPrompt?: string | null | undefined;
}

export const setEnrichmentPrompt = async (
  db: Db,
  update: EnrichmentPromptUpdate,
  actorUserId: string,
): Promise<EnrichmentPromptStatus> => {
  // Empty-string is treated as "clear the override" — operators
  // expect "delete the contents and save" to revert to the default,
  // not save an empty prompt that would break the LLM.
  const normalize = (v: string | null | undefined): string | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    return v.trim().length === 0 ? null : v;
  };
  const cleanseRules = normalize(update.cleanseRules);
  const categorizeRules = normalize(update.categorizeRules);
  const fullSystemPrompt = normalize(update.fullSystemPrompt);

  if (update.mode !== undefined) {
    await upsertSetting(db, PROMPT_KEY_MODE, update.mode, actorUserId);
  }
  if (cleanseRules !== undefined) {
    await upsertSetting(db, PROMPT_KEY_CLEANSE_RULES, cleanseRules, actorUserId);
  }
  if (categorizeRules !== undefined) {
    await upsertSetting(db, PROMPT_KEY_CATEGORIZE_RULES, categorizeRules, actorUserId);
  }
  if (fullSystemPrompt !== undefined) {
    await upsertSetting(db, PROMPT_KEY_FULL, fullSystemPrompt, actorUserId);
  }

  await writeAudit(db, {
    actorUserId,
    entityType: 'system_settings',
    entityId: 'enrichment.prompt',
    action: 'enrichment.prompt-update',
    payload: {
      modeSet: update.mode ?? null,
      cleanseRulesChanged: cleanseRules !== undefined,
      categorizeRulesChanged: categorizeRules !== undefined,
      fullSystemPromptChanged: fullSystemPrompt !== undefined,
    },
  });

  return enrichmentPromptStatus(db);
};

export const setEnrichmentToggle = async (
  db: Db,
  which: 'cleanse' | 'category',
  enabled: boolean,
  actorUserId: string,
): Promise<void> => {
  const key = which === 'cleanse' ? 'enrichment.cleanse_enabled' : 'enrichment.category_enabled';
  await upsertSetting(db, key, enabled ? 'true' : 'false', actorUserId);
  await writeAudit(db, {
    actorUserId,
    entityType: 'system_settings',
    entityId: key,
    action: 'enrichment.toggle',
    payload: { enabled },
  });
};

// Suppress unused-warning when the file is imported solely for the
// errors above in route validation.
void inArray;
