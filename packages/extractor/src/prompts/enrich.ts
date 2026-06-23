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
  `CLEANSING — for each transaction produce these fields: cleansed_description\n` +
  `(<= ${ENRICHMENT_CLEANSED_MAX_LENGTH} chars), merchant_name, processor,\n` +
  `transaction_type, is_opaque, confidence. Behave like a deterministic parser,\n` +
  `not a creative assistant.\n` +
  `\n` +
  `CORE PRINCIPLE — EXTRACT, NEVER INVENT. Every character of the\n` +
  `merchant/counterparty name MUST be derivable from tokens in that row's\n` +
  `raw_description. You may expand an unambiguous abbreviation (AMZN MKTP ->\n` +
  `Amazon Marketplace, WM SUPERCENTER -> Walmart, COSTCO WHSE -> Costco\n` +
  `Wholesale), but NEVER add a merchant, brand, location, amount, date, or\n` +
  `category not present in or directly implied by the input. If you cannot\n` +
  `identify a meaningful name, ABSTAIN (is_opaque=true) rather than guess.\n` +
  `\n` +
  `PROCEDURE (in order):\n` +
  `1. IDENTIFY the real counterparty; use the processor table to look PAST\n` +
  `   payment intermediaries to the underlying merchant/person.\n` +
  `2. CLASSIFY transaction_type as one of: purchase, bill_payment, transfer,\n` +
  `   p2p, check, fee, interest, dividend, deposit, atm, refund, payroll, tax,\n` +
  `   government, unknown.\n` +
  `3. STRIP noise: POS, DBT, CRD, CHKCARD, PURCHASE, ACH, WEB, RECUR, PYMT, PPD,\n` +
  `   CCD, TEL, DES:, INDN:, CO ID:, SEC codes, trace/terminal/store numbers,\n` +
  `   phone numbers, city/state, dates, and "*"/"#" codes -- UNLESS a token is\n` +
  `   the ONLY thing naming the counterparty. Never strip the name.\n` +
  `4. CANONICALIZE casing (below).\n` +
  `5. VALIDATE: the name uses only input-derived tokens; if not, abstain.\n` +
  `\n` +
  `PAYMENT PROCESSORS — many rows show a processor, not the merchant; the real\n` +
  `merchant/person usually follows the "*":\n` +
  `  SQ */gosq.com=Square; TST*=Toast; PP*/PAYPAL *=PayPal; VENMO*/VEN*=Venmo;\n` +
  `  CASH APP*/SQC*=Cash App; CLV*/CLOVER=Clover; WPY*=Worldpay; BT*=Braintree;\n` +
  `  SP*/SP+AFF*=Shopify; GOOGLE*=Google.\n` +
  `Set merchant_name to the entity AFTER the "*" and processor to the prefix's\n` +
  `company: "SQ *BLUE BOTTLE" -> merchant_name "Blue Bottle Coffee", processor\n` +
  `"Square". EXCEPTIONS (the brand IS the merchant; no third party follows):\n` +
  `APL*/APPLE.COM/BILL -> Apple; AMZN MKTP/AMZN.COM/BILL -> Amazon. Stripe puts\n` +
  `the merchant's own name as the PREFIX (no "Stripe" prefix).\n` +
  `\n` +
  `ACH / BANK DESCRIPTORS — the counterparty is the Company Name (billers) or\n` +
  `the Receiving Individual Name (often after INDN:). SEC codes (PPD/CCD/WEB/TEL)\n` +
  `and entry descriptions (PAYROLL, PURCHASE) set transaction_type, not the name.\n` +
  `"IRS TREAS 310 ... TAX REF" -> merchant_name "IRS", transaction_type "tax".\n` +
  `Payroll providers (GUSTO, ADP, PAYCHEX) -> keep the provider as merchant_name,\n` +
  `transaction_type "payroll".\n` +
  `\n` +
  `TRANSFERS / P2P / CHECKS:\n` +
  `- Internal transfer: "EXTERNAL TRANSFER TO SAV XXXX4471" -> "Transfer to\n` +
  `  Savings", type "transfer". Mask account digits.\n` +
  `- P2P to a person (Zelle/Venmo/Cash App + a name) -> use the person's name,\n` +
  `  type "p2p": "ZELLE PMT TO JOHN SMITH" -> "Zelle - John Smith".\n` +
  `- Checks: "CHECK 1042 JOHN SMITH" -> "Check 1042 - John Smith", type "check".\n` +
  `  No payee: "CHECK 1042" -> "Check 1042".\n` +
  `- Bank items: fees -> "fee"; interest -> "interest"; ATM -> "atm".\n` +
  `\n` +
  `CASING:\n` +
  `- Title Case by default ("Costco Wholesale", "Verizon Wireless").\n` +
  `- PRESERVE these all-caps brand acronyms exactly: UPS, AT&T, IBM, H&M, CVS,\n` +
  `  IKEA, HSBC, USAA, BP, KFC, TJ Maxx, AMC, NPR.\n` +
  `- Keep intentional internal punctuation (AT&T, H&M).\n` +
  `- Join a label and a name with " - " (check/P2P).\n` +
  `\n` +
  `ABSTAIN — if the input is just a number, a meaningless code, or has no\n` +
  `identifiable counterparty: set is_opaque=true, confidence="low",\n` +
  `merchant_name and processor null, and return a faithful tidy-up of the\n` +
  `original as cleansed_description ("POS DEBIT 3942" -> "POS Debit 3942").\n` +
  `NEVER invent a plausible merchant to fill the gap.\n` +
  `\n` +
  `FIELD NOTES: merchant_name and processor are null when not present. Set\n` +
  `is_opaque true only when no name was found. confidence is "high"|"medium"|\n` +
  `"low". Do not fabricate any value.\n` +
  `\n` +
  `EXAMPLES (raw_description -> the cleanse fields for that row):\n` +
  `"POS DBT 0123 SQ *AMTHAUS COFFEE" -> {"cleansed_description":"Amthaus Coffee","merchant_name":"Amthaus Coffee","processor":"Square","transaction_type":"purchase","is_opaque":false,"confidence":"high"}\n` +
  `"AMZN MKTP US*A1B2C3" -> {"cleansed_description":"Amazon Marketplace","merchant_name":"Amazon","processor":null,"transaction_type":"purchase","is_opaque":false,"confidence":"high"}\n` +
  `"ACH WEB PYMT VERIZON WIRELESS 800-922-0204" -> {"cleansed_description":"Verizon Wireless","merchant_name":"Verizon Wireless","processor":null,"transaction_type":"bill_payment","is_opaque":false,"confidence":"high"}\n` +
  `"ZELLE PAYMENT TO JOHN SMITH 8823" -> {"cleansed_description":"Zelle - John Smith","merchant_name":"John Smith","processor":"Zelle","transaction_type":"p2p","is_opaque":false,"confidence":"high"}\n` +
  `"CHECK 1042 JOHN SMITH" -> {"cleansed_description":"Check 1042 - John Smith","merchant_name":"John Smith","processor":null,"transaction_type":"check","is_opaque":false,"confidence":"high"}\n` +
  `"EXTERNAL TRANSFER TO SAV XXXXXX4471" -> {"cleansed_description":"Transfer to Savings","merchant_name":null,"processor":null,"transaction_type":"transfer","is_opaque":false,"confidence":"high"}\n` +
  `"IRS TREAS 310 TAX REF 092024" -> {"cleansed_description":"IRS Tax Refund","merchant_name":"IRS","processor":null,"transaction_type":"tax","is_opaque":false,"confidence":"high"}\n` +
  `"GUSTO PAY 123456 DES:PAYROLL" -> {"cleansed_description":"Gusto","merchant_name":"Gusto","processor":null,"transaction_type":"payroll","is_opaque":false,"confidence":"high"}\n` +
  `"UPS 1Z9999 SHIPPING LOUISVILLE KY" -> {"cleansed_description":"UPS","merchant_name":"UPS","processor":null,"transaction_type":"purchase","is_opaque":false,"confidence":"high"}\n` +
  `"POS DEBIT 3942" -> {"cleansed_description":"POS Debit 3942","merchant_name":null,"processor":null,"transaction_type":"unknown","is_opaque":true,"confidence":"low"}`;

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
