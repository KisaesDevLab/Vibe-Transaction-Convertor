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
import { csrf, csrfTokenHandler } from './middleware/csrf.js';
import { unauthRateLimiter } from './middleware/rate-limit.js';
import { requestId } from './middleware/request-id.js';
import { accountsByCompanyRouter, accountsRouter } from './routes/accounts.js';
import { authRouter, usersRouter } from './routes/auth.js';
import { companiesRouter } from './routes/companies.js';
import { adminRouter } from './routes/admin.js';
import { auditRouter } from './routes/audit.js';
import { exportsRouter } from './routes/exports.js';
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

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'connect-src': ["'self'"],
          'img-src': ["'self'", 'data:', 'blob:'],
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
        },
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

  // Authenticated routes.
  app.use('/api/users', requireAuth, usersRouter());
  app.use('/api/fidir', requireAuth, fidirRouter());
  app.use('/api/companies', requireAuth, companiesRouter());
  app.use('/api/companies/:companyId/accounts', requireAuth, accountsByCompanyRouter());
  app.use('/api/accounts', requireAuth, accountsRouter());
  app.use('/api/accounts/:accountId/uploads', requireAuth, uploadsByAccountRouter());
  app.use('/api/uploads', requireAuth, uploadsRawRouter());
  app.use('/api/statements', requireAuth, statementsRouter());
  app.use('/api/statements', requireAuth, exportsRouter());
  app.use('/api/audit', requireAuth, auditRouter());
  app.use('/api/admin', requireAuth, adminRouter());

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
