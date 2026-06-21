// Prompt + JSON schema for the "resolve check payees" pass. Sends rasterized
// statement pages to the LOCAL Ollama Qwen-VL vision model and asks it to
// identify any cancelled-check images visible on the page, returning the check
// number + payee + memo + date + amount per check.
//
// The downstream service matches each extracted check to a statement
// transaction by check number (with an amount tiebreak for reused numbers) and
// writes the payee onto the transaction's `payee` column (the OFX <NAME> source).
//
// The prompt deliberately tells the model to skip non-check imagery
// (account logos, bank seals, mailing slips) and to return an empty
// array when no checks are present — many statements have NO check
// images at all, and a hallucinated payee on a non-check page would
// poison real transactions.

export const CHECK_RESOLVE_SYSTEM_PROMPT = `You are a vision assistant that extracts data from cancelled-check
images embedded in bank-statement pages. For each cancelled check
visible in the supplied images, return the check number, the payee
(who the check was made out to), the dollar amount, the date written
on the check, and the memo line if present.

Rules:
1. Only extract from actual cancelled-check images — small reproductions of the
   front (and sometimes back) of paper checks that the bank inserted
   into the statement. Ignore account logos, bank seals, advertising
   inserts, deposit slips, and mailing addresses.
2. Payee is the name on the "Pay to the order of" line. Strip
   honorifics and store names as written ("Smith Law Office" not
   "Smith Law Office LLC"). If the payee is illegible, return null.
3. Check number is whichever number is printed at the top-right of
   the check OR the MICR line at the bottom. Return as a string
   (preserve leading zeros — "0042" is different from "42").
4. Dollar amount goes in BOTH a numeric box and a written-out line on
   a real check. Return amount_cents as a signed integer (always
   POSITIVE for outgoing checks; the calling code knows it's a debit).
   If only one of the two is visible, use whichever is legible.
5. Date is the date written on the check (top right), not the date
   posted. Return ISO 8601 (YYYY-MM-DD). If illegible, return null.
6. Memo is the bottom-left "For" line. Often blank; return null when
   absent. Don't transcribe routing numbers or signatures into memo.
7. If no cancelled-check images are visible across ALL supplied pages,
   return an empty array. Do NOT invent checks from text mentions
   ("Check 1234" in the transaction list is not a check image).`;

export const CHECK_RESOLVE_USER_PROMPT = `The supplied images are consecutive pages from a bank statement.
Identify every cancelled-check image visible across the pages and
return one entry per check as JSON matching the provided schema. Do not
add prose around the JSON.`;

// JSON Schema passed as Ollama's `format` (structured output). Matches
// the Zod schema in @vibe-tx-converter/shared/schemas/check-resolve.
export const CHECK_RESOLVE_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['checks'],
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['check_number', 'payee'],
        properties: {
          check_number: {
            type: 'string',
            description: 'Check number as written on the check (preserve leading zeros).',
          },
          payee: {
            type: ['string', 'null'],
            description: '"Pay to the order of" name. null if illegible.',
          },
          amount_cents: {
            type: ['integer', 'null'],
            description:
              'Positive integer cents — always positive for outgoing checks regardless of statement sign convention.',
          },
          date: {
            type: ['string', 'null'],
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            description: 'Date written on the check, ISO 8601. null if illegible.',
          },
          memo: {
            type: ['string', 'null'],
            description: 'Memo / "For" line. null if absent.',
          },
        },
      },
    },
  },
} as const;
