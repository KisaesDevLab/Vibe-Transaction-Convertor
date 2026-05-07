// Read the appliance manifest (`vibe-app.yaml`) without pulling in a
// YAML parser. The schema is stable (BuildPlan §29.1) and the only field
// the runtime ever needs from it is `version`, so a tight regex over the
// file is both adequate and avoids adding js-yaml to the image. If the
// manifest grows fields we have to surface at runtime, swap this for a
// real parser — but keep the search path logic.

import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_FILENAME = 'vibe-app.yaml';

const candidatePaths = (): string[] => {
  // dev (tsx in apps/api/src/...): up four to the repo root
  // built (apps/api/dist/lib/...): same up-four to repo root
  // container (image WORKDIR=/app): /app/vibe-app.yaml
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(process.cwd(), MANIFEST_FILENAME),
    join(here, '..', '..', '..', '..', MANIFEST_FILENAME),
    join(here, '..', '..', '..', MANIFEST_FILENAME),
    `/app/${MANIFEST_FILENAME}`,
  ];
};

const findManifest = (): string | null => {
  for (const p of candidatePaths()) {
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      // try next
    }
  }
  return null;
};

// Tight match for `version: <semver-ish>` at column 0. Quoted forms
// (`version: "0.1.0"` or `'0.1.0'`) are accepted; comments after the
// value are stripped.
const VERSION_RE = /^version:\s*["']?([^"'#\s]+)["']?\s*(?:#.*)?$/m;

export interface ManifestRead {
  path: string | null;
  version: string | null;
  error?: string;
}

export const readManifest = (): ManifestRead => {
  const path = findManifest();
  if (!path) return { path: null, version: null, error: 'vibe-app.yaml not found' };
  try {
    const raw = readFileSync(path, 'utf8');
    const match = VERSION_RE.exec(raw);
    if (!match) return { path, version: null, error: 'version field not found' };
    return { path, version: match[1] ?? null };
  } catch (err) {
    return { path, version: null, error: (err as Error).message };
  }
};

export interface HandshakeResult {
  // Whether the appliance installer told us which manifest version it
  // expected. False in standalone mode where APPLIANCE_VERSION is unset.
  applianceMode: boolean;
  expectedVersion: string | null;
  manifestVersion: string | null;
  manifestPath: string | null;
  // ok = matched, or appliance not in play. mismatch = installer set a
  // version that disagrees with the bundled manifest. unknown = manifest
  // unreadable for some reason; surfaces but is not fatal.
  status: 'ok' | 'mismatch' | 'unknown' | 'standalone';
  detail?: string;
}

export const performHandshake = (): HandshakeResult => {
  const applianceMode = process.env.APPLIANCE_MODE === 'true';
  const expectedVersion = process.env.APPLIANCE_VERSION ?? null;
  const manifest = readManifest();
  const base = {
    applianceMode,
    expectedVersion,
    manifestVersion: manifest.version,
    manifestPath: manifest.path,
  };

  if (!applianceMode) {
    return { ...base, status: 'standalone' };
  }
  if (manifest.error || !manifest.version) {
    return { ...base, status: 'unknown', detail: manifest.error ?? 'manifest unreadable' };
  }
  if (!expectedVersion) {
    // The installer should always inject APPLIANCE_VERSION in appliance
    // mode; absence is a soft warning, not a mismatch.
    return {
      ...base,
      status: 'unknown',
      detail: 'APPLIANCE_VERSION env not set by installer',
    };
  }
  if (expectedVersion !== manifest.version) {
    return {
      ...base,
      status: 'mismatch',
      detail: `installer expected ${expectedVersion}, image carries ${manifest.version}`,
    };
  }
  return { ...base, status: 'ok' };
};
