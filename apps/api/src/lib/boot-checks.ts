// Fail-fast guards run at boot. Each check that can't be proven safe at
// import time goes here so misconfigurations surface as a clear error
// instead of a confusing runtime crash later.

import { logger } from './logger.js';
import { performHandshake } from './manifest.js';

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

// MIG-6 — Vibe AI Router dual-mode. router without both URL and token is a
// misconfiguration, not something to limp through: every extraction would
// fail at request time with a worse message.
const enforceAiModeConfig = (): void => {
  const mode = process.env.VIBE_AI_MODE;
  if (mode && mode !== 'direct' && mode !== 'router') {
    throw new BootCheckError(`VIBE_AI_MODE must be 'direct' or 'router'; got ${mode}`);
  }
  if (mode === 'router' && (!process.env.VIBE_AI_ROUTER_URL || !process.env.VIBE_AI_TOKEN)) {
    throw new BootCheckError(
      'VIBE_AI_MODE=router requires both VIBE_AI_ROUTER_URL and VIBE_AI_TOKEN ' +
        '(the appliance mints the token during "vibe enable"), or set VIBE_AI_MODE=direct.',
    );
  }
};

// BuildPlan §29.12 — appliance handshake. Records both the appliance
// platform version (APPLIANCE_VERSION env) and the bundled app
// manifest version so the orchestrator can correlate them. The two
// values are intentionally NOT compared — they're orthogonal concepts.
const performApplianceHandshake = (): void => {
  const result = performHandshake();
  if (result.status === 'standalone') return;
  if (result.status === 'ok') {
    logger.info(
      { manifestVersion: result.manifestVersion, applianceVersion: result.applianceVersion },
      'appliance handshake ok',
    );
    return;
  }
  logger.warn(
    { manifestPath: result.manifestPath },
    `appliance handshake unknown: ${result.detail ?? 'no detail'}`,
  );
};

export const runBootChecks = (): void => {
  enforceSessionSecret();
  enforceDatabaseUrl();
  enforceLlmConfig();
  enforceAiModeConfig();
  performApplianceHandshake();
  logger.info('boot checks passed');
};
