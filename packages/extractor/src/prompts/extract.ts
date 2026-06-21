// System + user prompts for extraction. The LLM sees only OCR'd
// markdown text — never the raw PDF or rasterized images (ADR-019,
// ADR-020). Output is constrained to the schema in
// `@vibe-tx-converter/shared/schemas/extraction`.

export const SYSTEM_PROMPT = `You are an expert bank-statement extractor. Convert the supplied
markdown text (an OCR/text-layer dump of a single bank or credit-card
statement) into the structured JSON described by the provided JSON
Schema.

Output shape (Phase 12 nested):
  {
    "account": { "masked_number": <last4 or null>, "type_hint": <CHECKING/SAVINGS/...> },
    "institution": { "name": <bank name>, "intu_org_hint": <Wells Fargo / Chase / ...> },
    "period":   { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
    "balances": { "opening_cents": <int>, "closing_cents": <int> },
    "source_date_format": { "format": "MDY"|"DMY"|"YMD"|"TEXTUAL"|"AMBIGUOUS",
                            "confidence": 0..1, "evidence": <string?>, "sample": <string?> },
    "transactions": [ ... ]
  }

CRITICAL — required top-level fields. Every response MUST include the
"period", "balances", "source_date_format", AND "transactions" keys.
"transactions" MUST always be an array. If you genuinely identify no
transactions, emit an EMPTY array (transactions: []) and add a "notes"
field explaining why — NEVER omit the key. Responses missing any
required top-level field are REJECTED.

Hard rules:
1. All amounts are signed integer **cents**. Debits are NEGATIVE.
   Credits are POSITIVE. Refunds are POSITIVE. Fees are NEGATIVE.
   For credit-card statements, charges are POSITIVE (the customer
   owes more) and payments are NEGATIVE.
2. Dates are ISO 8601 (YYYY-MM-DD). Detect the source format and
   normalize. If the source is genuinely ambiguous (every day is
   <=12, no textual disambiguators, no period-end clue), set
   source_date_format.format = "AMBIGUOUS" and pick the most likely
   format with low confidence; include the ambiguous "sample" you saw.
3. Do not invent transactions. Skip lines that are headers,
   subtotals, footers, or layout artifacts.
4. running_balance_cents is OPTIONAL — include only when the
   statement explicitly prints a per-row running balance.
5. balances.opening_cents + sum(transactions.amount_cents) MUST
   equal balances.closing_cents. If you cannot make these tie,
   include "notes" explaining where the discrepancy is.
6. source_page is the 1-based page number where the row appears.
7. Use trntype only when the description clearly indicates one
   (e.g. ATM Withdrawal -> "ATM"). Otherwise omit.
8. confidence reflects your certainty in the row (0.0 - 1.0).`;

// Vision/OCR extraction (ADR-023). The local Ollama Qwen-VL model reads the
// raw statement / check page IMAGES directly and emits the structured JSON in
// one call — OCR + extract combined, better fidelity than a lossy
// OCR→markdown→extract path, and it can read the check payee. Images are
// processed locally and never egress, so they are NOT redacted.
export const IMAGE_SYSTEM_PROMPT = `You are an expert bank-statement and check extractor. You are given one or
more page IMAGES of a single bank or credit-card statement (and possibly
cancelled-check or deposit images). Convert them into the structured JSON
described by the provided JSON Schema. Read directly from the images.

Extract only the transaction and balance data described by the schema. Do not
extract the account holder's personal identity (name, address, full account
number) into any field — it is not part of the schema.

CRITICAL — required top-level fields. Every response MUST include the
"period", "balances", "source_date_format", AND "transactions" keys.
"transactions" MUST always be an array (emit [] with a "notes" explanation if
you find none) — never omit the key.

Hard rules:
1. All amounts are signed integer cents. Debits/fees NEGATIVE; credits/refunds
   POSITIVE. For credit-card statements, charges are POSITIVE and payments
   NEGATIVE.
2. Dates are ISO 8601 (YYYY-MM-DD). Detect the source format and normalize;
   set source_date_format accordingly (use "AMBIGUOUS" with low confidence
   only when genuinely undecidable).
3. Do not invent transactions. Skip headers, subtotals, footers, layout
   artifacts.
4. running_balance_cents is OPTIONAL — only when the row prints one.
5. balances.opening_cents + sum(transactions.amount_cents) MUST equal
   balances.closing_cents; if you cannot tie, explain in "notes".
6. source_page is the 1-based image/page index where the row appears.
7. Use trntype only when clearly indicated; otherwise omit.
8. confidence reflects your certainty in the row (0.0–1.0).

Check & payee rules:
- For a cancelled-check image, read the PAYEE from the "Pay to the order of"
  line and set transaction.payee. Match it to the statement row with the same
  check_number. Preserve the check number's leading zeros.
- Never put the account holder's own name in payee — payee is the party the
  check was written TO.
- For non-check rows, omit payee (or null).`;

