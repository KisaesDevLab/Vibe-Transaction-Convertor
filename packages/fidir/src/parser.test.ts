import { describe, expect, it, vi } from 'vitest';
import { parseFidir } from './parser.js';
import { searchFidir } from './search.js';

describe('parseFidir', () => {
  it('returns [] for empty input', () => {
    expect(parseFidir('')).toEqual([]);
  });

  it('parses a single record', () => {
    const input = [
      'INTU.BID=3000',
      'INTU.ORG=Wells Fargo',
      'BANK_NAME=Wells Fargo Bank, N.A.',
      'URL=https://www.wellsfargo.com',
    ].join('\n');
    const entries = parseFidir(input);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      intuBid: '3000',
      intuOrg: 'Wells Fargo',
      bankName: 'Wells Fargo Bank, N.A.',
      url: 'https://www.wellsfargo.com',
      country: 'US',
    });
  });

  it('parses multiple records separated by blank lines', () => {
    const input = [
      'INTU.BID=3000',
      'INTU.ORG=Wells Fargo',
      'BANK_NAME=Wells Fargo',
      '',
      'INTU.BID=10898',
      'INTU.ORG=Chase',
      'BANK_NAME=JPMorgan Chase',
    ].join('\n');
    const entries = parseFidir(input);
    expect(entries.map((e) => e.intuBid)).toEqual(['3000', '10898']);
  });

  it('skips records missing required fields with a warning', () => {
    const onWarning = vi.fn();
    const input = ['INTU.BID=999', 'BANK_NAME=Mystery Bank'].join('\n');
    const entries = parseFidir(input, { onWarning });
    expect(entries).toHaveLength(0);
    expect(onWarning).toHaveBeenCalledOnce();
  });

  it('warns on malformed lines but keeps going', () => {
    const onWarning = vi.fn();
    const input = [
      'this is junk',
      'INTU.BID=3000',
      'INTU.ORG=Wells Fargo',
      'BANK_NAME=Wells Fargo',
    ].join('\n');
    const entries = parseFidir(input, { onWarning });
    expect(entries).toHaveLength(1);
    expect(onWarning).toHaveBeenCalled();
  });

  it('tolerates trailing whitespace and CRLF endings', () => {
    const input = 'INTU.BID=3000  \r\nINTU.ORG=Wells Fargo\r\nBANK_NAME=Wells Fargo\r\n\r\n';
    const entries = parseFidir(input);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.intuBid).toBe('3000');
  });

  it('ignores comment lines beginning with #', () => {
    const input = [
      '# this is a comment',
      'INTU.BID=3000',
      'INTU.ORG=WF',
      'BANK_NAME=Wells Fargo',
    ].join('\n');
    expect(parseFidir(input)).toHaveLength(1);
  });
});

describe('searchFidir', () => {
  const entries = parseFidir(
    [
      'INTU.BID=3000',
      'INTU.ORG=Wells Fargo',
      'BANK_NAME=Wells Fargo Bank',
      '',
      'INTU.BID=10898',
      'INTU.ORG=Chase',
      'BANK_NAME=JPMorgan Chase',
    ].join('\n'),
  );

  it('exact-matches BID over name match', () => {
    const r = searchFidir(entries, '3000');
    expect(r).toHaveLength(1);
    expect(r[0]?.intuOrg).toBe('Wells Fargo');
  });

  it('substring-matches bank name (case-insensitive)', () => {
    expect(searchFidir(entries, 'chase')).toHaveLength(1);
    expect(searchFidir(entries, 'WELLS')).toHaveLength(1);
  });

  it('returns [] for empty query', () => {
    expect(searchFidir(entries, '')).toEqual([]);
  });
});
