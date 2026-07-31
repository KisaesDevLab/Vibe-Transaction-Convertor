// Phase 26 #9: pg_restore CLI wrapper. The same restore the admin UI
// exposes at /admin/backup, driven from the host shell — both call
// services/backup.ts#restoreBackup so behavior can't drift between them.
//
// Usage: pnpm --filter @vibe-tx-converter/api db:restore <backup-filename>
//
// The filename is resolved relative to $DATA_DIR/backups so operators
// don't need to specify a full path. A safety dump of the CURRENT
// database is taken before anything is touched, and the restore itself
// runs in a single transaction — a failure leaves the database
// unchanged. Migrations are re-applied afterwards so a backup that
// predates an upgrade lands on this build's schema.

/* eslint-disable no-console */
import { restoreBackup } from '../services/backup.js';

const main = async (): Promise<void> => {
  const filename = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!filename) {
    console.error('usage: db:restore <backup-filename>');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(2);
  }

  console.error(`restoring from ${filename}`);
  try {
    const result = await restoreBackup(filename, {
      // Redis isn't necessarily reachable from an operator shell and a
      // paused-but-never-resumed queue would be a nasty surprise, so the
      // CLI leaves the queue alone. Stop the worker first.
      pauseQueue: false,
    });
    if (result.safetyBackup) {
      console.error(`safety backup of the pre-restore database: ${result.safetyBackup.filename}`);
    }
    for (const w of result.warnings) console.error(`warning: ${w}`);
    console.error(
      `restored ${result.restoredFrom} (schemas: ${result.schemas.join(', ')}${
        result.migrated ? ', migrations re-applied' : ''
      }) in ${result.durationMs}ms`,
    );
    process.exit(0);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
};

void main();