export const imageUserPromptFor = (opts: UserPromptOptions = {}): string => {
  const overrideLine = opts.dateFormatOverride
    ? `\nOperator override: interpret every date using the **${opts.dateFormatOverride}** ` +
      `format; set source_date_format to "${opts.dateFormatOverride}" with confidence 1.0.\n`
    : '';
  return (
    `The preceding image(s) are the pages of one statement (and any cancelled ` +
    `checks). Emit JSON conforming to the schema. Do not add prose around the ` +
    `JSON.${overrideLine}`
  );
};

export interface UserPromptOptions {
  // Operator-confirmed date format. When set, the LLM is told to interpret
  // every date in the markdown using this format and emit ISO 8601. Used
  // when a prior extraction returned source_date_format='AMBIGUOUS' and
  // the operator picked one. Phase 15 item 4b.
  dateFormatOverride?: 'MDY' | 'DMY' | 'YMD' | undefined;
  // Operator-confirmed account-type hint (CHECKING / SAVINGS /
  // CREDITCARD / etc.). Currently unused; reserved for later phases.
  accountTypeHint?: string | undefined;
}

export const userPromptFor = (markdown: string, opts: UserPromptOptions = {}): string => {
  const overrideLine = opts.dateFormatOverride
    ? `\nOperator override: interpret every date in the markdown using ` +
      `the **${opts.dateFormatOverride}** format. Set source_date_format ` +
      `to "${opts.dateFormatOverride}" with confidence 1.0.\n`
    : '';
  return (
    `Below is the OCR/text-layer markdown for one statement. Emit JSON\n` +
    `that conforms to the schema. Do not add prose around the JSON.${overrideLine}\n\n` +
    `=== STATEMENT MARKDOWN ===\n${markdown}\n=== END ===`
  );
};

// Retry-after-missing-fields prompt. When the LLM's first response is
// well-formed JSON but omits a required top-level field (most commonly
// "transactions"), the provider retries once with this prompt instead
// of bouncing to provider fallback. The local Vibe Gateway with relaxed
// json_schema enforcement is the typical culprit — the explicit field
// list plus "you forgot X" framing reliably recovers the second call.
export const missingFieldsReminderPromptFor = (
  markdown: string,
  missingFields: string[],
  opts: UserPromptOptions = {},
): string => {
  const overrideLine = opts.dateFormatOverride
    ? `\nOperator override: interpret every date in the markdown using ` +
      `the **${opts.dateFormatOverride}** format. Set source_date_format ` +
      `to "${opts.dateFormatOverride}" with confidence 1.0.\n`
    : '';
  const fieldList = missingFields.length > 0 ? missingFields.join(', ') : 'a required field';
  return (
    `Your previous response was REJECTED — it was missing required ` +
    `top-level field(s): ${fieldList}.\n\n` +
    `Re-read the markdown below and emit the FULL extraction JSON with ` +
    `EVERY required top-level field present: period, balances, ` +
    `source_date_format, AND transactions. The "transactions" key is ` +
    `MANDATORY — emit "transactions": [] if you genuinely found no rows, ` +
    `but do NOT omit the key. Output ONLY the JSON object, no prose.${overrideLine}\n\n` +
    `=== STATEMENT MARKDOWN ===\n${markdown}\n=== END ===`
  );
};

