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

export const pool = new Proxy({} as pg.Pool, {
  get(_target, prop, receiver) {
    return Reflect.get(getPool() as object, prop, receiver);
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
