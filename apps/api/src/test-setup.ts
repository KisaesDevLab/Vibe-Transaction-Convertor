// Global Vitest setup for the API workspace. Runs before every test.
//
// Resets the login rate-limiter so a full-suite rerun against a persistent
// Redis (or a long-lived in-memory bucket under the single-fork pool) doesn't
// accumulate login attempts across files and spuriously 429 the login-based
// route tests. CI gets a fresh Redis per run, but local reruns reuse the same
// container — this keeps those deterministic.

import { beforeEach } from 'vitest';

import { resetLoginRateLimits } from './middleware/login-rate-limit.js';
import { resetRateLimiters } from './middleware/rate-limit.js';

beforeEach(async () => {
  await resetLoginRateLimits();
  await resetRateLimiters();
});
