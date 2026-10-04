import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { getPool, pool } from './client.js';

// The `pool` proxy must run pg-pool's methods against the real pool. When
// they ran with `this` = the proxy, pg-pool's internal reassignments
// (`this._clients = ...`, `this.ending = true`) landed on the empty proxy
// target: a failed or idle-removed client stayed counted against `max`
// forever, and end() never resolved.
describe('db/client pool proxy', () => {
  beforeAll(() => {
    // Nothing listens on port 1; no test here needs a live database.
    vi.stubEnv('DATABASE_URL', 'postgres://nobody:nothing@127.0.0.1:1/none');
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('a failed connect through the proxy leaves no zombie client in the real pool', async () => {
    await expect(pool.query('select 1')).rejects.toThrow();
    expect(getPool().totalCount).toBe(0);
  }, 15_000);

  it('end() through the proxy resolves and ends the real pool', async () => {
    await expect(pool.end()).resolves.toBeUndefined();
    expect(getPool().ending).toBe(true);
    expect(getPool().ended).toBe(true);
  }, 15_000);
});
