import { pino } from 'pino';

const logLevel = process.env.LOG_LEVEL ?? 'info';
// pino-pretty runs as a transport (a worker thread). Under Vitest every test
// file re-imports this module, so a single-fork API run would accumulate one
// transport thread per file and, at info level, eventually crash the fork
// ("Worker exited unexpectedly"). Tests log plain JSON instead.
const isDev = process.env.NODE_ENV !== 'production' && !process.env.VITEST;

// Exported so the redaction can be unit-tested against a captured stream.
export const logRedact = {
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
    // LLM payloads (CLAUDE.md: never log PII or LLM payloads). The
    // extractor's ExtractionResponseError carries the full model output in
    // an enumerable `rawResponse`, which pino's err serializer copies into
    // the log line — censor it wherever it lands.
    'rawResponse',
    'err.rawResponse',
    '*.rawResponse',
    '*.*.rawResponse',
    // Postgres errors carry the offending row values in `detail` ("Failing
    // row contains (...)", "Key (email)=(...) already exists") — account
    // numbers, descriptions, extracted text. Keep the message, drop the row.
    'err.detail',
    'err.cause.detail',
    'error.detail',
  ],
  censor: '[redacted]',
};

export const logger = pino({
  level: logLevel,
  base: {
    app: 'vibe-tx-converter',
  },
  redact: logRedact,
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
        },
      }
    : {}),
});
