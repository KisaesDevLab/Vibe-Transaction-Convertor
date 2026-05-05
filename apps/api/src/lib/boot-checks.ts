// Fail-fast guards run at boot. Each check that can't be proven safe at
// import time goes here so misconfigurations surface as a clear error
// instead of a confusing runtime crash later.

import { logger } from './logger.js';

export class BootCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootCheckError';
  }
}

const enforceSessionSecret = (): void => {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new BootCheckError('SESSION_SECRET is not set');
  }
  if (secret.length < 32) {
    throw new BootCheckError(`SESSION_SECRET must be at least 32 bytes; got ${secret.length}`);
  }
};

const enforceDatabaseUrl = (): void => {
  if (!process.env.DATABASE_URL) {
    throw new BootCheckError('DATABASE_URL is not set');
  }
};

const enforceLlmConfig = (): void => {
  // We do not require LLM_GATEWAY_URL eagerly — operators may run with
  // ANTHROPIC provider only. The provider factory throws the right
  // error when it discovers no usable config at extraction time.
  const provider = process.env.LLM_PROVIDER ?? 'local';
  if (provider !== 'local' && provider !== 'anthropic') {
    throw new BootCheckError(`LLM_PROVIDER must be 'local' or 'anthropic'; got ${provider}`);
  }
};

export const runBootChecks = (): void => {
  enforceSessionSecret();
  enforceDatabaseUrl();
  enforceLlmConfig();
  logger.info('boot checks passed');
};
