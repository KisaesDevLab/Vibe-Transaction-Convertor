// In-context examples used to anchor the LLM. All exemplars are SANITIZED
// (no real account numbers, no real PII). They are sent only to the local
// gateway provider; the Anthropic provider gets a smaller subset to keep
// the prompt budget under control.

import type { schemas } from '@vibe-tx-converter/shared';

type ExtractionResult = schemas.extraction.ExtractionResult;

export interface Exemplar {
  label: string;
  markdown: string;
  expected: ExtractionResult;
}

export const EXEMPLARS: Exemplar[] = [
  {
    label: 'chase-business-checking',
    markdown: `# JPMORGAN CHASE BANK, N.A. — Business Checking
Account Number ************5678
Statement Period: April 1, 2026 through April 30, 2026

BEGINNING BALANCE                              $12,450.00

DEPOSITS AND ADDITIONS
04/03  ONLINE TRANSFER FROM SAV ACCT 9876         5,000.00
04/15  REMOTE ONLINE DEPOSIT                       1,250.50

ATM & DEBIT CARD WITHDRAWALS
04/05  CARD PURCHASE  04/04  STAPLES STORE 0123        -82.49
04/22  ATM WITHDRAWAL  04/22  100 W ST FL                -200.00

ELECTRONIC WITHDRAWALS
04/10  ADP TX/FEES                                    -495.00
04/28  ONLINE PAYMENT 1234 TO COMCAST                 -149.95

ENDING BALANCE                                 $17,773.06`,
    expected: {
      account_number_masked: '5678',
      account_type_hint: 'CHECKING',
      period_start: '2026-04-01',
      period_end: '2026-04-30',
      opening_balance_cents: 1_245_000,
      closing_balance_cents: 1_777_306,
      source_date_format: 'MDY',
      source_date_format_confidence: 0.95,
      transactions: [
        {
          posted_date: '2026-04-03',
          description: 'ONLINE TRANSFER FROM SAV ACCT 9876',
          amount_cents: 500_000,
          trntype: 'XFER',
          source_page: 1,
          confidence: 0.99,
        },
        {
          posted_date: '2026-04-15',
          description: 'REMOTE ONLINE DEPOSIT',
          amount_cents: 125_050,
          trntype: 'DEP',
          source_page: 1,
          confidence: 0.97,
        },
        {
          posted_date: '2026-04-05',
          description: 'CARD PURCHASE STAPLES STORE 0123',
          amount_cents: -8_249,
          trntype: 'POS',
          source_page: 1,
          confidence: 0.95,
        },
        {
          posted_date: '2026-04-22',
          description: 'ATM WITHDRAWAL 100 W ST FL',
          amount_cents: -20_000,
          trntype: 'ATM',
          source_page: 1,
          confidence: 0.99,
        },
        {
          posted_date: '2026-04-10',
          description: 'ADP TX/FEES',
          amount_cents: -49_500,
          trntype: 'DIRECTDEBIT',
          source_page: 1,
          confidence: 0.95,
        },
        {
          posted_date: '2026-04-28',
          description: 'ONLINE PAYMENT 1234 TO COMCAST',
          amount_cents: -14_995,
          trntype: 'PAYMENT',
          source_page: 1,
          confidence: 0.95,
        },
      ],
    },
  },
  {
    label: 'wells-fargo-savings',
    markdown: `# Wells Fargo — Way2Save Savings
Account ending in 4321
Statement Period: 02/01/2026 - 02/28/2026

Beginning Balance on 02/01/2026                     $8,500.00

Deposits and Other Additions
02/05  TRANSFER FROM CHECKING X6789                       250.00
02/15  INTEREST PAYMENT                                     4.12

Withdrawals and Other Subtractions
02/20  TRANSFER TO CHECKING X6789                       -100.00

Ending Balance on 02/28/2026                        $8,654.12`,
    expected: {
      account_number_masked: '4321',
      account_type_hint: 'SAVINGS',
      period_start: '2026-02-01',
      period_end: '2026-02-28',
      opening_balance_cents: 850_000,
      closing_balance_cents: 865_412,
      source_date_format: 'MDY',
      source_date_format_confidence: 0.95,
      transactions: [
        {
          posted_date: '2026-02-05',
          description: 'TRANSFER FROM CHECKING X6789',
          amount_cents: 25_000,
          trntype: 'XFER',
          source_page: 1,
          confidence: 0.99,
        },
        {
          posted_date: '2026-02-15',
          description: 'INTEREST PAYMENT',
          amount_cents: 412,
          trntype: 'INT',
          source_page: 1,
          confidence: 0.99,
        },
        {
          posted_date: '2026-02-20',
          description: 'TRANSFER TO CHECKING X6789',
          amount_cents: -10_000,
          trntype: 'XFER',
          source_page: 1,
          confidence: 0.99,
        },
      ],
    },
  },
  {
    label: 'amex-credit-card',
    markdown: `# American Express Business Platinum
Account ending in 91009
Statement Closing Date: 03/15/2026
Previous Balance: $1,245.67
New Charges: $2,890.45
Payments/Credits: -$1,245.67
New Balance: $2,890.45

Date     Description                                    Amount
02/18    PAYMENT THANK YOU                          -1,245.67
02/22    AMAZON.COM*ABC123 SEATTLE WA                  127.83
02/27    AWS CLOUD SERVICES                            842.15
03/01    UBER TRIP HELP.UBER.COM                        24.50
03/05    HILTON HOTELS NYC                             612.40
03/08    DELTA AIR LINES ATL-LAX                     1,283.57

Statement Period: 02/16/2026 — 03/15/2026`,
    expected: {
      account_number_masked: '91009',
      account_type_hint: 'CREDITCARD',
      period_start: '2026-02-16',
      period_end: '2026-03-15',
      opening_balance_cents: 124_567,
      closing_balance_cents: 289_045,
      source_date_format: 'MDY',
      source_date_format_confidence: 0.95,
      transactions: [
        {
          posted_date: '2026-02-18',
          description: 'PAYMENT THANK YOU',
          amount_cents: -124_567,
          trntype: 'PAYMENT',
          source_page: 1,
          confidence: 0.99,
        },
        {
          posted_date: '2026-02-22',
          description: 'AMAZON.COM*ABC123 SEATTLE WA',
          amount_cents: 12_783,
          trntype: 'POS',
          source_page: 1,
          confidence: 0.95,
        },
        {
          posted_date: '2026-02-27',
          description: 'AWS CLOUD SERVICES',
          amount_cents: 84_215,
          trntype: 'POS',
          source_page: 1,
          confidence: 0.95,
        },
        {
          posted_date: '2026-03-01',
          description: 'UBER TRIP HELP.UBER.COM',
          amount_cents: 2_450,
          trntype: 'POS',
          source_page: 1,
          confidence: 0.95,
        },
        {
          posted_date: '2026-03-05',
          description: 'HILTON HOTELS NYC',
          amount_cents: 61_240,
          trntype: 'POS',
          source_page: 1,
          confidence: 0.95,
        },
        {
          posted_date: '2026-03-08',
          description: 'DELTA AIR LINES ATL-LAX',
          amount_cents: 128_357,
          trntype: 'POS',
          source_page: 1,
          confidence: 0.95,
        },
      ],
    },
  },
  {
    label: 'simple-checking',
    markdown: `# Acme Bank — Checking Statement
Account ending ••••1234
Period: 03/01/2026 – 03/31/2026

Opening Balance ........................ $1,200.00

Date       Description                                Amount       Balance
03/03/26   ATM WITHDRAWAL #4123                       -60.00       1,140.00
03/08/26   DIRECT DEPOSIT - PAYROLL                  3,200.00      4,340.00
03/12/26   GROCERY STORE #1882                         -74.21      4,265.79
03/19/26   WIRE TRANSFER FROM 555                       50.00      4,315.79

Closing Balance ........................ $4,315.79`,
    expected: {
      account_number_masked: '1234',
      account_type_hint: 'CHECKING',
      period_start: '2026-03-01',
      period_end: '2026-03-31',
      opening_balance_cents: 120_000,
      closing_balance_cents: 431_579,
      source_date_format: 'MDY',
      source_date_format_confidence: 0.9,
      transactions: [
        {
          posted_date: '2026-03-03',
          description: 'ATM WITHDRAWAL #4123',
          amount_cents: -6_000,
          running_balance_cents: 114_000,
          trntype: 'ATM',
          source_page: 1,
          confidence: 0.99,
        },
        {
          posted_date: '2026-03-08',
          description: 'DIRECT DEPOSIT - PAYROLL',
          amount_cents: 320_000,
          running_balance_cents: 434_000,
          trntype: 'DIRECTDEP',
          source_page: 1,
          confidence: 0.99,
        },
        {
          posted_date: '2026-03-12',
          description: 'GROCERY STORE #1882',
          amount_cents: -7_421,
          running_balance_cents: 426_579,
          trntype: 'POS',
          source_page: 1,
          confidence: 0.95,
        },
        {
          posted_date: '2026-03-19',
          description: 'WIRE TRANSFER FROM 555',
          amount_cents: 5_000,
          running_balance_cents: 431_579,
          trntype: 'XFER',
          source_page: 1,
          confidence: 0.9,
        },
      ],
    },
  },
];

export const exemplarsAsMessages = (
  limit?: number,
): Array<{ role: 'user' | 'assistant'; content: string }> => {
  const subset = limit !== undefined ? EXEMPLARS.slice(0, limit) : EXEMPLARS;
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const ex of subset) {
    out.push({ role: 'user', content: `=== STATEMENT MARKDOWN ===\n${ex.markdown}\n=== END ===` });
    out.push({ role: 'assistant', content: JSON.stringify(ex.expected, null, 2) });
  }
  return out;
};
