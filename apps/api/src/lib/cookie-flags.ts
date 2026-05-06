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
