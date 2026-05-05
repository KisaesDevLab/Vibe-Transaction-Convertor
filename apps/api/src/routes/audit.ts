// Phase 25 audit log routes. The audit_log table is append-only at the
// DB grant level (ADR-013); these routes are admin-only read paths.

import { Router } from 'express';
import { type SQL, and, asc, desc, eq, gte, ilike, isNull, lte, sql } from 'drizzle-orm';

import { db } from '../db/client.js';
import { auditLog, users } from '../db/schema.js';
import { ValidationError } from '../lib/errors.js';
import { requireAdmin } from '../middleware/auth.js';

interface AuditQuery {
  limit: number;
  offset: number;
  entityType?: string | undefined;
  entityId?: string | undefined;
  actorUserId?: string | undefined;
  since?: Date | undefined;
  until?: Date | undefined;
  actionContains?: string | undefined;
  mutationsOnly?: boolean;
}

const parseQuery = (q: Record<string, unknown>): AuditQuery => {
  const limit = Math.min(Math.max(Number.parseInt(String(q.limit ?? '100'), 10) || 100, 1), 500);
  const offset = Math.max(Number.parseInt(String(q.offset ?? '0'), 10) || 0, 0);

  const parseDate = (v: unknown, name: string): Date | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) {
      throw new ValidationError(`${name} must be a valid ISO 8601 date`);
    }
    return d;
  };

  const out: AuditQuery = { limit, offset };
  if (q.entityType) out.entityType = String(q.entityType);
  if (q.entityId) out.entityId = String(q.entityId);
  if (q.actorUserId) out.actorUserId = String(q.actorUserId);
  const since = parseDate(q.since, 'since');
  if (since !== undefined) out.since = since;
  const until = parseDate(q.until, 'until');
  if (until !== undefined) out.until = until;
  if (q.actionContains) out.actionContains = String(q.actionContains);
  if (q.mutationsOnly === 'true' || q.mutationsOnly === '1') out.mutationsOnly = true;
  return out;
};

const buildWhere = (q: AuditQuery): SQL | undefined => {
  const clauses: SQL[] = [];
  if (q.entityType) clauses.push(eq(auditLog.entityType, q.entityType));
  if (q.entityId) clauses.push(eq(auditLog.entityId, q.entityId));
  if (q.actorUserId) {
    if (q.actorUserId === 'system') clauses.push(isNull(auditLog.actorUserId));
    else clauses.push(eq(auditLog.actorUserId, q.actorUserId));
  }
  if (q.since) clauses.push(gte(auditLog.at, q.since));
  if (q.until) clauses.push(lte(auditLog.at, q.until));
  if (q.actionContains) clauses.push(ilike(auditLog.action, `%${q.actionContains}%`));
  // Phase 25 #14: "show only mutations" excludes pure read events.
  // Our convention: anything containing '.view-' or '.read' is a read.
  if (q.mutationsOnly) {
    clauses.push(
      sql`${auditLog.action} NOT LIKE '%.view-%' AND ${auditLog.action} NOT LIKE '%.read'`,
    );
  }
  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0];
  return and(...clauses);
};

const baseSelect = () =>
  db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      actorUserId: auditLog.actorUserId,
      actorEmail: users.email,
      actorDisplayName: users.displayName,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      action: auditLog.action,
      payload: auditLog.payload,
      correlationId: auditLog.correlationId,
    })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.actorUserId, users.id));

export const auditRouter = (): Router => {
  const router = Router();
  router.use(requireAdmin);

  router.get('/', async (req, res, next) => {
    try {
      const q = parseQuery(req.query as Record<string, unknown>);
      const where = buildWhere(q);
      const totalRows = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(where);
      const rows = await (where
        ? baseSelect().where(where).orderBy(desc(auditLog.at)).limit(q.limit).offset(q.offset)
        : baseSelect().orderBy(desc(auditLog.at)).limit(q.limit).offset(q.offset));
      res.json({ rows, total: Number(totalRows[0]?.c ?? 0) });
    } catch (err) {
      next(err);
    }
  });

  // Phase 25 #4: entity-shorthand for embeddable audit views.
  router.get('/:entityType/:entityId', async (req, res, next) => {
    try {
      const entityType = String(req.params.entityType);
      const entityId = String(req.params.entityId);
      const limit = Math.min(
        Math.max(Number.parseInt(String(req.query.limit ?? '50'), 10) || 50, 1),
        200,
      );
      const rows = await baseSelect()
        .where(and(eq(auditLog.entityType, entityType), eq(auditLog.entityId, entityId)))
        .orderBy(desc(auditLog.at))
        .limit(limit);
      res.json({ rows });
    } catch (err) {
      next(err);
    }
  });

  // Phase 25 #1: distinct actors for the filter dropdown. Excludes
  // system-only rows (actorUserId IS NULL) but flags whether any exist.
  router.get('/_actors', async (_req, res, next) => {
    try {
      const rows = await db
        .selectDistinct({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
        })
        .from(auditLog)
        .innerJoin(users, eq(auditLog.actorUserId, users.id))
        .orderBy(asc(users.email));
      const sysRows = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(isNull(auditLog.actorUserId));
      res.json({
        actors: rows,
        hasSystemActor: Number(sysRows[0]?.c ?? 0) > 0,
      });
    } catch (err) {
      next(err);
    }
  });

  // Phase 25 #8/#9: download a filtered audit set. JSON for forensic
  // tooling, CSV for spreadsheet review.
  router.get('/export.json', async (req, res, next) => {
    try {
      const q = parseQuery({ ...req.query, limit: '5000' });
      const where = buildWhere(q);
      const rows = await (where
        ? baseSelect().where(where).orderBy(desc(auditLog.at)).limit(q.limit)
        : baseSelect().orderBy(desc(auditLog.at)).limit(q.limit));
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader(
        'content-disposition',
        `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.json"`,
      );
      res.json({ rows, exportedAt: new Date().toISOString(), filters: q });
    } catch (err) {
      next(err);
    }
  });

  router.get('/export.csv', async (req, res, next) => {
    try {
      const q = parseQuery({ ...req.query, limit: '5000' });
      const where = buildWhere(q);
      const rows = await (where
        ? baseSelect().where(where).orderBy(desc(auditLog.at)).limit(q.limit)
        : baseSelect().orderBy(desc(auditLog.at)).limit(q.limit));
      const escape = (v: unknown): string => {
        if (v === null || v === undefined) return '';
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        if (/[",\r\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
        return s;
      };
      const header = [
        'id',
        'at',
        'actor_user_id',
        'actor_email',
        'entity_type',
        'entity_id',
        'action',
        'payload',
        'correlation_id',
      ].join(',');
      const body = rows
        .map((r) =>
          [
            r.id,
            r.at instanceof Date ? r.at.toISOString() : r.at,
            r.actorUserId ?? '',
            r.actorEmail ?? '',
            r.entityType,
            r.entityId,
            r.action,
            r.payload,
            r.correlationId ?? '',
          ]
            .map(escape)
            .join(','),
        )
        .join('\r\n');
      const csv = `${header}\r\n${body}\r\n`;
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader(
        'content-disposition',
        `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      res.send(csv);
    } catch (err) {
      next(err);
    }
  });

  return router;
};
