// Phase 33 — JSON Schema builder tests for enrichment. Locks in the
// dynamic-shape behaviour so a future change can't accidentally drop
// the additionalProperties=false guard or omit the category enum.

import { describe, expect, it } from 'vitest';

import { buildEnrichmentJsonSchema, ENRICHMENT_CLEANSED_MAX_LENGTH } from './enrichment.js';

describe('buildEnrichmentJsonSchema', () => {
  const oneCategory = [{ name: 'Office' }];

  it('rejects a no-op request', () => {
    expect(() =>
      buildEnrichmentJsonSchema({ cleanse: false, categorize: false, categoryNames: [] }),
    ).toThrow(/at least one/i);
  });

  it('rejects categorize with empty list', () => {
    expect(() =>
      buildEnrichmentJsonSchema({ cleanse: false, categorize: true, categoryNames: [] }),
    ).toThrow(/non-empty categoryNames/);
  });

  it('cleanse-only schema requires cleansed_description and forbids category', () => {
    const sch = buildEnrichmentJsonSchema({
      cleanse: true,
      categorize: false,
      categoryNames: [],
    }) as {
      properties: {
        transactions: { items: { required: string[]; properties: Record<string, unknown> } };
      };
    };
    const item = sch.properties.transactions.items;
    expect(item.required).toEqual([
      'index',
      'cleansed_description',
      'merchant_name',
      'processor',
      'transaction_type',
      'is_opaque',
      'confidence',
    ]);
    expect(item.properties.cleansed_description).toMatchObject({
      maxLength: ENRICHMENT_CLEANSED_MAX_LENGTH,
    });
    expect(item.properties.category).toBeUndefined();
    // Structured cleanse fields present + constrained.
    const props = item.properties as Record<string, { type?: unknown; enum?: string[] }>;
    expect(props.transaction_type?.enum).toContain('p2p');
    expect(props.confidence?.enum).toEqual(['high', 'medium', 'low']);
    expect(props.is_opaque?.type).toBe('boolean');
    expect(props.merchant_name?.type).toEqual(['string', 'null']);
  });

  it('categorize-only schema requires category enum', () => {
    const sch = buildEnrichmentJsonSchema({
      cleanse: false,
      categorize: true,
      categoryNames: oneCategory.map((c) => c.name),
    }) as {
      properties: {
        transactions: {
          items: { required: string[]; properties: { category?: { enum?: string[] } } };
        };
      };
    };
    const item = sch.properties.transactions.items;
    expect(item.required).toEqual(['index', 'category']);
    expect(item.properties.category?.enum).toEqual(['Office']);
  });

  it('both schema requires both fields', () => {
    const sch = buildEnrichmentJsonSchema({
      cleanse: true,
      categorize: true,
      categoryNames: ['Office', 'Travel'],
    }) as { properties: { transactions: { items: { required: string[] } } } };
    const item = sch.properties.transactions.items;
    expect(item.required).toEqual([
      'index',
      'cleansed_description',
      'merchant_name',
      'processor',
      'transaction_type',
      'is_opaque',
      'confidence',
      'category',
    ]);
  });

  it('top-level forbids extra properties', () => {
    const sch = buildEnrichmentJsonSchema({
      cleanse: true,
      categorize: false,
      categoryNames: [],
    }) as { additionalProperties: boolean };
    expect(sch.additionalProperties).toBe(false);
  });
});
