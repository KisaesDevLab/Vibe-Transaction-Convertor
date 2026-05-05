import { readFileSync } from 'node:fs';

import { REACHABILITY_FLAG_PATH, type ReachabilityFlag } from './global-setup';

/**
 * Read the flag file written by global-setup. Returns a defensive default
 * if the file is missing or unparseable so specs always have something
 * sensible to .skip against.
 */
export const readReachability = (): ReachabilityFlag => {
  try {
    const raw = readFileSync(REACHABILITY_FLAG_PATH, 'utf8');
    return JSON.parse(raw) as ReachabilityFlag;
  } catch {
    return {
      baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:4400',
      reachable: false,
      llmGatewayConfigured: Boolean(process.env.LLM_GATEWAY_URL),
      detail: 'reachability flag not found — global-setup did not run',
      checkedAt: new Date().toISOString(),
    };
  }
};
