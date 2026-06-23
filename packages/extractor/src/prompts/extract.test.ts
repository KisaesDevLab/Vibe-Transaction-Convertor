import { describe, expect, it } from 'vitest';

import { prepareMarkdown } from '../llm-client.js';
import { SYSTEM_PROMPT, extractionSystemPromptFor } from './extract.js';

describe('extractionSystemPromptFor', () => {
  it('returns the built-in default in rules mode with no extra instructions', () => {
    expect(extractionSystemPromptFor()).toBe(SYSTEM_PROMPT);
    expect(extractionSystemPromptFor({ mode: 'rules' })).toBe(SYSTEM_PROMPT);
    expect(extractionSystemPromptFor({ mode: 'rules', extraInstructions: '   ' })).toBe(
      SYSTEM_PROMPT,
    );
  });

  it('appends operator instructions after the default in rules mode', () => {
    const out = extractionSystemPromptFor({ mode: 'rules', extraInstructions: 'Bank X quirk.' });
    expect(out.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(out).toContain('ADDITIONAL OPERATOR INSTRUCTIONS');
    expect(out).toContain('Bank X quirk.');
  });

  it('uses the full override verbatim in full mode', () => {
    const out = extractionSystemPromptFor({ mode: 'full', fullSystemPrompt: 'ONLY THIS PROMPT' });
    expect(out).toBe('ONLY THIS PROMPT');
  });

  it('falls back to the default when full mode override is blank', () => {
    expect(extractionSystemPromptFor({ mode: 'full', fullSystemPrompt: '   ' })).toBe(
      SYSTEM_PROMPT,
    );
    expect(extractionSystemPromptFor({ mode: 'full' })).toBe(SYSTEM_PROMPT);
  });

  it('default prompt states integer-cents with a worked example', () => {
    expect(SYSTEM_PROMPT).toMatch(/123456/);
    expect(SYSTEM_PROMPT).toMatch(/integer (number of )?cents/i);
  });
});

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
