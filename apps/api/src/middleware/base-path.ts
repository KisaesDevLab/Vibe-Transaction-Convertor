// Vibe-Appliance LAN/Tailscale mode forwards requests to this app under
// a path prefix (`/vibe-tx-converter/...`) without stripping it before
// hitting the api container — the appliance Caddy treats the prefix as
// part of the upstream URL and lets the app see the full path. The SPA
// bundle is built with `base: '/vibe-tx-converter/'` (substituted in by
// scripts/web-base-path.sh from VITE_BASE_PATH), so its asset and fetch
// URLs include the prefix; without this middleware, those requests
// bypass express.static and the api routes both — express.static can't
// find `dist/vibe-tx-converter/assets/...`, the SPA fallback returns
// index.html for the JS request, the browser refuses to execute HTML
// as a script, and the page renders blank.
//
// Standalone deploys leave VITE_BASE_PATH unset (or `/`) and this
// middleware is a no-op.

import type { RequestHandler } from 'express';

const normalize = (raw: string | undefined): string => {
  if (!raw || raw.length === 0 || raw === '/') return '/';
  let v = raw;
  if (!v.startsWith('/')) v = `/${v}`;
  if (!v.endsWith('/')) v = `${v}/`;
  return v;
};

const noop: RequestHandler = (_req, _res, next) => next();

export const stripBasePath = (
  basePath: string | undefined = process.env.VITE_BASE_PATH,
): RequestHandler => {
  const normalized = normalize(basePath);
  if (normalized === '/') return noop;

  // "/vibe-tx-converter/" -> "/vibe-tx-converter"
  const prefix = normalized.slice(0, -1);

  return (req, _res, next) => {
    const url = req.url;
    if (url === prefix) {
      // The browser lands on the bare prefix (no trailing slash); rewrite
      // to "/" so the SPA fallback serves index.html.
      req.url = '/';
    } else if (url.startsWith(`${prefix}/`)) {
      // Strip the prefix from req.url so all downstream routing — api
      // routes, express.static, the SPA fallback regex — sees the
      // unprefixed path and works the same as in standalone mode.
      // originalUrl is preserved by Express for logs / X-Forwarded-* use.
      req.url = url.slice(prefix.length) || '/';
    }
    next();
  };
};