// Phase 16 item 6: repair-pass prompt. After the first extract fails to
// reconcile (or has flagged suspect rows), we send a SECOND LLM call
// containing the original markdown plus the failed transaction list and
// a precise hint at what's wrong. The LLM can re-read the markdown and
// emit a corrected transaction list under the same schema.
export interface RepairPromptInput {
  markdown: string;
  attemptedTransactions: Array<{
    posted_date: string;
    description: string;
    amount_cents: number | bigint;
    running_balance_cents?: number | bigint | null;
  }>;
  deltaCents: bigint; // closing - (opening + sum), nonzero
  suspectRowIndices: number[];
  openingBalanceCents: number | bigint;
  closingBalanceCents: number | bigint;
}

export const repairPromptFor = (input: RepairPromptInput): string => {
  const txTable = input.attemptedTransactions
    .map((t, i) => {
      const flag = input.suspectRowIndices.includes(i) ? ' ← SUSPECT' : '';
      const rb =
        t.running_balance_cents != null
          ? `, running=${formatCents(BigInt(t.running_balance_cents))}`
          : '';
      return `[${i}] ${t.posted_date}  ${formatCents(BigInt(t.amount_cents))}  ${t.description}${rb}${flag}`;
    })
    .join('\n');

  return (
    `Your prior extraction did not reconcile. Re-read the markdown below ` +
    `and emit a corrected transaction list.\n\n` +
    `Opening: ${formatCents(BigInt(input.openingBalanceCents))}\n` +
    `Closing: ${formatCents(BigInt(input.closingBalanceCents))}\n` +
    `Delta (closing - opening - sum): ${formatCents(input.deltaCents)} ` +
    `→ your sum is off by exactly this amount.\n\n` +
    `Attempted rows:\n${txTable}\n\n` +
    `Likely culprits, in priority order:\n` +
    `1. A debit was emitted as a credit (or vice versa) — check signs.\n` +
    `2. A duplicate row was emitted (header/footer line picked up twice).\n` +
    `3. A row was missed (look for indented continuation lines under a date).\n` +
    `4. An amount has the wrong magnitude (10x error from a misplaced decimal).\n\n` +
    `${input.suspectRowIndices.length > 0 ? `The rows marked SUSPECT have running-balance values that don't match the prior row + this row's amount. Inspect them first.\n\n` : ''}` +
    `Re-emit the FULL extraction object under the same schema — every ` +
    `top-level field (account, institution, period, balances, ` +
    `source_date_format, transactions). The schema is strict and ` +
    `additionalProperties=false, so partial outputs (e.g. ` +
    `{ "transactions": [...] } alone) will fail validation. Echo period, ` +
    `balances, and source_date_format from the prior call unless you ` +
    `genuinely re-detect a different set. If you still cannot reconcile, ` +
    `emit your best-guess corrections and set "notes" explaining ` +
    `what's irreducibly off.\n\n` +
    `=== STATEMENT MARKDOWN ===\n${input.markdown}\n=== END ===`
  );
};

const formatCents = (cents: bigint): string => {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const dollars = abs / 100n;
  const remainder = abs % 100n;
  return `${negative ? '-' : ''}$${dollars}.${remainder.toString().padStart(2, '0')}`;
};

// Phase 12 item 11: rough token estimator (4 chars per token, conservative)
// for prompt-budget enforcement. We don't ship a tokenizer (cl100k_base
// pulls in 1MB+); the 4:1 heuristic is within ~10% of the real count for
// English text and over-estimates for digit-heavy bank-statement OCR,
// which is the safe direction.
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

// Phase 12 item 12: light header/footer cleanup pass before the LLM sees
// the markdown. Strips obvious banking-statement noise that wastes tokens
// without affecting extraction:
//   * "Page X of Y" markers (we re-add # Page N headers ourselves)
//   * Bare phone numbers and 1-800 customer service lines
//   * Trailing whitespace and >2 consecutive blank lines
export const cleanupMarkdown = (markdown: string): string =>
  markdown
    .replace(/^[ \t]*page\s+\d+\s+of\s+\d+[ \t]*$/gim, '')
    .replace(/^[ \t]*(?:1[-. ]?)?(?:\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4})[ \t]*$/gim, '')
    .replace(/^[ \t]*customer\s+service:?\s*1[-. ]?\d{3}[-. ]?\d{3}[-. ]?\d{4}[ \t]*$/gim, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
