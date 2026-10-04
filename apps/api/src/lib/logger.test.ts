// The shared logger's redaction must keep LLM payloads out of log lines
// (CLAUDE.md: never log PII or LLM payloads). Regression: pino's err serializer
// copies an ExtractionResponseError's enumerable `rawResponse` — the full model
// output — into error-level logs. Exercised with the exported redact config on a
// captured stream (the module logger itself writes to stdout / pino-pretty).

import { Writable } from 'node:stream';

import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { ExtractionResponseError } from '@vibe-tx-converter/extractor';

import { logRedact } from './logger.js';

const RAW = '{"transactions":[{"description":"ZELLE TO JANE DOE","amount_cents":-12345}]}';

const capture = () => {
  let out = '';
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      out += chunk.toString();
      cb();
    },
  });
  return { lines: () => out, log: pino({ redact: logRedact }, sink) };
};

describe('logger redaction', () => {
  it('censors an ExtractionResponseError rawResponse logged under err', () => {
    const { lines, log } = capture();
    const err = new ExtractionResponseError({
      summary: 'LLM response did not match extraction schema',
      rawResponse: RAW,
    });
    log.error({ err, jobId: 'j1' }, 'extraction job failed');
    log.error(err, 'bare error');
    const out = lines();
    expect(out).not.toContain('JANE DOE');
    expect(out).toContain('[redacted]');
    // The useful parts survive.
    expect(out).toContain('ExtractionResponseError');
    expect(out).toContain('did not match extraction schema');
  });

  it('censors rawResponse at the top level and one or two levels deep', () => {
    const { lines, log } = capture();
    log.warn({ rawResponse: RAW }, 'top');
    log.warn({ outer: { rawResponse: RAW } }, 'one deep');
    log.warn({ outer: { inner: { rawResponse: RAW } } }, 'two deep');
    expect(lines()).not.toContain('JANE DOE');
  });

  it('censors the row values a Postgres error carries in detail', () => {
    const { lines, log } = capture();
    const pgErr = Object.assign(new Error('new row violates check constraint "x"'), {
      code: '23514',
      detail: 'Failing row contains (acct 123456789, ZELLE TO JANE DOE).',
    });
    log.error({ err: pgErr }, 'persist failed');
    log.error({ err: new Error('wrapped', { cause: pgErr }) }, 'wrapped failure');
    const out = lines();
    expect(out).not.toContain('JANE DOE');
    expect(out).toContain('violates check constraint');
  });
});
