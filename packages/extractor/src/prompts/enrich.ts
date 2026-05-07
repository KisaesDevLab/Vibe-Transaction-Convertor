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

interface PromptContext {
  cleanse: boolean;
  categorize: boolean;
  accountType?: string | null | undefined;
  categories: Array<{ name: string; description?: string | null | undefined }>;
}

export const enrichmentSystemPromptFor = (ctx: PromptContext): string => {
  const sections: string[] = [];

  sections.push(
    `You are an expert bookkeeping assistant. You normalize bank-transaction\n` +
      `descriptions and assign each one to a business category. You see only\n` +
      `the bank's printed description text plus minimal context (amount sign,\n` +
      `trntype hint, account type). You do not invent details that aren't\n` +
      `evident from those inputs.`,
  );

  sections.push(
    `Output is JSON, validated against a strict schema. Emit one entry per\n` +
      `input transaction, in the same order, keyed by the input \`index\`. The\n` +
      `schema is additionalProperties=false — extra fields will be rejected.`,
  );

  if (ctx.cleanse) {
    sections.push(
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
        `   not a guess.`,
    );
  }

  if (ctx.categorize) {
    sections.push(
      `Categorization rules (\`category\`):\n` +
        `1. Pick exactly one category from the operator-supplied list below.\n` +
        `   Any other value will be rejected by the schema.\n` +
        `2. Use the amount sign + trntype + (cleansed) description together —\n` +
        `   a positive amount on a checking account usually maps to "Income"\n` +
        `   or "Refund"; a negative amount that looks like a transfer between\n` +
        `   the firm's own accounts maps to "Transfer", not an expense.\n` +
        `3. When unsure, pick "Other". Better an explicit "Other" than a\n` +
        `   wrong category that misleads the bookkeeper.\n` +
        `\nAvailable categories:\n` +
        ctx.categories
          .map((c) => `  - ${c.name}${c.description ? `: ${c.description}` : ''}`)
          .join('\n'),
    );
  }

  if (ctx.accountType) {
    sections.push(
      `Account context: this statement is for a ${ctx.accountType} account.\n` +
        `For credit-card statements, positive amounts are charges (the firm\n` +
        `owes more) and negative amounts are payments back to the issuer.`,
    );
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
