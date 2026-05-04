import pg from 'pg';

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('db:reset:dev refuses to run in production');
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }
  const pool = new pg.Pool({ connectionString: url });
  try {
    await pool.query('DROP SCHEMA IF EXISTS vibetc CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
  } finally {
    await pool.end();
  }
  // eslint-disable-next-line no-console
  console.log('vibetc + drizzle schemas dropped — run db:migrate to recreate');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
