// Read-only metadata the statement review page needs, for every user with
// statement access. The admin router owns the category CRUD and the
// enrichment toggles, but it is admin-only end to end — reading them from
// there hid the Category / Cleansed columns and the enrichment buttons from
// staff reviewers, even though POST /api/statements/:id/enrich only needs the
// 'enrich' feature. These GETs return the same shapes as the admin ones.

import { Router } from 'express';
import { eq } from 'drizzle-orm';

import { db } from '../db/client.js';
import { businessCategories } from '../db/schema.js';
import { enrichmentToggleStatus } from '../services/enrichment.js';

export const reviewMetaRouter = (): Router => {
  const router = Router();

  // Active (non-archived) business categories for the grid's Category picker,
  // sorted like the admin list (sort_order, then name).
  router.get('/categories', async (_req, res, next) => {
    try {
      const rows = await db
        .select()
        .from(businessCategories)
        .where(eq(businessCategories.archived, false))
        .orderBy(businessCategories.sortOrder, businessCategories.name);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // Whether the cleanse / categorize passes are enabled, and the provider +
  // model each would use — drives which enrichment buttons the page shows.
  router.get('/enrichment', async (_req, res, next) => {
    try {
      res.json(await enrichmentToggleStatus(db));
    } catch (err) {
      next(err);
    }
  });

  return router;
};
