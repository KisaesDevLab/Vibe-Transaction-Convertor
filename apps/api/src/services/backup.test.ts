// Unit coverage for the pure pieces of the backup/restore service — the
// parts that decide what gets handed to pg_dump, pg_restore and psql.
// The end-to-end behavior (does a restore actually put the data back,
// does a mid-restore failure roll back) needs a live Postgres and lives
// in routes/admin.backup.test.ts.

import { afterEach, describe, expect, it } from 'vitest';

import {
  annotateRestoreError,
  assertSafeFilename,
  buildPreamble,
  filterSchemaEntries,
  parseDumpSchemas,
  pgConnectionArgs,
  summarizeSqlError,
} from './backup.js';

// A realistic slice of `pg_restore --list` output.
const TOC = `;
; Archive created at 2026-07-31 08:49:49
;     dbname: vibetc
;
; Selected TOC Entries:
;
9; 2615 16395 SCHEMA - vibetc vibetc
3938; 0 0 ACL - SCHEMA vibetc vibetc
7; 2615 16389 SCHEMA - drizzle vibetc
1081; 1247 16397 TYPE vibetc account_type vibetc
221; 1259 16535 TABLE vibetc accounts vibetc
399; 1255 16769 FUNCTION vibetc audit_log_block_modify() vibetc
`;

describe('assertSafeFilename', () => {
  it('accepts a filename of the shape createBackup() emits', () => {
    expect(() => assertSafeFilename('vibetc-2026-07-31T13-58-09-828Z.dump')).not.toThrow();
  });

  it.each([
    '../../etc/passwd',
    '..\\..\\windows\\system32',
    'vibetc-2026-07-31T13-58-09-828Z.dump/../../x',
    'arbitrary.dump',
    'vibetc-not-a-timestamp.dump',
    '',
  ])('rejects %j', (name) => {
    expect(() => assertSafeFilename(name)).toThrow(/unsafe backup filename/);
  });
});

describe('pgConnectionArgs', () => {
  const saved = process.env.DATABASE_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  });

  it('keeps the password out of argv and puts it in PGPASSWORD', () => {
    process.env.DATABASE_URL = 'postgres://vibetc:s3cr3t@db.internal:6543/vibetcdb';
    const { args, env } = pgConnectionArgs();
    expect(args).toEqual([
      '--host=db.internal',
      '--port=6543',
      '--dbname=vibetcdb',
      '--username=vibetc',
    ]);
    expect(args.join(' ')).not.toContain('s3cr3t');
    expect(env.PGPASSWORD).toBe('s3cr3t');
  });

  it('percent-decodes credentials', () => {
    process.env.DATABASE_URL = 'postgres://us%40er:p%40ss%3Aword@localhost/vibetc';
    const { args, env } = pgConnectionArgs();
    expect(args).toContain('--username=us@er');
    expect(env.PGPASSWORD).toBe('p@ss:word');
  });

  it('defaults the port', () => {
    process.env.DATABASE_URL = 'postgres://vibetc@localhost/vibetc';
    expect(pgConnectionArgs().args).toContain('--port=5432');
  });

  it('throws when DATABASE_URL is missing or unparseable', () => {
    delete process.env.DATABASE_URL;
    expect(() => pgConnectionArgs()).toThrow(/DATABASE_URL not set/);
    process.env.DATABASE_URL = 'not a url';
    expect(() => pgConnectionArgs()).toThrow(/not a valid URL/);
  });
});

describe('parseDumpSchemas', () => {
  it('finds the schemas a dump carries, sorted', () => {
    expect(parseDumpSchemas(TOC)).toEqual(['drizzle', 'vibetc']);
  });

  it('does not mistake the schema ACL entry for a schema', () => {
    const aclOnly = '3938; 0 0 ACL - SCHEMA vibetc vibetc\n';
    expect(parseDumpSchemas(aclOnly)).toEqual([]);
  });

  it('returns nothing for a listing with no schema entries', () => {
    expect(parseDumpSchemas('; nothing here\n')).toEqual([]);
  });
});

describe('filterSchemaEntries', () => {
  it('comments out CREATE SCHEMA entries and leaves everything else', () => {
    const filtered = filterSchemaEntries(TOC);
    expect(filtered).toContain(';9; 2615 16395 SCHEMA - vibetc vibetc');
    expect(filtered).toContain(';7; 2615 16389 SCHEMA - drizzle vibetc');
    // The ACL and the real objects must still be restored.
    expect(filtered).toContain('\n3938; 0 0 ACL - SCHEMA vibetc vibetc');
    expect(filtered).toContain('\n221; 1259 16535 TABLE vibetc accounts vibetc');
  });
});

describe('buildPreamble', () => {
  it('opens a transaction, replaces each schema, and restores extensions into it', () => {
    const sql = buildPreamble(
      ['drizzle', 'vibetc'],
      [
        { name: 'pg_trgm', schema: 'vibetc' },
        { name: 'btree_gist', schema: 'vibetc' },
      ],
    );
    expect(sql.startsWith('BEGIN;')).toBe(true);
    expect(sql).toContain('SET lock_timeout = 30000;');
    expect(sql).toContain('DROP SCHEMA IF EXISTS "drizzle" CASCADE;');
    expect(sql).toContain('CREATE SCHEMA "vibetc";');
    // Extensions must come back inside the schema the dump's indexes
    // expect them in, otherwise vibetc.gin_trgm_ops does not resolve.
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "vibetc";');
    // ...and after the schema exists.
    expect(sql.indexOf('CREATE SCHEMA "vibetc";')).toBeLessThan(
      sql.indexOf('CREATE EXTENSION IF NOT EXISTS "pg_trgm"'),
    );
    // Never committed here — the caller appends COMMIT only once
    // pg_restore has finished cleanly.
    expect(sql).not.toContain('COMMIT');
  });

  it('quotes identifiers', () => {
    expect(buildPreamble(['we"ird'], [])).toContain('DROP SCHEMA IF EXISTS "we""ird" CASCADE;');
  });
});

describe('summarizeSqlError', () => {
  it('leads with the ERROR line, not the notices around it', () => {
    const stderr = [
      'psql:<stdin>:3: NOTICE:  drop cascades to table drizzle.__drizzle_migrations',
      'psql:<stdin>:984: ERROR:  role "vibetc_app" does not exist',
      'psql:<stdin>:984: STATEMENT:  GRANT USAGE ON SCHEMA vibetc TO vibetc_app;',
    ].join('\n');
    expect(summarizeSqlError(stderr).split('\n')[0]).toContain('role "vibetc_app" does not exist');
  });

  it('falls back to the whole output when nothing looks like an error', () => {
    expect(summarizeSqlError('something odd\n')).toBe('something odd');
    expect(summarizeSqlError('   \n')).toBe('no output');
  });
});

describe('annotateRestoreError', () => {
  it('always states that the database is unchanged', () => {
    expect(annotateRestoreError('boom').message).toMatch(/rolled back — the database is unchanged/);
  });

  it('explains a lock timeout', () => {
    expect(annotateRestoreError('ERROR: canceling statement due to lock timeout').message).toMatch(
      /Stop the worker/,
    );
  });

  it('explains a missing role', () => {
    expect(annotateRestoreError('ERROR:  role "vibetc_app" does not exist').message).toMatch(
      /Create the role/,
    );
  });
});
