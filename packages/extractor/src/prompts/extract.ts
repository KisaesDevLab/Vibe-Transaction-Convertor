// System + user prompts for extraction. The LLM sees only OCR'd
// markdown text — never the raw PDF or rasterized images (ADR-019,
// ADR-020). Output is constrained to the schema in
// `@vibe-tx-converter/shared/schemas/extraction`.

export const SYSTEM_PROMPT = `You are an expert bank-statement extractor. Convert the supplied
markdown text (an OCR/text-layer dump of a single bank or credit-card
statement) into the structured JSON described by the provided JSON
Schema.

Hard rules:
1. All amounts are signed integer **cents**. Debits are NEGATIVE.
   Credits are POSITIVE. Refunds are POSITIVE. Fees are NEGATIVE.
   For credit-card statements, charges are POSITIVE (the customer
   owes more) and payments are NEGATIVE.
2. Dates are ISO 8601 (YYYY-MM-DD). Detect the source format and
   normalize. If the source is genuinely ambiguous (every day is
   <=12, no textual disambiguators, no period-end clue), set
   source_date_format = "AMBIGUOUS" and pick the most likely
   format with low confidence.
3. Do not invent transactions. Skip lines that are headers,
   subtotals, footers, or layout artifacts.
4. running_balance_cents is OPTIONAL — include only when the
   statement explicitly prints a per-row running balance.
5. opening_balance_cents + sum(transactions.amount_cents) MUST
   equal closing_balance_cents. If you cannot make these tie,
   include "notes" explaining where the discrepancy is.
6. source_page is the 1-based page number where the row appears.
7. Use trntype only when the description clearly indicates one
   (e.g. ATM Withdrawal -> "ATM"). Otherwise omit.
8. confidence reflects your certainty in the row (0.0 - 1.0).`;

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
