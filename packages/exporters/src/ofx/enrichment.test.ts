// Phase 33 — exports.ts maps cleansedDescription -> NAME and the raw
// description -> MEMO. The OFX writer itself is unchanged; this test
// pins down the writer's NAME/MEMO behaviour given the AST shape the
// service builds in production.

import { describe, expect, it } from 'vitest';

import { renderStmtTrnXml } from './xml-writer.js';

describe('renderStmtTrnXml — NAME / MEMO behaviour', () => {
  const baseRow = {
    trntype: 'POS',
    postedDate: '2026-03-08',
    amountCents: -42_50n,
    fitid: 'VTC-abc',
  };

  it('emits NAME only when memo is absent', () => {
    const out = renderStmtTrnXml({ ...baseRow, name: 'POS DBT 0123 SQ *AMTHAUS' });
    expect(out).toContain('<NAME>POS DBT 0123 SQ *AMTHAUS</NAME>');
    expect(out).not.toContain('<MEMO>');
  });

  it('emits NAME=cleansed and MEMO=raw when both are set', () => {
    const out = renderStmtTrnXml({
      ...baseRow,
      name: 'Square — Amthaus',
      memo: 'POS DBT 0123 SQ *AMTHAUS',
    });
    expect(out).toContain('<NAME>Square — Amthaus</NAME>');
    expect(out).toContain('<MEMO>POS DBT 0123 SQ *AMTHAUS</MEMO>');
  });

  it('truncates NAME to 32 chars and MEMO to 255', () => {
    const longName = 'X'.repeat(40);
    const longMemo = 'Y'.repeat(300);
    const out = renderStmtTrnXml({ ...baseRow, name: longName, memo: longMemo });
    expect(out).toContain(`<NAME>${'X'.repeat(32)}</NAME>`);
    expect(out).toContain(`<MEMO>${'Y'.repeat(255)}</MEMO>`);
  });
});
