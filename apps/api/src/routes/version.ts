import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface VersionPayload {
  name: string;
  version: string;
  buildSha: string;
  node: string;
}

let cached: VersionPayload | undefined;

const loadVersion = async (): Promise<VersionPayload> => {
  if (cached) return cached;
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const pkgPath = join(__dirname, '..', '..', 'package.json');
  let name = '@vibe-tx-converter/api';
  let version = '0.0.0';
  try {
    const raw = await readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { name?: string; version?: string };
    if (pkg.name) name = pkg.name;
    if (pkg.version) version = pkg.version;
  } catch {
    // fall through to defaults
  }
  cached = {
    name,
    version,
    buildSha: process.env.BUILD_SHA ?? 'unknown',
    node: process.version,
  };
  return cached;
};

export const versionRouter = (): Router => {
  const router = Router();
  router.get('/version', async (_req, res) => {
    res.json(await loadVersion());
  });
  return router;
};
