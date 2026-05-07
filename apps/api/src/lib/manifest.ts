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
  applianceMode: boolean;
  // The appliance platform version (Vibe-Appliance v1, v2, …) injected
  // by the installer via the APPLIANCE_VERSION env. This is the
  // appliance's own platform version, not the vibe-tx-converter app
  // version — they're separate concepts and must not be compared.
  applianceVersion: string | null;
  // The vibe-tx-converter app version baked into the image's manifest
  // (vibe-app.yaml `version`). Surfaced for the orchestrator to record
  // alongside the running build SHA.
  manifestVersion: string | null;
  manifestPath: string | null;
  // ok       = appliance mode + manifest readable
  // unknown  = appliance mode but manifest can't be read (image bug)
  // standalone = appliance mode is off
  status: 'ok' | 'unknown' | 'standalone';
  detail?: string;
}

export const performHandshake = (): HandshakeResult => {
  const applianceMode = process.env.APPLIANCE_MODE === 'true';
  const applianceVersion = process.env.APPLIANCE_VERSION ?? null;
  const manifest = readManifest();
  const base = {
    applianceMode,
    applianceVersion,
    manifestVersion: manifest.version,
    manifestPath: manifest.path,
  };

  if (!applianceMode) {
    return { ...base, status: 'standalone' };
  }
  if (manifest.error || !manifest.version) {
    return { ...base, status: 'unknown', detail: manifest.error ?? 'manifest unreadable' };
  }
  return { ...base, status: 'ok' };
};
