import { describe, expect, it } from 'vitest';

import { prepareMarkdown } from '../llm-client.js';

describe('prepareMarkdown truncation', () => {
  it('returns full text and truncated=false when input fits the budget', () => {
    const r = prepareMarkdown('# Page 1\n\nshort statement', 24_000);
    expect(r.truncated).toBe(false);
    expect(r.text).toContain('short statement');
  });

  it('preserves both head and tail when input exceeds the budget', () => {
    // ~50K tokens of filler with distinctive head + tail markers — the
    // golden-rule reconciler needs the trailing close balance, so the
    // tail must survive truncation.
    const headMarker = 'OPENING_BALANCE_MARKER_AAA';
    const tailMarker = 'CLOSING_BALANCE_MARKER_ZZZ';
    const filler = 'lorem ipsum '.repeat(20_000);
    const raw = `${headMarker}\n${filler}\n${tailMarker}`;
    const r = prepareMarkdown(raw, 5_000); // tight budget to force truncation
    expect(r.truncated).toBe(true);
    expect(r.text).toContain(headMarker);
    expect(r.text).toContain(tailMarker);
    expect(r.text).toContain('truncated');
  });

  it('keeps the output within the char budget when truncating', () => {
    const raw = 'x'.repeat(200_000);
    const r = prepareMarkdown(raw, 5_000);
    expect(r.truncated).toBe(true);
    // allowed = max(1000, 5000-4000) = 1000 tokens ≈ 4000 chars; plus
    // marker; output should be comfortably under 5000 chars.
    expect(r.text.length).toBeLessThan(5_000);
  });
});
