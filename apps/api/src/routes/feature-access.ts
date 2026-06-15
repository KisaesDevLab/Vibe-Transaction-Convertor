import { Router } from 'express';

import { db } from '../db/client.js';
import { ValidationError } from '../lib/errors.js';
import { FEATURE_DEFS } from '../lib/feature-registry.js';
import { requireAdmin } from '../middleware/auth.js';
import { requireFeature } from '../middleware/feature-access.js';
import { getFeatureAccessMatrix, setFeatureAccess } from '../services/feature-access.js';

export const featureAccessRouter = (): Router => {
  const router = Router();

  // Admin-only, and the access-management surface gates itself. The
  // last-admin lockout guard in the service keeps this from becoming a
  // one-way door.
  router.use(requireAdmin, requireFeature('admin.accessControl'));

  // Static catalog of gateable features (key/label/area/description).
  router.get('/registry', (_req, res) => {
    res.json(FEATURE_DEFS);
  });

  // Every user with their effective per-feature map.
  router.get('/', async (_req, res, next) => {
    try {
      res.json(await getFeatureAccessMatrix(db));
    } catch (err) {
      next(err);
    }
  });

  // Toggle one feature for one user.
  router.patch('/:userId/:featureKey', async (req, res, next) => {
    try {
      const userId = String(req.params.userId ?? '');
      const featureKey = String(req.params.featureKey ?? '');
      const enabled = (req.body ?? {}).enabled;
      if (typeof enabled !== 'boolean') {
        throw new ValidationError('enabled (boolean) is required');
      }
      await setFeatureAccess(db, {
        actorUserId: req.user!.id,
        targetUserId: userId,
        featureKey,
        enabled,
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
