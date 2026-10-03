// Adapter module for the `vibe-auth` CLI (break-glass account management,
// ADR-027). The CLI loads it from VIBE_AUTH_ADAPTER (set in the Dockerfile)
// or from `vibeAuth.adapter` in the package.json of its working directory
// (apps/api, for `pnpm exec vibe-auth ...` in dev).
//
// The Appliance runs, inside the api container:
//   node /app/apps/api/node_modules/@kisaesdevlab/vibe-auth/dist/cli.js \
//     breakglass ensure|rotate|status|verify --json
//
// Own process, same env as the server. Only DATABASE_URL is needed, so a
// status check works even when other config is broken.

import type { VibeAuthCliAdapter } from '@kisaesdevlab/vibe-auth';

import { closeDb, db } from './db/client.js';
import {
  BREAKGLASS_EMAIL,
  VIBETC_ROLES,
  createVibeAuditSink,
  createVibeUsers,
} from './lib/vibe-auth-users.js';

export default async function vibeAuthAdapter(): Promise<VibeAuthCliAdapter> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const warn = (msg: string, meta?: Record<string, unknown>) =>
    process.stderr.write(`${msg} ${JSON.stringify(meta ?? {})}\n`);
  return {
    users: createVibeUsers(db, { warn }),
    audit: createVibeAuditSink(db, { warn }),
    adminRole: VIBETC_ROLES.adminRole,
    breakglassEmail: BREAKGLASS_EMAIL,
    close: closeDb,
  };
}
