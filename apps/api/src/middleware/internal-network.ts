// Phase 29 #13 — gate routes that the appliance orchestrator polls
// (not user-facing) to private-network source IPs only.
//
// We accept loopback + RFC 1918 + the docker-compose default subnet
// ranges out of the box. In appliance mode the orchestrator hits us
// over the internal Docker network, which Express sees as a
// 172.16-31.x address. End-user traffic comes through Caddy on the
// host's public IP, so it never matches.
//
// `trust proxy: 1` on the Express app means req.ip already reflects
// the X-Forwarded-For client IP when behind a single trusted proxy.
// In appliance mode the orchestrator hits us directly (no proxy in
// the path) so req.ip is the real socket address.

import type { RequestHandler } from 'express';
import { isIPv4, isIPv6 } from 'node:net';

import { ForbiddenError } from '../lib/errors.js';

const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number.parseInt(p, 10);
    if (!Number.isFinite(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  // shift left can produce negatives for high addresses; coerce.
  return n >>> 0;
};

const inCidr4 = (ip: string, cidr: string): boolean => {
  const [base, bits] = cidr.split('/');
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base ?? '');
  if (ipInt === null || baseInt === null) return false;
  const n = Number.parseInt(bits ?? '32', 10);
  if (n === 0) return true;
  const mask = (~0 << (32 - n)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
};

// IPv4 ranges considered "internal". Docker user-defined networks
// hand out 172.17-31.x by default; the explicit RFC 1918 ranges
// cover everything else.
const ALLOWED_V4 = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

const stripV4Mapped = (ip: string): string => {
  // express on dual-stack interfaces reports IPv4 as ::ffff:1.2.3.4.
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
};

const isInternalIp = (ip: string): boolean => {
  const stripped = stripV4Mapped(ip);
  if (stripped === '::1') return true;
  if (isIPv6(stripped)) {
    // Treat fc00::/7 (ULA) and fe80::/10 (link-local) as internal.
    return stripped.startsWith('fc') || stripped.startsWith('fd') || stripped.startsWith('fe80');
  }
  if (!isIPv4(stripped)) return false;
  return ALLOWED_V4.some((c) => inCidr4(stripped, c));
};

export const requireInternalNetwork: RequestHandler = (req, _res, next) => {
  const ip = req.ip ?? '';
  if (!isInternalIp(ip)) {
    return next(new ForbiddenError(`internal endpoint; source ${ip} not allowed`));
  }
  next();
};

// Exported for unit tests and the self-check script.
export const _isInternalIp = isInternalIp;
