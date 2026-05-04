import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://vibetc:vibetc@localhost:5432/vibetc';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  schemaFilter: ['vibetc'],
  dbCredentials: { url: databaseUrl },
  verbose: true,
  strict: true,
});
