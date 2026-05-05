import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { csrf, csrfTokenHandler } from './middleware/csrf.js';
import { unauthRateLimiter } from './middleware/rate-limit.js';
import { requestId } from './middleware/request-id.js';
import { healthRouter } from './routes/health.js';
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

  // Rate limit unauthenticated routes; auth routes get their own limiter in Phase 6.
  app.use(unauthRateLimiter());

  app.use(csrf());

  app.get('/api/auth/csrf', csrfTokenHandler);
  app.use('/api/health', healthRouter());
  app.use('/api', versionRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
