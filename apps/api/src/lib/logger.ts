import { pino } from 'pino';

const logLevel = process.env.LOG_LEVEL ?? 'info';
const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: logLevel,
  base: {
    app: 'vibe-tx-converter',
  },
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'res.headers["set-cookie"]',
      '*.password',
      '*.password_hash',
      '*.api_key',
      '*.apiKey',
      // Top-level catches for the most-common LLM-provider key names.
      // Pino's '*.apiKey' only matches keys one level deep, so explicit
      // top-level entries are required. Phase 27 #30 regression.
      'apiKey',
      'api_key',
      'anthropicApiKey',
      'anthropic_api_key',
      'ANTHROPIC_API_KEY',
    ],
    censor: '[redacted]',
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
        },
      }
    : {}),
});
