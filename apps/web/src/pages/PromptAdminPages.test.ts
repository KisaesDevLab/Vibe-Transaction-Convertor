import { describe, expect, it } from 'vitest';

import { fieldPatch as enrichmentFieldPatch } from './EnrichmentPromptAdminPage';
import { fieldPatch as extractionFieldPatch } from './ExtractionPromptAdminPage';

const DEFAULT = 'built-in default prompt';
const builtIn = { current: DEFAULT, isOverride: false, defaultValue: DEFAULT };
const override = { current: 'custom rules', isOverride: true, defaultValue: DEFAULT };
// An override saved as a verbatim copy of the default (the old Reset → Save bug).
const verbatimOverride = { current: DEFAULT, isOverride: true, defaultValue: DEFAULT };

describe.each([
  ['enrichment', enrichmentFieldPatch],
  ['extraction', extractionFieldPatch],
])('%s prompt fieldPatch', (_name, fieldPatch) => {
  it('leaves an untouched field alone', () => {
    expect(fieldPatch(DEFAULT, builtIn, false)).toBeUndefined();
    expect(fieldPatch('custom rules', override, false)).toBeUndefined();
  });

  it('sends edited text as the new override', () => {
    expect(fieldPatch('new rules', builtIn, false)).toBe('new rules');
    expect(fieldPatch('new rules', override, false)).toBe('new rules');
  });

  it('clears (null) an override whose text was reset to the default — never stores a copy', () => {
    expect(fieldPatch(DEFAULT, override, false)).toBeNull();
    expect(fieldPatch(DEFAULT, override, true)).toBeNull();
  });

  it('does not send anything when the default is already in effect', () => {
    expect(fieldPatch(DEFAULT, builtIn, true)).toBeUndefined();
  });

  it('clears a verbatim-default override only after an explicit reset', () => {
    expect(fieldPatch(DEFAULT, verbatimOverride, false)).toBeUndefined();
    expect(fieldPatch(DEFAULT, verbatimOverride, true)).toBeNull();
  });

  it('treats an empty default (extra instructions) the same way', () => {
    const emptyDefault = { current: 'quirk notes', isOverride: true, defaultValue: '' };
    expect(fieldPatch('', emptyDefault, false)).toBeNull();
    expect(fieldPatch('', { current: '', isOverride: false, defaultValue: '' }, false)).toBe(
      undefined,
    );
  });
});
