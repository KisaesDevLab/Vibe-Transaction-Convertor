import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { loadSession, requireAuth } from './middleware/auth.js';
import { requireFeature } from './middleware/feature-access.js';
import { stripBasePath } from './middleware/base-path.js';
import { csrf, csrfTokenHandler } from './middleware/csrf.js';
import { requireInternalNetwork } from './middleware/internal-network.js';
import { unauthRateLimiter } from './middleware/rate-limit.js';
import { requestId } from './middleware/request-id.js';
import { accountsByCompanyRouter, accountsRouter } from './routes/accounts.js';
import { applianceAdminRouter, internalApplianceRouter } from './routes/appliance.js';
import { authRouter, usersRouter } from './routes/auth.js';
import { companiesRouter } from './routes/companies.js';
import { adminRouter } from './routes/admin.js';
import { auditRouter } from './routes/audit.js';
import { featureAccessRouter } from './routes/feature-access.js';
import { exportJobsRouter, exportsRouter } from './routes/exports.js';
import { fidirRouter } from './routes/fidir.js';
import { healthRouter } from './routes/health.js';
import { statementsRouter } from './routes/statements.js';
import { uploadsByAccountRouter, uploadsRawRouter } from './routes/uploads.js';
import { versionRouter } from './routes/version.js';

export const createApp = (): Express => {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(requestId);

  // Vibe-Appliance forwards `/vibe-tx-converter/...` requests with the
  // prefix intact; strip it before any routing so the api, static, and
  // SPA-fallback all see normalized paths. No-op in standalone mode.
  app.use(stripBasePath());

  // Helmet's default CSP includes `upgrade-insecure-requests`, which is
  // the right behavior on a real HTTPS deploy (any accidental http://
  // link gets upgraded). On the Vibe-Appliance LAN profile the page is
  // served over plain HTTP, so the browser would silently rewrite every
  // asset URL to https:// and fail with ERR_SSL_PROTOCOL_ERROR before
  // any JS runs — the screen renders blank. Detect HTTP deploys via
  // WEB_BASE_URL and remove the directive there. Setting a CSP
  // directive to null is helmet's documented way to drop a default.
  const isHttpsDeploy = (process.env.WEB_BASE_URL ?? '').toLowerCase().startsWith('https://');
  const cspDirectives: Record<string, string[] | null> = {
    'default-src': ["'self'"],
    'connect-src': ["'self'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'script-src': ["'self'"],
    'style-src': ["'self'", "'unsafe-inline'"],
  };
  if (!isHttpsDeploy) {
    cspDirectives['upgrade-insecure-requests'] = null;
  }
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        // Cast: helmet's types accept `null` for removal but the
        // declared union types are awkward to model in plain TS.
        directives: cspDirectives as never,
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  const webBaseUrl = process.env.WEB_BASE_URL;
  app.use(
    cors({
      origin: webBaseUrl ? [webBaseUrl] : false,
      credentials: true,
    }),
  );

  app.use(compression());
  app.use(cookieParser(process.env.SESSION_SECRET));
  app.use(express.json({ limit: '1mb' }));

  app.use(
    pinoHttp({
      logger,
      customProps: (req) => ({ requestId: (req as express.Request).requestId }),
      serializers: {
        req: (req) => ({ method: req.method, url: req.url }),
      },
    }),
  );

  app.use(unauthRateLimiter());
  app.use(csrf());
  app.use(loadSession);

  // Public routes — no requireAuth.
  app.get('/api/auth/csrf', csrfTokenHandler);
  app.use('/api/health', healthRouter());
  app.use('/api', versionRouter());
  app.use('/api/auth', authRouter());

  // Authenticated routes. Per-feature gates (requireFeature) sit after
  // requireAuth and 403 when a user has the feature disabled; access is
  // default-on, so an unconfigured user passes every gate. The statements
  // mount is gated by 'statements' (view); the AI sub-actions and exports
  // carry their own finer-grained gates (in-router / second mount).
  app.use('/api/users', requireAuth, requireFeature('admin.users'), usersRouter());
  app.use('/api/fidir', requireAuth, requireFeature('companies'), fidirRouter());
  app.use('/api/companies', requireAuth, requireFeature('companies'), companiesRouter());
  app.use(
    '/api/companies/:companyId/accounts',
    requireAuth,
    requireFeature('companies'),
    accountsByCompanyRouter(),
  );
  app.use('/api/accounts', requireAuth, requireFeature('companies'), accountsRouter());
  app.use(
    '/api/accounts/:accountId/uploads',
    requireAuth,
    requireFeature('uploads'),
    uploadsByAccountRouter(),
  );
  app.use('/api/uploads', requireAuth, requireFeature('uploads'), uploadsRawRouter());
  app.use('/api/statements', requireAuth, requireFeature('statements'), statementsRouter());
  app.use('/api/statements', requireAuth, requireFeature('exports'), exportsRouter());
  app.use('/api/exports', requireAuth, requireFeature('exports'), exportJobsRouter());
  app.use('/api/audit', requireAuth, requireFeature('admin.audit'), auditRouter());
  app.use('/api/admin/feature-access', requireAuth, featureAccessRouter());
  app.use('/api/admin', requireAuth, adminRouter());
  // Phase 29 #10 — admin-only "Update available" surfacing for the SPA.
  app.use('/api/admin/appliance', requireAuth, applianceAdminRouter());
  // Phase 29 #13 — internal-network-only handshake endpoint for the
  // appliance orchestrator. No auth, IP-restricted to RFC 1918 +
  // loopback ranges. Mounted *after* loadSession so an accidental
  // exposure to the public internet still 403s.
  app.use('/api/internal/appliance', requireInternalNetwork, internalApplianceRouter());

  // Static SPA serving — production deployments bundle apps/web/dist into
  // the same container as the API. Locating it relative to this file lets
  // the same code path work in dev (tsx watch from src/) and in prod
  // (compiled to dist/, with web at ../../web/dist).
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(__dirname, '..', '..', 'web', 'dist'), // monorepo dev: apps/api/src/ → apps/web/dist
    resolve(__dirname, '..', '..', '..', 'web', 'dist'), // built: apps/api/dist/ → apps/web/dist
    resolve('/app/apps/web/dist'), // container layout
  ];
  const spaDir = candidates.find((p) => existsSync(p));
  if (spaDir) {
    logger.info({ spaDir }, 'serving SPA');
    // Cache hashed assets aggressively, never the index.html.
    app.use(
      express.static(spaDir, {
        index: false,
        setHeaders: (res, filePath) => {
          if (/\.(js|css|woff2?|png|svg|jpg|gif|webp)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );
    // SPA fallback — serve index.html for any non-/api GET so client-side
    // routing survives a refresh on a deep route. We do NOT fall back for
    // requests that look like static assets (have an extension that isn't
    // .html) so missing JS/CSS/image files honestly 404 instead of
    // returning HTML that the browser can't parse.
    app.get(/^(?!\/api\/).*$/, (req: Request, res: Response, next: NextFunction) => {
      if (/\.[a-z0-9]+$/i.test(req.path) && !req.path.endsWith('.html')) {
        return next();
      }
      res.sendFile(join(spaDir, 'index.html'), (err) => {
        if (err) next(err);
      });
    });
  } else {
    logger.warn({ candidates }, 'SPA dist not found; / will 404');
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
