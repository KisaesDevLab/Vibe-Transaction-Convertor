// DB-free unit tests for the extraction worker's pure decision helpers: which
// attempt wins a fallback, which failures BullMQ may retry, and how the worker
// concurrency env is parsed. (The orchestration itself is covered by the
// live-Postgres extraction.worker*.test.ts suites.)

import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';

import { ExtractionResponseError } from '@vibe-tx-converter/extractor';

import {
  CancelledError,
  PermanentExtractionError,
  errorForBullmq,
  isPermanentExtractionFailure,
  parseWorkerConcurrency,
  pickBetterAttempt,
} from './extraction.worker.js';

type Outcome = Parameters<typeof pickBetterAttempt>[0];
// pickBetterAttempt only reads `rejection` (and, for a discrepancy, the
// reconciled balance delta); the rest of the outcome is irrelevant.
const outcome = (
  providerId: 'local' | 'anthropic',
  rejection: Outcome['rejection'],
  deltaCents?: bigint,
): Outcome =>
  ({
    providerId,
    rejection,
    ...(deltaCents !== undefined ? { reconciled: { deltaCents } } : {}),
  }) as unknown as Outcome;

describe('pickBetterAttempt', () => {
  it('keeps a primary with rows over an empty-txs secondary', () => {
    const primary = outcome('local', 'discrepancy');
    const secondary = outcome('anthropic', 'empty-txs');
    expect(pickBetterAttempt(primary, secondary)).toBe(primary);
  });

  it('takes a secondary with rows over an empty-txs primary', () => {
    const primary = outcome('local', 'empty-txs');
    const secondary = outcome('anthropic', 'discrepancy');
    expect(pickBetterAttempt(primary, secondary)).toBe(secondary);
  });

  it('prefers a verified attempt over a discrepancy either way round', () => {
    const verified = outcome('local', null);
    const discrepant = outcome('anthropic', 'discrepancy');
    expect(pickBetterAttempt(verified, discrepant)).toBe(verified);
    expect(pickBetterAttempt(discrepant, verified)).toBe(verified);
  });

  it('prefers any parsed outcome (even empty) over an http / malformed failure', () => {
    const empty = outcome('anthropic', 'empty-txs');
    expect(pickBetterAttempt(outcome('local', 'http'), empty)).toBe(empty);
    expect(pickBetterAttempt(empty, outcome('local', 'malformed'))).toBe(empty);
  });

  it('prefers the secondary (fallback) on a tie', () => {
    for (const r of [null, 'discrepancy', 'empty-txs', 'http'] as const) {
      const secondary = outcome('anthropic', r);
      expect(pickBetterAttempt(outcome('local', r), secondary)).toBe(secondary);
    }
    const malformed = outcome('anthropic', 'malformed');
    expect(pickBetterAttempt(outcome('local', 'http'), malformed)).toBe(malformed);
    const periodOnly = outcome('anthropic', 'discrepancy', 0n);
    expect(pickBetterAttempt(outcome('local', 'discrepancy', 0n), periodOnly)).toBe(periodOnly);
  });

  // A period-only discrepancy (balance ties to the cent, rows out of period)
  // must never be traded for a result whose balance does not tie.
  it('ranks a period-only discrepancy above a balance discrepancy either way round', () => {
    const periodOnly = outcome('local', 'discrepancy', 0n);
    const offBalance = outcome('anthropic', 'discrepancy', 1_234n);
    expect(pickBetterAttempt(periodOnly, offBalance)).toBe(periodOnly);
    expect(pickBetterAttempt(offBalance, periodOnly)).toBe(periodOnly);
  });

  it('still ranks verified above a period-only discrepancy', () => {
    const verified = outcome('local', null);
    const periodOnly = outcome('anthropic', 'discrepancy', 0n);
    expect(pickBetterAttempt(verified, periodOnly)).toBe(verified);
    expect(pickBetterAttempt(periodOnly, verified)).toBe(verified);
  });

  it('ranks a period-only discrepancy above empty / failed attempts', () => {
    const periodOnly = outcome('anthropic', 'discrepancy', 0n);
    expect(pickBetterAttempt(periodOnly, outcome('local', 'empty-txs'))).toBe(periodOnly);
    expect(pickBetterAttempt(periodOnly, outcome('local', 'http'))).toBe(periodOnly);
  });
});

describe('errorForBullmq / isPermanentExtractionFailure', () => {
  it('makes a schema / truncation ExtractionResponseError unrecoverable (no retry)', () => {
    const err = new ExtractionResponseError({
      summary: 'LLM response did not match extraction schema',
      rawResponse: '{"transactions":[]}',
    });
    expect(isPermanentExtractionFailure(err)).toBe(true);
    const out = errorForBullmq(err);
    expect(out).toBeInstanceOf(UnrecoverableError);
    expect((out as Error).message).toBe(err.message);
    // The raw model output never rides along into BullMQ's failedReason.
    expect((out as Error).message).not.toContain('transactions');
  });

  it('lets BullMQ retry an ExtractionResponseError flagged transient (empty completion)', () => {
    // Set after construction so this holds whether or not the built extractor
    // already accepts `transient` as a constructor option.
    const err = Object.assign(
      new ExtractionResponseError({
        summary: 'LLM returned an empty completion',
        rawResponse: '',
      }),
      { transient: true },
    );
    expect(isPermanentExtractionFailure(err)).toBe(false);
    expect(errorForBullmq(err)).toBe(err);
    // Only an explicit `true` counts — a deterministic one stays permanent.
    const deterministic = Object.assign(
      new ExtractionResponseError({ summary: 'LLM output truncated', rawResponse: '{' }),
      { transient: false },
    );
    expect(isPermanentExtractionFailure(deterministic)).toBe(true);
  });

  it('makes a PermanentExtractionError (cap / page cap / no text layer) unrecoverable', () => {
    const err = new PermanentExtractionError('monthly Anthropic spend cap reached');
    expect(isPermanentExtractionFailure(err)).toBe(true);
    const out = errorForBullmq(err);
    expect(out).toBeInstanceOf(UnrecoverableError);
    expect((out as Error).message).toBe('monthly Anthropic spend cap reached');
  });

  it('passes transient failures through unchanged so BullMQ retries them', () => {
    const err = new Error('local gateway HTTP 503');
    expect(isPermanentExtractionFailure(err)).toBe(false);
    expect(errorForBullmq(err)).toBe(err);
    const timeout = Object.assign(new Error('ollama POST /v1/chat/completions timed out'), {
      name: 'TimeoutError',
    });
    expect(errorForBullmq(timeout)).toBe(timeout);
  });

  it('does not treat a cooperative cancel as a permanent failure', () => {
    expect(isPermanentExtractionFailure(new CancelledError())).toBe(false);
  });
});

describe('parseWorkerConcurrency', () => {
  it('defaults to 1 when unset, non-numeric, or below 1', () => {
    expect(parseWorkerConcurrency(undefined)).toBe(1);
    expect(parseWorkerConcurrency('')).toBe(1);
    expect(parseWorkerConcurrency('abc')).toBe(1);
    expect(parseWorkerConcurrency('0')).toBe(1);
    expect(parseWorkerConcurrency('-3')).toBe(1);
  });

  it('accepts a positive integer', () => {
    expect(parseWorkerConcurrency('1')).toBe(1);
    expect(parseWorkerConcurrency('4')).toBe(4);
  });
});
