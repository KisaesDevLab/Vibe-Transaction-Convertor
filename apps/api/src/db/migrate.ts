import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Db } from './client.js';

// Resolve the migrations folder relative to this file. In dev (tsx)
// __dirname is apps/api/src/db; in built form it's apps/api/dist/db,
// where the build step copies src/db/migrations alongside.
const migrationsFolder = (): string => {
  const __filename = fileURLToPath(import.meta.url);
  return join(dirname(__filename), 'migrations');
};

// Reusable entry point: apply pending drizzle migrations against an
// existing pool/db instance. Used both by the standalone CLI (this
// file when invoked as a script) and by the API server's boot path
// when MIGRATIONS_AUTO=true.
export const runMigrations = async (db: Db): Promise<void> => {
  await migrate(db, { migrationsFolder: migrationsFolder() });
};

const isMain = (): boolean => {
  // Compare normalized URLs so this works under tsx, node, and the
  // packaged dist/db/migrate.js entry the appliance manifest declares.
  const here = fileURLToPath(import.meta.url);
  const argv1 = process.argv[1] ?? '';
  return here === argv1 || here.endsWith(argv1);
};

if (isMain()) {
  (async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    const pool = new pg.Pool({ connectionString: url });
    const db = drizzle(pool);
    try {
      await migrate(db, { migrationsFolder: migrationsFolder() });
      // eslint-disable-next-line no-console
      console.log('migrations applied');
    } finally {
      await pool.end();
    }
  })().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
