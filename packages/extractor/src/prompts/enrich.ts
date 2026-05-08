// Phase 33 — system + user prompts for description cleansing + business
// category assignment. The LLM sees only the raw bank description text
// plus minimal context (amount sign, trntype, account type) — never any
// PDF or image bytes (ADR-019, ADR-020 still apply).
//
// One batched call per statement: the request includes every transaction
// keyed by `index`, and the response is required to echo the same
// indices back in order. Output is constrained by the JSON Schema built
// in `@vibe-tx-converter/shared/schemas/enrichment` — its shape changes
// based on which transforms the operator asked for.

import { schemas } from '@vibe-tx-converter/shared';
const { ENRICHMENT_CLEANSED_MAX_LENGTH } = schemas.enrichment;

// Defaults are exported so the admin "edit prompt" UI can show what the
// operator is overriding and offer a "reset to default" button without
// duplicating the strings on the SPA side. Override-aware callers
// (apps/api/src/services/enrichment.ts) read system_settings and pass
// the overrides through PromptContext.

export const DEFAULT_ENRICHMENT_PERSONA =
  `You are an expert bookkeeping assistant. You normalize bank-transaction\n` +
  `descriptions and assign each one to a business category. You see only\n` +
  `the bank's printed description text plus minimal context (amount sign,\n` +
  `trntype hint, account type). You do not invent details that aren't\n` +
  `evident from those inputs.`;

export const DEFAULT_JSON_OUTPUT_FRAMING =
  `Output is JSON, validated against a strict schema. Emit one entry per\n` +
  `input transaction, in the same order, keyed by the input \`index\`. The\n` +
  `schema is additionalProperties=false — extra fields will be rejected.`;

export const DEFAULT_CLEANSE_RULES =
  `Cleansing rules (\`cleansed_description\`, max ${ENRICHMENT_CLEANSED_MAX_LENGTH} chars):\n` +
  `1. Keep the merchant or counterparty identity intact. "POS DBT 0123 SQ\n` +
  `   *AMTHAUS" → "Square — Amthaus". "AMZN MKTP US*A1B2C3" → "Amazon\n` +
  `   Marketplace".\n` +
  `2. Strip POS/DBT/CRD/CHK/REF/etc. transaction-channel noise unless it\n` +
  `   adds disambiguation. Keep cardholder names if present.\n` +
  `3. Preserve original wording when it's already clear ("Costco\n` +
  `   Wholesale", "Verizon Wireless").\n` +
  `4. Use proper case for merchant names; preserve all-caps brand names\n` +
  `   that are intentionally so ("UPS", "AT&T").\n` +
  `5. Never invent a merchant. If the source is opaque (e.g. "POS DEBIT\n` +
  `   3942"), emit the closest faithful normalization ("POS Debit 3942"),\n` +
  `   not a guess.`;

// The "Available categories:" listing is appended automatically after
// these rules — the operator edits the rules text only; the dynamic
// list always reflects the live business_categories table.
export const DEFAULT_CATEGORIZE_RULES =
  `Categorization rules (\`category\`):\n` +
  `1. Pick exactly one category from the operator-supplied list below.\n` +
  `   Any other value will be rejected by the schema.\n` +
  `2. Use the amount sign + trntype + (cleansed) description together —\n` +
  `   a positive amount on a checking account usually maps to "Income"\n` +
  `   or "Refund"; a negative amount that looks like a transfer between\n` +
  `   the firm's own accounts maps to "Transfer", not an expense.\n` +
  `3. When unsure, pick "Other". Better an explicit "Other" than a\n` +
  `   wrong category that misleads the bookkeeper.`;

// Account-context is auto-appended in both rules-mode and full-mode
// because the account type is per-statement metadata, not a
// per-firm preference.
const accountContextSection = (accountType: string): string =>
  `Account context: this statement is for a ${accountType} account.\n` +
  `For credit-card statements, positive amounts are charges (the firm\n` +
  `owes more) and negative amounts are payments back to the issuer.`;

const renderCategoriesList = (
  categories: ReadonlyArray<{ name: string; description?: string | null | undefined }>,
): string =>
  categories.map((c) => `  - ${c.name}${c.description ? `: ${c.description}` : ''}`).join('\n');

