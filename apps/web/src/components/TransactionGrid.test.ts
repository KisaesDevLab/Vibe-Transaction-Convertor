import { describe, expect, it } from 'vitest';

import { ApiError } from '../lib/api';
import {
  DEFAULT_SUSPECT_THRESHOLD,
  buildRowEditPatch,
  deleteRowsEach,
  editFieldsFromTx,
  isGridHotkeyIgnored,
  isLowConfidence,
} from './TransactionGrid';

const tx = {
  description: 'COFFEE SHOP',
  amountCents: '-450',
  trntype: 'DEBIT',
  postedDate: '2026-04-03',
};

describe('editFieldsFromTx', () => {
  it('seeds the editor with the decimal amount', () => {
    expect(editFieldsFromTx(tx)).toEqual({
      description: 'COFFEE SHOP',
      amount: '-4.50',
      trntype: 'DEBIT',
      postedDate: '2026-04-03',
    });
  });
});

describe('buildRowEditPatch', () => {
  it('returns an empty patch when nothing changed', () => {
    expect(buildRowEditPatch(tx, editFieldsFromTx(tx))).toEqual({ ok: true, patch: {} });
  });

  it('sends only the edited field', () => {
    const fields = { ...editFieldsFromTx(tx), description: 'Blue Bottle' };
    expect(buildRowEditPatch(tx, fields)).toEqual({
      ok: true,
      patch: { description: 'Blue Bottle' },
    });
  });

  it('does not revert a field changed elsewhere since the editor was seeded', () => {
    // Editor seeded while trntype was DEBIT; a bulk change then set it to FEE.
    const base = editFieldsFromTx(tx);
    const refetched = { ...tx, trntype: 'FEE' };
    const fields = { ...base, description: 'Blue Bottle' };
    expect(buildRowEditPatch(refetched, fields, base)).toEqual({
      ok: true,
      patch: { description: 'Blue Bottle' },
    });
  });

  it('compares the amount in cents, not as typed', () => {
    const same = { ...editFieldsFromTx(tx), amount: '-4.5' };
    expect(buildRowEditPatch(tx, same)).toEqual({ ok: true, patch: {} });
    const changed = { ...editFieldsFromTx(tx), amount: '-$1,004.50' };
    expect(buildRowEditPatch(tx, changed)).toEqual({
      ok: true,
      patch: { amount_cents: '-100450' },
    });
  });

  it('trims the description and rejects an empty one', () => {
    const padded = { ...editFieldsFromTx(tx), description: '  COFFEE SHOP  ' };
    expect(buildRowEditPatch(tx, padded)).toEqual({ ok: true, patch: {} });
    const blank = { ...editFieldsFromTx(tx), description: '   ' };
    expect(buildRowEditPatch(tx, blank)).toEqual({ ok: false, error: 'description required' });
  });

  it('validates the amount and date only when edited', () => {
    const fields = editFieldsFromTx(tx);
    expect(buildRowEditPatch(tx, { ...fields, amount: 'abc' })).toEqual({
      ok: false,
      error: 'decimal like -4.50',
    });
    expect(buildRowEditPatch(tx, { ...fields, amount: '0' })).toEqual({
      ok: false,
      error: 'non-zero',
    });
    expect(buildRowEditPatch(tx, { ...fields, postedDate: '' })).toEqual({
      ok: false,
      error: 'date YYYY-MM-DD',
    });
    // A zero-amount row (unreadable amount) can still get a description fix.
    const zeroRow = { ...tx, amountCents: '0' };
    expect(
      buildRowEditPatch(zeroRow, { ...editFieldsFromTx(zeroRow), description: 'ATM' }),
    ).toEqual({ ok: true, patch: { description: 'ATM' } });
  });

  it('sends trntype and posted_date changes', () => {
    const fields = { ...editFieldsFromTx(tx), trntype: 'POS', postedDate: '2026-04-04' };
    expect(buildRowEditPatch(tx, fields)).toEqual({
      ok: true,
      patch: { trntype: 'POS', posted_date: '2026-04-04' },
    });
  });
});

describe('deleteRowsEach', () => {
  it('carries on past failures and treats a 404 as already deleted', async () => {
    const outcomes: Record<string, Error | null> = {
      a: null,
      b: new ApiError(404, { message: 'transaction b not found' }),
      c: new ApiError(500, { message: 'boom' }),
      d: new Error('network down'),
      e: null,
    };
    const tried: string[] = [];
    const gone: string[] = [];
    const failed = await deleteRowsEach(
      ['a', 'b', 'c', 'd', 'e'],
      async (id) => {
        tried.push(id);
        const err = outcomes[id];
        if (err) throw err;
      },
      (id) => gone.push(id),
    );
    expect(tried).toEqual(['a', 'b', 'c', 'd', 'e']);
    // Gone rows leave the selection; only real failures stay for a retry.
    expect(gone).toEqual(['a', 'b', 'e']);
    expect(failed).toEqual(['c', 'd']);
  });
});

describe('isLowConfidence', () => {
  it('flags confidence strictly below the threshold', () => {
    expect(isLowConfidence(0.69, DEFAULT_SUSPECT_THRESHOLD)).toBe(true);
    expect(isLowConfidence(0.7, DEFAULT_SUSPECT_THRESHOLD)).toBe(false);
    expect(isLowConfidence(0.85, 0.9)).toBe(true);
  });

  it('treats a missing confidence as confident and threshold 0 as off', () => {
    expect(isLowConfidence(null, 0.7)).toBe(false);
    expect(isLowConfidence(undefined, 0.7)).toBe(false);
    expect(isLowConfidence(0, 0)).toBe(false);
  });
});

describe('isGridHotkeyIgnored', () => {
  type KeyInput = Parameters<typeof isGridHotkeyIgnored>[0];
  // Plain objects stand in for DOM elements (the tests run without a DOM).
  const el = (props: { tagName: string; isContentEditable?: boolean }) =>
    props as unknown as KeyInput['target'];
  const key = (over: Partial<KeyInput> = {}): KeyInput => ({
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    target: el({ tagName: 'BODY' }),
    ...over,
  });

  it('handles bare keys on the page', () => {
    expect(isGridHotkeyIgnored(key())).toBe(false);
    expect(isGridHotkeyIgnored(key({ target: null }))).toBe(false);
  });

  it('ignores modifier chords (Ctrl/Cmd+R must still reload) and IME composition', () => {
    expect(isGridHotkeyIgnored(key({ ctrlKey: true }))).toBe(true);
    expect(isGridHotkeyIgnored(key({ metaKey: true }))).toBe(true);
    expect(isGridHotkeyIgnored(key({ altKey: true }))).toBe(true);
    expect(isGridHotkeyIgnored(key({ isComposing: true }))).toBe(true);
  });

  it('ignores keys typed into form controls and contenteditable', () => {
    for (const tagName of ['INPUT', 'SELECT', 'TEXTAREA']) {
      expect(isGridHotkeyIgnored(key({ target: el({ tagName }) }))).toBe(true);
    }
    const editable = el({ tagName: 'DIV', isContentEditable: true });
    expect(isGridHotkeyIgnored(key({ target: editable }))).toBe(true);
  });
});
