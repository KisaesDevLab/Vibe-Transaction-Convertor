import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CATEGORIZE_RULES,
  DEFAULT_CLEANSE_RULES,
  DEFAULT_FULL_SYSTEM_PROMPT,
  enrichmentSystemPromptFor,
} from './enrich.js';

const CATEGORIES = [
  { name: 'Income', description: 'Money in' },
  { name: 'Office Supplies' },
  { name: 'Transfer' },
];

describe('enrichmentSystemPromptFor', () => {
  describe('rules mode (default)', () => {
    it('embeds the built-in cleanse + categorize rules and the live category list', () => {
      const out = enrichmentSystemPromptFor({
        cleanse: true,
        categorize: true,
        categories: CATEGORIES,
      });
      expect(out).toContain('You are an expert bookkeeping assistant');
      expect(out).toContain(DEFAULT_CLEANSE_RULES);
      expect(out).toContain(DEFAULT_CATEGORIZE_RULES);
      expect(out).toContain('Available categories:');
      expect(out).toContain('  - Income: Money in');
      expect(out).toContain('  - Office Supplies');
      expect(out).toContain('  - Transfer');
    });

    it('omits the cleanse block when cleanse=false', () => {
      const out = enrichmentSystemPromptFor({
        cleanse: false,
        categorize: true,
        categories: CATEGORIES,
      });
      expect(out).not.toContain('Cleansing rules');
      expect(out).toContain('Categorization rules');
    });

    it('uses the operator override for cleanse rules when provided', () => {
      const out = enrichmentSystemPromptFor({
        cleanse: true,
        categorize: false,
        categories: CATEGORIES,
        cleanseRulesOverride: 'CUSTOM CLEANSE: keep merchant short.',
      });
      expect(out).toContain('CUSTOM CLEANSE: keep merchant short.');
      expect(out).not.toContain(DEFAULT_CLEANSE_RULES);
    });

    it('falls back to the default when the override is empty/whitespace', () => {
      const out = enrichmentSystemPromptFor({
        cleanse: true,
        categorize: false,
        categories: CATEGORIES,
        cleanseRulesOverride: '   \n  ',
      });
      expect(out).toContain(DEFAULT_CLEANSE_RULES);
    });

    it('appends the live category list after a categorize override', () => {
      const out = enrichmentSystemPromptFor({
        cleanse: false,
        categorize: true,
        categories: CATEGORIES,
        categorizeRulesOverride: 'CUSTOM CAT: pick the closest match.',
      });
      expect(out).toContain('CUSTOM CAT: pick the closest match.');
      expect(out).toContain('Available categories:');
      expect(out).toContain('  - Income');
    });

    it('appends the per-statement account-context section when accountType is set', () => {
      const out = enrichmentSystemPromptFor({
        cleanse: true,
        categorize: false,
        accountType: 'CREDITCARD',
        categories: CATEGORIES,
      });
      expect(out).toContain('this statement is for a CREDITCARD account');
    });
  });

  describe('full takeover mode', () => {
    it('replaces the entire prompt and substitutes {{categories}}', () => {
      const out = enrichmentSystemPromptFor({
        cleanse: true,
        categorize: true,
        categories: CATEGORIES,
        mode: 'full',
        fullSystemPromptOverride: 'OPERATOR PROMPT: do the thing. Pick from:\n{{categories}}',
      });
      expect(out).toContain('OPERATOR PROMPT: do the thing.');
      expect(out).toContain('  - Income: Money in');
      expect(out).not.toContain('You are an expert bookkeeping assistant');
      expect(out).not.toContain('{{categories}}');
    });

    it('still appends account-context after the operator prompt in full mode', () => {
      const out = enrichmentSystemPromptFor({
        cleanse: true,
        categorize: true,
        accountType: 'CHECKING',
        categories: CATEGORIES,
        mode: 'full',
        fullSystemPromptOverride: 'OP: short.\n{{categories}}',
      });
      expect(out).toContain('OP: short.');
      expect(out).toContain('this statement is for a CHECKING account');
    });

    it('falls back to rules mode when fullSystemPromptOverride is empty even with mode=full', () => {
      const out = enrichmentSystemPromptFor({
        cleanse: true,
        categorize: true,
        categories: CATEGORIES,
        mode: 'full',
        fullSystemPromptOverride: '',
      });
      // No rejection — operator likely flipped the mode but hasn't
      // saved a custom prompt yet. Better to fall back to safe defaults
      // than send an empty system prompt to the model.
      expect(out).toContain('You are an expert bookkeeping assistant');
    });

    it('default full prompt preserves built-in behavior when used verbatim', () => {
      const out = enrichmentSystemPromptFor({
        cleanse: true,
        categorize: true,
        categories: CATEGORIES,
        mode: 'full',
        fullSystemPromptOverride: DEFAULT_FULL_SYSTEM_PROMPT,
      });
      expect(out).toContain('You are an expert bookkeeping assistant');
      expect(out).toContain(DEFAULT_CLEANSE_RULES);
      expect(out).toContain(DEFAULT_CATEGORIZE_RULES);
      expect(out).toContain('  - Income: Money in');
    });
  });
});
