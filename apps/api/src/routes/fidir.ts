import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';

import { NotFoundError, ValidationError } from '../lib/errors.js';
import { db } from '../db/client.js';
import { fidirEntries } from '../db/schema.js';
import { getFidirStatus } from '../services/fidir-seeder.js';

export const fidirRouter = (): Router => {
  const router = Router();

  router.get('/search', async (req, res, next) => {
    try {
      const q = String(req.query.q ?? '').trim();
      const limitInput = Number.parseInt(String(req.query.limit ?? '20'), 10);
      const limit = Math.min(Math.max(Number.isFinite(limitInput) ? limitInput : 20, 1), 50);
      if (q.length === 0) {
        return res.json({ query: q, results: [] });
      }
      const lower = q.toLowerCase();
      const ilike = `%${lower}%`;
      const rows = await db
        .select({
          id: fidirEntries.id,
          intuBid: fidirEntries.intuBid,
          intuOrg: fidirEntries.intuOrg,
          bankName: fidirEntries.bankName,
          url: fidirEntries.url,
          score: sql<number>`similarity(lower(${fidirEntries.bankName}), ${lower})`,
        })
        .from(fidirEntries)
        .where(
          sql`${fidirEntries.intuBid} = ${q}
              OR lower(${fidirEntries.bankName}) % ${lower}
              OR lower(${fidirEntries.bankName}) LIKE ${ilike}
              OR lower(${fidirEntries.intuOrg}) LIKE ${ilike}`,
        )
        .orderBy(sql`similarity(lower(${fidirEntries.bankName}), ${lower}) DESC`)
        .limit(limit);
      res.json({ query: q, results: rows });
    } catch (err) {
      next(err);
    }
  });

  router.get('/by-bid/:bid', async (req, res, next) => {
    try {
      const bid = String(req.params.bid ?? '').trim();
      if (bid.length === 0) {
        throw new ValidationError('bid is required');
      }
      const rows = await db.select().from(fidirEntries).where(eq(fidirEntries.intuBid, bid));
      if (rows.length === 0) {
        throw new NotFoundError(`No FIDIR entry for INTU.BID=${bid}`);
      }
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  });

  router.get('/status', async (_req, res, next) => {
    try {
      res.json(await getFidirStatus(db));
    } catch (err) {
      next(err);
    }
  });

  return router;
};
