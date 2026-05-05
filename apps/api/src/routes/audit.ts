import { Router } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';

import { db } from '../db/client.js';
import { auditLog } from '../db/schema.js';
import { requireAdmin } from '../middleware/auth.js';

export const auditRouter = (): Router => {
  const router = Router();
  router.use(requireAdmin);

  router.get('/', async (req, res, next) => {
    try {
      const limit = Math.min(
        Math.max(Number.parseInt(String(req.query.limit ?? '100'), 10) || 100, 1),
        500,
      );
      const offset = Math.max(Number.parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
      const entityType = req.query.entityType ? String(req.query.entityType) : undefined;
      const entityId = req.query.entityId ? String(req.query.entityId) : undefined;

      const where =
        entityType && entityId
          ? and(eq(auditLog.entityType, entityType), eq(auditLog.entityId, entityId))
          : entityType
            ? eq(auditLog.entityType, entityType)
            : undefined;

      const totalRows = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(where);
      const rows = await (where
        ? db
            .select()
            .from(auditLog)
            .where(where)
            .orderBy(desc(auditLog.at))
            .limit(limit)
            .offset(offset)
        : db.select().from(auditLog).orderBy(desc(auditLog.at)).limit(limit).offset(offset));

      res.json({ rows, total: Number(totalRows[0]?.c ?? 0) });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