// Default seed for the "full takeover" mode. Mirrors the rules-mode
// default so an operator switching modes doesn't lose the baseline
// behavior. {{categories}} is substituted with the live category list
// at runtime; if the operator removes it, the LLM has no list to pick
// from and the schema-constrained response will fail.
export const DEFAULT_FULL_SYSTEM_PROMPT =
  `${DEFAULT_ENRICHMENT_PERSONA}\n\n` +
  `${DEFAULT_JSON_OUTPUT_FRAMING}\n\n` +
  `${DEFAULT_CLEANSE_RULES}\n\n` +
  `${DEFAULT_CATEGORIZE_RULES}\n\n` +
  `Available categories:\n{{categories}}`;

export type EnrichmentPromptMode = 'rules' | 'full';

interface PromptContext {
  cleanse: boolean;
  categorize: boolean;
  accountType?: string | null | undefined;
  categories: Array<{ name: string; description?: string | null | undefined }>;
  // Per-section overrides (rules mode). Empty / null / undefined means
  // "use the built-in default".
  cleanseRulesOverride?: string | null | undefined;
  categorizeRulesOverride?: string | null | undefined;
  // When mode is 'full', this verbatim text replaces the entire system
  // prompt except the account-context section (which is auto-appended).
  // {{categories}} is substituted with the live category list at
  // runtime. Ignored when mode is 'rules' or undefined.
  mode?: EnrichmentPromptMode | undefined;
  fullSystemPromptOverride?: string | null | undefined;
}

const isNonEmpty = (s: string | null | undefined): s is string =>
  typeof s === 'string' && s.trim().length > 0;

export const enrichmentSystemPromptFor = (ctx: PromptContext): string => {
  // Full-takeover mode: operator owns the whole prompt. We still
  // substitute {{categories}} (so the dynamic list stays current
  // even when the wording is custom) and append per-statement
  // account-context.
  if (ctx.mode === 'full' && isNonEmpty(ctx.fullSystemPromptOverride)) {
    const categoriesText = renderCategoriesList(ctx.categories);
    let prompt = ctx.fullSystemPromptOverride.replace(/\{\{categories\}\}/g, categoriesText);
    if (ctx.accountType) {
      prompt += `\n\n${accountContextSection(ctx.accountType)}`;
    }
    return prompt;
  }

  const sections: string[] = [];
  sections.push(DEFAULT_ENRICHMENT_PERSONA);
  sections.push(DEFAULT_JSON_OUTPUT_FRAMING);

  if (ctx.cleanse) {
    sections.push(
      isNonEmpty(ctx.cleanseRulesOverride) ? ctx.cleanseRulesOverride : DEFAULT_CLEANSE_RULES,
    );
  }

  if (ctx.categorize) {
    const rules = isNonEmpty(ctx.categorizeRulesOverride)
      ? ctx.categorizeRulesOverride
      : DEFAULT_CATEGORIZE_RULES;
    sections.push(`${rules}\n\nAvailable categories:\n${renderCategoriesList(ctx.categories)}`);
  }

  if (ctx.accountType) {
    sections.push(accountContextSection(ctx.accountType));
  }

  return sections.join('\n\n');
};

interface UserPromptInput {
  transactions: Array<{
    index: number;
    raw_description: string;
    amount_cents: number;
    trntype?: string | null | undefined;
  }>;
}

export const enrichmentUserPromptFor = (input: UserPromptInput): string => {
  // We send the input as JSON, not a free-form table — the LLM is more
  // reliable when the structure of input mirrors the structure of the
  // expected output. A literal "transactions" array on input maps 1:1
  // to the "transactions" array in the schema-constrained response.
  const payload = JSON.stringify(
    {
      transactions: input.transactions.map((t) => ({
        index: t.index,
        raw_description: t.raw_description,
        amount_cents: t.amount_cents,
        ...(t.trntype ? { trntype: t.trntype } : {}),
      })),
    },
    null,
    2,
  );
  return (
    `Enrich the following transactions. Emit JSON that conforms to the\n` +
    `schema. Every input row must produce exactly one output row at the\n` +
    `matching \`index\`.\n\n` +
    `=== INPUT ===\n${payload}\n=== END ===`
  );
};
