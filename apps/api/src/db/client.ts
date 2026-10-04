import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

let _pool: pg.Pool | undefined;
let _db: ReturnType<typeof drizzle<typeof schema>> | undefined;

const ensureUrl = (): string => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return url;
};

export const getPool = (): pg.Pool => {
  if (!_pool) _pool = new pg.Pool({ connectionString: ensureUrl() });
  return _pool;
};

export const getDb = (): ReturnType<typeof drizzle<typeof schema>> => {
  if (!_db) _db = drizzle(getPool(), { schema });
  return _db;
};

// Proxy used by call sites that want to keep the lightweight `db.select(...)`
// surface without explicitly invoking getDb(). All access is lazy.
export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb() as object, prop, receiver);
  },
});

// Methods are bound to the real pool: pg-pool reassigns its own state from
// inside them (`this._clients = this._clients.filter(...)` when a client is
// removed, `this.ending = true` in end()). Called with `this` = the proxy,
// those writes would land on the empty proxy target, leaving removed
// clients counted against `max` until every query hangs and end() never
// resolves. Plain property writes are forwarded for the same reason.
export const pool = new Proxy({} as pg.Pool, {
  get(_target, prop) {
    const real = getPool();
    const value: unknown = Reflect.get(real, prop, real);
    return typeof value === 'function' ? value.bind(real) : value;
  },
  set(_target, prop, value) {
    const real = getPool();
    return Reflect.set(real, prop, value, real);
  },
});

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export const closeDb = async (): Promise<void> => {
  if (_pool) {
    await _pool.end();
    _pool = undefined;
    _db = undefined;
  }
};
