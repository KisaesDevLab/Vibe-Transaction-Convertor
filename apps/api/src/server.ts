import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { loadSession, requireAuth } from './middleware/auth.js';
import { csrf, csrfTokenHandler } from './middleware/csrf.js';
import { unauthRateLimiter } from './middleware/rate-limit.js';
import { requestId } from './middleware/request-id.js';
import { accountsByCompanyRouter, accountsRouter } from './routes/accounts.js';
import { authRouter, usersRouter } from './routes/auth.js';
import { companiesRouter } from './routes/companies.js';
import { fidirRouter } from './routes/fidir.js';
import { healthRouter } from './routes/health.js';
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

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
