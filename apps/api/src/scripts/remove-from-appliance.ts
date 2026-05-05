// Phase 29 #19 — operator-run uninstall path. Drops the `vibetc`
// schema after confirming there are no in-flight extractions and
// printing a backup hint. Lives as a script (not a route) because
// the action is irreversible and we do not want it accessible over
// the network at all.
//
// Required confirmation token: pass --i-have-a-backup as a single
// CLI argument. Without it the script does NOTHING and prints
// guidance. The phrase exists to prevent accidental invocation by
// shell history, copy-paste, or automation that happened to invoke
// the wrong script.
//
//   pnpm tsx apps/api/src/scripts/remove-from-appliance.ts --i-have-a-backup

/* eslint-disable no-console */

import pg from 'pg';

const TOKEN = '--i-have-a-backup';

const log = (msg: string): void => {
  console.log(msg);
};

const checkBackupHint = (): void => {
  const dataDir = process.env.DATA_DIR ?? '/var/lib/vibetc';
  log('');
  log('━━━ Backup hint ━━━');
  log(`Source PDFs and rendered exports live under: ${dataDir}`);
  log('Database backups (if any) are at /admin/backup or your operator backup process.');
  log('You should keep both before continuing.');
  log('━━━━━━━━━━━━━━━━━━');
  log('');
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (!args.includes(TOKEN)) {
    log('vibe-tx-converter — remove from appliance');
    log('');
    log('This drops the `vibetc` Postgres schema and its tables, transactions,');
    log('exports, audit log, and sessions. The PDFs on disk are NOT removed by');
    log('this script — delete $DATA_DIR yourself once you have a confirmed backup.');
    log('');
    log('To proceed, run:');
    log(`  pnpm tsx apps/api/src/scripts/remove-from-appliance.ts ${TOKEN}`);
    process.exit(2);
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set; nothing to do.');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: url });
  try {
    // Pre-flight: refuse to drop while extractions are in flight.
    // "in flight" = any statement row whose status is not a terminal
    // state. terminal = review | exported | failed | awaiting-locale.
    const inflight = await pool.query<{ count: string }>(
      `select count(*)::text as count from vibetc.statements
        where status not in ('review','exported','failed','awaiting-locale-confirmation')`,
    );
    const n = Number(inflight.rows[0]?.count ?? '0');
    if (n > 0) {
      console.error(
        `Refusing to drop: ${n} statement(s) are mid-pipeline. Wait for them to ` +
          `reach a terminal status (review/exported/failed) or cancel them, then re-run.`,
      );
      process.exit(1);
    }

    checkBackupHint();
    log('Dropping schema vibetc CASCADE…');
    await pool.query(`drop schema if exists vibetc cascade`);
    log('Done. The schema has been removed.');
    log('');
    log(`Next steps for the operator:`);
    log(`  1. Stop the vibe-tx-converter container.`);
    log(
      `  2. Remove $DATA_DIR (${process.env.DATA_DIR ?? '/var/lib/vibetc'}) when you have a confirmed backup.`,
    );
    log(`  3. Remove the app from the appliance manifest.`);
  } catch (err) {
    console.error('Drop failed:', (err as Error).message);
    process.exit(1);
  } finally {
    await pool.end().catch(() => undefined);
  }
};

main().catch((err) => {
  console.error('Unexpected error:', (err as Error).message);
  process.exit(1);
});
