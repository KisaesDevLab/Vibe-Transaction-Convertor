// Cookie security-flag resolver.
//
// `Secure` cookies are dropped silently by the browser on plain-HTTP
// responses, so a single hard-coded `secure: true` (or
// `NODE_ENV === 'production'`) breaks LAN HTTP installs: login returns
// 200 with a session id, the browser refuses to store the cookie, and
// every subsequent request lands as 401. Hard-coding `false` weakens
// HTTPS deploys.
//
// The Vibe-Appliance computes per install mode and threads the value
// through env (true under domain/Tailscale, false under LAN HTTP). When
// SESSION_SECURE is unset we keep the historical NODE_ENV heuristic so
// pre-existing standalone deploys behave the same as before.

const truthy = (v: string | undefined): boolean => v === '1' || v?.toLowerCase() === 'true';

export const cookieSecure = (): boolean => {
  const explicit = process.env.SESSION_SECURE;
  if (explicit !== undefined && explicit !== '') {
    return truthy(explicit);
  }
  return process.env.NODE_ENV === 'production';
};

// BuildPlan §29.16 — session/CSRF cookies must be scoped to the per-app
// subdomain when running alongside other Vibe apps on a shared appliance.
// Returning `undefined` leaves the `Domain` attribute off, which makes
// the cookie host-only — i.e. the browser only sends it back to the
// exact host that issued it (`tx.<appliance-domain>`), never to a
// sibling app on the same parent domain. This is the strictest scoping
// available and the right default; SESSION_COOKIE_DOMAIN is the escape
// hatch for the rare deploy that needs an explicit shared domain.
export const cookieDomain = (): string | undefined => {
  const explicit = process.env.SESSION_COOKIE_DOMAIN;
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  return undefined;
};

// Path is always `/` so cookies cover both the SPA and `/api/*`. Express
// defaults to `/` when omitted, but stating it explicitly documents the
// intent and survives any future `res.cookie` default change.
export const cookiePath = (): string => '/';
