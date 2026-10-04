import { describe, expect, it } from 'vitest';

import { AccountUpdate } from './account.js';

describe('AccountUpdate', () => {
  it('accepts an empty patch and leaves absent fields absent', () => {
    expect(AccountUpdate.parse({})).toEqual({});
    expect(AccountUpdate.parse({ nickname: ' Operating ' })).toEqual({ nickname: 'Operating' });
  });

  it('null clears the routing number; a blank string means the same', () => {
    // The account edit form sends routingNumber: null for an emptied field
    // (and for every credit card) together with the other edits.
    expect(
      AccountUpdate.parse({ nickname: 'AmEx', defaultCsvTemplate: 'qbo3', routingNumber: null }),
    ).toEqual({ nickname: 'AmEx', defaultCsvTemplate: 'qbo3', routingNumber: null });
    expect(AccountUpdate.parse({ routingNumber: '' })).toEqual({ routingNumber: null });
    expect(AccountUpdate.parse({ routingNumber: '   ' })).toEqual({ routingNumber: null });
  });

  it('trims a routing number', () => {
    expect(AccountUpdate.parse({ routingNumber: ' 021000021 ' })).toEqual({
      routingNumber: '021000021',
    });
  });

  it('refuses a routing number on a credit card in the same patch', () => {
    const r = AccountUpdate.safeParse({ accountType: 'CREDITCARD', routingNumber: '021000021' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['routingNumber']);
  });

  it('allows switching to a credit card while clearing the routing number', () => {
    expect(AccountUpdate.parse({ accountType: 'CREDITCARD', routingNumber: null })).toEqual({
      accountType: 'CREDITCARD',
      routingNumber: null,
    });
  });

  it('requires at least 4 digits in an account number, as AccountCreate does', () => {
    expect(AccountUpdate.safeParse({ accountNumber: '----' }).success).toBe(false);
    expect(AccountUpdate.safeParse({ accountNumber: '12-3' }).success).toBe(false);
    expect(AccountUpdate.safeParse({ accountNumber: 'abcd' }).success).toBe(false);
    expect(AccountUpdate.parse({ accountNumber: '1234-5678' })).toEqual({
      accountNumber: '1234-5678',
    });
  });

  it('still rejects a wrong type for routingNumber', () => {
    expect(AccountUpdate.safeParse({ routingNumber: 21000021 }).success).toBe(false);
  });
});
