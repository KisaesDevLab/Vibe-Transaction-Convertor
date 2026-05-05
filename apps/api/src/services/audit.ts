import type { Db } from '../db/client.js';
import { auditLog } from '../db/schema.js';

export interface AuditEntry {
  actorUserId?: string | null;
  entityType: string;
  entityId: string;
  action: string;
  payload?: Record<string, unknown>;
  correlationId?: string | null;
}

export const writeAudit = async (db: Db, entry: AuditEntry): Promise<void> => {
  await db.insert(auditLog).values({
    actorUserId: entry.actorUserId ?? null,
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    payload: entry.payload ?? null,
    correlationId: entry.correlationId ?? null,
  });
};
