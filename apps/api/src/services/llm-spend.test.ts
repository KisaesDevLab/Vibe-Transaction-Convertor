// LLM spend ledger + Anthropic monthly-cap check, against a stub Db (no
// Postgres). The SQL itself is exercised by the live-DB enrichment and
// check-resolver suites.

import { describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/client.js';
import { addStatementLlmCost, anthropicCapStatus } from './llm-spend.js';

// db.select().from().where() resolves, in call order, to the cap-setting rows
// and then the month's spend total.
const stubDb = (capValue: string | null, spentMicros: string): Db => {
  let call = 0;
  return {
    select: () => ({
      from: () => ({
        where: async () => {
          call += 1;
          if (call === 1) return capValue === null ? [] : [{ valuePlaintext: capValue }];
          return [{ total: spentMicros }];
        },
      }),
    }),
  } as unknown as Db;
};

describe('anthropicCapStatus', () => {
  it('is never blocked without a numeric cap', async () => {
    expect(await anthropicCapStatus(stubDb(null, '999000000'))).toEqual({ blocked: false });
    expect(await anthropicCapStatus(stubDb('lots', '999000000'))).toEqual({ blocked: false });
  });

  it('blocks once the month spend reaches the cap', async () => {
    const atCap = await anthropicCapStatus(stubDb('5', '5000000'));
    expect(atCap).toMatchObject({ blocked: true, spentUsd: 5, capUsd: 5 });
    expect(atCap.message).toBe('monthly Anthropic spend cap reached: $5.00 >= $5.00');
    expect(await anthropicCapStatus(stubDb('5', '4999999'))).toMatchObject({ blocked: false });
  });
});

describe('addStatementLlmCost', () => {
  const stubUpdate = () => {
    const where = vi.fn(async () => undefined);
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    return { db: { update } as unknown as Db, update, set, where };
  };

  it('is a no-op for zero spend', async () => {
    const s = stubUpdate();
    await addStatementLlmCost(s.db, 'stmt-1', 0n);
    expect(s.update).not.toHaveBeenCalled();
  });

  it('adds (never overwrites) the spend, scoped to the statement', async () => {
    const s = stubUpdate();
    await addStatementLlmCost(s.db, 'stmt-1', 1_234n);
    expect(s.update).toHaveBeenCalledTimes(1);
    expect(s.set).toHaveBeenCalledWith({ llmCostMicros: expect.anything() });
    expect(s.where).toHaveBeenCalledTimes(1);
  });
});
