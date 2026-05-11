import { describe, expect, it } from 'vitest';

import { providerOrderFor, type LlmProviderPolicy } from './llm-provider.js';

describe('providerOrderFor', () => {
  it('maps each policy to the right primary/secondary pair', () => {
    const cases: Array<[LlmProviderPolicy, 'local' | 'anthropic', 'local' | 'anthropic' | null]> = [
      ['local-only', 'local', null],
      ['anthropic-only', 'anthropic', null],
      ['local-first', 'local', 'anthropic'],
      ['anthropic-first', 'anthropic', 'local'],
    ];
    for (const [policy, primary, secondary] of cases) {
      expect(providerOrderFor(policy)).toEqual({ primary, secondary });
    }
  });

  it('returns secondary=null exactly for the *-only modes', () => {
    expect(providerOrderFor('local-only').secondary).toBeNull();
    expect(providerOrderFor('anthropic-only').secondary).toBeNull();
    expect(providerOrderFor('local-first').secondary).toBe('anthropic');
    expect(providerOrderFor('anthropic-first').secondary).toBe('local');
  });
});
