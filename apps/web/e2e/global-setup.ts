import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved at module load; specs import the same constant so the path
// is identical on both sides.
const __dirname = dirname(fileURLToPath(import.meta.url));
export const REACHABILITY_FLAG_PATH = join(__dirname, '.reachability.json');

export interface ReachabilityFlag {
  baseURL: string;
  reachable: boolean;
  status?: number;
  detail?: string;
  llmGatewayConfigured: boolean;
  checkedAt: string;
}

/**
 * Pings /api/health/ready against the configured baseURL and writes a flag
 * file at e2e/.reachability.json. Spec files read that flag and skip
 * themselves when the API isn't running, so a developer who hasn't booted
 * the stack still gets `playwright test` exit-0'ing rather than 30 seconds
 * of refused-connection failures per spec.
 *
 * Returning rather than throwing is intentional — we want the test session
 * to load and skip with a readable reason, not fail global-setup.
 */
const globalSetup = async (): Promise<void> => {
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:4400';
  const flag: ReachabilityFlag = {
    baseURL,
    reachable: false,
    llmGatewayConfigured: Boolean(process.env.LLM_GATEWAY_URL),
    checkedAt: new Date().toISOString(),
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    try {
      const res = await fetch(`${baseURL.replace(/\/$/, '')}/api/health/ready`, {
        signal: controller.signal,
      });
      flag.status = res.status;
      // /api/health/ready returns 200 when all configured deps are healthy
      // and 503 ("degraded") when one is unconfigured/failing — the API
      // process itself is still up, so 503 is also a green light for the
      // E2E suite. Anything outside the 2xx/5xx range (or fetch throw) is
      // treated as unreachable.
      flag.reachable = res.status >= 200 && res.status < 600;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    flag.detail = (err as Error).message;
  }

  mkdirSync(dirname(REACHABILITY_FLAG_PATH), { recursive: true });
  writeFileSync(REACHABILITY_FLAG_PATH, JSON.stringify(flag, null, 2), 'utf8');

  if (!flag.reachable) {
    // eslint-disable-next-line no-console
    console.warn(
      `[global-setup] API at ${baseURL} not reachable (${flag.detail ?? `status ${flag.status}`}). Specs will skip gracefully.`,
    );
  }
};

export default globalSetup;
