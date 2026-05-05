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
  {
    label: 'bofa-checking',
    markdown: `# Bank of America — Advantage Checking
Account ending ••••8821
Statement Period: 05/01/2026 through 05/31/2026

Beginning Balance on 05/01/2026 ............... $5,200.00

Deposits and other additions
05/02  DIRECT DEPOSIT ACME CORP PAYROLL              2,400.00
05/20  MOBILE CHECK DEPOSIT                            540.00
05/30  WIRE TRANSFER RECEIVED FROM GLOBEX INC        1,250.00

Withdrawals and other subtractions
05/05  ONLINE TRANSFER TO SAVINGS ••••2244            -300.00
05/10  POS PURCHASE TRADER JOES #421                   -82.55
05/14  ATM WITHDRAWAL MAIN STREET BRANCH              -100.00
05/27  MONTHLY MAINTENANCE FEE                         -12.00

Ending Balance on 05/31/2026 .................. $8,895.45`,
    expected: {
      account_number_masked: '8821',
      account_type_hint: 'CHECKING',
      period_start: '2026-05-01',
      period_end: '2026-05-31',
      opening_balance_cents: 520_000,
      closing_balance_cents: 889_545,
      source_date_format: 'MDY',
      source_date_format_confidence: 0.95,
      transactions: [
        {
          posted_date: '2026-05-02',
          description: 'DIRECT DEPOSIT ACME CORP PAYROLL',
          amount_cents: 240_000,
          trntype: 'DIRECTDEP',
          source_page: 1,
          confidence: 0.99,
        },
        {
          posted_date: '2026-05-05',
          description: 'ONLINE TRANSFER TO SAVINGS ••••2244',
          amount_cents: -30_000,
          trntype: 'XFER',
          source_page: 1,
          confidence: 0.99,
        },
        {
          posted_date: '2026-05-10',
          description: 'POS PURCHASE TRADER JOES #421',
          amount_cents: -8_255,
          trntype: 'POS',
          source_page: 1,
          confidence: 0.95,
        },
        {
          posted_date: '2026-05-14',
          description: 'ATM WITHDRAWAL MAIN STREET BRANCH',
          amount_cents: -10_000,
          trntype: 'ATM',
          source_page: 1,
          confidence: 0.99,
        },
        {
          posted_date: '2026-05-20',
          description: 'MOBILE CHECK DEPOSIT',
          amount_cents: 54_000,
          trntype: 'DEP',
          source_page: 1,
          confidence: 0.97,
        },
        {
          posted_date: '2026-05-27',
          description: 'MONTHLY MAINTENANCE FEE',
          amount_cents: -1_200,
          trntype: 'SRVCHG',
          source_page: 1,
          confidence: 0.99,
        },
        {
          posted_date: '2026-05-30',
          description: 'WIRE TRANSFER RECEIVED FROM GLOBEX INC',
          amount_cents: 125_000,
          trntype: 'XFER',
          source_page: 1,
          confidence: 0.95,
        },
      ],
    },
  },
  {
    label: 'capital-one-credit-card',
    markdown: `# Capital One Quicksilver
Account ending ••••3344
Statement Closing Date: 06/30/2026
Previous Balance: $850.45
Payments/Credits: -$850.45
New Charges: $42.84
New Balance: $42.84

Statement Period: 06/01/2026 — 06/30/2026

Date     Description                                       Amount
06/02    CAPITAL ONE MOBILE PAYMENT - THANK YOU          -850.45
06/05    SHELL OIL 12345                                   48.20
06/10    NETFLIX.COM                                       15.99
06/15    TARGET T-1234 MINNEAPOLIS                        132.78
06/20    SPOTIFY USA                                       11.99
06/25    HOME DEPOT 0987                                  215.43`,
    expected: {
      account_number_masked: '3344',
      account_type_hint: 'CREDITCARD',
      period_start: '2026-06-01',
      period_end: '2026-06-30',
      opening_balance_cents: 85_045,
      closing_balance_cents: 42_439,
      source_date_format: 'MDY',
      source_date_format_confidence: 0.95,
      transactions: [
        {
          posted_date: '2026-06-02',
          description: 'CAPITAL ONE MOBILE PAYMENT - THANK YOU',
          amount_cents: -85_045,
          trntype: 'PAYMENT',
          source_page: 1,
          confidence: 0.99,
        },
        {
          posted_date: '2026-06-05',
          description: 'SHELL OIL 12345',
          amount_cents: 4_820,
          trntype: 'POS',
          source_page: 1,
          confidence: 0.95,
        },
        {
          posted_date: '2026-06-10',
          description: 'NETFLIX.COM',
          amount_cents: 1_599,
          trntype: 'POS',
          source_page: 1,
          confidence: 0.95,
        },
        {
          posted_date: '2026-06-15',
          description: 'TARGET T-1234 MINNEAPOLIS',
          amount_cents: 13_278,
          trntype: 'POS',
          source_page: 1,
          confidence: 0.95,
        },
        {
          posted_date: '2026-06-20',
          description: 'SPOTIFY USA',
          amount_cents: 1_199,
          trntype: 'POS',
          source_page: 1,
          confidence: 0.95,
        },
        {
          posted_date: '2026-06-25',
          description: 'HOME DEPOT 0987',
          amount_cents: 21_543,
          trntype: 'POS',
          source_page: 1,
          confidence: 0.95,
        },
      ],
    },
  },
  {
    label: 'discover-credit-card',
    markdown: `# Discover it Cash Back
Account ending ••••7711
Statement Closing Date: 07/31/2026
Previous Balance: $1,580.20
Payments and Credits: -$1,605.20
Purchases: $828.02
New Balance: $783.02

Statement Period: 07/01/2026 — 07/31/2026

Trans Date   Description                                   Amount
07/03        INTERNET PAYMENT - THANK YOU                -1,580.20
07/08        WALMART STORE 4421                              87.65
07/12        COSTCO WHOLESALE 0815                          412.93
07/18        STARBUCKS STORE 09182                            7.45
07/22        BEST BUY #1230                                 299.99
07/28        CASHBACK BONUS REDEMPTION                      -25.00`,
    expected: {
      account_number_masked: '7711',
      account_type_hint: 'CREDITCARD',
      period_start: '2026-07-01',
      period_end: '2026-07-31',
      opening_balance_cents: 158_020,
      closing_balance_cents: 78_302,
      source_date_format: 'MDY',
      source_date_format_confidence: 0.95,
      transactions: [
        {
          posted_date: '2026-07-03',
          description: 'INTERNET PAYMENT - THANK YOU',
          amount_cents: -158_020,
          trntype: 'PAYMENT',
          source_page: 1,
          confidence: 0.99,
        },
        {
          posted_date: '2026-07-08',
          description: 'WALMART STORE 4421',
          amount_cents: 8_765,
          trntype: 'POS',
          source_page: 1,
          confidence: 0.95,
        },
        {
          posted_date: '2026-07-12',
          description: 'COSTCO WHOLESALE 0815',
          amount_cents: 41_293,
          trntype: 'POS',
          source_page: 1,
          confidence: 0.95,
        },
        {
          posted_date: '2026-07-18',
          description: 'STARBUCKS STORE 09182',
          amount_cents: 745,
          trntype: 'POS',
          source_page: 1,
          confidence: 0.95,
        },
        {
          posted_date: '2026-07-22',
          description: 'BEST BUY #1230',
          amount_cents: 29_999,
          trntype: 'POS',
          source_page: 1,
          confidence: 0.95,
        },
        {
          posted_date: '2026-07-28',
          description: 'CASHBACK BONUS REDEMPTION',
          amount_cents: -2_500,
          trntype: 'CREDIT',
          source_page: 1,
          confidence: 0.95,
        },
      ],
    },
  },
  {
    label: 'citi-credit-card',
    markdown: `# Citi Business / AAdvantage Platinum Select
Account ending ••••5599
Statement Period: 01/08/2026 — 31/08/2026
Statement Closing Date: 31/08/2026

Previous Balance: $645.30
Payments/Credits: -$645.30
Purchases: $1,904.40
New Balance: $1,904.40

Trans Date    Description                                  Amount
03/08/2026    PAYMENT RECEIVED THANK YOU                  -645.30
12/08/2026    LONDON UNDERGROUND TFL                        28.50
15/08/2026    SAINSBURYS LONDON                            142.65
19/08/2026    BRITISH AIRWAYS LHR-JFK                    1,289.00
24/08/2026    PRET A MANGER 0123                            18.45
28/08/2026    HILTON LONDON PADDINGTON                     425.80`,
    expected: {
      account_number_masked: '5599',
      account_type_hint: 'CREDITCARD',
      period_start: '2026-08-01',
      period_end: '2026-08-31',
      opening_balance_cents: 64_530,
      closing_balance_cents: 190_440,
      source_date_format: 'DMY',
      source_date_format_confidence: 0.92,
      transactions: [
        {
          posted_date: '2026-08-03',
          description: 'PAYMENT RECEIVED THANK YOU',
          amount_cents: -64_530,
          trntype: 'PAYMENT',
          source_page: 1,
          confidence: 0.99,
        },
        {
          posted_date: '2026-08-12',
          description: 'LONDON UNDERGROUND TFL',
          amount_cents: 2_850,
          trntype: 'POS',
          source_page: 1,
          confidence: 0.95,
        },
        {
          posted_date: '2026-08-15',
          description: 'SAINSBURYS LONDON',
          amount_cents: 14_265,
          trntype: 'POS',
          source_page: 1,
          confidence: 0.95,
        },
        {
          posted_date: '2026-08-19',
          description: 'BRITISH AIRWAYS LHR-JFK',
          amount_cents: 128_900,
          trntype: 'POS',
          source_page: 1,
          confidence: 0.95,
        },
        {
          posted_date: '2026-08-24',
          description: 'PRET A MANGER 0123',
          amount_cents: 1_845,
          trntype: 'POS',
          source_page: 1,
          confidence: 0.95,
        },
        {
          posted_date: '2026-08-28',
          description: 'HILTON LONDON PADDINGTON',
          amount_cents: 42_580,
          trntype: 'POS',
          source_page: 1,
          confidence: 0.95,
        },
      ],
    },
  },
  {
    label: 'us-bank-checking',
    markdown: `# U.S. Bank — Easy Checking
Account ending ••••6644
Statement Period: 2026-09-01 to 2026-09-30

Beginning Balance 2026-09-01 .................... $3,650.75

Date         Description                                       Amount
2026-09-02   ACH DEPOSIT GUSTO PAYROLL                       2,850.00
2026-09-04   EXTERNAL TRANSFER FROM SAV ••••7766               500.00
2026-09-09   DEBIT CARD PURCHASE WHOLE FOODS #4429            -156.78
2026-09-15   ATM WITHDRAWAL US BANK BRANCH 0182               -200.00
2026-09-22   ONLINE BILL PAY DUKE ENERGY                      -184.20
2026-09-28   INTEREST PAYMENT                                    1.85

Ending Balance 2026-09-30 ....................... $6,461.62`,
    expected: {
      account_number_masked: '6644',
      account_type_hint: 'CHECKING',
      period_start: '2026-09-01',
      period_end: '2026-09-30',
      opening_balance_cents: 365_075,
      closing_balance_cents: 646_162,
      source_date_format: 'YMD',
      source_date_format_confidence: 0.98,
      transactions: [
        {
          posted_date: '2026-09-02',
          description: 'ACH DEPOSIT GUSTO PAYROLL',
          amount_cents: 285_000,
          trntype: 'DIRECTDEP',
          source_page: 1,
          confidence: 0.99,
        },
        {
          posted_date: '2026-09-04',
          description: 'EXTERNAL TRANSFER FROM SAV ••••7766',
          amount_cents: 50_000,
          trntype: 'XFER',
          source_page: 1,
          confidence: 0.99,
        },
        {
          posted_date: '2026-09-09',
          description: 'DEBIT CARD PURCHASE WHOLE FOODS #4429',
          amount_cents: -15_678,
          trntype: 'POS',
          source_page: 1,
          confidence: 0.95,
        },
        {
          posted_date: '2026-09-15',
          description: 'ATM WITHDRAWAL US BANK BRANCH 0182',
          amount_cents: -20_000,
          trntype: 'ATM',
          source_page: 1,
          confidence: 0.99,
        },
        {
          posted_date: '2026-09-22',
          description: 'ONLINE BILL PAY DUKE ENERGY',
          amount_cents: -18_420,
          trntype: 'PAYMENT',
          source_page: 1,
          confidence: 0.95,
        },
        {
          posted_date: '2026-09-28',
          description: 'INTEREST PAYMENT',
          amount_cents: 185,
          trntype: 'INT',
          source_page: 1,
          confidence: 0.99,
        },
      ],
    },
  },
  {
    label: 'pnc-business-checking',
    markdown: `# PNC Bank — Business Checking
Account ending ••••9988
Statement Period: 2026-10-01 to 2026-10-31

Beginning Balance 2026-10-01 ................... $18,920.40

Deposits and Credits
2026-10-02   ACH CREDIT CLIENT INVOICE 8821                 5,400.00
2026-10-14   REMOTE DEPOSIT BATCH                           2,825.50
2026-10-30   INTEREST EARNED                                   12.45

Withdrawals and Debits
2026-10-05   WIRE OUT TO VENDOR ZENITH LLC                 -3,200.00
2026-10-10   PAYROLL ADP TX/FEES                           -8,750.00
2026-10-20   TREASURY MGMT MONTHLY FEE                        -45.00
2026-10-25   ONLINE TRANSFER TO MMA ••••3399               -1,000.00

Ending Balance 2026-10-31 ...................... $14,163.35`,
    expected: {
      account_number_masked: '9988',
      account_type_hint: 'CHECKING',
      period_start: '2026-10-01',
      period_end: '2026-10-31',
      opening_balance_cents: 1_892_040,
      closing_balance_cents: 1_416_335,
      source_date_format: 'YMD',
      source_date_format_confidence: 0.98,
      transactions: [
        {
          posted_date: '2026-10-02',
          description: 'ACH CREDIT CLIENT INVOICE 8821',
          amount_cents: 540_000,
          trntype: 'DEP',
          source_page: 1,
          confidence: 0.97,
        },
        {
          posted_date: '2026-10-05',
          description: 'WIRE OUT TO VENDOR ZENITH LLC',
          amount_cents: -320_000,
          trntype: 'XFER',
          source_page: 1,
          confidence: 0.99,
        },
        {
          posted_date: '2026-10-10',
          description: 'PAYROLL ADP TX/FEES',
          amount_cents: -875_000,
          trntype: 'DIRECTDEBIT',
          source_page: 1,
          confidence: 0.95,
        },
        {
          posted_date: '2026-10-14',
          description: 'REMOTE DEPOSIT BATCH',
          amount_cents: 282_550,
          trntype: 'DEP',
          source_page: 1,
          confidence: 0.97,
        },
        {
          posted_date: '2026-10-20',
          description: 'TREASURY MGMT MONTHLY FEE',
          amount_cents: -4_500,
          trntype: 'SRVCHG',
          source_page: 1,
          confidence: 0.99,
        },
        {
          posted_date: '2026-10-25',
          description: 'ONLINE TRANSFER TO MMA ••••3399',
          amount_cents: -100_000,
          trntype: 'XFER',
          source_page: 1,
          confidence: 0.99,
        },
        {
          posted_date: '2026-10-30',
          description: 'INTEREST EARNED',
          amount_cents: 1_245,
          trntype: 'INT',
          source_page: 1,
          confidence: 0.99,
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
