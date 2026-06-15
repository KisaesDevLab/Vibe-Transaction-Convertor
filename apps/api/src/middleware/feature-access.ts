import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { AuthError, ForbiddenError } from '../lib/errors.js';
import type { FeatureKey } from '../lib/feature-registry.js';

// Route guard mirroring requireAdmin: 403s when the authenticated user
// has the named feature explicitly disabled. Access defaults to enabled,
// so a missing entry (or an unauthenticated-but-somehow-here request)
// passes the feature check — requireAuth/requireAdmin handle identity.
export const requireFeature =
  (feature: FeatureKey): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(new AuthError());
    if (req.featureAccess?.[feature] === false) {
      return next(new ForbiddenError(`feature disabled: ${feature}`));
    }
    next();
  };
