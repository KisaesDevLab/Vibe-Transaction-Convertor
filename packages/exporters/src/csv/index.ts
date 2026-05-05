// CSV exporters for QuickBooks 3-col / 4-col, Xero, and a generic
// flat profile. All output uses CRLF line endings (Windows-friendly,
// QuickBooks-friendly), unconditionally quotes fields containing
// commas, quotes, or newlines, and emits dates in en-US MDY (ADR-014).

import { centsToDecimal } from '../ofx/ast.js';

export type CsvTemplate = 'qbo3' | 'qbo4' | 'xero' | 'generic';

export interface CsvRow {
  postedDate: string; // YYYY-MM-DD
  description: string;
  amountCents: bigint;
  checkNumber?: string | undefined;
  memo?: string | undefined;
}

const escapeCell = (s: string): string => {
  if (/[",\r\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
};

const toCsv = (rows: string[][]): string =>
  rows.map((r) => r.map(escapeCell).join(',')).join('\r\n') + '\r\n';

const isoToMdy = (iso: string): string => {
  const [yyyy, mm, dd] = iso.split('-');
  return `${mm}/${dd}/${yyyy}`;
};

// QBO 3-column: Date, Description, Amount (signed; debits negative)
const renderQbo3 = (rows: CsvRow[]): string => {
  const out: string[][] = [['Date', 'Description', 'Amount']];
  for (const r of rows) {
    out.push([isoToMdy(r.postedDate), r.description, centsToDecimal(r.amountCents)]);
  }
  return toCsv(out);
};

// QBO 4-column: Date, Description, Debit, Credit (positive in their column)
const renderQbo4 = (rows: CsvRow[]): string => {
  const out: string[][] = [['Date', 'Description', 'Debit', 'Credit']];
  for (const r of rows) {
    const negative = r.amountCents < 0n;
    const abs = negative ? -r.amountCents : r.amountCents;
    out.push([
      isoToMdy(r.postedDate),
      r.description,
      negative ? centsToDecimal(abs) : '',
      negative ? '' : centsToDecimal(abs),
    ]);
  }
  return toCsv(out);
};

// Xero: *Date, *Amount, Payee, Description, Reference, Cheque Number
const renderXero = (rows: CsvRow[]): string => {
  const out: string[][] = [
    ['*Date', '*Amount', 'Payee', 'Description', 'Reference', 'Cheque Number'],
  ];
  for (const r of rows) {
    out.push([
      isoToMdy(r.postedDate),
      centsToDecimal(r.amountCents),
      r.description.split('  ')[0] ?? '',
      r.description,
      r.memo ?? '',
      r.checkNumber ?? '',
    ]);
  }
  return toCsv(out);
};

// Generic: Date,Description,Amount,Memo
const renderGeneric = (rows: CsvRow[]): string => {
  const out: string[][] = [['Date', 'Description', 'Amount', 'Memo']];
  for (const r of rows) {
    out.push([isoToMdy(r.postedDate), r.description, centsToDecimal(r.amountCents), r.memo ?? '']);
  }
  return toCsv(out);
};

export const renderCsv = (template: CsvTemplate, rows: CsvRow[]): string => {
  switch (template) {
    case 'qbo3':
      return renderQbo3(rows);
    case 'qbo4':
      return renderQbo4(rows);
    case 'xero':
      return renderXero(rows);
    case 'generic':
      return renderGeneric(rows);
  }
};
